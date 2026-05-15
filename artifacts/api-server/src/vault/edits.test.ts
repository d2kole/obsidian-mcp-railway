import { describe, it, expect } from "vitest";
import {
  insertAtHeading,
  insertAtBlockId,
  insertAtTextMatch,
  updateFrontmatter,
  appendContent,
  applyUnifiedPatch,
  addTagToContent,
  removeTagFromContent,
} from "./edits";
import { VaultError } from "./service";

describe("insertAtHeading", () => {
  const doc = "# Title\n\n## Section A\nalpha\n\n## Section B\nbeta\n";

  it("inserts after the heading section by default (trims trailing blanks)", () => {
    const out = insertAtHeading(doc, "Section A", "GAMMA");
    expect(out).toContain("alpha\nGAMMA\n\n## Section B");
  });

  it("inserts before the heading", () => {
    const out = insertAtHeading(doc, "Section B", "PRE", "before");
    expect(out).toContain("PRE\n\n## Section B");
  });

  it("replaces the body of the heading section", () => {
    const out = insertAtHeading(doc, "Section A", "REPLACED", "replace");
    expect(out).toContain("## Section A\nREPLACED\n## Section B");
  });

  it("throws VaultError when the heading is missing", () => {
    expect(() => insertAtHeading(doc, "Missing", "x")).toThrow(VaultError);
  });
});

describe("insertAtBlockId", () => {
  const doc = "alpha\nbeta ^abc\ngamma\n";

  it("inserts after the block id by default", () => {
    const out = insertAtBlockId(doc, "abc", "INSERTED");
    expect(out).toBe("alpha\nbeta ^abc\nINSERTED\ngamma\n");
  });

  it("inserts before the block id", () => {
    const out = insertAtBlockId(doc, "abc", "BEFORE", "before");
    expect(out).toBe("alpha\nBEFORE\nbeta ^abc\ngamma\n");
  });

  it("replaces the line containing the block id", () => {
    const out = insertAtBlockId(doc, "abc", "REPLACED", "replace");
    expect(out).toBe("alpha\nREPLACED\ngamma\n");
  });

  it("throws VaultError when the block id is missing", () => {
    expect(() => insertAtBlockId(doc, "missing", "x")).toThrow(VaultError);
  });

  it("strips a leading caret on the block id argument", () => {
    const out = insertAtBlockId(doc, "^abc", "X");
    expect(out).toContain("beta ^abc\nX");
  });
});

describe("insertAtTextMatch", () => {
  const doc = "hello world hello";

  it("inserts after the match by default (newline-prefixed)", () => {
    const out = insertAtTextMatch(doc, "world", "EXTRA");
    expect(out).toBe("hello world\nEXTRA hello");
  });

  it("inserts before the match", () => {
    const out = insertAtTextMatch(doc, "world", "PRE", "before");
    expect(out).toBe("hello PRE\nworld hello");
  });

  it("replaces the match", () => {
    const out = insertAtTextMatch(doc, "world", "REP", "replace");
    expect(out).toBe("hello REP hello");
  });

  it("throws VaultError when the text is missing", () => {
    expect(() => insertAtTextMatch(doc, "missing", "x")).toThrow(VaultError);
  });
});

describe("updateFrontmatter", () => {
  it("merges into existing frontmatter", () => {
    const doc = "---\ntitle: Old\nstatus: draft\n---\nbody\n";
    const out = updateFrontmatter(doc, { status: "done", tags: ["a", "b"] });
    expect(out).toContain("title: Old");
    expect(out).toContain("status: done");
    expect(out).toContain('tags: ["a", "b"]');
    expect(out).toContain("body");
  });

  it("creates new frontmatter when none exists", () => {
    const out = updateFrontmatter("body", { title: "X" });
    expect(out.startsWith("---\ntitle: X\n---\n")).toBe(true);
  });

  it("serializes nested objects via JSON", () => {
    const out = updateFrontmatter("body", { meta: { k: 1 } });
    expect(out).toContain('meta: {"k":1}');
  });

  it("skips null and undefined values", () => {
    const out = updateFrontmatter("body", { keep: "yes", drop: null });
    expect(out).toContain("keep: yes");
    expect(out).not.toContain("drop:");
  });
});

