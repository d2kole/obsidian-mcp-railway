/**
 * E2E: Write flow against ephemeral git remote (Task #14)
 *
 * Validates the full write chain against a real local bare repo — no vault
 * service mocks in Group 1.
 *
 * Group 1 "Real git remote"
 *   vi.resetModules() called once in beforeAll so a fresh VaultService
 *   instance points at the ephemeral bare repo. All git-level assertions
 *   (commit count, file content, push-race) live here.
 *
 * Group 2 "Disallowed-path via MCP HTTP stack"
 *   Uses static imports + mocked VaultService to drive write_note through
 *   the full Express → OAuth → MCP middleware stack. Verifies the write-path
 *   allowlist rejection shape and confirms no git operations are attempted.
 */

// ---------------------------------------------------------------------------
// Group 2 static imports — must appear BEFORE any vi.resetModules() call
// so Vitest resolves them from the original module registry.
// ---------------------------------------------------------------------------
import "../../src/test/env";
import { buildOAuthRouter } from "../../src/oauth/routes";
import { buildMcpRouter } from "../../src/mcp/transport";
import { vaultService } from "../../src/vault/service";
import { getConfig } from "../../src/lib/config";
import { assertWriteAllowed as assertWriteAllowedPure } from "../../src/vault/write-path";

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import express, { type Express } from "express";
import request from "supertest";
import crypto from "node:crypto";

import { makeBareRepo, seedBareRepo, type BareRepo } from "../fixtures/git";

// ---------------------------------------------------------------------------
// Shared git helpers — use git raw commands so simple-git's internal log
// format does not interfere with our queries.
// ---------------------------------------------------------------------------

async function commitCount(bareDir: string): Promise<number> {
  try {
    const out = await simpleGit(bareDir).raw(["rev-list", "--count", "HEAD"]);
    return parseInt(out.trim(), 10);
  } catch {
    return 0;
  }
}

async function lastNMessages(bareDir: string, n: number): Promise<string[]> {
  const out = await simpleGit(bareDir).raw([
    "log",
    `--format=%s`,
    `-${n}`,
  ]);
  return out
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
}

// ---------------------------------------------------------------------------
// Group 2 helpers — full HTTP stack with mocked vault service
// ---------------------------------------------------------------------------

function makeApp(): Express {
  const app = express();
  app.use(express.json({ limit: "4mb" }));
  app.use(express.urlencoded({ extended: true }));
  app.use(buildOAuthRouter());
  app.use("/mcp", buildMcpRouter());
  return app;
}

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
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
      auth_token: cfg.oauth.personalAuthToken,
    });
  const code = new URL(
    authRes.headers["location"] as string,
  ).searchParams.get("code")!;
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
  return tokRes.body.access_token as string;
}

async function initSession(app: Express, token: string): Promise<string> {
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
        clientInfo: { name: "write-flow-test", version: "1" },
      },
      id: 1,
    });
  const sid =
    (res.headers["mcp-session-id"] as string | undefined) ??
    (res.headers["Mcp-Session-Id"] as string | undefined);
  if (!sid) throw new Error(`No session-id: status=${res.status}`);
  return sid;
}

function extractMcpText(res: request.Response): string {
  const ct = (res.headers["content-type"] as string) ?? "";
  if (ct.includes("application/json")) {
    const body = res.body as {
      result?: { content?: { text: string }[] };
    };
    return body.result?.content?.[0]?.text ?? "";
  }
  const match = res.text.match(/data:\s*(\{.*\})/s);
  if (!match) throw new Error(`No SSE data frame: ${res.text}`);
  const parsed = JSON.parse(match[1]!) as {
    result?: { content?: { text: string }[] };
  };
  return parsed.result?.content?.[0]?.text ?? "";
}

// ===========================================================================
// Group 1: Real git remote — all tests share one VaultService instance
// ===========================================================================

