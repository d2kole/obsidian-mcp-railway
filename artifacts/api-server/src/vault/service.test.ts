import "../test/env";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi } from "vitest";
import { VaultService, VaultError } from "./service";

const CACHE_DIR = path.join(tmpdir(), "vault-cache-test");

function primed(): VaultService {
  const svc = new VaultService();
  // Bypass init() (which would clone a real git repo) by priming internals.
  const internals = svc as unknown as {
    initialized: boolean;
    cacheDir: string;
    writePaths: string[];
    git: unknown;
  };
  internals.initialized = true;
  internals.cacheDir = CACHE_DIR;
  internals.writePaths = ["00-Inbox", "01-Daily", "Captures"];
  internals.git = {};
  return svc;
}

interface FakeGit {
  pull: ReturnType<typeof vi.fn>;
}

function primedWithFakeGit(
  pullImpl: () => Promise<unknown>,
  minSyncIntervalMs = 5000,
): { svc: VaultService; git: FakeGit } {
  const svc = new VaultService();
  const git: FakeGit = { pull: vi.fn(pullImpl) };
  const internals = svc as unknown as {
    initialized: boolean;
    cacheDir: string;
    writePaths: string[];
    git: FakeGit;
    branch: string;
    minSyncIntervalMs: number;
  };
  internals.initialized = true;
  internals.cacheDir = CACHE_DIR;
  internals.writePaths = [];
  internals.branch = "main";
  internals.minSyncIntervalMs = minSyncIntervalMs;
  internals.git = git;
  return { svc, git };
}

describe("VaultService write-path safety", () => {
  it("isWriteAllowed accepts paths under allowed roots", () => {
    const svc = primed();
    expect(svc.isWriteAllowed("00-Inbox/note.md")).toBe(true);
    expect(svc.isWriteAllowed("01-Daily/2026-05-15.md")).toBe(true);
    expect(svc.isWriteAllowed("Captures/sub/nested.md")).toBe(true);
  });

  it("isWriteAllowed rejects paths outside allowed roots", () => {
    const svc = primed();
    expect(svc.isWriteAllowed("README.md")).toBe(false);
    expect(svc.isWriteAllowed("Archive/old.md")).toBe(false);
    // Prefix-but-not-folder must not slip through.
    expect(svc.isWriteAllowed("00-InboxImpostor/note.md")).toBe(false);
  });

  it("assertWriteAllowed throws VaultError outside allowed paths", () => {
    const svc = primed();
    expect(() => svc.assertWriteAllowed("Secrets/leak.md")).toThrow(VaultError);
    expect(() => svc.assertWriteAllowed("00-Inbox/ok.md")).not.toThrow();
  });

  it("resolveSafePath blocks parent traversal sequences", () => {
    const svc = primed();
    expect(() => svc.resolveSafePath("../etc/passwd")).toThrow(VaultError);
    expect(() => svc.resolveSafePath("00-Inbox/../../escape.md")).toThrow(
      VaultError,
    );
  });

  it("resolveSafePath blocks paths that resolve outside the cache dir", () => {
    const svc = primed();
    // `..` is rejected by the traversal check; absolute paths are
    // rejected by the absolute-path check (see write-path.ts).
    expect(() => svc.resolveSafePath("..")).toThrow(VaultError);
    expect(() => svc.resolveSafePath("/etc/passwd")).toThrow(VaultError);
  });

  it("resolveSafePath returns a path inside the cache dir for valid input", () => {
    const svc = primed();
    const abs = svc.resolveSafePath("00-Inbox/note.md");
    expect(abs.startsWith(CACHE_DIR + path.sep)).toBe(true);
    expect(abs.endsWith(path.join("00-Inbox", "note.md"))).toBe(true);
  });

  it("fails closed when the configured allowlist is empty (env unset)", () => {
    const svc = primed();
    const internals = svc as unknown as { writePaths: string[] };
    internals.writePaths = [];
    // Every otherwise-valid write must be rejected.
    expect(() => svc.assertWriteAllowed("00-Inbox/ok.md")).toThrow(VaultError);
    expect(() => svc.assertWriteAllowed("anything.md")).toThrow(VaultError);
    expect(svc.isWriteAllowed("00-Inbox/ok.md")).toBe(false);
    // Hint must point the operator at the env var so they have a next action.
    try {
      svc.assertWriteAllowed("00-Inbox/ok.md");
    } catch (err) {
      const e = err as VaultError;
      expect(e.hint).toMatch(/OBSIDIAN_WRITE_PATHS/);
      expect(e.hint).toMatch(/Set/);
    }
  });
});

describe("VaultService.sync() concurrency and throttling", () => {
  it("shares a single in-flight pull across concurrent callers", async () => {
    let resolvePull!: () => void;
    const pullPromise = new Promise<void>((resolve) => {
      resolvePull = resolve;
    });
    const { svc, git } = primedWithFakeGit(() => pullPromise);

    const call1 = svc.sync();
    const call2 = svc.sync();
    const call3 = svc.sync(true); // force still joins an in-flight pull

    expect(git.pull).toHaveBeenCalledTimes(1);
    resolvePull();
    await Promise.all([call1, call2, call3]);
    expect(git.pull).toHaveBeenCalledTimes(1);
  });

  it("throttles repeated calls within minSyncIntervalMs but force bypasses it", async () => {
    const { svc, git } = primedWithFakeGit(() => Promise.resolve(), 60_000);

    await svc.sync();
    expect(git.pull).toHaveBeenCalledTimes(1);

    await svc.sync();
    expect(git.pull).toHaveBeenCalledTimes(1);

    await svc.sync(true);
    expect(git.pull).toHaveBeenCalledTimes(2);
  });

  it("does not throttle when minSyncIntervalMs is 0", async () => {
    const { svc, git } = primedWithFakeGit(() => Promise.resolve(), 0);

    await svc.sync();
    await svc.sync();
    expect(git.pull).toHaveBeenCalledTimes(2);
  });
});

describe("VaultService.sync() error hints", () => {
  it("surfaces a rebase-conflict hint for content conflicts", async () => {
    const { svc } = primedWithFakeGit(() =>
      Promise.reject(
        new Error("CONFLICT (content): Merge conflict in note.md"),
      ),
    );
    await expect(svc.sync()).rejects.toMatchObject({
      hint: expect.stringMatching(/re-clones from GitHub/),
    });
  });

  it("surfaces a timeout hint distinct from auth errors when the subprocess is killed", async () => {
    const { svc } = primedWithFakeGit(() =>
      Promise.reject(new Error("block timeout reached")),
    );
    await expect(svc.sync()).rejects.toMatchObject({
      hint: expect.stringMatching(/VAULT_GIT_TIMEOUT_MS/),
    });
  });

  it("surfaces a pid-exhaustion hint distinct from auth errors", async () => {
    const { svc } = primedWithFakeGit(() =>
      Promise.reject(new Error("crun: fork: Resource temporarily unavailable")),
    );
    await expect(svc.sync()).rejects.toMatchObject({
      hint: expect.stringMatching(/pid exhaustion/i),
    });
  });

  it("falls back to the generic auth hint for other errors", async () => {
    const { svc } = primedWithFakeGit(() =>
      Promise.reject(new Error("fatal: Authentication failed")),
    );
    await expect(svc.sync()).rejects.toMatchObject({
      hint: expect.stringMatching(/GITHUB_PAT/),
    });
  });
});
