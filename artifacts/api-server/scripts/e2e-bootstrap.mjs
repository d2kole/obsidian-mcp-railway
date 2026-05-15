#!/usr/bin/env node
/**
 * E2E webServer bootstrap.
 *
 * Creates an ephemeral bare git repo seeded with deterministic vault
 * content, points VAULT_REPO_URL at it, then exec's the api-server in
 * HTTP mode. Used by Playwright's webServer so the OAuth + MCP browser
 * flow can read real seeded notes without touching github.com.
 */
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");

const root = await mkdtemp(path.join(tmpdir(), "e2e-vault-"));
const bareDir = path.join(root, "remote.git");
const cacheDir = path.join(root, "cache");
await mkdir(bareDir, { recursive: true });
await mkdir(cacheDir, { recursive: true });

const branch = process.env.VAULT_BRANCH ?? "main";
const bare = simpleGit(bareDir);
await bare.init({ "--bare": null, "--initial-branch": branch });

// Seed an initial commit with deterministic content.
const seedDir = path.join(root, "seed");
await mkdir(seedDir, { recursive: true });
const seed = simpleGit(seedDir);
await seed.init({ "--initial-branch": branch });
await seed.addConfig("user.email", "e2e@obsidian-mcp-railway.local");
await seed.addConfig("user.name", "obsidian-mcp e2e");

const files = {
  "00-Inbox/welcome.md":
    "# E2E welcome note\n\nThis note is seeded by scripts/e2e-bootstrap.mjs and used\nby tests/e2e/oauth-mcp.spec.ts to assert the read_note tool works.\n",
  "00-Inbox/.gitkeep": "",
  "Journal/.gitkeep": "",
};
for (const [rel, contents] of Object.entries(files)) {
  const abs = path.join(seedDir, rel);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, contents, "utf8");
}
await seed.add(".");
await seed.commit("seed: e2e fixture content");
await seed.addRemote("origin", `file://${bareDir}`);
await seed.push("origin", branch, { "--set-upstream": null });

process.env.VAULT_REPO_URL = `file://${bareDir}`;
process.env.VAULT_BRANCH = branch;
process.env.VAULT_CACHE_DIR = cacheDir;
// Prefer caller-provided OAuth env, but fall back to deterministic defaults.
process.env.OAUTH_STORE_PATH ??= path.join(root, "oauth-store.json");

const cleanup = async () => {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    // best-effort
  }
};

const child = spawn(
  "node",
  ["--enable-source-maps", path.join(pkgRoot, "dist", "index.mjs"), "http"],
  { stdio: "inherit", env: process.env, cwd: pkgRoot },
);

const forward = (sig) => {
  if (!child.killed) child.kill(sig);
};
process.on("SIGINT", () => forward("SIGINT"));
process.on("SIGTERM", () => forward("SIGTERM"));

child.on("exit", async (code, signal) => {
  await cleanup();
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