describe("Write flow against real bare git remote (no vault mocks)", () => {
  let bare: BareRepo;
  let svc: import("../../src/vault/service").VaultService;
  let VaultError: typeof import("../../src/vault/service").VaultError;

  beforeAll(async () => {
    // Create the bare repo and seed it with initial content.
    bare = await makeBareRepo({ prefix: "e2e-write-flow-" });
    await seedBareRepo(bare, {
      "README.md": "# Vault\n",
      "00-Inbox/.gitkeep": "",
      "Journal/.gitkeep": "",
      "00-Inbox/patchable.md": "# Patchable\n\nline two.\n",
    });

    // Reset modules once so the fresh VaultService reads from our stubbed env.
    vi.resetModules();

    const cacheDir = await mkdtemp(path.join(tmpdir(), "e2e-write-cache-"));
    vi.stubEnv("VAULT_REPO_URL", bare.url);
    vi.stubEnv("GITHUB_PAT", "test-pat-file-transport");
    vi.stubEnv("VAULT_CACHE_DIR", cacheDir);
    vi.stubEnv("VAULT_BRANCH", "main");
    vi.stubEnv("OAUTH_STORE_PATH", path.join(cacheDir, ".oauth-store.json"));
    vi.stubEnv("OAUTH_CLIENT_ID", "obsidian-mcp-railway");
    vi.stubEnv("OAUTH_CLIENT_SECRET", "test-client-secret-12345678");
    vi.stubEnv("SESSION_ENCRYPTION_KEY", "test-session-encryption-key-32chars!!");
    vi.stubEnv("PERSONAL_AUTH_TOKEN", "test-personal-auth-token");
    vi.stubEnv("BASE_URL", "http://localhost:3000");
    vi.stubEnv("OBSIDIAN_WRITE_PATHS", "00-Inbox,Journal");
    vi.stubEnv("MAX_WRITES_PER_HOUR", "20");

    const cfgMod = await import("../../src/lib/config");
    cfgMod.loadConfig("stdio");

    const svcMod = await import("../../src/vault/service");
    svc = new svcMod.VaultService();
    await svc.init();
    VaultError = svcMod.VaultError;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await bare.cleanup();
  });

  it("write_note to an allowed path produces exactly one commit on the bare remote", async () => {
    const before = await commitCount(bare.bareDir);
    await svc.sync();
    await svc.writeFile("00-Inbox/capture.md", "# Capture\n\nTest note.\n");
    const sha = await svc.commitAndPush("test: write_note to 00-Inbox/capture.md");
    const after = await commitCount(bare.bareDir);

    expect(sha).toBeTruthy();
    expect(after).toBe(before + 1);

    // Verify the commit message appears on the bare remote.
    const [latest] = await lastNMessages(bare.bareDir, 1);
    expect(latest).toContain("write_note");
  });

  it("apply_patch produces the expected file content and a commit on the bare remote", async () => {
    await svc.sync();

    // Read the current content from the working copy (avoids a no-op write).
    const current = await svc.readFile("00-Inbox/patchable.md");
    expect(current).toContain("line two.");

    const before = await commitCount(bare.bareDir);

    // Patch: insert a third line.
    const { applyUnifiedPatch } = await import("../../src/vault/edits");
    const patch =
      "--- a/00-Inbox/patchable.md\n" +
      "+++ b/00-Inbox/patchable.md\n" +
      "@@ -1,3 +1,4 @@\n" +
      " # Patchable\n" +
      " \n" +
      " line two.\n" +
      "+line three.\n";
    const updated = applyUnifiedPatch(current, patch);
    expect(updated).toContain("line three.");

    await svc.writeFile("00-Inbox/patchable.md", updated);
    const sha = await svc.commitAndPush("test: apply_patch to patchable.md");
    const after = await commitCount(bare.bareDir);

    expect(sha).toBeTruthy();
    expect(after).toBe(before + 1);

    // Read back from a fresh clone to confirm the patched content is on remote.
    const wc = await bare.freshWorkingClone();
    const onRemote = await simpleGit(wc.dir).show([
      "HEAD:00-Inbox/patchable.md",
    ]);
    expect(onRemote).toContain("line three.");
    expect(onRemote).toContain("line two.");
  });

  it("git log matches the expected commit sequence after multiple writes", async () => {
    await svc.sync();
    await svc.writeFile("Journal/note-a.md", "# A\n");
    await svc.commitAndPush("test: write A");
    await svc.writeFile("Journal/note-b.md", "# B\n");
    await svc.commitAndPush("test: write B");
    await svc.writeFile("Journal/note-c.md", "# C\n");
    await svc.commitAndPush("test: write C");

    const messages = await lastNMessages(bare.bareDir, 3);
    expect(messages[0]).toContain("write C");
    expect(messages[1]).toContain("write B");
    expect(messages[2]).toContain("write A");
  });

  it("push race — competing commit between sync and push surfaces a descriptive error", async () => {
    // Sync to get current HEAD.
    await svc.sync();

    // Inject a competing commit onto the bare remote before our push.
    const competitor = await bare.freshWorkingClone();
    await competitor.commitAndPush(
      { "00-Inbox/race-interloper.md": "# Interloper\n" },
      "race: competing commit",
    );

    // Write a file — succeeds locally.
    await svc.writeFile("00-Inbox/racer.md", "# Racer\n");

    // Push must fail (our local is behind the advanced remote).
    // The server must surface an error — not silently swallow it.
    let caught: Error | null = null;
    try {
      await svc.commitAndPush("test: push after race");
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).not.toBeNull();
    expect(caught!.message.length).toBeGreaterThan(0);
    // Raw PAT / basic-auth fragments must not appear in the error text.
    expect(caught!.message).not.toMatch(/ghp_/);
    expect(caught!.message).not.toMatch(new RegExp("://[^@]+@"));
  });
});

