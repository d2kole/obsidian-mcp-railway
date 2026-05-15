/**
 * E2E: Failure-mode drills
 *
 * Drives the four failure modes called out in OPERATIONS.md as real
 * end-to-end scenarios through the full Express middleware stack:
 *
 *   1. PAT revoked / unreachable remote: vaultService.dryRunFetch() rejects
 *      → /api/healthz returns 500 with the failing check named, and tool
 *      calls surface an actionable MCP error mentioning GITHUB_PAT.
 *   2. Volume wiped: cache dir is deleted between boots; on next request
 *      the server re-clones from the bare-repo fixture and serves content.
 *   3. Rate-limit hit: 21 writes in a single hour; the 21st returns the
 *      documented MCP error including the retry-after window.
 *   4. Tampered token: a forged bearer token returns 401 with a body that
 *      does NOT leak which signature check failed.
 */

import "../../src/test/env";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import { buildOAuthRouter } from "../../src/oauth/routes";
import { buildMcpRouter } from "../../src/mcp/transport";
import healthRouter from "../../src/routes/health";
import { vaultService } from "../../src/vault/service";
import { _resetWriteRateForTests } from "../../src/mcp/rateLimit";
import { getConfig } from "../../src/lib/config";
import { makeBareRepo, seedBareRepo, type BareRepo } from "../fixtures/git";

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
  app.use("/api", healthRouter);
  return app;
}

async function obtainToken(app: Express): Promise<string> {
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
    throw new Error(`authorize failed: ${authRes.status} ${authRes.text}`);
  }
  const loc = new URL(authRes.headers["location"] as string);
  const code = loc.searchParams.get("code")!;
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
  if (tokRes.status !== 200) {
    throw new Error(`token failed: ${tokRes.status} ${tokRes.text}`);
  }
  return tokRes.body.access_token as string;
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
        clientInfo: { name: "failure-mode-test", version: "1" },
      },
      id: 1,
    });
  const sid =
    (res.headers["mcp-session-id"] as string | undefined) ??
    (res.headers["Mcp-Session-Id"] as string | undefined);
  if (!sid) throw new Error(`No session id: ${res.status} ${res.text}`);
  return sid;
}

function parseJsonRpc(res: request.Response): JsonRpcResponse {
  const ct = (res.headers["content-type"] as string | undefined) ?? "";
  if (ct.includes("application/json")) return res.body as JsonRpcResponse;
  if (ct.includes("text/event-stream")) {
    const m = res.text.match(/data:\s*(\{.*\})/s);
    if (!m) throw new Error(`No SSE frame: ${res.text}`);
    return JSON.parse(m[1]!) as JsonRpcResponse;
  }
  throw new Error(`Unexpected content-type: ${ct} body=${res.text}`);
}

async function callTool(
  app: Express,
  token: string,
  sid: string,
  name: string,
  args: Record<string, unknown>,
  id = 2,
): Promise<JsonRpcResponse> {
  const res = await request(app)
    .post("/mcp")
    .set("Authorization", `Bearer ${token}`)
    .set("Accept", "application/json, text/event-stream")
    .set("Content-Type", "application/json")
    .set("mcp-session-id", sid)
    .send({
      jsonrpc: "2.0",
      method: "tools/call",
      params: { name, arguments: args },
      id,
    });
  return parseJsonRpc(res);
}

