import "../test/env";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { z } from "zod";
import { buildTools, isWriteTool, type ToolDef } from "./tools";
import { vaultService, VaultError } from "../vault/service";
import { redactError } from "../lib/redact";

/**
 * Contract tests for the MCP tool surface.
 *
 * Per task #10/#11 the auth front door and the tool surface are the two
 * places a regression silently breaks Claude.ai. This file pins the
 * tool registry shape, every tool's metadata quality, the schema-error
 * shape, and the "next action" hint contract so any future change has
 * to be intentional.
 */

const tools = buildTools();
const names = tools.map((t) => t.name);

// Documented surface — pinned literal so silently dropping or renaming a
// tool fails the gate. Kept in sync with the production buildTools().
const EXPECTED_TOOL_NAMES = [
  "read_note",
  "read_notes",
  "search_vault",
  "write_note",
  "append_to_note",
  "delete_note",
  "move_note",
  "insert_at_heading",
  "insert_at_block_id",
  "insert_at_text_match",
  "update_frontmatter",
  "apply_patch",
  "list_notes",
  "list_directory",
  "create_directory",
  "add_tag",
  "remove_tag",
  "rename_tag",
  "list_tags",
  "log_journal_entry",
  "add_journal_activity",
] as const;

/**
 * Mirror of the catch block in src/mcp/server.ts so this test asserts
 * the wire-level shape Claude.ai sees, not just the raw thrown error.
 */
function wrapAsMcpError(_name: string, err: unknown): {
  isError: true;
  content: { type: "text"; text: string }[];
} {
  // Mirrors the catch block in src/mcp/server.ts EXACTLY (same field
  // set, same field order). Drift here is a real wire-shape bug, so we
  // intentionally do not add extra fields like `tool`.
  const message = redactError(err);
  let hint: string | undefined;
  if (err instanceof VaultError) {
    hint =
      err.hint ??
      "Re-read the affected note, adjust your arguments to match its current contents, and retry. If the file or anchor was removed, fall back to write_note or search_vault.";
  } else if (err instanceof z.ZodError) {
    const fields = err.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    hint = `Fix the arguments and retry. Failing fields: ${fields}. Call ListTools to see this tool's input schema.`;
  } else {
    hint =
      "Inspect the error message, then either retry with different arguments or call a different tool. Use ListTools if unsure which tool fits.";
  }
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify({ ok: false, error: message, hint }),
      },
    ],
  };
}

/**
 * Drive a tool through the same sequence as src/mcp/server.ts:
 * 1. parse the input with the tool's zod schema (which is what the
 *    server does), 2. invoke the handler, 3. on throw, wrap the error
 *    in the same MCP envelope. Returns either the tool's success
 *    payload or the wire-level error envelope.
 */
async function callTool(
  tool: ToolDef,
  args: unknown,
): Promise<
  | { ok: true; payload: { content: { type: "text"; text: string }[] } }
  | {
      ok: false;
      payload: { isError: true; content: { type: "text"; text: string }[] };
    }
> {
  try {
    const parsed = tool.inputSchema.parse(args ?? {});
    const result = (await tool.handler(parsed as Record<string, unknown>)) as {
      content: { type: "text"; text: string }[];
    };
    return { ok: true, payload: result };
  } catch (err) {
    return { ok: false, payload: wrapAsMcpError(tool.name, err) };
  }
}

function decode<T = unknown>(env: {
  content: { type: "text"; text: string }[];
}): T {
  return JSON.parse(env.content[0]!.text) as T;
}

