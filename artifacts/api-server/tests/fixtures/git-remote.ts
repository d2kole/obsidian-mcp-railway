import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

export interface EphemeralRemote {
  /** Absolute path to the bare repo directory. */
  dir: string;
  /** file:// URL suitable for `git clone` / VaultService config. */
  url: string;
  /** Default branch name (matches what VaultService expects). */
  branch: string;
  /**
   * Seed the remote with an initial commit on `branch`. Files are written
   * relative to a fresh working tree, then pushed up to the bare repo.
   * Returns the working-tree path so callers can keep mutating if they want.
   */
  seed(files: Record<string, string>, message?: string): Promise<string>;
  /** Recursively delete the bare repo and any working trees created via seed(). */
  cleanup(): Promise<void>;
}

export interface CreateEphemeralRemoteOptions {
  branch?: string;
  prefix?: string;
}

/**
 * Initialize a bare git repo in a temp directory and return helpers for
 * pushing seed commits to it. Used by VaultService write-flow tests so we
 * never touch the real GitHub vault.
 */
export async function createEphemeralRemote(
  opts: CreateEphemeralRemoteOptions = {},
): Promise<EphemeralRemote> {
  const branch = opts.branch ?? "main";
  const prefix = opts.prefix ?? "obsidian-mcp-remote-";
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const bareDir = path.join(root, "remote.git");
  await mkdir(bareDir, { recursive: true });

  const bare: SimpleGit = simpleGit(bareDir);
  await bare.init({ "--bare": null, "--initial-branch": branch });

  const url = `file://${bareDir}`;
  const workTrees: string[] = [];

  return {
    dir: bareDir,
    url,
    branch,
    async seed(files, message = "seed") {
      const work = await mkdtemp(path.join(root, "work-"));
      workTrees.push(work);
      const wg: SimpleGit = simpleGit(work);
      await wg.init({ "--initial-branch": branch });
      await wg.addConfig("user.email", "tests@obsidian-mcp-railway.local");
      await wg.addConfig("user.name", "obsidian-mcp tests");

      for (const [rel, contents] of Object.entries(files)) {
        const abs = path.join(work, rel);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, contents, "utf8");
      }

      await wg.add(".");
      await wg.commit(message);
      await wg.addRemote("origin", url);
      await wg.push("origin", branch, { "--set-upstream": null });
      return work;
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
