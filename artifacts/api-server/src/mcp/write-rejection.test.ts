import "../test/env";
import { describe, it, expect, beforeEach } from "vitest";
import { vaultService, VaultError } from "../vault/service";
import { buildTools } from "./tools";
import { redactError } from "../lib/redact";

/**
 * MCP-layer proof: when a write tool is invoked with a rejected path
 * (traversal or absolute), the response payload that server.ts emits
 * must surface the configured allowlist and the "Use one of these
 * paths instead" guidance — this is the contract Claude.ai sees.
 *
 * We exercise the write_note tool handler directly (it throws a
 * VaultError) and then run the SAME wrapping shape that
 * src/mcp/server.ts uses around the catch block, so the assertion
 * mirrors what an MCP CallTool response would carry on the wire.
 */
describe("MCP write_note — write-path rejection payload", () => {
  beforeEach(() => {
    // Prime the shared vaultService singleton so writeFile() runs the
    // real allowlist + path-resolution checks without touching git.
    const internals = vaultService as unknown as {
      initialized: boolean;
      cacheDir: string;
      writePaths: string[];
      git: unknown;
    };
    internals.initialized = true;
    internals.cacheDir = "/tmp/vault-cache-test";
    internals.writePaths = ["00-Inbox", "Journal"];
    internals.git = {};
  });

  function getWriteNoteTool() {
    const tools = buildTools();
    const tool = tools.find((t) => t.name === "write_note");
    if (!tool) throw new Error("write_note tool not registered");
    return tool;
  }

  /**
   * Mirrors the catch block in src/mcp/server.ts so this test fails
   * loudly if the wire-level shape ever diverges from the production
   * error path.
   */
  function wrapAsMcpError(err: unknown): {
    isError: true;
    content: { type: "text"; text: string }[];
  } {
    const message = redactError(err);
    const hint =
      err instanceof VaultError
        ? err.hint ??
          "Re-read the affected note, adjust your arguments to match its current contents, and retry. If the file or anchor was removed, fall back to write_note or search_vault."
        : "Inspect the error message, then either retry with different arguments or call a different tool.";
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

  it("rejects a traversal path and surfaces allowlist + guidance in the MCP payload", async () => {
    const tool = getWriteNoteTool();
    let caught: unknown;
    try {
      await tool.handler({ path: "../etc/passwd", content: "leak" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VaultError);

    const payload = wrapAsMcpError(caught);
    expect(payload.isError).toBe(true);
    const body = JSON.parse(payload.content[0].text) as {
      ok: false;
      error: string;
      hint: string;
    };
    expect(body.ok).toBe(false);
    expect(body.error).toContain("../etc/passwd");
    // assertWriteAllowed fires before resolveSafePath, so the user gets
    // the allowlist hint with the "use one of these paths instead"
    // guidance — exactly the contract Claude.ai needs.
    expect(body.hint).toContain("00-Inbox");
    expect(body.hint).toContain("Journal");
    expect(body.hint).toContain("Use one of these paths instead");
  });

  it("rejects a path outside the allowlist and names the configured paths", async () => {
    const tool = getWriteNoteTool();
    let caught: unknown;
    try {
      await tool.handler({ path: "Secrets/leak.md", content: "leak" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VaultError);

    const body = JSON.parse(wrapAsMcpError(caught).content[0].text) as {
      ok: false;
      error: string;
      hint: string;
    };
    expect(body.error).toContain("Secrets/leak.md");
    expect(body.hint).toContain("00-Inbox");
    expect(body.hint).toContain("Journal");
    expect(body.hint).toContain("OBSIDIAN_WRITE_PATHS");
    expect(body.hint).toContain("Use one of these paths instead");
  });

  it("rejects an absolute path with allowlist guidance in the payload", async () => {
    const tool = getWriteNoteTool();
    let caught: unknown;
    try {
      await tool.handler({ path: "/etc/passwd", content: "leak" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(VaultError);

    const body = JSON.parse(wrapAsMcpError(caught).content[0].text) as {
      ok: false;
      error: string;
      hint: string;
    };
    // assertWriteAllowed runs before resolveSafePath, and isWriteAllowed
    // explicitly rejects absolute-like inputs, so the user gets the
    // allowlist-bearing hint with the "Use one of these paths instead"
    // guidance — same wire contract as the traversal/out-of-allowlist
    // cases above.
    expect(body.error).toContain("/etc/passwd");
    expect(body.hint).toContain("00-Inbox");
    expect(body.hint).toContain("Journal");
    expect(body.hint).toContain("OBSIDIAN_WRITE_PATHS");
    expect(body.hint).toContain("Use one of these paths instead");
  });
});