describe("MCP tool registry", () => {
  it("registers a non-empty deduplicated tool list", () => {
    expect(tools.length).toBeGreaterThan(0);
    expect(new Set(names).size).toBe(names.length);
  });

  it("registers exactly the documented set of tools (pinned literal)", () => {
    expect([...names].sort()).toEqual([...EXPECTED_TOOL_NAMES].sort());
  });

  it("does NOT register the disabled obsidian_execute_command tool", () => {
    expect(names).not.toContain("obsidian_execute_command");
    // Defense in depth: anything execute/exec/shell/spawn-shaped is also out.
    for (const n of names) {
      expect(n).not.toMatch(/execute_command|exec_command|run_shell|spawn/);
    }
  });

  it("isWriteTool agrees with the registered set (bidirectional, no orphans either way)", () => {
    const expectedWrites = new Set([
      "write_note",
      "append_to_note",
      "delete_note",
      "move_note",
      "insert_at_heading",
      "insert_at_block_id",
      "insert_at_text_match",
      "update_frontmatter",
      "apply_patch",
      "create_directory",
      "add_tag",
      "remove_tag",
      "rename_tag",
      "log_journal_entry",
      "add_journal_activity",
    ]);
    // Forward: isWriteTool() must classify every registered tool correctly.
    for (const n of names) {
      expect(isWriteTool(n)).toBe(expectedWrites.has(n));
    }
    // Reverse: every name in expectedWrites must actually be registered —
    // no stale write entries pointing at tools that were renamed/removed.
    for (const w of expectedWrites) {
      expect(names).toContain(w);
    }
  });
});