// ===========================================================================
// Group 2: Disallowed path via full MCP HTTP stack
// ===========================================================================

describe("Disallowed write path via MCP HTTP stack", () => {
  beforeEach(() => {
    const cfg = getConfig();
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    // writeFile mock enforces the allowlist — matching the real implementation —
    // so write_note's call to writeFile throws for disallowed paths even though
    // the singleton was never init()-ed (writePaths defaults to []).
    vi.spyOn(vaultService, "writeFile").mockImplementation(async (p) => {
      assertWriteAllowedPure(p, cfg.vault.writePaths);
    });
    vi.spyOn(vaultService, "commitAndPush").mockResolvedValue("abc0000");
    vi.spyOn(vaultService, "readFile").mockResolvedValue("# Note\n");
    vi.spyOn(vaultService, "exists").mockResolvedValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  it("write_note to a disallowed path returns an MCP error that names the allowlist — no git ops attempted", async () => {
    const app = makeApp();
    const token = await obtainToken(app);
    const sid = await initSession(app, token);

    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json, text/event-stream")
      .set("Mcp-Session-Id", sid)
      .send({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "write_note",
          arguments: { path: "Wiki/secret.md", content: "# Secret\n" },
        },
        id: 10,
      });

    expect(res.status).toBe(200);
    const text = extractMcpText(res);
    expect(text).toBeTruthy();
    const payload = JSON.parse(text) as {
      ok: boolean;
      error: string;
      hint: string;
      allowed_paths?: string[];
    };

    expect(payload.ok).toBe(false);
    // Error must name the denied path.
    expect(payload.error).toMatch(/Wiki\/secret\.md/);
    // Hint or allowed_paths must reference the configured write paths.
    const combined = JSON.stringify(payload);
    expect(combined).toMatch(/00-Inbox|Journal|Captures/);

    // writeFile is called but throws the allowlist rejection before any
    // git commit is attempted — commitAndPush must never be reached.
    expect(vi.mocked(vaultService.writeFile)).toHaveBeenCalledWith(
      "Wiki/secret.md",
      "# Secret\n",
    );
    expect(vi.mocked(vaultService.commitAndPush)).not.toHaveBeenCalled();
  });

  it("write_note to an allowed path calls writeFile and commitAndPush", async () => {
    const app = makeApp();
    const token = await obtainToken(app);
    const sid = await initSession(app, token);

    const res = await request(app)
      .post("/mcp")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept", "application/json, text/event-stream")
      .set("Mcp-Session-Id", sid)
      .send({
        jsonrpc: "2.0",
        method: "tools/call",
        params: {
          name: "write_note",
          arguments: { path: "00-Inbox/allowed.md", content: "# New\n" },
        },
        id: 11,
      });

    expect(res.status).toBe(200);
    const text = extractMcpText(res);
    const payload = JSON.parse(text) as { ok: boolean };
    expect(payload.ok).toBe(true);

    expect(vi.mocked(vaultService.writeFile)).toHaveBeenCalledWith(
      "00-Inbox/allowed.md",
      "# New\n",
    );
    expect(vi.mocked(vaultService.commitAndPush)).toHaveBeenCalledOnce();
  });
});
