import { describe, expect, it } from "vitest";

describe("test harness smoke", () => {
  it("vitest can run a unit test from tests/unit/", () => {
    expect(1 + 1).toBe(2);
  });
});
