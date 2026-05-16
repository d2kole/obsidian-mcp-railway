import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeBareRepo, seedBareRepo, type BareRepo } from "../fixtures/git";

const GIT_INTEGRATION_TIMEOUT = process.platform === "win32" ? 20_000 : 8_000;

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

/**
 * Tests that share an initialized vault. We use beforeAll to clone once and
 * keep wall-clock time well under the 10s spec target.
 */
describe("VaultService — shared initialized vault", () => {
  let bare: BareRepo;
  let cacheDir: string;
  let scratchRoot: string;
  let svc: BootedVault["svc"];
  let VaultError: BootedVault["VaultError"];

  beforeAll(async () => {
    scratchRoot = await mkdtemp(path.join(tmpdir(), "vault-shared-"));
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
    ({ svc, VaultError } = await bootVault({ remoteUrl: bare.url, cacheDir }));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(scratchRoot, { recursive: true, force: true });
    await bare.cleanup();
  });

  it("listMarkdown returns the seeded files", async () => {
    const all = await svc.listMarkdown();
    expect(all).toContain("00-Inbox/welcome.md");
    expect(all).toContain("README.md");
  });

  it("listDir returns root files and dirs (excluding .git)", async () => {
    const root = await svc.listDir();
    expect(root.dirs).toContain("00-Inbox");
    expect(root.files).toContain("README.md");
    expect(root.dirs).not.toContain(".git");
  });

  it("exists() reports presence and absence", async () => {
    expect(await svc.exists("00-Inbox/welcome.md")).toBe(true);
    expect(await svc.exists("00-Inbox/missing.md")).toBe(false);
  });

  it("listDir(subdir) reads a nested folder", async () => {
    const sub = await svc.listDir("00-Inbox");
    expect(sub.files).toContain("welcome.md");
  });

  it("getCacheDir and getWritePaths expose configured values", () => {
    expect(svc.getCacheDir()).toBe(cacheDir);
    expect(svc.getWritePaths()).toEqual(["00-Inbox", "Journal"]);
  });

  it("commitAndPush returns null when the working tree is clean", async () => {
    const sha = await svc.commitAndPush("noop");
    expect(sha).toBeNull();
  });

  it("read / write / delete / move round-trip through the working tree", async () => {
    await svc.writeFile("00-Inbox/round-trip.md", "first\n");
    expect(await svc.readFile("00-Inbox/round-trip.md")).toBe("first\n");

    await svc.moveFile("00-Inbox/round-trip.md", "Journal/round-trip.md");
    expect(await svc.readFile("Journal/round-trip.md")).toBe("first\n");

    await svc.deleteFile("Journal/round-trip.md");
    await expect(svc.readFile("Journal/round-trip.md")).rejects.toThrow(
      /Note not found/,
    );
  });

  it("deleteFile throws Note not found for missing files", async () => {
    await expect(svc.deleteFile("00-Inbox/never.md")).rejects.toThrow(
      /Note not found/,
    );
  });

  it("listMarkdown(subdir) restricts the walk to the given folder", async () => {
    await svc.writeFile("Journal/2026-05-15.md", "# day\n");
    const inbox = await svc.listMarkdown("00-Inbox");
    expect(inbox).toContain("welcome.md");
    expect(inbox).not.toContain("README.md");
    const journal = await svc.listMarkdown("Journal");
    expect(journal).toContain("2026-05-15.md");
  });

  it("createDirectory writes a .gitkeep under an allowed path", async () => {
    await svc.createDirectory("Journal/sub");
    expect(existsSync(path.join(cacheDir, "Journal/sub/.gitkeep"))).toBe(true);
  });

  it("createDirectory does not overwrite an existing .gitkeep", async () => {
    await svc.createDirectory("Journal/keep");
    await writeFile(
      path.join(cacheDir, "Journal/keep/.gitkeep"),
      "preserve",
      "utf8",
    );
    await svc.createDirectory("Journal/keep");
    const kept = await readFile(
      path.join(cacheDir, "Journal/keep/.gitkeep"),
      "utf8",
    );
    expect(kept).toBe("preserve");
  });

  it(
    "commitAndPush produces a single commit with the supplied message and lands it on the remote",
    async () => {
      await svc.writeFile("00-Inbox/landed.md", "# landed\n");
      const sha = await svc.commitAndPush("add landed note");
      expect(sha).toMatch(/^[0-9a-f]{7,40}$/);

      const verify = await bare.freshWorkingClone();
      const log = await verify.git.log();
      expect(log.latest?.message).toBe("add landed note");
      const fromRemote = await readFile(
        path.join(verify.dir, "00-Inbox/landed.md"),
        "utf8",
      );
      expect(fromRemote).toContain("landed");
    },
    GIT_INTEGRATION_TIMEOUT,
  );

  it(
    "sync() fast-forwards to a commit pushed by another writer",
    async () => {
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
    },
    GIT_INTEGRATION_TIMEOUT,
  );

  it("ensureInit() rejects calls before init() with a hint about /api/healthz", async () => {
    // Build an uninitialized instance from the same module — no clone needed.
    const svcMod = await import("../../src/vault/service");
    const fresh = new svcMod.VaultService();
    expect(() => fresh.resolveSafePath("00-Inbox/x.md")).toThrow(VaultError);
    try {
      fresh.resolveSafePath("00-Inbox/x.md");
    } catch (err) {
      expect((err as InstanceType<typeof VaultError>).hint).toMatch(/healthz/);
    }
  });
});

