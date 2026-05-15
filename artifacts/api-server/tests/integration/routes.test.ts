/**
 * Integration tests — HTTP route contracts
 *
 * Covers every route mounted in app.ts against the real Express middleware
 * stack using supertest. No network calls leave the process: vaultService
 * methods are spied to no-ops so git operations don't run.
 *
 * Grouped by surface area:
 *  1.  Root /
 *  2.  /.well-known/oauth-authorization-server  (RFC 8414)
 *  3.  /.well-known/oauth-protected-resource
 *  4.  /oauth/register
 *  5.  /oauth/authorize  GET  (consent form)
 *  6.  /oauth/authorize  POST (credential check + code issue)
 *  7.  /oauth/token      (PKCE code exchange)
 *  8.  Full PKCE happy-path (register → authorize → token → /mcp bearer)
 *  9.  /mcp  auth guard  (401 paths)
 *  10. /mcp  transport   (session lifecycle)
 *  11. /api/healthz      (binary 200/500 + check names)
 *  12. /admin/tokens     (list + revoke)
 */

import "../../src/test/env";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import crypto from "node:crypto";
import fs from "node:fs/promises";

import { buildOAuthRouter } from "../../src/oauth/routes";
import { buildMcpRouter } from "../../src/mcp/transport";
import healthRouter from "../../src/routes/health";
import { vaultService } from "../../src/vault/service";
import { getConfig } from "../../src/lib/config";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApp(): Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(buildOAuthRouter());
  app.use("/mcp", buildMcpRouter());
  app.use("/api", healthRouter);
  app.get("/", (_req, res) => {
    res.json({
      name: "obsidian-mcp-railway",
      mcp_endpoint: "/mcp",
      health: "/api/healthz",
      oauth_metadata: "/.well-known/oauth-authorization-server",
    });
  });
  return app;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

/** Drive the full PKCE flow and return a valid bearer token. */
async function obtainToken(
  app: Express,
  opts: { redirectUri?: string } = {},
): Promise<string> {
  const cfg = getConfig();
  const { verifier, challenge } = pkcePair();
  const redirectUri = opts.redirectUri ?? "https://claude.ai/cb";

  const authRes = await request(app)
    .post("/oauth/authorize")
    .type("form")
    .send({
      response_type: "code",
      client_id: cfg.oauth.clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: "S256",
      scope: "mcp",
      state: "test-state",
      auth_token: cfg.oauth.personalAuthToken,
    });
  if (authRes.status !== 302)
    throw new Error(
      `authorize failed: ${authRes.status} ${JSON.stringify(authRes.body)}`,
    );

  const loc = new URL(authRes.headers["location"] as string);
  const code = loc.searchParams.get("code");
  if (!code) throw new Error("No code in redirect");

  const tokRes = await request(app)
    .post("/oauth/token")
    .type("form")
    .send({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      client_id: cfg.oauth.clientId,
    });
  if (tokRes.status !== 200 || !tokRes.body.access_token)
    throw new Error(
      `token failed: ${tokRes.status} ${JSON.stringify(tokRes.body)}`,
    );
  return tokRes.body.access_token as string;
}

