import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeBareRepo, seedBareRepo, type BareRepo } from "../fixtures/git";

interface BootedVault {
  svc: import("../../src/vault/service").VaultService;
  VaultError: typeof import("../../src/vault/service").VaultError;
}

interface BootOptions {
  remoteUrl: string;
  cacheDir: string;
  branch?: string;
  pat?: string;
  init?: boolean;
}

async function bootVault(opts: BootOptions): Promise<BootedVault> {
  vi.resetModules();
  vi.stubEnv("VAULT_REPO_URL", opts.remoteUrl);
  vi.stubEnv("GITHUB_PAT", opts.pat ?? "test-pat-not-used-by-file-transport");
  vi.stubEnv("VAULT_CACHE_DIR", opts.cacheDir);
  vi.stubEnv("VAULT_BRANCH", opts.branch ?? "main");
  vi.stubEnv(
    "OAUTH_STORE_PATH",
    path.join(opts.cacheDir, ".oauth-store-test.json"),
  );
  vi.stubEnv("OBSIDIAN_WRITE_PATHS", "00-Inbox,Journal");
  vi.stubEnv("MAX_WRITES_PER_HOUR", "20");

  const config = await import("../../src/lib/config");
  // Use stdio mode so OAuth secrets aren't required.
  config.loadConfig("stdio");

  const svcMod = await import("../../src/vault/service");
  const svc = new svcMod.VaultService();
  if (opts.init !== false) {
    await svc.init();
  }
  return { svc, VaultError: svcMod.VaultError };
}