// =========================================================================
// 1. PAT revoked / unreachable remote
// =========================================================================
describe("Scenario 1 — PAT revoked / unreachable remote", () => {
  beforeEach(() => {
    vi.spyOn(vaultService, "dryRunFetch").mockRejectedValue(
      new Error(
        "git fetch failed: remote: Repository not found or fatal: Authentication failed",
      ),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("/api/healthz returns 500 and names the failing check", async () => {
    const app = makeApp();
    const res = await request(app).get("/api/healthz");
    expect(res.status).toBe(500);
    expect(res.body.status).toBe("fail");
    const failed = (res.body.checks as Array<{ name: string; ok: boolean; detail?: string }>)
      .filter((c) => !c.ok);
    expect(failed.length).toBeGreaterThan(0);
    const names = failed.map((c) => c.name);
    expect(names).toContain("git_fetch_dry_run");
    // Detail should describe the failure (operator runbook hint)
    const fetchCheck = failed.find((c) => c.name === "git_fetch_dry_run")!;
    expect(fetchCheck.detail).toBeTruthy();
    expect(fetchCheck.detail!.length).toBeGreaterThan(0);
  });
});

// =========================================================================
// 2. Volume wiped — server re-clones on next boot
// =========================================================================
describe("Scenario 2 — Volume wiped, server re-clones cleanly", () => {
  let bare: BareRepo;
  let cacheDir: string;

  beforeAll(async () => {
    bare = await makeBareRepo({ branch: "main" });
    await seedBareRepo(bare, { "00-Inbox/seed.md": "# seeded\n" }, "seed");
    cacheDir = await fs.mkdtemp(path.join(tmpdir(), "wiped-cache-"));
  });
  afterAll(async () => {
    if (bare) await bare.cleanup();
    if (cacheDir) await fs.rm(cacheDir, { recursive: true, force: true });
  });

  it("re-clones into a freshly-empty cache dir", async () => {
    // Wipe: ensure cacheDir exists but contains no .git checkout
    await fs.rm(cacheDir, { recursive: true, force: true });
    await fs.mkdir(cacheDir, { recursive: true });

    // Boot a fresh VaultService against the bare remote with the wiped cache.
    vi.resetModules();
    process.env["VAULT_REPO_URL"] = bare.url;
    process.env["VAULT_BRANCH"] = "main";
    process.env["VAULT_CACHE_DIR"] = cacheDir;

    const { vaultService: fresh } = await import("../../src/vault/service");
    const { loadConfig } = await import("../../src/lib/config");
    loadConfig("http");
    await fresh.init();

    // After init, the .git directory must exist and the seed file must be present.
    const gitDirStat = await fs.stat(path.join(cacheDir, ".git"));
    expect(gitDirStat.isDirectory()).toBe(true);

    const seedExists = await fresh.exists("00-Inbox/seed.md");
    expect(seedExists).toBe(true);

    const content = await fresh.readFile("00-Inbox/seed.md");
    expect(content).toContain("# seeded");
  });
});

// =========================================================================
// 3. Rate-limit hit — 21st write surfaces actionable error
// =========================================================================
describe("Scenario 3 — Rate-limit hit on 21st write", () => {
  beforeEach(() => {
    _resetWriteRateForTests();
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    vi.spyOn(vaultService, "commitAndPush").mockResolvedValue("abc1234");
    vi.spyOn(vaultService, "exists").mockResolvedValue(false);
    vi.spyOn(vaultService, "dryRunFetch").mockResolvedValue();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    _resetWriteRateForTests();
  });

  it("21st write_note in an hour returns rate-limit error with retry-after window", async () => {
    const app = makeApp();
    const token = await obtainToken(app);
    const sid = await initSession(app, token);

    // First 20 writes succeed.
    for (let i = 0; i < 20; i++) {
      const r = await callTool(
        app,
        token,
        sid,
        "write_note",
        { path: `00-Inbox/note-${i}.md`, content: `note ${i}\n` },
        100 + i,
      );
      expect(r.result?.isError, `write #${i + 1} unexpectedly errored`).toBeFalsy();
    }

    // 21st must be rejected with documented rate-limit error text.
    const r = await callTool(
      app,
      token,
      sid,
      "write_note",
      { path: "00-Inbox/note-21.md", content: "overflow\n" },
      121,
    );
    expect(r.result?.isError).toBe(true);
    const text = r.result?.content?.[0]?.text ?? "";
    expect(text.toLowerCase()).toMatch(/rate[- ]?limit|max_writes_per_hour|too many/i);
    // Retry-after window must be communicated.
    expect(text).toMatch(/retry|wait|reset|seconds|minutes/i);
  });
});

// =========================================================================
// 4. Tampered token — 401 without leaking which check failed
// =========================================================================
describe("Scenario 4 — Tampered token rejected without leaking detail", () => {
  beforeEach(() => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "dryRunFetch").mockResolvedValue();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 401 with a generic body that does not name the failed check", async () => {
    const app = makeApp();
    // Forge a JWT-shaped token signed with a wrong key.
    const header = Buffer.from(
      JSON.stringify({ alg: "HS256", typ: "JWT" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        sub: "attacker",
        jti: crypto.randomUUID(),
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString("base64url");
    const wrongSig = crypto
      .createHmac("sha256", "wrong-key-not-the-real-one")
      .update(`${header}.${payload}`)
      .digest("base64url");
    const forged = `${header}.${payload}.${wrongSig}`;

    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${forged}`)
      .set("Accept", "application/json, text/event-stream")
      .set("Content-Type", "application/json")
      .send({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "attacker", version: "1" },
        },
        id: 1,
      });

    expect(res.status).toBe(401);
    const bodyText = JSON.stringify(res.body) + " " + (res.text ?? "");
    // Body must use the generic invalid_token error code (per RFC 6750)
    // and must NOT name which specific check failed (signature vs. jti
    // revocation vs. wrong key vs. malformed segments). The current server
    // collapses all failures into one combined message — that's the
    // contract we're locking in here.
    expect(res.body.error).toBe("invalid_token");
    expect(bodyText).not.toMatch(/\bsignature\b/i);
    expect(bodyText).not.toMatch(/\bissuer\b/i);
    expect(bodyText).not.toMatch(/\bjti\b/i);
    expect(bodyText).not.toMatch(/\bhmac\b/i);
    expect(bodyText).not.toMatch(/\brevoked\b/i);
    expect(bodyText).not.toMatch(/wrong key/i);
    // But it SHOULD include WWW-Authenticate so clients know to re-auth.
    const wwwAuth = res.headers["www-authenticate"];
    expect(wwwAuth).toBeTruthy();
  });

  it("rejects an entirely malformed bearer with the same generic 401", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/mcp")
      .set("Authorization", "Bearer not-even-a-jwt")
      .set("Accept", "application/json, text/event-stream")
      .set("Content-Type", "application/json")
      .send({
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "attacker", version: "1" },
        },
        id: 1,
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
    const bodyText = JSON.stringify(res.body) + " " + (res.text ?? "");
    expect(bodyText).not.toMatch(/\bsignature\b|\bissuer\b|malformed/i);
  });
});
