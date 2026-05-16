/**
 * E2E: OAuth + MCP flow in a real browser
 *
 * Drives the full pipeline a Claude.ai-style client experiences:
 *   1. Browser hits /oauth/authorize, sees the consent form, submits the
 *      PERSONAL_AUTH_TOKEN, and is redirected with an auth `code`.
 *   2. The test exchanges the code at /oauth/token for an access token.
 *   3. The test calls read_note over /mcp with the bearer token and
 *      asserts the seeded fixture content comes back.
 *
 * A negative test confirms an attacker-controlled redirect_uri (not on the
 * OAUTH_ALLOWED_REDIRECT_PREFIXES allowlist) is rejected before any auth
 * code is issued.
 *
 * The vault is a local bare git repo seeded by scripts/e2e-bootstrap.mjs —
 * no github.com calls. A network-blocking route asserts that.
 */
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import crypto from "node:crypto";

const PERSONAL_AUTH_TOKEN = "e2e-personal-auth-token";
const CLIENT_ID = "obsidian-mcp-railway-e2e";

const E2E_PORT = process.env.E2E_PORT ?? process.env.PORT ?? "5179";
const E2E_ORIGIN = `http://127.0.0.1:${E2E_PORT}`;
const ALLOWED_REDIRECT = `${E2E_ORIGIN}/cb`;
const ATTACKER_REDIRECT = "https://evil.example.com/cb";

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

async function blockGithub(page: Page) {
  // Prove the test never touches github.com.
  await page.route(/github\.com|api\.github\.com/, (route) => {
    return route.abort("blockedbyclient");
  });
}

async function exchangeCodeForToken(
  request: APIRequestContext,
  code: string,
  verifier: string,
  redirectUri: string,
): Promise<string> {
  const res = await request.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: CLIENT_ID,
    },
  });
  expect(res.status(), `token exchange failed: ${await res.text()}`).toBe(200);
  const body = await res.json();
  expect(body.access_token).toBeTruthy();
  expect(body.token_type).toMatch(/bearer/i);
  return body.access_token as string;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: { isError?: boolean; content?: { type: string; text: string }[] };
  error?: { code: number; message: string };
}

function parseJsonRpc(contentType: string, text: string): JsonRpcResponse {
  if (contentType.includes("application/json")) return JSON.parse(text);
  if (contentType.includes("text/event-stream")) {
    const m = text.match(/data:\s*(\{.*\})/s);
    if (!m) throw new Error(`No SSE frame: ${text}`);
    return JSON.parse(m[1]!);
  }
  throw new Error(`Unexpected content-type: ${contentType} body=${text}`);
}

test.describe("OAuth + MCP browser flow", () => {
  test("happy path: browser drives form, then read_note returns seeded content", async ({
    page,
    request,
  }) => {
    await blockGithub(page);
    const { verifier, challenge } = pkcePair();
    const state = crypto.randomBytes(8).toString("hex");

    // Step 1: navigate to /oauth/authorize and submit the consent form.
    const authorizeQs = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: ALLOWED_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp",
      state,
    });
    const nav = await page.goto(`/oauth/authorize?${authorizeQs.toString()}`);
    expect(
      nav?.status(),
      `authorize GET expected 200, got ${nav?.status()}: ${(await page.content()).slice(0, 800)}`,
    ).toBe(200);
    await expect(page.locator('input[name="auth_token"]')).toBeVisible({
      timeout: 10_000,
    });

    // Submit form; the redirect target (127.0.0.1:5179/cb) will return
    // 404 from the api-server, but that's fine — we only need the URL.
    await page.fill('input[name="auth_token"]', PERSONAL_AUTH_TOKEN);
    const responsePromise = page.waitForResponse(
      (r) => r.url().includes("/cb") || r.status() === 302,
      { timeout: 5000 },
    );
    await Promise.all([
      page.click('button[type="submit"], input[type="submit"]'),
      responsePromise.catch(() => null),
    ]);

    // The browser should have ended up at /cb?code=...&state=...
    const finalUrl = new URL(page.url());
    expect(finalUrl.pathname).toBe("/cb");
    const code = finalUrl.searchParams.get("code");
    const returnedState = finalUrl.searchParams.get("state");
    expect(code, "auth code missing from redirect").toBeTruthy();
    expect(returnedState).toBe(state);

    // Step 2: exchange the code for an access token (out-of-band HTTP).
    const accessToken = await exchangeCodeForToken(
      request,
      code!,
      verifier,
      ALLOWED_REDIRECT,
    );

    // Step 3: initialize an MCP session with the bearer token.
    const initRes = await request.post("/mcp", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
      data: {
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "playwright-e2e", version: "1" },
        },
        id: 1,
      },
    });
    expect(initRes.status()).toBe(200);
    const sid =
      initRes.headers()["mcp-session-id"] ??
      initRes.headers()["Mcp-Session-Id"];
    expect(sid, "MCP session id missing from initialize response").toBeTruthy();

    // Step 4: call read_note for the seeded fixture.
    const callRes = await request.post("/mcp", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "mcp-session-id": sid!,
      },
      data: {
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "read_note",
          arguments: { path: "00-Inbox/welcome.md" },
        },
        id: 2,
      },
    });
    expect(callRes.status()).toBe(200);
    const ct = callRes.headers()["content-type"] ?? "";
    const parsed = parseJsonRpc(ct, await callRes.text());
    expect(parsed.result?.isError).toBeFalsy();
    const text = parsed.result?.content?.[0]?.text ?? "";
    expect(text).toContain("E2E welcome note");
  });

  test("rejects an attacker-controlled redirect_uri without issuing a code", async ({
    page,
  }) => {
    await blockGithub(page);
    const { challenge } = pkcePair();

    const authorizeQs = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: ATTACKER_REDIRECT,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp",
      state: "x",
    });
    const res = await page.goto(`/oauth/authorize?${authorizeQs.toString()}`);
    // Server should refuse before rendering the form. The exact status is
    // 400-class with an error_description; just make sure the form is NOT
    // shown and the browser never navigates to the attacker's host (the
    // request URL still contains evil.example.com inside redirect_uri).
    expect(res?.status()).toBeGreaterThanOrEqual(400);
    expect(res?.status()).toBeLessThan(500);
    expect(new URL(page.url()).hostname).not.toBe("evil.example.com");
    expect(new URL(page.url()).pathname).toBe("/oauth/authorize");

    const body = await page.content();
    expect(body.toLowerCase()).toMatch(/redirect|allowlist|unauthorized|invalid/);
    // The login form must NOT be shown for an unallowed redirect_uri.
    await expect(page.locator('input[name="auth_token"]')).toHaveCount(0);
  });
});