describe("appendContent", () => {
  it("returns the addition when content is empty", () => {
    expect(appendContent("", "x")).toBe("x");
  });

  it("appends without extra blank when content already ends in two newlines", () => {
    expect(appendContent("a\n\n", "b")).toBe("a\n\nb");
  });

  it("adds a separator newline when content ends in a single newline", () => {
    expect(appendContent("a\n", "b")).toBe("a\n\nb");
  });

  it("adds a blank line when content has no trailing newline", () => {
    expect(appendContent("a", "b")).toBe("a\n\nb");
  });
});

describe("applyUnifiedPatch", () => {
  it("applies a simple add/remove hunk", () => {
    const content = "one\ntwo\nthree\n";
    const patch = "@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n";
    expect(applyUnifiedPatch(content, patch)).toBe("one\nTWO\nthree\n");
  });

  it("throws on a malformed hunk header", () => {
    expect(() => applyUnifiedPatch("a\n", "@@ bogus @@\n a\n")).toThrow(
      VaultError,
    );
  });

  it("throws on a context mismatch", () => {
    const content = "one\ntwo\n";
    const patch = "@@ -1,2 +1,2 @@\n WRONG\n two\n";
    expect(() => applyUnifiedPatch(content, patch)).toThrow(VaultError);
  });

  it("throws on a removal mismatch", () => {
    const content = "one\ntwo\n";
    const patch = "@@ -1,2 +1,2 @@\n one\n-WRONG\n";
    expect(() => applyUnifiedPatch(content, patch)).toThrow(VaultError);
  });
});

describe("addTagToContent", () => {
  it("adds a tag into an existing tags array", () => {
    const doc = "---\ntags: [\"a\"]\n---\nbody";
    const out = addTagToContent(doc, "b");
    expect(out).toContain('tags: ["a", "b"]');
  });

  it("does not duplicate an existing tag", () => {
    const doc = "---\ntags: [\"a\"]\n---\nbody";
    const out = addTagToContent(doc, "a");
    const matches = out.match(/"a"/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("creates a tags entry when frontmatter has no tags line", () => {
    const doc = "---\ntitle: x\n---\nbody";
    const out = addTagToContent(doc, "new");
    expect(out).toContain("tags:");
    expect(out).toContain("new");
  });

  it("creates frontmatter when none exists", () => {
    const out = addTagToContent("body", "fresh");
    expect(out.startsWith("---")).toBe(true);
    expect(out).toContain("fresh");
  });

  it("strips a leading hash from the tag", () => {
    const doc = "---\ntags: [\"a\"]\n---\nbody";
    const out = addTagToContent(doc, "#hashed");
    expect(out).toContain("hashed");
    expect(out).not.toContain("#hashed");
  });
});

describe("removeTagFromContent", () => {
  it("removes inline #tag occurrences", () => {
    const out = removeTagFromContent("hello #foo world", "foo");
    expect(out).toContain("hello");
    expect(out).toContain("world");
    expect(out).not.toContain("#foo");
  });

  it("removes a tag from the frontmatter tags array", () => {
    const doc = "---\ntags: [\"a\", \"b\"]\n---\nbody";
    const out = removeTagFromContent(doc, "a");
    expect(out).toContain('tags: ["b"]');
    expect(out).not.toContain('"a"');
  });

  it("strips a leading hash from the tag argument", () => {
    const out = removeTagFromContent("text #x more", "#x");
    expect(out).not.toContain("#x");
    expect(out).toContain("text");
    expect(out).toContain("more");
  });
});
