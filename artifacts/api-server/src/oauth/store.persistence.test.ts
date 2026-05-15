import "../test/env";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-store-test-"));
const storeFile = path.join(tmpDir, "oauth-store.json");
process.env["OAUTH_STORE_PATH"] = storeFile;

async function freshStore(opts?: { storePathOverride?: string }): Promise<typeof import("./store")> {
  const mod = await import("./store");
  // Flush any pending debounced write from the previous case to disk before
  // wiping in-memory state — that's what a real restart would observe.
  mod.flushPersist();
  mod._resetStoreForTests();
  process.env["OAUTH_STORE_PATH"] = opts?.storePathOverride ?? storeFile;
  return mod;
}

describe("oauth store persistence", () => {
  beforeEach(() => {
    try {
      fs.unlinkSync(storeFile);
    } catch {
      /* noop */
    }
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists auth codes across simulated restart", async () => {
    const a = await freshStore();
    const code = a.createAuthCode({
      clientId: "obsidian-mcp-railway",
      redirectUri: "https://claude.ai/cb",
      codeChallenge: "abc",
      codeChallengeMethod: "S256",
      scope: "mcp",
    });
    a.flushPersist();
    expect(fs.existsSync(storeFile)).toBe(true);

    // Simulate restart: clear in-memory state, force reload from disk.
    const b = await freshStore();
    const consumed = b.consumeAuthCode(code);
    expect(consumed).not.toBeNull();
    expect(consumed!.redirectUri).toBe("https://claude.ai/cb");
  });

  it("persists revoked jti across simulated restart", async () => {
    const a = await freshStore();
    a.revokeJti("jti-survives-restart");

    const b = await freshStore();
    const tok = await b.issueAccessToken({
      clientId: "obsidian-mcp-railway",
      scope: "mcp",
      ttlSec: 60,
    });
    // Force-revoke the freshly issued jti to confirm round-trip persistence.
    b.revokeJti(tok.jti);

    const c = await freshStore();
    const looked = await c.lookupAccessToken(tok.token);
    expect(looked).toBeNull();

    const raw = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
      revoked: Array<{ jti: string }>;
    };
    const jtis = raw.revoked.map((r) => r.jti);
    expect(jtis).toContain("jti-survives-restart");
    expect(jtis).toContain(tok.jti);
  });

  it("drops expired entries when reloading", async () => {
    const a = await freshStore();
    a.createAuthCode({
      clientId: "obsidian-mcp-railway",
      redirectUri: "https://claude.ai/cb",
      codeChallenge: "abc",
      codeChallengeMethod: "S256",
      scope: "mcp",
      ttlMs: -1000,
    });

    const b = await freshStore();
    // After reload, the expired code should not have been retained.
    const raw = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
      codes: unknown[];
    };
    // The first store still wrote the (already-expired) code, but the new
    // process should ignore it on load and clearExpired should rewrite the file.
    b.clearExpired();
    b.flushPersist();
    const after = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
      codes: unknown[];
    };
    expect(raw.codes.length).toBe(1);
    expect(after.codes.length).toBe(0);
  });

  it("starts empty when the store file does not exist", async () => {
    fs.rmSync(storeFile, { force: true });
    const s = await freshStore();
    const result = s.consumeAuthCode("nonexistent");
    expect(result).toBeNull();
  });

  it("coalesces a burst of mutations into a single fsync", async () => {
    const s = await freshStore();
    // Write the file once so we have a baseline mtime.
    s.revokeJti("seed");
    s.flushPersist();
    const baselineMtime = fs.statSync(storeFile).mtimeMs;

    // Burst of mutations — none should hit disk synchronously.
    for (let i = 0; i < 50; i++) {
      s.revokeJti(`burst-${i}`);
    }
    expect(fs.statSync(storeFile).mtimeMs).toBe(baselineMtime);

    // A single flush coalesces them into one write.
    s.flushPersist();
    const raw = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
      revoked: Array<{ jti: string }>;
    };
    expect(raw.revoked.map((r) => r.jti)).toContain("burst-49");
  });

  it("starts empty when the store file is corrupt JSON", async () => {
    fs.writeFileSync(storeFile, "{not valid json");
    const s = await freshStore();
    // Touching the store triggers ensureLoaded — must not throw.
    expect(s.consumeAuthCode("nope")).toBeNull();
  });

  it("starts empty when the store file has an unsupported version", async () => {
    fs.writeFileSync(storeFile, JSON.stringify({ version: 999 }));
    const s = await freshStore();
    expect(s.consumeAuthCode("nope")).toBeNull();
  });

  it("loads a v1 store file that omits the codes/revoked/issued arrays", async () => {
    // Older snapshots may have been written before the issued[] field existed.
    fs.writeFileSync(storeFile, JSON.stringify({ version: 1 }));
    const s = await freshStore();
    // No throw on load, and no entries surface.
    expect(s.consumeAuthCode("nope")).toBeNull();
    expect(s.listActiveTokens()).toEqual([]);
  });

  it("logs a warning but does not throw when persistence fails", async () => {
    // Point the store at a path under a regular file so mkdirSync/writeFileSync
    // both fail. The store must swallow the error and keep serving requests.
    const blocker = path.join(tmpDir, "blocker-file");
    fs.writeFileSync(blocker, "x");
    const badPath = path.join(blocker, "child", "store.json");
    const s = await freshStore({ storePathOverride: badPath });
    // Sanity: the override must actually be in effect for the assertion below
    // to mean anything. If freshStore ever silently resets the path, this trips.
    expect(process.env["OAUTH_STORE_PATH"]).toBe(badPath);
    expect(() => {
      s.revokeJti("will-fail-to-persist");
      s.flushPersist();
    }).not.toThrow();
    // The bad path must not have been created (nothing wrote successfully).
    expect(fs.existsSync(badPath)).toBe(false);
    // Restore for subsequent tests.
    process.env["OAUTH_STORE_PATH"] = storeFile;
  });

  it("evicts oldest revoked entries past the cap", async () => {
    const s = await freshStore();
    const cap = s._internals.REVOKED_CAP;
    const overflow = 25;
    const now = Date.now();
    // Insert cap+overflow entries with increasing expiresAt; oldest expiries
    // should be evicted first.
    for (let i = 0; i < cap + overflow; i++) {
      s.revokeJti(`jti-${i}`, now + i * 1000);
    }
    s.flushPersist();
    const raw = JSON.parse(fs.readFileSync(storeFile, "utf8")) as {
      revoked: Array<{ jti: string; expiresAt: number }>;
    };
    expect(raw.revoked.length).toBe(cap);
    const jtis = new Set(raw.revoked.map((r) => r.jti));
    // Earliest entries (smallest expiresAt) are dropped.
    expect(jtis.has("jti-0")).toBe(false);
    expect(jtis.has(`jti-${overflow - 1}`)).toBe(false);
    // Most recent entries are retained.
    expect(jtis.has(`jti-${cap + overflow - 1}`)).toBe(true);
  });
});
