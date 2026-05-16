import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { VaultError } from "../../src/vault/errors";
import {
  assertNoSymlinkEscape,
  assertWriteAllowed,
  buildWriteRejection,
  containsTraversal,
  isAbsoluteLike,
  isWriteAllowed,
  normalizeRelativePath,
  resolveSafePath,
} from "../../src/vault/write-path";

const ALLOWED = ["00-Inbox", "01-Daily", "Captures", "Journal"] as const;
const CACHE = path.join(tmpdir(), "vault-cache-test");
const DIRECTORY_SYMLINK_TYPE = process.platform === "win32" ? "junction" : "dir";

describe("normalizeRelativePath", () => {
  it("strips leading slashes and normalizes backslashes to forward", () => {
    expect(normalizeRelativePath("/foo/bar")).toBe("foo/bar");
    expect(normalizeRelativePath("\\foo\\bar")).toBe("foo/bar");
    expect(normalizeRelativePath("00-Inbox\\note.md")).toBe(
      "00-Inbox/note.md",
    );
  });

  it("collapses multiple leading slashes", () => {
    expect(normalizeRelativePath("///foo")).toBe("foo");
  });
});

describe("containsTraversal", () => {
  it("detects literal `..`", () => {
    expect(containsTraversal("../etc/passwd")).toBe(true);
    expect(containsTraversal("00-Inbox/../escape")).toBe(true);
  });

  it("detects URL-encoded `%2e%2e` regardless of case", () => {
    expect(containsTraversal("%2e%2e/etc/passwd")).toBe(true);
    expect(containsTraversal("%2E%2E/etc/passwd")).toBe(true);
    expect(containsTraversal("00-Inbox/%2e%2e/escape")).toBe(true);
  });

  it("detects mixed encoded variants `.%2e` and `%2e.`", () => {
    expect(containsTraversal(".%2e/secret")).toBe(true);
    expect(containsTraversal("%2e./secret")).toBe(true);
  });

  it("returns false for ordinary paths", () => {
    expect(containsTraversal("00-Inbox/note.md")).toBe(false);
    expect(containsTraversal("file.with.dots.md")).toBe(false);
  });
});

describe("isWriteAllowed (table)", () => {
  const cases: Array<[string, boolean, string]> = [
    // exact prefix match
    ["00-Inbox/note.md", true, "exact prefix"],
    ["00-Inbox", true, "exact match (folder itself)"],
    // nested
    ["Captures/sub/nested.md", true, "nested allow"],
    ["Journal/2026/05/15.md", true, "deeply nested allow"],
    // sibling reject
    ["00-InboxImpostor/note.md", false, "sibling-prefix reject"],
    ["JournalArchive/old.md", false, "sibling-prefix reject"],
    // parent rejects
    ["README.md", false, "vault root reject"],
    ["Archive/old.md", false, "unrelated folder reject"],
    // traversal
    ["../etc/passwd", false, "parent traversal reject"],
    ["00-Inbox/../escape.md", false, "embedded traversal reject"],
    // url-encoded
    ["%2e%2e/etc/passwd", false, "URL-encoded traversal reject"],
    ["%2E%2E/etc/passwd", false, "uppercase URL-encoded reject"],
    // absolute / windows
    ["/etc/passwd", false, "absolute path reject"],
    ["\\etc\\passwd", false, "Windows-style absolute reject"],
    ["00-Inbox\\..\\escape.md", false, "Windows traversal reject"],
    // empty / dot
    ["", false, "empty path reject"],
    ["/", false, "bare slash reject"],
  ];

  for (const [input, expected, label] of cases) {
    it(`${label}: ${JSON.stringify(input)} -> ${expected}`, () => {
      expect(isWriteAllowed(input, ALLOWED)).toBe(expected);
    });
  }

  it("empty allowlist rejects everything", () => {
    for (const p of ["00-Inbox/x.md", "Journal/y.md", "anywhere"]) {
      expect(isWriteAllowed(p, [])).toBe(false);
    }
  });

  it("tolerates allowlist entries with leading or trailing slashes", () => {
    expect(isWriteAllowed("00-Inbox/x.md", ["/00-Inbox/"])).toBe(true);
    expect(isWriteAllowed("00-Inbox/x.md", ["00-Inbox///"])).toBe(true);
  });

  it("ignores empty allowlist entries", () => {
    expect(isWriteAllowed("anything", [""])).toBe(false);
    expect(isWriteAllowed("anything", ["/"])).toBe(false);
  });
});

