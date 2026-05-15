import crypto from "node:crypto";
import { logger } from "../lib/logger";

/**
 * Per-session write rate limiter.
 *
 * Rolling-window counter keyed by an opaque session key (typically the OAuth
 * access token). Hand-rolled (rather than `express-rate-limit`'s MemoryStore)
 * so that:
 *   1. `Date.now()` is the only time source — fake timers in tests work
 *      deterministically with no real waits.
 *   2. The MCP tool dispatcher (which is not an Express request handler) can
 *      consume directly without a fake `req`/`res` shim.
 *   3. We can reset state between tests via `_resetWriteRateForTests()`.
 *
 * Out of scope: cross-instance limiting. The Railway deployment is single
 * instance per task #9 spec.
 */

const HOUR_MS = 60 * 60 * 1000;

interface Bucket {
  count: number;
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

/**
 * Soft cap on distinct session buckets we track in memory. The Railway
 * deployment is single-instance + single-user so churn is tiny in normal
 * operation, but a token-rotation loop or a misbehaving client could in
 * principle accumulate stale entries forever. Whenever we cross this
 * threshold we sweep any bucket whose window has expired.
 */
const BUCKET_SOFT_CAP = 1024;

function pruneExpired(now: number): void {
  for (const [key, b] of buckets) {
    if (now - b.windowStart >= HOUR_MS) {
      buckets.delete(key);
    }
  }
}

export interface RateLimitOutcome {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  retryAfterSec: number;
}

export async function consumeWrite(
  key: string,
  maxPerHour: number,
): Promise<RateLimitOutcome> {
  const now = Date.now();
  if (buckets.size >= BUCKET_SOFT_CAP) {
    pruneExpired(now);
  }
  let bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= HOUR_MS) {
    bucket = { count: 0, windowStart: now };
    buckets.set(key, bucket);
  }
  bucket.count += 1;

  const resetMs = Math.max(0, bucket.windowStart + HOUR_MS - now);
  const retryAfterSec = Math.max(1, Math.ceil(resetMs / 1000));

  if (bucket.count > maxPerHour) {
    logger.warn(
      { used: bucket.count, maxPerHour, retryAfterSec },
      "write rate limit exceeded",
    );
    return { allowed: false, remaining: 0, resetMs, retryAfterSec };
  }
  return {
    allowed: true,
    remaining: Math.max(0, maxPerHour - bucket.count),
    resetMs,
    retryAfterSec,
  };
}

/**
 * Derive a short, non-reversible session id from the raw session key. We
 * surface this in rate-limit rejection payloads so a confused Claude session
 * can correlate its own retries without the server ever echoing the bearer
 * token back over the wire.
 */
export function shortSessionId(sessionKey: string): string {
  return crypto
    .createHash("sha256")
    .update(sessionKey)
    .digest("hex")
    .slice(0, 8);
}

export interface RateLimitRejection {
  error: string;
  hint: string;
  retry_after_seconds: number;
  session_id: string;
}

export function buildRateLimitRejection(opts: {
  maxWritesPerHour: number;
  sessionKey: string;
  retryAfterSec: number;
}): RateLimitRejection {
  const sid = shortSessionId(opts.sessionKey);
  return {
    error: `Write rate limit exceeded: ${opts.maxWritesPerHour} writes per hour for session ${sid}.`,
    hint: `Retry in ${opts.retryAfterSec}s once the rolling window resets, or raise MAX_WRITES_PER_HOUR on Railway if this cap is too tight for your workload.`,
    retry_after_seconds: opts.retryAfterSec,
    session_id: sid,
  };
}

/** Reset all in-memory buckets. Tests only. */
export function _resetWriteRateForTests(): void {
  buckets.clear();
}

/** Tests-only inspector for the bucket map size. */
export function _bucketCountForTests(): number {
  return buckets.size;
}

/** Tests-only knob: shrink the soft cap so we can exercise pruning fast. */
export const _BUCKET_SOFT_CAP_FOR_TESTS = BUCKET_SOFT_CAP;