describe.each(tools.map((t) => [t.name, t] as const))(
  "tool %s contract",
  (_name, tool) => {
    it("has a name, description, ZodObject input schema, and async handler", () => {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(typeof tool.description).toBe("string");
      expect(tool.inputSchema).toBeInstanceOf(z.ZodObject);
      expect(typeof tool.handler).toBe("function");
    });

    it("description is >=40 chars and contains a 'Use this when' or 'Prefer this over' phrase", () => {
      expect(tool.description.length).toBeGreaterThanOrEqual(40);
      expect(tool.description).toMatch(/Use this when|Prefer this over/);
    });

    it("rejects schema-invalid input with a ZodError that the wrapper turns into a 'Fix the arguments' hint", () => {
      // Drive the schema parse directly (no handler invocation) so the
      // assertion is unambiguous for tools with all-optional schemas
      // (list_notes, list_directory, list_tags). For those, the
      // contract is "empty payload is accepted" — the schema-rejection
      // contract is then exercised by the strict-schema siblings.
      const hasRequired = Object.values(tool.inputSchema.shape).some(
        (f) =>
          !(f instanceof z.ZodOptional) && !(f instanceof z.ZodDefault),
      );
      if (!hasRequired) {
        const ok = tool.inputSchema.safeParse({});
        expect(ok.success).toBe(true);
        return;
      }
      // Strict tools: missing all required fields must fail with ZodError.
      const parse = tool.inputSchema.safeParse({});
      expect(parse.success).toBe(false);
      if (parse.success) return;
      const body = decode<{ ok: false; error: string; hint: string }>(
        wrapAsMcpError(tool.name, parse.error),
      );
      expect(body.ok).toBe(false);
      expect(body.hint).toMatch(/Fix the arguments and retry/);
      expect(body.hint).toMatch(/Call ListTools to see this tool's input schema/);
    });
  },
);

describe("Missing-file error surfaces a 'next action' hint", () => {
  beforeEach(() => {
    // Stub the vaultService so readFile throws the documented VaultError
    // without going anywhere near git.
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "readFile").mockRejectedValue(
      new VaultError(`Note not found: "missing/path.md".`),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("read_note: missing file returns the search_vault fallback hint", async () => {
    const tool = tools.find((t) => t.name === "read_note")!;
    const r = await callTool(tool, { path: "missing/path.md" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const body = decode<{ error: string; hint: string }>(r.payload);
    expect(body.error).toContain("missing/path.md");
    expect(body.hint).toMatch(/search_vault/);
  });

  it("apply_patch: missing file uses the same VaultError fallback hint", async () => {
    const tool = tools.find((t) => t.name === "apply_patch")!;
    const r = await callTool(tool, { path: "missing/path.md", patch: "@@" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const body = decode<{ error: string; hint: string }>(r.payload);
    expect(body.hint).toMatch(/search_vault/);
  });
});

describe("Write tools surface the OBSIDIAN_WRITE_PATHS allowlist on rejection", () => {
  beforeEach(() => {
    // Prime the shared singleton enough for assertWriteAllowed to fire
    // without touching git or the filesystem.
    const internals = vaultService as unknown as {
      initialized: boolean;
      cacheDir: string;
      writePaths: string[];
      git: unknown;
    };
    internals.initialized = true;
    internals.cacheDir = "/tmp/vault-cache-test";
    internals.writePaths = ["00-Inbox", "01-Daily", "Captures"];
    internals.git = {};
  });

  const writeCases: Array<{
    tool: string;
    args: Record<string, unknown>;
    badField: "path" | "from";
  }> = [
    { tool: "write_note", args: { path: "Secrets/x.md", content: "x" }, badField: "path" },
    { tool: "delete_note", args: { path: "Secrets/x.md" }, badField: "path" },
    { tool: "create_directory", args: { path: "Secrets/x" }, badField: "path" },
    { tool: "move_note", args: { from: "Secrets/x.md", to: "00-Inbox/y.md" }, badField: "from" },
  ];

  for (const c of writeCases) {
    it(`${c.tool} rejects out-of-allowlist ${c.badField} and surfaces the configured paths`, async () => {
      const tool = tools.find((t) => t.name === c.tool)!;
      const r = await callTool(tool, c.args);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      const body = decode<{ error: string; hint: string }>(r.payload);
      expect(body.hint).toContain("00-Inbox");
      expect(body.hint).toContain("01-Daily");
      expect(body.hint).toContain("Captures");
      expect(body.hint).toContain("OBSIDIAN_WRITE_PATHS");
      expect(body.hint).toMatch(/Use one of these paths instead/);
    });
  }
});

/* ────────────────────────────────────────────────────────────────────
   Per-tool happy + sad path coverage for the 5 most complex tools.
   These exercise the actual edit/search logic with a stubbed vault so
   we don't need git or a real cache directory.
   ──────────────────────────────────────────────────────────────────── */

function stubReadOnlyVault(file: string, content: string): void {
  vi.spyOn(vaultService, "sync").mockResolvedValue();
  vi.spyOn(vaultService, "readFile").mockImplementation(async (p: string) => {
    if (p === file) return content;
    throw new VaultError(`Note not found: "${p}".`);
  });
  vi.spyOn(vaultService, "exists").mockImplementation(async (p: string) => p === file);
  vi.spyOn(vaultService, "writeFile").mockResolvedValue();
  vi.spyOn(vaultService, "commitAndPush").mockResolvedValue("deadbeef");
  vi.spyOn(vaultService, "listMarkdown").mockResolvedValue([file]);
}

describe("apply_patch happy + sad", () => {
  afterEach(() => vi.restoreAllMocks());

  it("applies a clean unified diff and commits", async () => {
    stubReadOnlyVault("00-Inbox/n.md", "alpha\nbeta\ngamma\n");
    const writeSpy = vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    const tool = tools.find((t) => t.name === "apply_patch")!;
    const patch =
      "--- a/00-Inbox/n.md\n+++ b/00-Inbox/n.md\n@@ -1,3 +1,3 @@\n alpha\n-beta\n+BETA\n gamma\n";
    const r = await callTool(tool, { path: "00-Inbox/n.md", patch });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = decode<{ ok: true; data: { path: string; commit: string } }>(
      r.payload,
    );
    expect(body.data.path).toBe("00-Inbox/n.md");
    expect(body.data.commit).toBe("deadbeef");
    const written = writeSpy.mock.calls[0]![1] as string;
    expect(written).toContain("BETA");
    expect(written).not.toMatch(/^beta$/m);
  });

  it("rejects a patch whose context does not match with the VaultError-derived next-action hint", async () => {
    stubReadOnlyVault("00-Inbox/n.md", "alpha\nbeta\ngamma\n");
    const tool = tools.find((t) => t.name === "apply_patch")!;
    const patch =
      "--- a/00-Inbox/n.md\n+++ b/00-Inbox/n.md\n@@ -1,3 +1,3 @@\n NOT_THERE\n-beta\n+BETA\n gamma\n";
    const r = await callTool(tool, { path: "00-Inbox/n.md", patch });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const body = decode<{ error: string; hint: string }>(r.payload);
    // Must surface a VaultError-derived actionable hint (specific
    // recovery step or the documented default), never the generic
    // non-VaultError fallback "Inspect the error message…".
    expect(body.hint).toMatch(/search_vault|re-?read|retry|read the (note|file)|use [a-z_]+/i);
    expect(body.hint).not.toMatch(/^Inspect the error/);
  });
});

describe("insert_at_heading happy + sad", () => {
  afterEach(() => vi.restoreAllMocks());

  it("inserts content after a matching heading and commits", async () => {
    stubReadOnlyVault(
      "00-Inbox/n.md",
      "# Top\n\nintro\n\n## Notes\n\nold line\n",
    );
    const writeSpy = vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    const tool = tools.find((t) => t.name === "insert_at_heading")!;
    const r = await callTool(tool, {
      path: "00-Inbox/n.md",
      heading: "Notes",
      content: "new line",
      position: "after",
    });
    expect(r.ok).toBe(true);
    const written = writeSpy.mock.calls[0]![1] as string;
    expect(written).toContain("new line");
    expect(written).toContain("old line");
  });

  it("returns the VaultError-derived next-action hint when the heading is not present", async () => {
    stubReadOnlyVault("00-Inbox/n.md", "# Top\n\nbody\n");
    const tool = tools.find((t) => t.name === "insert_at_heading")!;
    const r = await callTool(tool, {
      path: "00-Inbox/n.md",
      heading: "DoesNotExist",
      content: "x",
      position: "after",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const body = decode<{ error: string; hint: string }>(r.payload);
    expect(body.hint).toMatch(/search_vault|re-?read|retry|read the (note|file)|use [a-z_]+/i);
    expect(body.hint).not.toMatch(/^Inspect the error/);
  });
});

describe("insert_at_block_id happy + sad", () => {
  afterEach(() => vi.restoreAllMocks());

  it("inserts content after a matching block id and commits", async () => {
    stubReadOnlyVault(
      "00-Inbox/n.md",
      "para one ^abc123\n\npara two\n",
    );
    const writeSpy = vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    const tool = tools.find((t) => t.name === "insert_at_block_id")!;
    const r = await callTool(tool, {
      path: "00-Inbox/n.md",
      blockId: "abc123",
      content: "FOLLOWUP",
      position: "after",
    });
    expect(r.ok).toBe(true);
    const written = writeSpy.mock.calls[0]![1] as string;
    expect(written).toContain("FOLLOWUP");
    expect(written).toContain("^abc123");
  });

  it("returns the VaultError-derived next-action hint when the block id is not present", async () => {
    stubReadOnlyVault("00-Inbox/n.md", "no block ids here\n");
    const tool = tools.find((t) => t.name === "insert_at_block_id")!;
    const r = await callTool(tool, {
      path: "00-Inbox/n.md",
      blockId: "missing",
      content: "x",
      position: "after",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const body = decode<{ error: string; hint: string }>(r.payload);
    expect(body.hint).toMatch(/search_vault|re-?read|retry|read the (note|file)|use [a-z_]+/i);
    expect(body.hint).not.toMatch(/^Inspect the error/);
  });
});

describe("update_frontmatter happy + sad", () => {
  afterEach(() => vi.restoreAllMocks());

  it("merges keys into existing frontmatter and preserves untouched keys", async () => {
    stubReadOnlyVault(
      "00-Inbox/n.md",
      "---\ntitle: Existing\nkeep: yes\n---\n\nbody\n",
    );
    const writeSpy = vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    const tool = tools.find((t) => t.name === "update_frontmatter")!;
    const r = await callTool(tool, {
      path: "00-Inbox/n.md",
      updates: { title: "Updated", added: 1 },
    });
    expect(r.ok).toBe(true);
    const written = writeSpy.mock.calls[0]![1] as string;
    expect(written).toMatch(/title: Updated/);
    expect(written).toMatch(/keep: yes/);
    expect(written).toMatch(/added: 1/);
  });

  it("rejects schema-invalid updates (non-object) with the schema-error hint", async () => {
    stubReadOnlyVault("00-Inbox/n.md", "---\ntitle: x\n---\n");
    const tool = tools.find((t) => t.name === "update_frontmatter")!;
    const r = await callTool(tool, {
      path: "00-Inbox/n.md",
      updates: "not-an-object",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const body = decode<{ hint: string }>(r.payload);
    expect(body.hint).toMatch(/Fix the arguments and retry/);
  });
});

describe("log_journal_entry + add_journal_activity", () => {
  afterEach(() => vi.restoreAllMocks());

  function todayPath(): string {
    const d = new Date();
    const yyyy = d.getUTCFullYear().toString();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `Journal/${yyyy}-${mm}-${dd}.md`;
  }

  it("log_journal_entry appends to today's daily note (creates it when missing)", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "exists").mockResolvedValue(false);
    const writeSpy = vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    vi.spyOn(vaultService, "commitAndPush").mockResolvedValue("c0ffee");
    const tool = tools.find((t) => t.name === "log_journal_entry")!;
    const r = await callTool(tool, { entry: "test reflection" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = decode<{ data: { path: string; commit: string } }>(r.payload);
    expect(body.data.path).toBe(todayPath());
    expect(body.data.commit).toBe("c0ffee");
    const written = writeSpy.mock.calls[0]![1] as string;
    expect(written).toContain("test reflection");
  });

  it("add_journal_activity appends under the '## Activity' heading when present", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "exists").mockResolvedValue(true);
    vi.spyOn(vaultService, "readFile").mockResolvedValue(
      "# 2026-05-15\n\n## Activity\n\n- prior\n",
    );
    const writeSpy = vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    vi.spyOn(vaultService, "commitAndPush").mockResolvedValue("ac71v1");
    const tool = tools.find((t) => t.name === "add_journal_activity")!;
    const r = await callTool(tool, { activity: "Edited Health.md" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = decode<{ data: { path: string; commit: string } }>(r.payload);
    expect(body.data.commit).toBe("ac71v1");
    const written = writeSpy.mock.calls[0]![1] as string;
    expect(written).toContain("## Activity");
    expect(written).toContain("Edited Health.md");
    expect(written).toContain("- prior");
  });

  it("add_journal_activity seeds the '## Activity' section when missing", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "exists").mockResolvedValue(true);
    vi.spyOn(vaultService, "readFile").mockResolvedValue("# 2026-05-15\n\nbody only\n");
    const writeSpy = vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    vi.spyOn(vaultService, "commitAndPush").mockResolvedValue("seed1");
    const tool = tools.find((t) => t.name === "add_journal_activity")!;
    const r = await callTool(tool, { activity: "Seeded section" });
    expect(r.ok).toBe(true);
    const written = writeSpy.mock.calls[0]![1] as string;
    expect(written).toContain("## Activity");
    expect(written).toContain("Seeded section");
  });
});

describe("Remaining read/edit/tag handlers (coverage)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("read_note returns the file content", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "readFile").mockResolvedValue("hello world");
    const tool = tools.find((t) => t.name === "read_note")!;
    const r = await callTool(tool, { path: "x.md" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = decode<{ data: { path: string; content: string } }>(r.payload);
    expect(body.data.content).toBe("hello world");
  });

  it("read_notes returns per-path success/failure", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "readFile").mockImplementation(async (p) => {
      if (p === "good.md") return "yes";
      throw new VaultError(`Note not found: "${p}".`, "use search_vault");
    });
    const tool = tools.find((t) => t.name === "read_notes")!;
    const r = await callTool(tool, { paths: ["good.md", "bad.md"] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = decode<{
      data: { path: string; ok: boolean; content?: string; error?: string }[];
    }>(r.payload);
    expect(body.data[0]).toMatchObject({ path: "good.md", ok: true, content: "yes" });
    expect(body.data[1]!.ok).toBe(false);
  });

  it("list_notes returns the file count and list", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "listMarkdown").mockResolvedValue(["a.md", "b.md"]);
    const tool = tools.find((t) => t.name === "list_notes")!;
    const r = await callTool(tool, { subdir: "00-Inbox" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = decode<{ data: { count: number; files: string[] } }>(r.payload);
    expect(body.data.count).toBe(2);
  });

  it("list_notes accepts no subdir argument", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "listMarkdown").mockResolvedValue([]);
    const tool = tools.find((t) => t.name === "list_notes")!;
    const r = await callTool(tool, {});
    expect(r.ok).toBe(true);
  });

  it("list_directory returns files and dirs", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "listDir").mockResolvedValue({
      files: ["a.md"],
      dirs: ["sub"],
    });
    const tool = tools.find((t) => t.name === "list_directory")!;
    const rWithPath = await callTool(tool, { path: "00-Inbox" });
    const rWithout = await callTool(tool, {});
    expect(rWithPath.ok).toBe(true);
    expect(rWithout.ok).toBe(true);
  });

  it("append_to_note appends to an existing note", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "exists").mockResolvedValue(true);
    vi.spyOn(vaultService, "readFile").mockResolvedValue("first\n");
    const writeSpy = vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    vi.spyOn(vaultService, "commitAndPush").mockResolvedValue("app1");
    const tool = tools.find((t) => t.name === "append_to_note")!;
    const r = await callTool(tool, { path: "00-Inbox/n.md", content: "second" });
    expect(r.ok).toBe(true);
    const written = writeSpy.mock.calls[0]![1] as string;
    expect(written).toContain("first");
    expect(written).toContain("second");
  });

  it("append_to_note creates a new note when the file does not exist", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "exists").mockResolvedValue(false);
    const writeSpy = vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    vi.spyOn(vaultService, "commitAndPush").mockResolvedValue("app2");
    const tool = tools.find((t) => t.name === "append_to_note")!;
    const r = await callTool(tool, { path: "00-Inbox/new.md", content: "fresh" });
    expect(r.ok).toBe(true);
    expect(writeSpy.mock.calls[0]![1] as string).toContain("fresh");
  });

  it("write_note + delete_note + move_note + create_directory commit and return the sha", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    vi.spyOn(vaultService, "deleteFile").mockResolvedValue();
    vi.spyOn(vaultService, "moveFile").mockResolvedValue();
    vi.spyOn(vaultService, "createDirectory").mockResolvedValue();
    vi.spyOn(vaultService, "commitAndPush").mockResolvedValue("sha1");

    const w = await callTool(tools.find((t) => t.name === "write_note")!, {
      path: "00-Inbox/a.md",
      content: "x",
    });
    const d = await callTool(tools.find((t) => t.name === "delete_note")!, {
      path: "00-Inbox/a.md",
    });
    const m = await callTool(tools.find((t) => t.name === "move_note")!, {
      from: "00-Inbox/a.md",
      to: "00-Inbox/b.md",
    });
    const c = await callTool(tools.find((t) => t.name === "create_directory")!, {
      path: "00-Inbox/sub",
    });
    expect(w.ok && d.ok && m.ok && c.ok).toBe(true);
  });

  it("insert_at_text_match inserts content at a substring", async () => {
    stubReadOnlyVault("00-Inbox/n.md", "before MARK after\n");
    const writeSpy = vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    const tool = tools.find((t) => t.name === "insert_at_text_match")!;
    const r = await callTool(tool, {
      path: "00-Inbox/n.md",
      match: "MARK",
      content: "INSERTED",
      position: "after",
    });
    expect(r.ok).toBe(true);
    expect(writeSpy.mock.calls[0]![1] as string).toContain("INSERTED");
  });

  it("update_frontmatter on a note without frontmatter creates one", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "exists").mockResolvedValue(false);
    const writeSpy = vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    vi.spyOn(vaultService, "commitAndPush").mockResolvedValue("fm1");
    const tool = tools.find((t) => t.name === "update_frontmatter")!;
    const r = await callTool(tool, {
      path: "00-Inbox/new.md",
      updates: { title: "New" },
    });
    expect(r.ok).toBe(true);
    expect(writeSpy.mock.calls[0]![1] as string).toMatch(/title: New/);
  });

  it("add_tag and remove_tag round-trip a tag through a note", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "readFile").mockResolvedValue(
      "---\ntags: []\n---\n\nbody #other\n",
    );
    const writeSpy = vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    vi.spyOn(vaultService, "commitAndPush").mockResolvedValue("tag1");

    const add = await callTool(tools.find((t) => t.name === "add_tag")!, {
      path: "00-Inbox/n.md",
      tag: "alpha",
    });
    const rm = await callTool(tools.find((t) => t.name === "remove_tag")!, {
      path: "00-Inbox/n.md",
      tag: "other",
    });
    expect(add.ok).toBe(true);
    expect(rm.ok).toBe(true);
    expect(writeSpy.mock.calls.length).toBe(2);
  });

  it("rename_tag rewrites every touched note in a single commit", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "listMarkdown").mockResolvedValue([
      "00-Inbox/a.md",
      "00-Inbox/b.md",
      "00-Inbox/c.md",
    ]);
    vi.spyOn(vaultService, "readFile").mockImplementation(async (p) => {
      if (p === "00-Inbox/a.md") return "body #old here\n";
      if (p === "00-Inbox/b.md") return "no tag here\n";
      return "another #old line\n";
    });
    vi.spyOn(vaultService, "assertWriteAllowed").mockReturnValue(undefined as never);
    const writeSpy = vi.spyOn(vaultService, "writeFile").mockResolvedValue();
    const commitSpy = vi
      .spyOn(vaultService, "commitAndPush")
      .mockResolvedValue("rename1");
    const tool = tools.find((t) => t.name === "rename_tag")!;
    const r = await callTool(tool, { from: "#old", to: "new" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = decode<{ data: { renamed: number; commit: string | null } }>(
      r.payload,
    );
    expect(body.data.renamed).toBe(2);
    expect(body.data.commit).toBe("rename1");
    expect(writeSpy.mock.calls.length).toBe(2);
    expect(commitSpy.mock.calls.length).toBe(1);
  });

  it("rename_tag with no matches returns commit=null and renamed=0", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "listMarkdown").mockResolvedValue(["x.md"]);
    vi.spyOn(vaultService, "readFile").mockResolvedValue("nothing matching\n");
    const tool = tools.find((t) => t.name === "rename_tag")!;
    const r = await callTool(tool, { from: "absent", to: "new" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = decode<{ data: { renamed: number; commit: string | null } }>(
      r.payload,
    );
    expect(body.data.renamed).toBe(0);
    expect(body.data.commit).toBeNull();
  });

  it("list_tags counts inline #tags and frontmatter tags arrays", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "listMarkdown").mockResolvedValue(["a.md", "b.md"]);
    vi.spyOn(vaultService, "readFile").mockImplementation(async (p) =>
      p === "a.md"
        ? "---\ntags: [foo, \"bar\"]\n---\n\nbody #foo and #baz\n"
        : "no tags here\n",
    );
    const tool = tools.find((t) => t.name === "list_tags")!;
    const r = await callTool(tool, {});
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = decode<{
      data: { count: number; tags: { tag: string; count: number }[] };
    }>(r.payload);
    const found = new Map(body.data.tags.map((t) => [t.tag, t.count]));
    expect(found.get("foo")).toBeGreaterThanOrEqual(2);
    expect(found.get("bar")).toBe(1);
    expect(found.get("baz")).toBe(1);
  });

  it("search_vault exact mode honors the limit cap", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "listMarkdown").mockResolvedValue(["a.md"]);
    vi.spyOn(vaultService, "readFile").mockResolvedValue(
      "needle\nneedle\nneedle\nneedle\n",
    );
    const tool = tools.find((t) => t.name === "search_vault")!;
    const r = await callTool(tool, {
      query: "needle",
      mode: "exact",
      limit: 2,
      contextLines: 0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = decode<{ data: { hits: unknown[] } }>(r.payload);
    expect(body.data.hits.length).toBe(2);
  });

  it("search_vault skips files that throw on read", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "listMarkdown").mockResolvedValue(["a.md", "b.md"]);
    vi.spyOn(vaultService, "readFile").mockImplementation(async (p) => {
      if (p === "a.md") throw new VaultError("boom");
      return "needle here\n";
    });
    const tool = tools.find((t) => t.name === "search_vault")!;
    const r = await callTool(tool, { query: "needle", mode: "exact" });
    expect(r.ok).toBe(true);
  });
});

