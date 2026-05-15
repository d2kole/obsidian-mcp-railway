import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";

/**
 * Task #7's preferred fixture surface (`makeBareRepo` + `seedBareRepo`).
 *
 * Internally this layers on top of the lower-level `git-remote.ts` helper
 * shipped in Task #6. New VaultService tests should import from this file;
 * legacy callers can keep using `git-remote.ts` directly.
 */

export interface BareRepo {
  /** Absolute path to the bare repo directory. */
  bareDir: string;
  /** file:// URL safe to pass to `git clone` / VaultService. */
  url: string;
  /** Default branch name. */
  branch: string;
  /** Recursively delete the bare repo, working trees, and the parent tmp dir. */
  cleanup(): Promise<void>;
  /**
   * Open a fresh working clone of the bare repo. Useful when a test needs
   * to push a divergent commit to simulate a conflict.
   */
  freshWorkingClone(): Promise<WorkingClone>;
}

export interface WorkingClone {
  dir: string;
  git: SimpleGit;
  /** Commit a set of files (path -> contents) and push to the bare remote. */
  commitAndPush(files: Record<string, string>, message?: string): Promise<string>;
}

export interface MakeBareRepoOptions {
  branch?: string;
  prefix?: string;
}

/**
 * Initialize a bare repo in a fresh tmp dir. Returns the bare URL plus a
 * cleanup() that wipes everything created (bare repo, working clones, root).
 */
export async function makeBareRepo(
  opts: MakeBareRepoOptions = {},
): Promise<BareRepo> {
  const branch = opts.branch ?? "main";
  const prefix = opts.prefix ?? "obsidian-mcp-bare-";
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const bareDir = path.join(root, "remote.git");
  await mkdir(bareDir, { recursive: true });

  const bare: SimpleGit = simpleGit(bareDir);
  await bare.init({ "--bare": null, "--initial-branch": branch });

  const url = `file://${bareDir}`;

  return {
    bareDir,
    url,
    branch,
    async freshWorkingClone(): Promise<WorkingClone> {
      const work = await mkdtemp(path.join(root, "work-"));
      const wg: SimpleGit = simpleGit();
      await wg.clone(url, work, ["--branch", branch]);
      const wgInRepo = simpleGit(work);
      await wgInRepo.addConfig("user.email", "tests@obsidian-mcp-railway.local");
      await wgInRepo.addConfig("user.name", "obsidian-mcp tests");
      return {
        dir: work,
        git: wgInRepo,
        async commitAndPush(files, message = "test commit") {
          for (const [rel, contents] of Object.entries(files)) {
            const abs = path.join(work, rel);
            await mkdir(path.dirname(abs), { recursive: true });
            await writeFile(abs, contents, "utf8");
          }
          await wgInRepo.add(".");
          const c = await wgInRepo.commit(message);
          await wgInRepo.push("origin", branch);
          return c.commit;
        },
      };
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Seed an existing bare repo with an initial commit. Files are written into
 * a fresh working tree, committed, and pushed up. Returns the working tree
 * path so callers can keep using it if useful.
 */
export async function seedBareRepo(
  bare: BareRepo,
  files: Record<string, string>,
  message = "seed",
): Promise<string> {
  const root = path.dirname(bare.bareDir);
  const work = await mkdtemp(path.join(root, "seed-"));
  const wg: SimpleGit = simpleGit(work);
  await wg.init({ "--initial-branch": bare.branch });
  await wg.addConfig("user.email", "tests@obsidian-mcp-railway.local");
  await wg.addConfig("user.name", "obsidian-mcp tests");

  for (const [rel, contents] of Object.entries(files)) {
    const abs = path.join(work, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, contents, "utf8");
  }

  await wg.add(".");
  await wg.commit(message);
  await wg.addRemote("origin", bare.url);
  await wg.push("origin", bare.branch, { "--set-upstream": null });
  return work;
}
