import "../test/env";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  consumeWrite,
  buildRateLimitRejection,
  shortSessionId,
  _resetWriteRateForTests,
} from "./rateLimit";

describe("write rate limiter (deterministic, fake clock)", () => {
  beforeEach(() => {
    _resetWriteRateForTests();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("allows up to maxPerHour, then blocks subsequent writes", async () => {
    const max = 3;
    const r1 = await consumeWrite("k1", max);
    const r2 = await consumeWrite("k1", max);
    const r3 = await consumeWrite("k1", max);
    expect([r1.allowed, r2.allowed, r3.allowed]).toEqual([true, true, true]);
    expect(r1.remaining).toBe(2);
    expect(r2.remaining).toBe(1);
    expect(r3.remaining).toBe(0);

    const r4 = await consumeWrite("k1", max);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.retryAfterSec).toBe(3600);

    // Stays blocked for any further attempts inside the window.
    const r5 = await consumeWrite("k1", max);
    expect(r5.allowed).toBe(false);
  });

  it("rolls the window forward exactly at the one-hour boundary", async () => {
    const max = 2;
    await consumeWrite("k", max);
    await consumeWrite("k", max);
    expect((await consumeWrite("k", max)).allowed).toBe(false);

    // Advance to 59m59s — still inside the original window.
    vi.advanceTimersByTime(59 * 60 * 1000 + 59 * 1000);
    expect((await consumeWrite("k", max)).allowed).toBe(false);

    // Cross the hour boundary by another two seconds.
    vi.advanceTimersByTime(2 * 1000);
    const r = await consumeWrite("k", max);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(1);
  });

  it("isolates two sessions — one hitting the limit doesn't affect the other", async () => {
    const max = 1;
    expect((await consumeWrite("alice", max)).allowed).toBe(true);
    expect((await consumeWrite("alice", max)).allowed).toBe(false);

    // Bob is unaffected by Alice exhausting her quota.
    expect((await consumeWrite("bob", max)).allowed).toBe(true);
    expect((await consumeWrite("bob", max)).allowed).toBe(false);

    // And Alice is still blocked, even after Bob's traffic.
    expect((await consumeWrite("alice", max)).allowed).toBe(false);
  });

  it("retryAfterSec decreases as time passes inside the same window", async () => {
    const max = 1;
    await consumeWrite("k", max);
    const blocked1 = await consumeWrite("k", max);
    expect(blocked1.allowed).toBe(false);
    expect(blocked1.retryAfterSec).toBe(3600);

    vi.advanceTimersByTime(30 * 60 * 1000); // +30 min
    const blocked2 = await consumeWrite("k", max);
    expect(blocked2.allowed).toBe(false);
    expect(blocked2.retryAfterSec).toBeLessThanOrEqual(1800);
    expect(blocked2.retryAfterSec).toBeGreaterThan(1799);
  });

  it("retryAfterSec is at least 1 second even at the very edge of the window", async () => {
    const max = 1;
    await consumeWrite("edge", max);
    // Jump to 999 ms before the window closes.
    vi.advanceTimersByTime(60 * 60 * 1000 - 999);
    const r = await consumeWrite("edge", max);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
  });
});

describe("buildRateLimitRejection — wire contract for Claude.ai", () => {
  it("names the limit, retry-after seconds, and a redacted session id (never the raw token)", () => {
    const rawToken = "ghp_supersecretpat-token-fragment-XYZ";
    const r = buildRateLimitRejection({
      maxWritesPerHour: 20,
      sessionKey: rawToken,
      retryAfterSec: 1234,
    });

    expect(r.error).toContain("Write rate limit exceeded");
    expect(r.error).toContain("20 writes per hour");
    expect(r.hint).toContain("Retry in 1234s");
    expect(r.hint).toContain("MAX_WRITES_PER_HOUR");
    expect(r.retry_after_seconds).toBe(1234);
    expect(r.session_id).toMatch(/^[0-9a-f]{8}$/);
    // Raw token must NEVER appear in the wire payload.
    const wire = JSON.stringify(r);
    expect(wire).not.toContain(rawToken);
    expect(wire).not.toContain("supersecretpat");
  });

  it("session_id is stable for a given session key (correlatable across retries)", () => {
    expect(shortSessionId("abc")).toBe(shortSessionId("abc"));
    expect(shortSessionId("abc")).not.toBe(shortSessionId("xyz"));
  });
});