/** Initialize an MCP session and return the session-id header value. */
async function initMcpSession(
  app: Express,
  token: string,
): Promise<string> {
  const res = await request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${token}`)
    .set("Accept", "application/json, text/event-stream")
    .send({
      jsonrpc: "2.0",
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "routes-test", version: "1" },
      },
      id: 1,
    });
  const sid =
    (res.headers["mcp-session-id"] as string | undefined) ??
    (res.headers["Mcp-Session-Id"] as string | undefined);
  if (!sid)
    throw new Error(
      `No mcp-session-id: status=${res.status} headers=${JSON.stringify(res.headers)} body=${res.text}`,
    );
  return sid;
}

// ---------------------------------------------------------------------------
// Shared stubs — vault service must not hit disk or git
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(vaultService, "sync").mockResolvedValue();
  vi.spyOn(vaultService, "writeFile").mockResolvedValue();
  vi.spyOn(vaultService, "commitAndPush").mockResolvedValue("abc0000");
  vi.spyOn(vaultService, "readFile").mockResolvedValue("# Note\n");
  vi.spyOn(vaultService, "exists").mockResolvedValue(true);
  vi.spyOn(vaultService, "dryRunFetch").mockResolvedValue();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// 1. Root /
// ===========================================================================

describe("GET /", () => {
  it("returns 200 with service identity JSON", async () => {
    const res = await request(makeApp()).get("/");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("obsidian-mcp-railway");
    expect(res.body.mcp_endpoint).toBe("/mcp");
    expect(res.body.health).toBe("/api/healthz");
    expect(res.body.oauth_metadata).toBe(
      "/.well-known/oauth-authorization-server",
    );
  });
});

// ===========================================================================
// 2. /.well-known/oauth-authorization-server  (RFC 8414)
// ===========================================================================

describe("GET /.well-known/oauth-authorization-server", () => {
  it("returns 200 with all RFC 8414 required fields", async () => {
    const cfg = getConfig();
    const res = await request(makeApp()).get(
      "/.well-known/oauth-authorization-server",
    );
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);

    const body = res.body as Record<string, unknown>;
    expect(body.issuer).toBe(cfg.baseUrl);
    expect(body.authorization_endpoint).toBe(
      `${cfg.baseUrl}/oauth/authorize`,
    );
    expect(body.token_endpoint).toBe(`${cfg.baseUrl}/oauth/token`);
    expect(body.registration_endpoint).toBe(
      `${cfg.baseUrl}/oauth/register`,
    );
    expect(body.response_types_supported).toEqual(["code"]);
    expect(body.grant_types_supported).toEqual(["authorization_code"]);
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(body.scopes_supported).toContain("mcp");
  });
});

// ===========================================================================
// 3. /.well-known/oauth-protected-resource
// ===========================================================================

describe("GET /.well-known/oauth-protected-resource", () => {
  it("returns 200 with resource, authorization_servers, bearer_methods_supported", async () => {
    const cfg = getConfig();
    const res = await request(makeApp()).get(
      "/.well-known/oauth-protected-resource",
    );
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe(cfg.baseUrl);
    expect(Array.isArray(res.body.authorization_servers)).toBe(true);
    expect(res.body.authorization_servers).toContain(cfg.baseUrl);
    expect(res.body.bearer_methods_supported).toContain("header");
    expect(res.body.scopes_supported).toContain("mcp");
  });
});

// ===========================================================================
// 4. /oauth/register  (RFC 7591 dynamic client registration stub)
// ===========================================================================

describe("POST /oauth/register", () => {
  it("returns 201 with the configured client_id and expected grant/response fields", async () => {
    const cfg = getConfig();
    const res = await request(makeApp())
      .post("/oauth/register")
      .send({ redirect_uris: ["https://claude.ai/cb"] });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toBe(cfg.oauth.clientId);
    expect(res.body.grant_types).toContain("authorization_code");
    expect(res.body.response_types).toContain("code");
    expect(res.body.token_endpoint_auth_method).toBe("none");
    expect(typeof res.body.client_id_issued_at).toBe("number");
  });

  it("echoes back the redirect_uris sent by the caller", async () => {
    const uris = ["https://claude.ai/cb", "http://localhost:8080/cb"];
    const res = await request(makeApp())
      .post("/oauth/register")
      .send({ redirect_uris: uris });
    expect(res.status).toBe(201);
    expect(res.body.redirect_uris).toEqual(uris);
  });
});

// ===========================================================================
// 5. GET /oauth/authorize  (consent form)
// ===========================================================================

describe("GET /oauth/authorize", () => {
  const cfg = () => getConfig();
  const validParams = () => ({
    response_type: "code",
    client_id: cfg().oauth.clientId,
    redirect_uri: "https://claude.ai/cb",
    code_challenge: "abc123challenge",
    code_challenge_method: "S256",
    scope: "mcp",
  });

  it("returns 200 HTML consent form for valid params", async () => {
    const res = await request(makeApp())
      .get("/oauth/authorize")
      .query(validParams());
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("obsidian-mcp-railway");
    expect(res.text).toContain("<form");
    expect(res.text).toContain('name="auth_token"');
  });

  it.each([
    ["response_type", "response_type"],
    ["client_id", "client_id"],
    ["redirect_uri", "redirect_uri"],
    ["code_challenge", "code_challenge"],
  ] as const)(
    "returns 400 invalid_request when %s is missing",
    async (_label, omit) => {
      const params = { ...validParams(), [omit]: undefined };
      const res = await request(makeApp())
        .get("/oauth/authorize")
        .query(params);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_request");
    },
  );

  it("returns 400 unsupported_response_type for response_type != code", async () => {
    const res = await request(makeApp())
      .get("/oauth/authorize")
      .query({ ...validParams(), response_type: "token" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_response_type");
  });

  it("returns 400 unauthorized_client for unknown client_id", async () => {
    const res = await request(makeApp())
      .get("/oauth/authorize")
      .query({ ...validParams(), client_id: "not-registered" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unauthorized_client");
  });

  it("returns 400 invalid_request for redirect_uri not in allowlist", async () => {
    const res = await request(makeApp())
      .get("/oauth/authorize")
      .query({ ...validParams(), redirect_uri: "https://evil.example.com/cb" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 400 invalid_request for unsupported code_challenge_method", async () => {
    const res = await request(makeApp())
      .get("/oauth/authorize")
      .query({ ...validParams(), code_challenge_method: "plain" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });
});

// ===========================================================================
// 6. POST /oauth/authorize  (credential check + code issue)
// ===========================================================================

describe("POST /oauth/authorize", () => {
  const cfg = () => getConfig();
  const validBody = () => ({
    response_type: "code",
    client_id: cfg().oauth.clientId,
    redirect_uri: "https://claude.ai/cb",
    code_challenge: "abc123challenge456789012345678901234567",
    code_challenge_method: "S256",
    scope: "mcp",
    state: "s1",
    auth_token: cfg().oauth.personalAuthToken,
  });

  it("returns 302 redirect with code + state for a valid submission", async () => {
    const res = await request(makeApp())
      .post("/oauth/authorize")
      .type("form")
      .send(validBody());
    expect(res.status).toBe(302);
    const loc = new URL(res.headers["location"] as string);
    expect(loc.searchParams.get("code")).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe("s1");
  });

  it("returns 401 access_denied for a wrong personal access token", async () => {
    const res = await request(makeApp())
      .post("/oauth/authorize")
      .type("form")
      .send({ ...validBody(), auth_token: "wrong-token" });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("access_denied");
  });

  it("returns 400 unauthorized_client for unknown client_id", async () => {
    const res = await request(makeApp())
      .post("/oauth/authorize")
      .type("form")
      .send({ ...validBody(), client_id: "unknown" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unauthorized_client");
  });

  it("returns 400 invalid_request for redirect_uri not in allowlist", async () => {
    const res = await request(makeApp())
      .post("/oauth/authorize")
      .type("form")
      .send({ ...validBody(), redirect_uri: "https://attacker.example/cb" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 400 invalid_request for unsupported code_challenge_method", async () => {
    const res = await request(makeApp())
      .post("/oauth/authorize")
      .type("form")
      .send({ ...validBody(), code_challenge_method: "plain" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("returns 400 invalid_request when redirect_uri or code_challenge is absent", async () => {
    const res = await request(makeApp())
      .post("/oauth/authorize")
      .type("form")
      .send({ ...validBody(), redirect_uri: "", code_challenge: "" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });
});

// ===========================================================================
// 7. POST /oauth/token  (code exchange)
// ===========================================================================

describe("POST /oauth/token", () => {
  it("returns 400 unsupported_grant_type for grant_type != authorization_code", async () => {
    const res = await request(makeApp())
      .post("/oauth/token")
      .type("form")
      .send({ grant_type: "client_credentials" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_grant_type");
  });

  it("returns 400 invalid_grant for a bogus authorization code", async () => {
    const cfg = getConfig();
    const res = await request(makeApp())
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code: "totally-fake-code-that-was-never-issued",
        redirect_uri: "https://claude.ai/cb",
        code_verifier: "verifier",
        client_id: cfg.oauth.clientId,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    expect(res.body.error_description).toMatch(/invalid or expired/i);
  });

  it("returns 400 invalid_grant for redirect_uri mismatch", async () => {
    const app = makeApp();
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
        auth_token: cfg.oauth.personalAuthToken,
      });
    const code = new URL(authRes.headers["location"] as string).searchParams.get(
      "code",
    )!;

    const res = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://claude.ai/different-path",
        code_verifier: verifier,
        client_id: cfg.oauth.clientId,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    expect(res.body.error_description).toMatch(/redirect_uri mismatch/i);
  });

  it("returns 400 invalid_grant when client_id does not match the code's issuing client", async () => {
    const app = makeApp();
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
        auth_token: cfg.oauth.personalAuthToken,
      });
    const code = new URL(authRes.headers["location"] as string).searchParams.get(
      "code",
    )!;

    const res = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://claude.ai/cb",
        code_verifier: verifier,
        client_id: "some-other-client",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("returns 400 invalid_grant for incorrect PKCE code_verifier", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const { challenge } = pkcePair();
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
        auth_token: cfg.oauth.personalAuthToken,
      });
    const code = new URL(authRes.headers["location"] as string).searchParams.get(
      "code",
    )!;

    const res = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://claude.ai/cb",
        code_verifier: "wrong-verifier",
        client_id: cfg.oauth.clientId,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    expect(res.body.error_description).toMatch(/PKCE/i);
  });

  it("returns 200 with access_token, token_type=Bearer, expires_in, scope on valid exchange", async () => {
    const app = makeApp();
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
        auth_token: cfg.oauth.personalAuthToken,
      });
    const code = new URL(authRes.headers["location"] as string).searchParams.get(
      "code",
    )!;

    const res = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://claude.ai/cb",
        code_verifier: verifier,
        client_id: cfg.oauth.clientId,
      });
    expect(res.status).toBe(200);
    expect(typeof res.body.access_token).toBe("string");
    expect(res.body.token_type).toBe("Bearer");
    expect(typeof res.body.expires_in).toBe("number");
    expect(res.body.expires_in).toBeGreaterThan(0);
    expect(res.body.scope).toBe("mcp");
  });
});

// ===========================================================================
// 8. Full PKCE happy-path end-to-end
// ===========================================================================

describe("Full PKCE flow: register → authorize → token → /mcp bearer accepted", () => {
  it("issues a working bearer token that /mcp accepts for an initialize request", async () => {
    const app = makeApp();
    const token = await obtainToken(app);
    expect(typeof token).toBe("string");

    // Bearer must be accepted by the MCP router (initialize → session-id returned)
    const initRes = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "e2e-test", version: "1" },
        },
        id: 1,
      });
    expect(initRes.status).toBe(200);
    const sid =
      (initRes.headers["mcp-session-id"] as string | undefined) ??
      (initRes.headers["Mcp-Session-Id"] as string | undefined);
    expect(typeof sid).toBe("string");
    expect(sid!.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 9. /mcp — auth guard (401 paths)
// ===========================================================================

describe("/mcp auth guard", () => {
  it("returns 401 with missing_token error and WWW-Authenticate when no Authorization header", async () => {
    const res = await request(makeApp())
      .post("/mcp")
      .send({ jsonrpc: "2.0", method: "initialize", id: 1 });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_token");
    expect(res.headers["www-authenticate"]).toMatch(/Bearer/);
    expect(res.body.error_description).toMatch(/oauth.*authorize/i);
  });

  it("returns 401 with invalid_token error for an expired or bogus bearer token", async () => {
    const res = await request(makeApp())
      .post("/mcp")
      .set("Authorization", "Bearer totally-invalid-token-xyz")
      .send({ jsonrpc: "2.0", method: "initialize", id: 1 });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
    expect(res.headers["www-authenticate"]).toMatch(/invalid_token/);
  });

  it("returns 401 for a malformed Authorization header (not Bearer scheme)", async () => {
    const res = await request(makeApp())
      .post("/mcp")
      .set("Authorization", "Basic dXNlcjpwYXNz")
      .send({ jsonrpc: "2.0", method: "initialize", id: 1 });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_token");
  });
});

// ===========================================================================
// 10. /mcp — session lifecycle
// ===========================================================================

describe("/mcp session lifecycle", () => {
  it("returns 400 jsonrpc error when POST has an mcp-session-id that is unknown", async () => {
    const app = makeApp();
    const token = await obtainToken(app);

    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json, text/event-stream")
      .set("Mcp-Session-Id", "00000000-0000-0000-0000-nonexistent")
      .send({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 2,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeDefined();
    expect(res.body.error.message).toMatch(/mcp-session-id/i);
  });

  it("DELETE /mcp with unknown session-id returns 204 (idempotent)", async () => {
    const app = makeApp();
    const token = await obtainToken(app);

    const res = await request(app)
      .delete("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Mcp-Session-Id", "nonexistent-session-id-abc");
    expect(res.status).toBe(204);
  });

  it("DELETE /mcp with no session-id returns 204", async () => {
    const app = makeApp();
    const token = await obtainToken(app);

    const res = await request(app)
      .delete("/mcp")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
  });

  it("DELETE /mcp with a live session-id closes the session and returns 204", async () => {
    const app = makeApp();
    const token = await obtainToken(app);
    const sid = await initMcpSession(app, token);

    const res = await request(app)
      .delete("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Mcp-Session-Id", sid);
    expect(res.status).toBe(204);
  });
});

// ===========================================================================
// 11. /api/healthz
// ===========================================================================

describe("GET /api/healthz", () => {
  it("returns 200 or 500 (binary, never any other status)", async () => {
    const res = await request(makeApp()).get("/api/healthz");
    expect([200, 500]).toContain(res.status);
  });

  it("response shape has status, elapsedMs, and checks array", async () => {
    const res = await request(makeApp()).get("/api/healthz");
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(["ok", "fail"]).toContain(res.body.status);
    expect(typeof res.body.elapsedMs).toBe("number");
    expect(Array.isArray(res.body.checks)).toBe(true);
  });

  it("every check entry has name (string) and ok (boolean)", async () => {
    const res = await request(makeApp()).get("/api/healthz");
    for (const check of res.body.checks as { name: unknown; ok: unknown }[]) {
      expect(typeof check.name).toBe("string");
      expect(typeof check.ok).toBe("boolean");
    }
  });

  it("check names include vault_cache_present, git_fetch_dry_run, mcp_handler_registered", async () => {
    const res = await request(makeApp()).get("/api/healthz");
    const names = (res.body.checks as { name: string }[]).map((c) => c.name);
    expect(names).toContain("vault_cache_present");
    expect(names).toContain("git_fetch_dry_run");
    expect(names).toContain("mcp_handler_registered");
  });

  it("returns 200 and status=ok when vault cache dir is present and git fetch succeeds", async () => {
    const cfg = getConfig();
    await fs.mkdir(cfg.vault.cacheDir, { recursive: true });
    vi.spyOn(vaultService, "dryRunFetch").mockResolvedValue();

    const res = await request(makeApp()).get("/api/healthz");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    const cacheCheck = (res.body.checks as { name: string; ok: boolean }[]).find(
      (c) => c.name === "vault_cache_present",
    );
    expect(cacheCheck?.ok).toBe(true);
    const fetchCheck = (res.body.checks as { name: string; ok: boolean }[]).find(
      (c) => c.name === "git_fetch_dry_run",
    );
    expect(fetchCheck?.ok).toBe(true);
  });

  it("returns 500 and status=fail when git fetch dry-run rejects", async () => {
    const cfg = getConfig();
    await fs.mkdir(cfg.vault.cacheDir, { recursive: true });
    vi.spyOn(vaultService, "dryRunFetch").mockRejectedValue(
      new Error("network unreachable"),
    );

    const res = await request(makeApp()).get("/api/healthz");
    expect(res.status).toBe(500);
    expect(res.body.status).toBe("fail");
    const fetchCheck = (res.body.checks as { name: string; ok: boolean; detail?: string }[]).find(
      (c) => c.name === "git_fetch_dry_run",
    );
    expect(fetchCheck?.ok).toBe(false);
    // detail must be present but must NOT expose the raw error chain
    expect(typeof fetchCheck?.detail).toBe("string");
  });

  it("mcp_handler_registered check is true when the MCP router has been mounted", async () => {
    // makeApp() always calls buildMcpRouter(), which sets mounted=true.
    const res = await request(makeApp()).get("/api/healthz");
    const check = (res.body.checks as { name: string; ok: boolean }[]).find(
      (c) => c.name === "mcp_handler_registered",
    );
    expect(check?.ok).toBe(true);
  });
});

// ===========================================================================
// 12. /admin/tokens  (list + revoke)
// ===========================================================================

describe("/admin/tokens", () => {
  it("GET /admin/tokens without Authorization returns 401 with WWW-Authenticate", async () => {
    const res = await request(makeApp()).get("/admin/tokens");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
    expect(res.headers["www-authenticate"]).toMatch(/Bearer/);
  });

  it("GET /admin/tokens with wrong bearer returns 401", async () => {
    const res = await request(makeApp())
      .get("/admin/tokens")
      .set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  it("GET /admin/tokens with correct PERSONAL_AUTH_TOKEN returns 200 with tokens array", async () => {
    const cfg = getConfig();
    const res = await request(makeApp())
      .get("/admin/tokens")
      .set("Authorization", `Bearer ${cfg.oauth.personalAuthToken}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.tokens)).toBe(true);
  });

  it("POST /admin/tokens/:jti/revoke with unknown jti returns 404", async () => {
    const cfg = getConfig();
    const res = await request(makeApp())
      .post("/admin/tokens/nonexistent-jti-abc/revoke")
      .set("Authorization", `Bearer ${cfg.oauth.personalAuthToken}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  it("POST /admin/tokens/:jti/revoke revokes a live token so it can no longer call /mcp", async () => {
    const app = makeApp();
    const cfg = getConfig();

    // Obtain a token and verify it works.
    const bearer = await obtainToken(app);
    const preRes = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${bearer}`)
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "revoke-test", version: "1" },
        },
        id: 1,
      });
    expect(preRes.status).toBe(200);

    // Decode the JWT payload directly to get the exact jti for this bearer.
    const [, payloadB64] = bearer.split(".");
    const jti = (
      JSON.parse(Buffer.from(payloadB64!, "base64url").toString()) as {
        jti: string;
      }
    ).jti;
    expect(typeof jti).toBe("string");

    // Confirm it appears in the admin token list before revoking.
    const listRes = await request(app)
      .get("/admin/tokens")
      .set("Authorization", `Bearer ${cfg.oauth.personalAuthToken}`);
    const tokens = listRes.body.tokens as { jti: string }[];
    expect(tokens.some((t) => t.jti === jti)).toBe(true);

    // Revoke it.
    const revokeRes = await request(app)
      .post(`/admin/tokens/${jti}/revoke`)
      .set("Authorization", `Bearer ${cfg.oauth.personalAuthToken}`);
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.revoked).toBe(true);
    expect(revokeRes.body.jti).toBe(jti);

    // The bearer should now be rejected.
    const postRes = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${bearer}`)
      .set("Accept", "application/json, text/event-stream")
      .send({
        jsonrpc: "2.0",
        method: "tools/list",
        id: 2,
      });
    expect(postRes.status).toBe(401);
    expect(postRes.body.error).toBe("invalid_token");
  });
});
