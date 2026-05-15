import { describe, expect, it } from "vitest";

describe("integration harness smoke", () => {
  it("vitest can run an integration test from tests/integration/", () => {
    expect(typeof fetch).toBe("function");
  });
});
