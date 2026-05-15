import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Config-level fail-closed proof: when OBSIDIAN_WRITE_PATHS is unset
 * or set to an empty string, loadConfig() returns an empty writePaths
 * list so VaultService rejects every write at the boundary. Lives in
 * its own file (not src/test/env.ts which seeds defaults) so we can
 * stub a clean process.env per case.
 */
describe("loadConfig — OBSIDIAN_WRITE_PATHS fail-closed", () => {
  const ORIGINAL = process.env;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL,
      VAULT_REPO_URL: "https://github.com/example/vault.git",
      GITHUB_PAT: "ghp_supersecretpattokenvalue1234567890",
      OAUTH_CLIENT_ID: "obsidian-mcp-railway",
      OAUTH_CLIENT_SECRET: "test-client-secret-12345678",
      SESSION_ENCRYPTION_KEY: "test-session-encryption-key-32chars!!",
      PERSONAL_AUTH_TOKEN: "test-personal-auth-token",
      BASE_URL: "http://localhost:3000",
      OAUTH_ALLOWED_REDIRECT_PREFIXES:
        "https://claude.ai/,http://localhost:8080/cb",
      MAX_WRITES_PER_HOUR: "3",
      VAULT_CACHE_DIR: "/tmp/vault-cache-test",
    };
    delete process.env["OBSIDIAN_WRITE_PATHS"];
  });

  afterEach(() => {
    process.env = ORIGINAL;
  });

  async function freshLoadConfig() {
    // Reset the module graph so the in-module `cached` singleton does
    // not leak between cases.
    vi.resetModules();
    const mod = await import("./config");
    return mod.loadConfig("http");
  }

  it("returns an empty writePaths list when OBSIDIAN_WRITE_PATHS is unset", async () => {
    const cfg = await freshLoadConfig();
    expect(cfg.vault.writePaths).toEqual([]);
  });

  it("returns an empty writePaths list when OBSIDIAN_WRITE_PATHS is the empty string", async () => {
    process.env["OBSIDIAN_WRITE_PATHS"] = "";
    const cfg = await freshLoadConfig();
    expect(cfg.vault.writePaths).toEqual([]);
  });

  it("returns an empty writePaths list when OBSIDIAN_WRITE_PATHS is whitespace-only entries", async () => {
    process.env["OBSIDIAN_WRITE_PATHS"] = "  , ,";
    const cfg = await freshLoadConfig();
    expect(cfg.vault.writePaths).toEqual([]);
  });

  it("returns the configured paths when OBSIDIAN_WRITE_PATHS is set", async () => {
    process.env["OBSIDIAN_WRITE_PATHS"] = "00-Inbox,Journal";
    const cfg = await freshLoadConfig();
    expect(cfg.vault.writePaths).toEqual(["00-Inbox", "Journal"]);
  });
});
