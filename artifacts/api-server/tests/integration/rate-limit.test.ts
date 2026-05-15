import "../../src/test/env";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import crypto from "node:crypto";

import { buildOAuthRouter } from "../../src/oauth/routes";
import { buildMcpRouter } from "../../src/mcp/transport";
import { _resetWriteRateForTests } from "../../src/mcp/rateLimit";
import { vaultService } from "../../src/vault/service";
import { getConfig } from "../../src/lib/config";

/**
 * Drive writes through the real Express middleware stack:
 *   express.json -> CORS -> OAuth -> /mcp router -> requireAccessToken
 *   -> StreamableHTTPServerTransport -> createMcpServer -> isWriteTool
 *   -> consumeWrite -> rejection payload.
 *
 * vaultService methods are spied to no-ops so the test exercises the
 * dispatcher without needing a real git remote.
 */

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: { isError?: boolean; content?: { type: string; text: string }[] };
  error?: { code: number; message: string };
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

function makeApp(): Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(buildOAuthRouter());
  app.use("/mcp", buildMcpRouter());
  return app;
}

async function getToken(app: Express): Promise<string> {
  const cfg = getConfig();
  const { verifier, challenge } = pkcePair();
  const authRes = await request(app)
    .post("/oauth/authorize")
    .type("form")
    .send({
      response_type: "code",
      client_id: cfg.oauth.clientId,
      redirect_uri: "https://claude.ai/cb",
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp",
      state: "s",
      auth_token: cfg.oauth.personalAuthToken,
    });
  if (authRes.status !== 302) {
    throw new Error(
      `OAuth authorize failed: status=${authRes.status} body=${JSON.stringify(authRes.body)}`,
    );
  }
  const loc = new URL(authRes.headers["location"] as string);
  const code = loc.searchParams.get("code");
  if (!code) throw new Error("No code in OAuth redirect");
  const tokRes = await request(app)
    .post("/oauth/token")
    .type("form")
    .send({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://claude.ai/cb",
      code_verifier: verifier,
      client_id: cfg.oauth.clientId,
    });
  if (tokRes.status !== 200 || !tokRes.body.access_token) {
    throw new Error(
      `OAuth token failed: status=${tokRes.status} body=${JSON.stringify(tokRes.body)}`,
    );
  }
  return tokRes.body.access_token as string;
}

function parseJsonRpc(res: request.Response): JsonRpcResponse {
  const ct = (res.headers["content-type"] as string | undefined) ?? "";
  if (ct.includes("application/json")) return res.body as JsonRpcResponse;
  if (ct.includes("text/event-stream")) {
    // Streamable HTTP SSE frames: `event: message\ndata: {json}\n\n`
    const text = res.text;
    const match = text.match(/data:\s*(\{.*\})/s);
    if (!match) {
      throw new Error(`No SSE data frame in response. Text=${text}`);
    }
    return JSON.parse(match[1]!) as JsonRpcResponse;
  }
  throw new Error(`Unexpected content-type: ${ct} body=${res.text}`);
}

async function initSession(app: Express, token: string): Promise<string> {
  const res = await request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${token}`)
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json")
    .send({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "rate-limit-test", version: "1" },
      },
      id: 1,
    });
  const sid =
    (res.headers["mcp-session-id"] as string | undefined) ??
    (res.headers["Mcp-Session-Id"] as string | undefined);
  if (!sid) {
    throw new Error(
      `No mcp-session-id header. status=${res.status} headers=${JSON.stringify(
        res.headers,
      )} body=${res.text}`,
    );
  }
  // Some clients require the explicit `notifications/initialized` ack;
  // fire-and-forget here so the transport considers the session live.
  await request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${token}`)
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json")
    .set("Mcp-Session-Id", sid)
    .send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    });
  return sid;
}

