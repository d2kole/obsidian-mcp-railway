import { describe, it, expect } from "vitest";

// Task #40 CI drill: this test is intentionally failing to verify that
// Railway's "Wait for CI" gate prevents a deploy when CI is red.
// It will be reverted in the very next commit.
describe("Task #40 — Railway Wait-for-CI drill", () => {
  it("intentional failure to make CI red (will be reverted)", () => {
    expect(true).toBe(false);
  });
});
