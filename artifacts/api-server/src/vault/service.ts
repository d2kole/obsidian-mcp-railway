import path from "node:path";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { simpleGit, type SimpleGit } from "simple-git";
import { logger } from "../lib/logger";
import { getConfig } from "../lib/config";
import { redactError, redactSecrets } from "../lib/redact";
import { VaultError } from "./errors";
import {
  assertNoSymlinkEscape,
  assertWriteAllowed as assertWriteAllowedPure,
  isWriteAllowed as isWriteAllowedPure,
  resolveSafePath as resolveSafePathPure,
} from "./write-path";

export { VaultError } from "./errors";

export class VaultService {
  private git: SimpleGit | null = null;
  private cacheDir = "";
  private repoUrl = "";
  private branch = "main";
  private writePaths: string[] = [];
  private initialized = false;
  private lastSyncMs = 0;
  // Pull before every read per spec; no throttle by default. Set VAULT_SYNC_MIN_INTERVAL_MS to throttle in dev.
  private readonly minSyncIntervalMs = Number(process.env["VAULT_SYNC_MIN_INTERVAL_MS"] ?? 0);

  async init(): Promise<void> {
    const cfg = getConfig();
    this.cacheDir = cfg.vault.cacheDir;
    this.branch = cfg.vault.branch;
    this.writePaths = cfg.vault.writePaths;

    const url = new URL(cfg.vault.repoUrl);
    url.username = "x-access-token";
    url.password = cfg.vault.githubPat;
    this.repoUrl = url.toString();

    await fs.mkdir(this.cacheDir, { recursive: true });

    const gitDir = path.join(this.cacheDir, ".git");
    if (!existsSync(gitDir)) {
      // If the cache dir has orphan files but no .git, the working copy is
      // corrupt (manual edit, half-deleted, etc.). Clear it so the clone
      // can land — there's no valid history to preserve here anyway.
      const entries = await fs.readdir(this.cacheDir).catch(() => [] as string[]);
      if (entries.length > 0) {
        logger.warn(
          { cacheDir: this.cacheDir, orphanCount: entries.length },
          "Vault cache has orphan files but no .git, wiping before re-clone",
        );
        for (const name of entries) {
          await fs.rm(path.join(this.cacheDir, name), {
            recursive: true,
            force: true,
          });
        }
      }
      logger.info(
        { cacheDir: this.cacheDir, branch: this.branch },
        "Vault cache empty, cloning from GitHub",
      );
      const tempGit = simpleGit();
      try {
        await tempGit.clone(this.repoUrl, this.cacheDir, [
          "--branch",
          this.branch,
          "--single-branch",
        ]);
      } catch (err) {
        logger.error({ err: redactError(err) }, "Vault clone failed");
        throw new Error(redactSecrets("Vault clone failed. See logs for details."));
      }
      logger.info("Vault clone complete");
    }

    this.git = simpleGit(this.cacheDir);
    await this.git.addConfig("user.email", "obsidian-mcp@railway.local");
    await this.git.addConfig("user.name", "obsidian-mcp-railway");
    await this.git.remote(["set-url", "origin", this.repoUrl]);

    this.initialized = true;
    logger.info("VaultService initialized");
  }

  private ensureInit(): void {
    if (!this.initialized || !this.git) {
      throw new VaultError(
        "Vault service is not initialized.",
        "Wait for server startup to complete or check /api/healthz for git/PAT errors.",
      );
    }
  }

  async sync(force = false): Promise<void> {
    this.ensureInit();
    const now = Date.now();
    if (!force && now - this.lastSyncMs < this.minSyncIntervalMs) {
      return;
    }
    try {
      await this.git!.pull("origin", this.branch, ["--ff-only"]);
      this.lastSyncMs = now;
    } catch (err) {
      const raw = redactError(err);
      logger.warn({ err: raw }, "git pull failed");
      // Distinguish a divergence/non-fast-forward conflict from auth/network
      // errors so the operator gets a useful next-action hint.
      if (
        /not possible to fast-forward|non-fast-forward|diverged|unrelated histories|would clobber/i.test(
          raw,
        )
      ) {
        throw new VaultError(
          "git pull failed: local and remote have diverged (not a fast-forward).",
          "Resolve the conflict by rebasing or resetting the cache (e.g. delete /vault-cache and let the server re-clone), then retry. See server logs for the redacted git output.",
        );
      }
      throw new VaultError(
        "git pull failed.",
        "Check that GITHUB_PAT is valid and has read access to VAULT_REPO_URL. See server logs for redacted details.",
      );
    }
  }

  async dryRunFetch(): Promise<void> {
    this.ensureInit();
    try {
      await this.git!.raw(["fetch", "--dry-run", "origin", this.branch]);
    } catch (err) {
      throw new Error(redactError(err));
    }
  }

