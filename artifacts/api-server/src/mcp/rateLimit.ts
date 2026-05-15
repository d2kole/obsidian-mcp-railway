import { MemoryStore, type Store } from "express-rate-limit";
import { logger } from "../lib/logger";

/**
 * We use express-rate-limit's MemoryStore directly so we can increment from
 * inside the MCP tool dispatcher (a single HTTP POST may dispatch many
 * tool calls over the session lifetime). This keeps the implementation
 * consistent with express-rate-limit's algorithm and TTL semantics while
 * allowing per-tool gating.
 */
const HOUR_MS = 60 * 60 * 1000;

// Initialize the limiter so the MemoryStore is configured with the same
// window the MCP server uses; mounting it as middleware is also valid for
// any future per-request endpoints.
let store: Store | null = null;

export function getWriteRateStore(): Store {
  if (store) return store;
  const s = new MemoryStore();
  // Store.init is required before increment(); express-rate-limit normally
  // calls it on first request, but we use the store directly from the MCP
  // dispatcher.
  // express-rate-limit's Store.init expects the full resolved Options type,
  // but only windowMs is meaningful for MemoryStore. Cast through unknown to
  // satisfy the strict signature without pulling in the entire Options shape.
  (s.init as (opts: { windowMs: number }) => void)({ windowMs: HOUR_MS });
  store = s;
  return store;
}

export interface RateLimitOutcome {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export async function consumeWrite(
  key: string,
  maxPerHour: number,
): Promise<RateLimitOutcome> {
  const s = getWriteRateStore();
  const result = await s.increment(key);
  const used = result.totalHits;
  const resetMs = result.resetTime
    ? result.resetTime.getTime() - Date.now()
    : HOUR_MS;
  if (used > maxPerHour) {
    logger.warn({ key, used, maxPerHour }, "write rate limit exceeded");
    return { allowed: false, remaining: 0, resetMs };
  }
  return { allowed: true, remaining: maxPerHour - used, resetMs };
}