/**
 * Tests that need a fresh init / their own remote because they mutate
 * lifecycle state (clone, conflict, missing remote, missing PAT).
 */
describe("VaultService — isolated lifecycle behaviors", () => {
  let bare: BareRepo;
  let cacheDir: string;
  let scratchRoot: string;

  beforeAll(async () => {
    // Per-suite scratch root so afterEach cleanups stay scoped.
    scratchRoot = await mkdtemp(path.join(tmpdir(), "vault-iso-"));
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(scratchRoot, { recursive: true, force: true });
  });

  async function freshSetup() {
    cacheDir = await mkdtemp(path.join(scratchRoot, "cache-"));
    await rm(cacheDir, { recursive: true, force: true });
    bare = await makeBareRepo();
    await seedBareRepo(
      bare,
      {
        "README.md": "# vault\n",
        "00-Inbox/welcome.md": "# welcome\n",
      },
      "initial seed",
    );
  }

  afterEach(async () => {
    if (bare) await bare.cleanup();
  });

  it(
    "init() clones the remote into an empty cache dir on first boot",
    async () => {
      await freshSetup();
      expect(existsSync(cacheDir)).toBe(false);
      await bootVault({ remoteUrl: bare.url, cacheDir });
      expect(existsSync(path.join(cacheDir, ".git"))).toBe(true);
      const seeded = await readFile(
        path.join(cacheDir, "00-Inbox/welcome.md"),
        "utf8",
      );
      expect(seeded).toContain("welcome");
    },
    GIT_INTEGRATION_TIMEOUT,
  );

  it(
    "init() reuses an existing clone on subsequent boots (no re-clone)",
    async () => {
      await freshSetup();
      await bootVault({ remoteUrl: bare.url, cacheDir });
      const sentinel = path.join(cacheDir, ".sentinel");
      await writeFile(sentinel, "keep me", "utf8");

      await bootVault({ remoteUrl: bare.url, cacheDir });
      expect(existsSync(sentinel)).toBe(true);
      expect(await readFile(sentinel, "utf8")).toBe("keep me");
    },
    GIT_INTEGRATION_TIMEOUT,
  );

  it(
    "init() re-clones when the working copy is corrupt (.git missing)",
    async () => {
      await freshSetup();
      await bootVault({ remoteUrl: bare.url, cacheDir });
      await rm(path.join(cacheDir, ".git"), { recursive: true, force: true });
      expect(existsSync(path.join(cacheDir, ".git"))).toBe(false);

      await bootVault({ remoteUrl: bare.url, cacheDir });
      expect(existsSync(path.join(cacheDir, ".git"))).toBe(true);
      const seeded = await readFile(
        path.join(cacheDir, "00-Inbox/welcome.md"),
        "utf8",
      );
      expect(seeded).toContain("welcome");
    },
    GIT_INTEGRATION_TIMEOUT,
  );

  it(
    "sync() throws a conflict-specific VaultError when --rebase hits a content conflict",
    async () => {
      await freshSetup();
      const { svc, VaultError } = await bootVault({
        remoteUrl: bare.url,
        cacheDir,
      });

      const other = await bare.freshWorkingClone();
      await other.commitAndPush(
        { "00-Inbox/welcome.md": "# welcome — remote edit\n" },
        "remote divergent edit",
      );

      await writeFile(
        path.join(cacheDir, "00-Inbox/welcome.md"),
        "# welcome — local edit\n",
        "utf8",
      );
      await svc.commitAndPush("local divergent edit").catch(() => {});

      await expect(svc.sync(true)).rejects.toMatchObject({
        name: "VaultError",
        message: expect.stringMatching(/conflict|rebase/i),
      });
      await svc.sync(true).catch((err) => {
        expect(err).toBeInstanceOf(VaultError);
        expect((err as InstanceType<typeof VaultError>).hint).toMatch(
          /rebas|reset|re-clone|cache/i,
        );
      });
    },
    GIT_INTEGRATION_TIMEOUT,
  );

  it(
    "dryRunFetch() surfaces an error that names the failing operation when the remote disappears",
    async () => {
      await freshSetup();
      const { svc } = await bootVault({ remoteUrl: bare.url, cacheDir });

      const moved = bare.bareDir + ".moved";
      await mkdir(path.dirname(moved), { recursive: true });
      const fs = await import("node:fs/promises");
      await fs.rename(bare.bareDir, moved);

      try {
        await expect(svc.dryRunFetch()).rejects.toThrow(
          /fetch|repository|not.*found/i,
        );
      } finally {
        await fs.rename(moved, bare.bareDir);
      }
    },
    GIT_INTEGRATION_TIMEOUT,
  );

  it(
    "loadConfig surfaces a descriptive error when GITHUB_PAT is missing",
    async () => {
      await freshSetup();
      vi.resetModules();
      vi.stubEnv("VAULT_REPO_URL", bare.url);
      vi.stubEnv("VAULT_CACHE_DIR", cacheDir);
      vi.stubEnv("GITHUB_PAT", "");

      const config = await import("../../src/lib/config");
      expect(() => config.loadConfig("stdio")).toThrow(
        /Missing required environment variable: GITHUB_PAT/,
      );
    },
    GIT_INTEGRATION_TIMEOUT,
  );
});
