import "../test/env";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oauth-store-test-"));
const storeFile = path.join(tmpDir, "oauth-store.json");
process.env["OAUTH_STORE_PATH"] = storeFile;

async function freshStore(): Promise<typeof import("./store")> {
  const mod = await import("./store");
  mod._resetStoreForTests();
  process.env["OAUTH_STORE_PATH"] = storeFile;
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
});
