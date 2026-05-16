import "../test/env";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
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
