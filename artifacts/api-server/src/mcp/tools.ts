import path from "node:path";
import Fuse from "fuse.js";
import { z } from "zod";
import { vaultService, VaultError } from "../vault/service";
import {
  insertAtHeading,
  insertAtBlockId,
  insertAtTextMatch,
  updateFrontmatter,
  appendContent,
  applyUnifiedPatch,
  addTagToContent,
  removeTagFromContent,
} from "../vault/edits";
import { getConfig } from "../lib/config";
import { logger } from "../lib/logger";

const WRITE_TOOLS = new Set([
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

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function todayString(format: string): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear().toString();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return format
    .replace("YYYY", yyyy)
    .replace("MM", mm)
    .replace("DD", dd);
}

function formatTool(args: { ok?: boolean; data?: unknown; message?: string }): {
  content: { type: "text"; text: string }[];
} {
  const text = JSON.stringify(args, null, 2);
  return { content: [{ type: "text", text }] };
}

export function isWriteTool(name: string): boolean {
  return WRITE_TOOLS.has(name);
}

export function buildTools(): ToolDef[] {
  return [
    {
      name: "read_note",
      description:
        "Read the full contents of a single note from the Obsidian vault. Use this when you know the exact path. For multi-file reads, use read_notes (more efficient). For unknown paths, use search_vault first.",
      inputSchema: z.object({
        path: z.string().describe("Vault-relative path, e.g. '00-Inbox/today.md'"),
      }),
      handler: async (args) => {
        await vaultService.sync();
        const p = String(args["path"]);
        const content = await vaultService.readFile(p);
        return formatTool({ ok: true, data: { path: p, content } });
      },
    },
    {
      name: "read_notes",
      description:
        "Read multiple notes in a single request. Returns per-note success/failure so partial failures do not block the rest. Prefer this over multiple read_note calls.",
      inputSchema: z.object({
        paths: z.array(z.string()).min(1),
      }),
      handler: async (args) => {
        await vaultService.sync();
        const paths = args["paths"] as string[];
        const results = await Promise.all(
          paths.map(async (p) => {
            try {
              const content = await vaultService.readFile(p);
              return { path: p, ok: true, content };
            } catch (err) {
              const e = err as VaultError;
              return { path: p, ok: false, error: e.message, hint: e.hint };
            }
          }),
        );
        return formatTool({ ok: true, data: results });
      },
    },
    {
      name: "search_vault",
      description:
        "Search note filenames and content. Default mode is fuzzy (typo-tolerant, ranked by relevance). Set mode='exact' for literal substring matching with surrounding context lines. Use this to locate notes when you don't know the exact path.",
      inputSchema: z.object({
        query: z.string().min(1),
        mode: z.enum(["fuzzy", "exact"]).default("fuzzy"),
        limit: z.number().int().positive().max(50).default(20),
        contextLines: z.number().int().min(0).max(10).default(2),
      }),
      handler: async (args) => {
        await vaultService.sync();
        const query = String(args["query"]);
        const mode = (args["mode"] as string) ?? "fuzzy";
        const limit = (args["limit"] as number) ?? 20;
        const contextLines = (args["contextLines"] as number) ?? 2;

        const files = await vaultService.listMarkdown();
        const docs: { path: string; content: string }[] = [];
        for (const f of files.slice(0, 5000)) {
          try {
            docs.push({ path: f, content: await vaultService.readFile(f) });
          } catch {
            /* skip */
          }
        }

        if (mode === "exact") {
          const hits: {
            path: string;
            line: number;
            preview: string;
          }[] = [];
          for (const d of docs) {
            const lines = d.content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if ((lines[i] ?? "").toLowerCase().includes(query.toLowerCase())) {
                const start = Math.max(0, i - contextLines);
                const end = Math.min(lines.length, i + contextLines + 1);
                hits.push({
                  path: d.path,
                  line: i + 1,
                  preview: lines.slice(start, end).join("\n"),
                });
                if (hits.length >= limit) break;
              }
            }
            if (hits.length >= limit) break;
          }
          return formatTool({ ok: true, data: { mode, query, hits } });
        }

        const fuse = new Fuse(docs, {
          keys: [
            { name: "path", weight: 0.3 },
            { name: "content", weight: 0.7 },
          ],
          includeScore: true,
          threshold: 0.4,
          ignoreLocation: true,
        });
        const fuseResults = fuse.search(query, { limit });
        const hits = fuseResults.map((r) => ({
          path: r.item.path,
          score: r.score ?? 0,
          preview: r.item.content.slice(0, 240),
        }));
        return formatTool({ ok: true, data: { mode, query, hits } });
      },
    },
    {
      name: "write_note",
      description:
        "Create a new note or fully overwrite an existing one. Restricted to OBSIDIAN_WRITE_PATHS. For partial edits, prefer insert_at_heading, insert_at_text_match, or apply_patch.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      handler: async (args) => {
        const p = String(args["path"]);
        const content = String(args["content"]);
        await vaultService.writeFile(p, content);
        const sha = await vaultService.commitAndPush(`mcp: write ${p}`);
        return formatTool({ ok: true, data: { path: p, commit: sha } });
      },
    },
    {
      name: "append_to_note",
      description: "Append content to an existing note. Restricted to OBSIDIAN_WRITE_PATHS.",
      inputSchema: z.object({
        path: z.string(),
        content: z.string(),
      }),
      handler: async (args) => {
        await vaultService.sync();
        const p = String(args["path"]);
        const addition = String(args["content"]);
        const existing = (await vaultService.exists(p))
          ? await vaultService.readFile(p)
          : "";
        await vaultService.writeFile(p, appendContent(existing, addition));
        const sha = await vaultService.commitAndPush(`mcp: append ${p}`);
        return formatTool({ ok: true, data: { path: p, commit: sha } });
      },
    },
    {
      name: "delete_note",
      description: "Delete a note. Restricted to OBSIDIAN_WRITE_PATHS. Reversible via git history.",
      inputSchema: z.object({ path: z.string() }),
      handler: async (args) => {
        const p = String(args["path"]);
        await vaultService.deleteFile(p);
        const sha = await vaultService.commitAndPush(`mcp: delete ${p}`);
        return formatTool({ ok: true, data: { path: p, commit: sha } });
      },
    },
    {
      name: "move_note",
      description: "Move or rename a note. Both source and destination must be in OBSIDIAN_WRITE_PATHS.",
      inputSchema: z.object({
        from: z.string(),
        to: z.string(),
      }),
      handler: async (args) => {
        const from = String(args["from"]);
        const to = String(args["to"]);
        await vaultService.moveFile(from, to);
        const sha = await vaultService.commitAndPush(`mcp: move ${from} -> ${to}`);
        return formatTool({ ok: true, data: { from, to, commit: sha } });
      },
    },
    {
      name: "insert_at_heading",
      description:
        "Insert (or replace) content at a specific markdown heading. Use position='after' to add to the end of the section, 'before' to insert above the heading, 'replace' to overwrite the section body.",
      inputSchema: z.object({
        path: z.string(),
        heading: z.string(),
        content: z.string(),
        position: z.enum(["before", "after", "replace"]).default("after"),
      }),
      handler: async (args) => {
        await vaultService.sync();
        const p = String(args["path"]);
        const existing = await vaultService.readFile(p);
        const updated = insertAtHeading(
          existing,
          String(args["heading"]),
          String(args["content"]),
          (args["position"] as "before" | "after" | "replace") ?? "after",
        );
        await vaultService.writeFile(p, updated);
        const sha = await vaultService.commitAndPush(`mcp: edit heading in ${p}`);
        return formatTool({ ok: true, data: { path: p, commit: sha } });
      },
    },
    {
      name: "insert_at_block_id",
      description: "Insert (or replace) content at a specific Obsidian block id (e.g. ^abc123).",
      inputSchema: z.object({
        path: z.string(),
        blockId: z.string(),
        content: z.string(),
        position: z.enum(["before", "after", "replace"]).default("after"),
      }),
      handler: async (args) => {
        await vaultService.sync();
        const p = String(args["path"]);
        const existing = await vaultService.readFile(p);
        const updated = insertAtBlockId(
          existing,
          String(args["blockId"]),
          String(args["content"]),
          (args["position"] as "before" | "after" | "replace") ?? "after",
        );
        await vaultService.writeFile(p, updated);
        const sha = await vaultService.commitAndPush(`mcp: edit block in ${p}`);
        return formatTool({ ok: true, data: { path: p, commit: sha } });
      },
    },
    {
      name: "insert_at_text_match",
      description:
        "Insert content relative to an exact substring in a note. Use this when there is no convenient heading or block id.",
      inputSchema: z.object({
        path: z.string(),
        match: z.string(),
        content: z.string(),
        position: z.enum(["before", "after", "replace"]).default("after"),
      }),
      handler: async (args) => {
        await vaultService.sync();
        const p = String(args["path"]);
        const existing = await vaultService.readFile(p);
        const updated = insertAtTextMatch(
          existing,
          String(args["match"]),
          String(args["content"]),
          (args["position"] as "before" | "after" | "replace") ?? "after",
        );
        await vaultService.writeFile(p, updated);
        const sha = await vaultService.commitAndPush(`mcp: edit text in ${p}`);
        return formatTool({ ok: true, data: { path: p, commit: sha } });
      },
    },
    {
      name: "update_frontmatter",
      description:
        "Merge keys into the YAML frontmatter of a note. Existing keys are overwritten; other keys are preserved.",
      inputSchema: z.object({
        path: z.string(),
        updates: z.record(z.unknown()),
      }),
      handler: async (args) => {
        await vaultService.sync();
        const p = String(args["path"]);
        const existing = (await vaultService.exists(p))
          ? await vaultService.readFile(p)
          : "";
        const updated = updateFrontmatter(
          existing,
          (args["updates"] as Record<string, unknown>) ?? {},
        );
        await vaultService.writeFile(p, updated);
        const sha = await vaultService.commitAndPush(`mcp: frontmatter ${p}`);
        return formatTool({ ok: true, data: { path: p, commit: sha } });
      },
    },
    {
      name: "apply_patch",
      description:
        "Apply a unified diff patch to a note. Strict context matching. Read the note first, build the patch from current contents, then apply.",
      inputSchema: z.object({
        path: z.string(),
        patch: z.string(),
      }),
      handler: async (args) => {
        await vaultService.sync();
        const p = String(args["path"]);
        const existing = await vaultService.readFile(p);
        const updated = applyUnifiedPatch(existing, String(args["patch"]));
        await vaultService.writeFile(p, updated);
        const sha = await vaultService.commitAndPush(`mcp: patch ${p}`);
        return formatTool({ ok: true, data: { path: p, commit: sha } });
      },
    },
    {
      name: "list_notes",
      description: "List all markdown files in the vault, optionally under a subdirectory.",
      inputSchema: z.object({
        subdir: z.string().optional(),
      }),
      handler: async (args) => {
        await vaultService.sync();
        const files = await vaultService.listMarkdown(
          args["subdir"] ? String(args["subdir"]) : undefined,
        );
        return formatTool({ ok: true, data: { count: files.length, files } });
      },
    },
    {
      name: "list_directory",
      description: "List immediate files and subdirectories within a vault directory.",
      inputSchema: z.object({
        path: z.string().optional(),
      }),
      handler: async (args) => {
        await vaultService.sync();
        const result = await vaultService.listDir(
          args["path"] ? String(args["path"]) : undefined,
        );
        return formatTool({ ok: true, data: result });
      },
    },
    {
      name: "create_directory",
      description: "Create a new directory in the vault. Restricted to OBSIDIAN_WRITE_PATHS.",
      inputSchema: z.object({ path: z.string() }),
      handler: async (args) => {
        const p = String(args["path"]);
        await vaultService.createDirectory(p);
        const sha = await vaultService.commitAndPush(`mcp: mkdir ${p}`);
        return formatTool({ ok: true, data: { path: p, commit: sha } });
      },
    },
    {
      name: "add_tag",
      description: "Add a tag to a note's frontmatter (creates frontmatter if missing).",
      inputSchema: z.object({
        path: z.string(),
        tag: z.string(),
      }),
      handler: async (args) => {
        await vaultService.sync();
        const p = String(args["path"]);
        const existing = await vaultService.readFile(p);
        const updated = addTagToContent(existing, String(args["tag"]));
        await vaultService.writeFile(p, updated);
        const sha = await vaultService.commitAndPush(`mcp: add_tag ${p}`);
        return formatTool({ ok: true, data: { path: p, commit: sha } });
      },
    },
    {
      name: "remove_tag",
      description: "Remove a tag from a note (frontmatter and inline #tag references).",
      inputSchema: z.object({
        path: z.string(),
        tag: z.string(),
      }),
      handler: async (args) => {
        await vaultService.sync();
        const p = String(args["path"]);
        const existing = await vaultService.readFile(p);
        const updated = removeTagFromContent(existing, String(args["tag"]));
        await vaultService.writeFile(p, updated);
        const sha = await vaultService.commitAndPush(`mcp: remove_tag ${p}`);
        return formatTool({ ok: true, data: { path: p, commit: sha } });
      },
    },
    {
      name: "rename_tag",
      description:
        "Rename a tag across the entire vault. Touches every note containing the tag and commits a single batched change.",
      inputSchema: z.object({
        from: z.string(),
        to: z.string(),
      }),
      handler: async (args) => {
        await vaultService.sync();
        const fromTag = String(args["from"]).replace(/^#/, "");
        const toTag = String(args["to"]).replace(/^#/, "");
        const files = await vaultService.listMarkdown();
        const touched: string[] = [];
        for (const f of files) {
          const c = await vaultService.readFile(f);
          if (!c.includes(fromTag)) continue;
          const without = removeTagFromContent(c, fromTag);
          const renamed = addTagToContent(without, toTag);
          if (renamed !== c) {
            try {
              await vaultService.writeFile(f, renamed);
              touched.push(f);
            } catch (err) {
              logger.warn({ file: f, err: (err as Error).message }, "rename_tag skipped (write not allowed)");
            }
          }
        }
        const sha = touched.length
          ? await vaultService.commitAndPush(`mcp: rename_tag ${fromTag} -> ${toTag}`)
          : null;
        return formatTool({ ok: true, data: { renamed: touched.length, commit: sha, touched } });
      },
    },
    {
      name: "list_tags",
      description: "List every tag found across the vault with usage counts.",
      inputSchema: z.object({}),
      handler: async () => {
        await vaultService.sync();
        const counts = new Map<string, number>();
        const files = await vaultService.listMarkdown();
        for (const f of files) {
          const c = await vaultService.readFile(f);
          const inline = c.match(/(?<=^|\s)#[A-Za-z0-9/_-]+/g) ?? [];
          for (const t of inline) {
            const k = t.replace(/^#/, "");
            counts.set(k, (counts.get(k) ?? 0) + 1);
          }
          const fmMatch = /^---\n([\s\S]*?)\n---/.exec(c);
          if (fmMatch) {
            const tagLine = /^tags:\s*\[(.*)\]/m.exec(fmMatch[1] ?? "");
            if (tagLine) {
              const items = tagLine[1]!
                .split(",")
                .map((s) => s.trim().replace(/^"|"$/g, ""))
                .filter(Boolean);
              for (const t of items) counts.set(t, (counts.get(t) ?? 0) + 1);
            }
          }
        }
        const tags = Array.from(counts.entries())
          .map(([tag, count]) => ({ tag, count }))
          .sort((a, b) => b.count - a.count);
        return formatTool({ ok: true, data: { count: tags.length, tags } });
      },
    },
    {
      name: "log_journal_entry",
      description:
        "Append a free-form journal entry to today's daily note. Use this for general notes, observations, or reflections that should land in the journal but are not specifically about an activity Claude performed. Creates the daily note from JOURNAL_PATH_TEMPLATE if it does not exist.",
      inputSchema: z.object({
        entry: z.string().describe("One-paragraph journal entry."),
      }),
      handler: async (args) => {
        const data = await writeJournal({
          line: `- ${new Date().toISOString()} — ${String(args["entry"])}`,
          underActivityHeading: false,
        });
        return formatTool({ ok: true, data });
      },
    },
    {
      name: "add_journal_activity",
      description:
        "Record an activity Claude just performed on the user's behalf, under today's daily note '## Activity' section. Use this any time you make changes to the vault so there is an audit trail (e.g. 'Refactored the index of 03-Areas/Health.md and added two new headings').",
      inputSchema: z.object({
        activity: z
          .string()
          .describe("Short past-tense description of what Claude did."),
      }),
      handler: async (args) => {
        const data = await writeJournal({
          line: `- ${new Date().toISOString()} — ${String(args["activity"])}`,
          underActivityHeading: true,
        });
        return formatTool({ ok: true, data });
      },
    },
  ];
}

async function writeJournal(opts: {
  line: string;
  underActivityHeading: boolean;
}): Promise<{ path: string; commit: string | null }> {
  await vaultService.sync();
  const cfg = getConfig();
  const dateStr = todayString(cfg.journal.dateFormat);
  const journalPath = cfg.journal.pathTemplate.replace("{{date}}", dateStr);

  const seed = `# ${dateStr}\n\n${cfg.journal.activitySection}\n\n`;
  const existing = (await vaultService.exists(journalPath))
    ? await vaultService.readFile(journalPath)
    : seed;

  let updated: string;
  if (opts.underActivityHeading) {
    if (existing.includes(cfg.journal.activitySection)) {
      updated = insertAtHeading(
        existing,
        cfg.journal.activitySection.replace(/^#+\s*/, ""),
        opts.line,
        "after",
      );
    } else {
      updated = appendContent(
        existing,
        `${cfg.journal.activitySection}\n\n${opts.line}`,
      );
    }
  } else {
    updated = appendContent(existing, opts.line);
  }

  await vaultService.writeFile(journalPath, updated);
  const sha = await vaultService.commitAndPush(
    `mcp: journal ${path.basename(journalPath)}`,
  );
  return { path: journalPath, commit: sha };
}