describe("assertWriteAllowed", () => {
  it("does not throw for allowed paths", () => {
    expect(() => assertWriteAllowed("00-Inbox/x.md", ALLOWED)).not.toThrow();
  });

  it("throws VaultError naming the allowlist for rejected paths", () => {
    try {
      assertWriteAllowed("Secrets/leak.md", ALLOWED);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      const e = err as VaultError;
      expect(e.message).toContain("Secrets/leak.md");
      expect(e.hint).toContain("00-Inbox");
      expect(e.hint).toContain("Journal");
      expect(e.hint).toContain("OBSIDIAN_WRITE_PATHS");
      expect(e.hint).toContain("Use one of these paths instead");
    }
  });

  it("throws a fail-closed-specific hint when allowlist is empty", () => {
    try {
      assertWriteAllowed("00-Inbox/x.md", []);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      const e = err as VaultError;
      expect(e.hint).toMatch(/OBSIDIAN_WRITE_PATHS/);
      expect(e.hint).toMatch(/Set/);
    }
  });
});

describe("buildWriteRejection", () => {
  it("includes the offending path in the message", () => {
    const e = buildWriteRejection("foo/bar.md", ALLOWED);
    expect(e.message).toContain("foo/bar.md");
  });

  it("hint lists every allowlist entry", () => {
    const e = buildWriteRejection("x", ["A", "B", "C"]);
    expect(e.hint).toContain("A");
    expect(e.hint).toContain("B");
    expect(e.hint).toContain("C");
  });
});

describe("resolveSafePath", () => {
  it("returns an absolute path inside the cache for valid input", () => {
    const abs = resolveSafePath(CACHE, "00-Inbox/note.md");
    expect(abs.startsWith(CACHE + path.sep)).toBe(true);
    expect(abs.endsWith(path.join("00-Inbox", "note.md"))).toBe(true);
  });

  it("rejects literal `..` traversal", () => {
    expect(() => resolveSafePath(CACHE, "../etc/passwd")).toThrow(VaultError);
    expect(() => resolveSafePath(CACHE, "..")).toThrow(VaultError);
  });

  it("rejects URL-encoded `%2e%2e` traversal", () => {
    expect(() => resolveSafePath(CACHE, "%2e%2e/etc/passwd")).toThrow(
      VaultError,
    );
    expect(() => resolveSafePath(CACHE, "%2E%2E/etc/passwd")).toThrow(
      VaultError,
    );
  });

  it("rejects paths containing NUL bytes", () => {
    expect(() => resolveSafePath(CACHE, "00-Inbox/\0note.md")).toThrow(
      VaultError,
    );
  });

  it("rejects absolute POSIX paths", () => {
    expect(() => resolveSafePath(CACHE, "/etc/passwd")).toThrow(VaultError);
    expect(() => resolveSafePath(CACHE, "/00-Inbox/x.md")).toThrow(VaultError);
  });

  it("rejects Windows-style absolute paths", () => {
    expect(() => resolveSafePath(CACHE, "\\etc\\passwd")).toThrow(VaultError);
    expect(() => resolveSafePath(CACHE, "C:\\Users\\evil")).toThrow(VaultError);
    expect(() => resolveSafePath(CACHE, "C:/Users/evil")).toThrow(VaultError);
  });

  it("normalizes backslashes so Windows traversal still trips the parent check", () => {
    expect(() => resolveSafePath(CACHE, "00-Inbox\\..\\escape")).toThrow(
      VaultError,
    );
  });
});

describe("isAbsoluteLike", () => {
  it("flags POSIX absolute paths", () => {
    expect(isAbsoluteLike("/etc/passwd")).toBe(true);
    expect(isAbsoluteLike("/")).toBe(true);
  });
  it("flags Windows absolute paths", () => {
    expect(isAbsoluteLike("\\evil")).toBe(true);
    expect(isAbsoluteLike("C:\\Users")).toBe(true);
    expect(isAbsoluteLike("c:/Users")).toBe(true);
  });
  it("returns false for relative paths and the empty string", () => {
    expect(isAbsoluteLike("00-Inbox/x.md")).toBe(false);
    expect(isAbsoluteLike("note.md")).toBe(false);
    expect(isAbsoluteLike("")).toBe(false);
    // A bare letter without a separator is not an absolute path.
    expect(isAbsoluteLike("C:foo")).toBe(false);
  });
});

