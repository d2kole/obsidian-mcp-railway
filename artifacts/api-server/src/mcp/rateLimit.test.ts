import "../test/env";
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { consumeWrite } from "./rateLimit";

describe("write rate limiter", () => {
  it("allows up to MAX_WRITES_PER_HOUR then blocks subsequent writes", async () => {
    const key = `test-${crypto.randomUUID()}`;
    const max = 3;

    const r1 = await consumeWrite(key, max);
    const r2 = await consumeWrite(key, max);
    const r3 = await consumeWrite(key, max);
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    const r4 = await consumeWrite(key, max);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);

    const r5 = await consumeWrite(key, max);
    expect(r5.allowed).toBe(false);
  });

  it("tracks counts independently per session key", async () => {
    const a = `sess-a-${crypto.randomUUID()}`;
    const b = `sess-b-${crypto.randomUUID()}`;
    const max = 1;
    expect((await consumeWrite(a, max)).allowed).toBe(true);
    expect((await consumeWrite(a, max)).allowed).toBe(false);
    // Different key starts fresh.
    expect((await consumeWrite(b, max)).allowed).toBe(true);
  });
});
