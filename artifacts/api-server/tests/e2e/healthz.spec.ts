import { expect, test } from "@playwright/test";

test("GET /api/healthz returns a binary 200/500 with the documented shape", async ({
  request,
}) => {
  const res = await request.get("/api/healthz");
  expect([200, 500]).toContain(res.status());

  const body = await res.json();
  expect(body).toHaveProperty("status");
  expect(body).toHaveProperty("checks");
  expect(Array.isArray(body.checks)).toBe(true);

  for (const check of body.checks) {
    expect(check).toHaveProperty("name");
    expect(check).toHaveProperty("ok");
  }
});

test("GET / returns the service identity JSON", async ({ request }) => {
  const res = await request.get("/");
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(body.name).toBe("obsidian-mcp-railway");
  expect(body.mcp_endpoint).toBe("/mcp");
});