describe("assertNoSymlinkEscape", () => {
  let cacheDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    const root = await mkdtemp(path.join(tmpdir(), "wp-symlink-"));
    cacheDir = path.join(root, "cache");
    outsideDir = path.join(root, "outside");
    await mkdir(cacheDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    await writeFile(path.join(outsideDir, "secret.txt"), "leak", "utf8");
  });

  afterEach(async () => {
    await rm(path.dirname(cacheDir), { recursive: true, force: true });
  });

  it("allows writes that stay inside the cache", async () => {
    const target = path.join(cacheDir, "00-Inbox/new.md");
    await expect(
      assertNoSymlinkEscape(cacheDir, target, ["00-Inbox"]),
    ).resolves.toBeUndefined();
  });

  it("allows writes when called with an empty allowlist (path is inside the cache)", async () => {
    const target = path.join(cacheDir, "anywhere.md");
    await expect(
      assertNoSymlinkEscape(cacheDir, target, []),
    ).resolves.toBeUndefined();
  });

  it("rejects writes that would resolve outside the cache via a symlink, naming the allowlist", async () => {
    const linkDir = path.join(cacheDir, "evil");
    await symlink(outsideDir, linkDir, DIRECTORY_SYMLINK_TYPE);
    const target = path.join(linkDir, "secret.txt");
    try {
      await assertNoSymlinkEscape(cacheDir, target, ["00-Inbox", "Journal"]);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      const e = err as VaultError;
      expect(e.message).toMatch(/symlink/);
      expect(e.hint).toContain("00-Inbox");
      expect(e.hint).toContain("Journal");
      expect(e.hint).toContain("OBSIDIAN_WRITE_PATHS");
      expect(e.hint).toContain("Use one of these paths instead");
    }
  });

  it("symlink rejection hint surfaces the empty-allowlist guidance when no paths are configured", async () => {
    const linkDir = path.join(cacheDir, "evil2");
    await symlink(outsideDir, linkDir, DIRECTORY_SYMLINK_TYPE);
    const target = path.join(linkDir, "secret.txt");
    try {
      await assertNoSymlinkEscape(cacheDir, target, []);
      throw new Error("should have thrown");
    } catch (err) {
      const e = err as VaultError;
      expect(e.hint).toContain("OBSIDIAN_WRITE_PATHS is empty");
    }
  });
});

describe("property: random paths preserve the allowlist invariant", () => {
  // Hand-rolled property test (fast-check is not a dep yet). 1000 random
  // paths assembled from a token alphabet that mixes safe folders, the
  // configured allowlist, and known-dangerous fragments.
  function rng(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0xffffffff;
    };
  }

  function randPath(rand: () => number): string {
    const tokens = [
      "00-Inbox",
      "01-Daily",
      "Captures",
      "Journal",
      "Archive",
      "Secrets",
      "00-InboxImpostor",
      "..",
      "%2e%2e",
      "%2E%2E",
      ".%2e",
      "note.md",
      "sub",
      "deep",
      "",
    ];
    const seps = ["/", "\\", "//"];
    const len = 1 + Math.floor(rand() * 5);
    let out = "";
    for (let i = 0; i < len; i++) {
      out += tokens[Math.floor(rand() * tokens.length)];
      if (i < len - 1) out += seps[Math.floor(rand() * seps.length)];
    }
    if (rand() < 0.2) out = "/" + out;
    return out;
  }

  it("isWriteAllowed accepts only paths whose normalized form starts with an allow entry", () => {
    const rand = rng(0xDEADBEEF);
    const TRIALS = 1000;
    for (let i = 0; i < TRIALS; i++) {
      const p = randPath(rand);
      const allowed = isWriteAllowed(p, ALLOWED);

      if (allowed) {
        // Invariant: allowed implies the cleaned form starts with an allow
        // entry AND has no traversal sequences.
        const cleaned = normalizeRelativePath(p);
        expect(containsTraversal(cleaned)).toBe(false);
        const matchesAllow = ALLOWED.some(
          (a) => cleaned === a || cleaned.startsWith(a + "/"),
        );
        expect(matchesAllow).toBe(true);
      } else {
        // Invariant: rejection produces a descriptive VaultError.
        const err = buildWriteRejection(p, ALLOWED);
        expect(err.message).toContain(p);
        expect(err.hint).toContain("OBSIDIAN_WRITE_PATHS");
      }
    }
  });

  it("empty allowlist rejects every random path", () => {
    const rand = rng(0xC0FFEE);
    for (let i = 0; i < 1000; i++) {
      expect(isWriteAllowed(randPath(rand), [])).toBe(false);
    }
  });
});