  async commitAndPush(message: string): Promise<string | null> {
    this.ensureInit();
    const status = await this.git!.status();
    if (status.isClean()) {
      return null;
    }
    await this.git!.add(["-A"]);
    const commit = await this.git!.commit(message);
    try {
      await this.git!.push("origin", this.branch);
    } catch (err) {
      logger.warn({ err: redactError(err) }, "git push failed");
      throw new VaultError(
        "git push failed.",
        "Check that GITHUB_PAT has write access (contents: write) to VAULT_REPO_URL. See server logs for redacted details.",
      );
    }
    return commit.commit;
  }

  resolveSafePath(relPath: string): string {
    this.ensureInit();
    return resolveSafePathPure(this.cacheDir, relPath);
  }

  isWriteAllowed(relPath: string): boolean {
    return isWriteAllowedPure(relPath, this.writePaths);
  }

  assertWriteAllowed(relPath: string): void {
    assertWriteAllowedPure(relPath, this.writePaths);
  }

  getCacheDir(): string {
    return this.cacheDir;
  }

  getWritePaths(): string[] {
    return [...this.writePaths];
  }

  async readFile(relPath: string): Promise<string> {
    const abs = this.resolveSafePath(relPath);
    try {
      return await fs.readFile(abs, "utf8");
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new VaultError(
          `Note not found: "${relPath}".`,
          "Check the path with list_notes or search_vault, or create the note with write_note.",
        );
      }
      throw new VaultError(`Failed to read "${relPath}": ${e.message}`);
    }
  }

  async writeFile(relPath: string, content: string): Promise<void> {
    this.assertWriteAllowed(relPath);
    const abs = this.resolveSafePath(relPath);
    await assertNoSymlinkEscape(this.cacheDir, abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf8");
  }

  async deleteFile(relPath: string): Promise<void> {
    this.assertWriteAllowed(relPath);
    const abs = this.resolveSafePath(relPath);
    await assertNoSymlinkEscape(this.cacheDir, abs);
    try {
      await fs.unlink(abs);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") {
        throw new VaultError(`Note not found: "${relPath}".`);
      }
      throw new VaultError(`Failed to delete "${relPath}": ${e.message}`);
    }
  }

  async moveFile(fromPath: string, toPath: string): Promise<void> {
    this.assertWriteAllowed(fromPath);
    this.assertWriteAllowed(toPath);
    const absFrom = this.resolveSafePath(fromPath);
    const absTo = this.resolveSafePath(toPath);
    await assertNoSymlinkEscape(this.cacheDir, absFrom);
    await assertNoSymlinkEscape(this.cacheDir, absTo);
    await fs.mkdir(path.dirname(absTo), { recursive: true });
    await fs.rename(absFrom, absTo);
  }

  async exists(relPath: string): Promise<boolean> {
    const abs = this.resolveSafePath(relPath);
    return existsSync(abs);
  }

  async listMarkdown(subdir?: string): Promise<string[]> {
    this.ensureInit();
    const root = subdir
      ? this.resolveSafePath(subdir)
      : this.cacheDir;
    const out: string[] = [];
    await this.walk(root, root, out, true);
    return out.sort();
  }

  async listDir(subdir?: string): Promise<{ files: string[]; dirs: string[] }> {
    const root = subdir ? this.resolveSafePath(subdir) : this.cacheDir;
    const entries = await fs.readdir(root, { withFileTypes: true });
    const files: string[] = [];
    const dirs: string[] = [];
    for (const e of entries) {
      if (e.name === ".git" || e.name === ".obsidian") continue;
      if (e.isDirectory()) dirs.push(e.name);
      else files.push(e.name);
    }
    return { files: files.sort(), dirs: dirs.sort() };
  }

  async createDirectory(relPath: string): Promise<void> {
    this.assertWriteAllowed(relPath);
    const abs = this.resolveSafePath(relPath);
    await assertNoSymlinkEscape(this.cacheDir, abs);
    await fs.mkdir(abs, { recursive: true });
    const keep = path.join(abs, ".gitkeep");
    if (!existsSync(keep)) {
      await fs.writeFile(keep, "", "utf8");
    }
  }

  private async walk(
    rootDir: string,
    current: string,
    out: string[],
    mdOnly: boolean,
  ): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === ".git" || e.name === ".obsidian") continue;
      const abs = path.join(current, e.name);
      if (e.isDirectory()) {
        await this.walk(rootDir, abs, out, mdOnly);
      } else {
        if (!mdOnly || e.name.endsWith(".md")) {
          out.push(path.relative(rootDir, abs).replace(/\\/g, "/"));
        }
      }
    }
  }
}

export const vaultService = new VaultService();