describe("VaultService — git-backed integration", () => {
  let bare: BareRepo;
  let cacheDir: string;
  let scratchRoot: string;

  beforeEach(async () => {
    scratchRoot = await mkdtemp(path.join(tmpdir(), "vault-cache-test-"));
    cacheDir = path.join(scratchRoot, "vault-cache");
    bare = await makeBareRepo();
    await seedBareRepo(
      bare,
      {
        "README.md": "# vault\n",
        "00-Inbox/welcome.md": "# welcome\n",
      },
      "initial seed",
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(scratchRoot, { recursive: true, force: true });
    await bare.cleanup();
  });

  describe("init()", () => {
    it("clones the remote into an empty cache dir on first boot", async () => {
      expect(existsSync(cacheDir)).toBe(false);
      await bootVault({ remoteUrl: bare.url, cacheDir });
      expect(existsSync(path.join(cacheDir, ".git"))).toBe(true);
      const seeded = await readFile(
        path.join(cacheDir, "00-Inbox/welcome.md"),
        "utf8",
      );
      expect(seeded).toContain("welcome");
    });

    it("reuses an existing clone on subsequent boots (no re-clone)", async () => {
      await bootVault({ remoteUrl: bare.url, cacheDir });
      // Drop a sentinel file inside the working tree that re-cloning would erase.
      const sentinel = path.join(cacheDir, ".sentinel");
      await writeFile(sentinel, "keep me", "utf8");
      const before = (await stat(sentinel)).mtimeMs;

      await bootVault({ remoteUrl: bare.url, cacheDir });
      expect(existsSync(sentinel)).toBe(true);
      const after = (await stat(sentinel)).mtimeMs;
      expect(after).toBe(before);
    });

    it("re-clones when the working copy is corrupt (.git missing)", async () => {
      await bootVault({ remoteUrl: bare.url, cacheDir });
      // Simulate a corrupt working copy by ripping out .git.
      await rm(path.join(cacheDir, ".git"), { recursive: true, force: true });
      expect(existsSync(path.join(cacheDir, ".git"))).toBe(false);

      await bootVault({ remoteUrl: bare.url, cacheDir });
      expect(existsSync(path.join(cacheDir, ".git"))).toBe(true);
      // Seeded file is back.
      const seeded = await readFile(
        path.join(cacheDir, "00-Inbox/welcome.md"),
        "utf8",
      );
      expect(seeded).toContain("welcome");
    });
  });

  describe("sync()", () => {
    it("fast-forwards to a commit pushed by another writer", async () => {
      const { svc } = await bootVault({ remoteUrl: bare.url, cacheDir });

      const other = await bare.freshWorkingClone();
      await other.commitAndPush(
        { "00-Inbox/from-other.md": "# from other\n" },
        "external write",
      );

      await svc.sync(true);
      const pulled = await readFile(
        path.join(cacheDir, "00-Inbox/from-other.md"),
        "utf8",
      );
      expect(pulled).toContain("from other");
    });

    it("surfaces a descriptive VaultError when --ff-only would conflict", async () => {
      const { svc, VaultError } = await bootVault({
        remoteUrl: bare.url,
        cacheDir,
      });

      // Make a divergent commit on the remote via an external writer.
      const other = await bare.freshWorkingClone();
      await other.commitAndPush(
        { "00-Inbox/welcome.md": "# welcome — remote edit\n" },
        "remote divergent edit",
      );

      // Make a conflicting local commit on top of the original base.
      await writeFile(
        path.join(cacheDir, "00-Inbox/welcome.md"),
        "# welcome — local edit\n",
        "utf8",
      );
      await svc.commitAndPush("local divergent edit").catch(() => {
        /* push will fail because of divergence; we expect that and ignore. */
      });

      await expect(svc.sync(true)).rejects.toMatchObject({
        name: "VaultError",
        message: expect.stringContaining("git pull failed"),
      });
      // The error names the failing operation in its message.
      await svc.sync(true).catch((err) => {
        expect(err).toBeInstanceOf(VaultError);
        expect(err.hint).toMatch(/GITHUB_PAT|read access/);
      });
    });
  });

  describe("commitAndPush()", () => {
    it("produces a single commit with the supplied message and lands it on the remote", async () => {
      const { svc } = await bootVault({ remoteUrl: bare.url, cacheDir });

      await svc.writeFile("00-Inbox/new.md", "# new note\n");
      const sha = await svc.commitAndPush("add new note");
      expect(sha).toMatch(/^[0-9a-f]{7,40}$/);

      // Verify by cloning the bare repo into a fresh dir and inspecting log + file.
      const verify = await bare.freshWorkingClone();
      const log = await verify.git.log();
      expect(log.latest?.message).toBe("add new note");
      expect(log.all.length).toBe(2); // seed + new note

      const fromRemote = await readFile(
        path.join(verify.dir, "00-Inbox/new.md"),
        "utf8",
      );
      expect(fromRemote).toContain("new note");
    });

    it("returns null and creates no commit when the working tree is clean", async () => {
      const { svc } = await bootVault({ remoteUrl: bare.url, cacheDir });
      const sha = await svc.commitAndPush("noop");
      expect(sha).toBeNull();
    });
  });

  describe("dryRunFetch()", () => {
    it("returns an error that names the failing operation when the remote disappears", async () => {
      const { svc } = await bootVault({ remoteUrl: bare.url, cacheDir });

      // Move the bare repo so the remote URL no longer resolves.
      const moved = bare.bareDir + ".moved";
      await mkdir(path.dirname(moved), { recursive: true });
      const fs = await import("node:fs/promises");
      await fs.rename(bare.bareDir, moved);

      try {
        await expect(svc.dryRunFetch()).rejects.toThrow(/fetch|repository|not.*found/i);
      } finally {
        await fs.rename(moved, bare.bareDir);
      }
    });
  });

  describe("missing PAT", () => {
    it("loadConfig surfaces a descriptive error naming the missing variable", async () => {
      vi.resetModules();
      vi.stubEnv("VAULT_REPO_URL", bare.url);
      vi.stubEnv("VAULT_CACHE_DIR", cacheDir);
      // Intentionally clear GITHUB_PAT.
      vi.stubEnv("GITHUB_PAT", "");

      const config = await import("../../src/lib/config");
      expect(() => config.loadConfig("stdio")).toThrow(
        /Missing required environment variable: GITHUB_PAT/,
      );
    });
  });

  describe("readFile / writeFile / deleteFile / moveFile", () => {
    it("round-trips content through the working tree", async () => {
      const { svc } = await bootVault({ remoteUrl: bare.url, cacheDir });
      await svc.writeFile("00-Inbox/a.md", "first\n");
      expect(await svc.readFile("00-Inbox/a.md")).toBe("first\n");

      await svc.moveFile("00-Inbox/a.md", "Journal/a.md");
      expect(await svc.readFile("Journal/a.md")).toBe("first\n");

      await svc.deleteFile("Journal/a.md");
      await expect(svc.readFile("Journal/a.md")).rejects.toThrow(
        /Note not found/,
      );
    });

    it("listMarkdown and listDir respect the cache root", async () => {
      const { svc } = await bootVault({ remoteUrl: bare.url, cacheDir });
      const all = await svc.listMarkdown();
      expect(all).toContain("00-Inbox/welcome.md");
      expect(all).toContain("README.md");

      const root = await svc.listDir();
      expect(root.dirs).toContain("00-Inbox");
      expect(root.files).toContain("README.md");
    });

    it("createDirectory writes a .gitkeep under an allowed path", async () => {
      const { svc } = await bootVault({ remoteUrl: bare.url, cacheDir });
      await svc.createDirectory("Journal/2026");
      expect(existsSync(path.join(cacheDir, "Journal/2026/.gitkeep"))).toBe(
        true,
      );
    });
  });

  describe("exists / listMarkdown subdir / deleteFile errors", () => {
    it("exists() reports presence and absence", async () => {
      const { svc } = await bootVault({ remoteUrl: bare.url, cacheDir });
      expect(await svc.exists("00-Inbox/welcome.md")).toBe(true);
      expect(await svc.exists("00-Inbox/missing.md")).toBe(false);
    });

    it("listMarkdown(subdir) restricts the walk to the given folder", async () => {
      const { svc } = await bootVault({ remoteUrl: bare.url, cacheDir });
      await svc.writeFile("Journal/2026-05-15.md", "# day\n");
      const inbox = await svc.listMarkdown("00-Inbox");
      expect(inbox).toContain("welcome.md");
      expect(inbox).not.toContain("README.md");
      const journal = await svc.listMarkdown("Journal");
      expect(journal).toContain("2026-05-15.md");
    });

    it("listDir(subdir) reads a nested folder", async () => {
      const { svc } = await bootVault({ remoteUrl: bare.url, cacheDir });
      const sub = await svc.listDir("00-Inbox");
      expect(sub.files).toContain("welcome.md");
    });

    it("deleteFile throws Note not found for missing files", async () => {
      const { svc } = await bootVault({ remoteUrl: bare.url, cacheDir });
      await expect(svc.deleteFile("00-Inbox/nope.md")).rejects.toThrow(
        /Note not found/,
      );
    });

    it("createDirectory does not overwrite an existing .gitkeep", async () => {
      const { svc } = await bootVault({ remoteUrl: bare.url, cacheDir });
      await svc.createDirectory("Journal/2026");
      await writeFile(
        path.join(cacheDir, "Journal/2026/.gitkeep"),
        "preserve",
        "utf8",
      );
      await svc.createDirectory("Journal/2026");
      const kept = await readFile(
        path.join(cacheDir, "Journal/2026/.gitkeep"),
        "utf8",
      );
      expect(kept).toBe("preserve");
    });

    it("getCacheDir and getWritePaths expose configured values", async () => {
      const { svc } = await bootVault({ remoteUrl: bare.url, cacheDir });
      expect(svc.getCacheDir()).toBe(cacheDir);
      expect(svc.getWritePaths()).toEqual(["00-Inbox", "Journal"]);
    });
  });

  describe("ensureInit()", () => {
    it("rejects calls before init() with a hint about /api/healthz", async () => {
      const { svc, VaultError } = await bootVault({
        remoteUrl: bare.url,
        cacheDir,
        init: false,
      });
      expect(() => svc.resolveSafePath("00-Inbox/x.md")).toThrow(VaultError);
      try {
        svc.resolveSafePath("00-Inbox/x.md");
      } catch (err) {
        expect((err as InstanceType<typeof VaultError>).hint).toMatch(
          /healthz/,
        );
      }
    });
  });
});