async function callTool(
  app: Express,
  token: string,
  sid: string,
  name: string,
  args: Record<string, unknown>,
  id: number,
): Promise<request.Response> {
  return request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${token}`)
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json")
    .set("Mcp-Session-Id", sid)
    .send({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name, arguments: args },
      id,
    });
}

describe("Rate limit through the real Express + MCP middleware stack", () => {
  beforeEach(() => {
    _resetWriteRateForTests();
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    vi.spyOn(vaultService, "commitAndPush").mockResolvedValue("0000000abc");
    vi.spyOn(vaultService, "readFile").mockResolvedValue("hi");
    vi.spyOn(vaultService, "exists").mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("blocks the (max+1)th write with the documented rate-limit error and surfaces retry-after + redacted session id", async () => {
    const app = makeApp();
    const token = await getToken(app);
    const sid = await initSession(app, token);
    const max = getConfig().rateLimit.maxWritesPerHour; // 20 in test/env

    for (let i = 0; i < max; i++) {
      const r = await callTool(
        app,
        token,
        sid,
        "write_note",
        { path: "00-Inbox/x.md", content: "hi" },
        100 + i,
      );
      expect(r.status).toBe(200);
      const body = parseJsonRpc(r);
      expect(body.result?.isError ?? false).toBe(false);
    }

    // The (max+1)th write — i.e. the 21st when MAX_WRITES_PER_HOUR=20 — must
    // be rejected with the documented payload contract.
    const blocked = await callTool(
      app,
      token,
      sid,
      "write_note",
      { path: "00-Inbox/x.md", content: "hi" },
      999,
    );
    expect(blocked.status).toBe(200);
    const body = parseJsonRpc(blocked);
    expect(body.result?.isError).toBe(true);
    const text = body.result?.content?.[0]?.text;
    expect(text).toBeTruthy();
    const payload = JSON.parse(text!) as {
      ok: false;
      error: string;
      hint: string;
      retry_after_seconds: number;
      session_id: string;
    };
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain("Write rate limit exceeded");
    expect(payload.error).toContain(`${max} writes per hour`);
    expect(payload.hint).toContain("Retry in");
    expect(payload.hint).toContain("MAX_WRITES_PER_HOUR");
    expect(payload.retry_after_seconds).toBeGreaterThan(0);
    expect(payload.retry_after_seconds).toBeLessThanOrEqual(3600);
    expect(payload.session_id).toMatch(/^[0-9a-f]{8}$/);
    // The redacted session id must NEVER echo the raw bearer token.
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain(token);
  });

  it("does not count read tools toward the write quota", async () => {
    const app = makeApp();
    const token = await getToken(app);
    const sid = await initSession(app, token);
    const max = getConfig().rateLimit.maxWritesPerHour;

    // Hammer reads beyond the write cap — all must succeed.
    for (let i = 0; i < max + 5; i++) {
      const r = await callTool(
        app,
        token,
        sid,
        "read_note",
        { path: "README.md" },
        200 + i,
      );
      expect(r.status).toBe(200);
      const body = parseJsonRpc(r);
      expect(body.result?.isError ?? false).toBe(false);
    }
    // First write afterwards is still allowed (reads didn't decrement).
    const r = await callTool(
      app,
      token,
      sid,
      "write_note",
      { path: "00-Inbox/x.md", content: "hi" },
      999,
    );
    expect(r.status).toBe(200);
    expect(parseJsonRpc(r).result?.isError ?? false).toBe(false);
  });

  it("isolates two parallel sessions — one hitting the limit doesn't affect the other", async () => {
    const app = makeApp();
    const tokenA = await getToken(app);
    const tokenB = await getToken(app);
    const sidA = await initSession(app, tokenA);
    const sidB = await initSession(app, tokenB);
    const max = getConfig().rateLimit.maxWritesPerHour;

    // Burn session A's quota.
    for (let i = 0; i < max; i++) {
      const r = await callTool(
        app,
        tokenA,
        sidA,
        "write_note",
        { path: "00-Inbox/a.md", content: "x" },
        300 + i,
      );
      expect(parseJsonRpc(r).result?.isError ?? false).toBe(false);
    }
    // A's next call is blocked.
    const blocked = await callTool(
      app,
      tokenA,
      sidA,
      "write_note",
      { path: "00-Inbox/a.md", content: "x" },
      998,
    );
    expect(parseJsonRpc(blocked).result?.isError).toBe(true);

    // B is unaffected.
    const ok = await callTool(
      app,
      tokenB,
      sidB,
      "write_note",
      { path: "00-Inbox/b.md", content: "x" },
      999,
    );
    expect(parseJsonRpc(ok).result?.isError ?? false).toBe(false);
  });
});