describe("search_vault happy + sad", () => {
  afterEach(() => vi.restoreAllMocks());

  it("exact mode finds literal substring matches with line numbers and previews", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "listMarkdown").mockResolvedValue(["a.md", "b.md"]);
    vi.spyOn(vaultService, "readFile").mockImplementation(async (p) =>
      p === "a.md" ? "alpha\nneedle\nomega\n" : "no match here\n",
    );
    const tool = tools.find((t) => t.name === "search_vault")!;
    const r = await callTool(tool, { query: "needle", mode: "exact", limit: 5, contextLines: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = decode<{
      data: { hits: { path: string; line: number; preview: string }[] };
    }>(r.payload);
    expect(body.data.hits.length).toBe(1);
    expect(body.data.hits[0]!.path).toBe("a.md");
    expect(body.data.hits[0]!.line).toBe(2);
    expect(body.data.hits[0]!.preview).toContain("needle");
  });

  it("fuzzy mode returns ranked hits with scores", async () => {
    vi.spyOn(vaultService, "sync").mockResolvedValue();
    vi.spyOn(vaultService, "listMarkdown").mockResolvedValue(["a.md", "b.md"]);
    vi.spyOn(vaultService, "readFile").mockImplementation(async (p) =>
      p === "a.md" ? "the quick brown fox" : "lorem ipsum dolor",
    );
    const tool = tools.find((t) => t.name === "search_vault")!;
    const r = await callTool(tool, { query: "quick", mode: "fuzzy", limit: 10, contextLines: 2 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const body = decode<{
      data: { hits: { path: string; score: number; preview: string }[] };
    }>(r.payload);
    expect(body.data.hits.length).toBeGreaterThan(0);
    expect(body.data.hits[0]!.path).toBe("a.md");
    expect(typeof body.data.hits[0]!.score).toBe("number");
  });

  it("rejects schema-invalid query (empty string) with the schema-error hint", async () => {
    const tool = tools.find((t) => t.name === "search_vault")!;
    const r = await callTool(tool, { query: "" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const body = decode<{ hint: string }>(r.payload);
    expect(body.hint).toMatch(/Fix the arguments and retry/);
  });
});
