import { VaultError } from "./service";

export function insertAtHeading(
  content: string,
  heading: string,
  insertText: string,
  position: "before" | "after" | "replace" = "after",
): string {
  const lines = content.split("\n");
  const headingTrim = heading.trim();
  let idx = -1;
  let level = 0;

  for (let i = 0; i < lines.length; i++) {
    const m = /^(#{1,6})\s+(.*)$/.exec(lines[i] ?? "");
    if (m && m[2]?.trim() === headingTrim) {
      idx = i;
      level = m[1]!.length;
      break;
    }
  }

  if (idx === -1) {
    throw new VaultError(
      `Heading "${heading}" not found.`,
      "Read the note first to confirm the exact heading text, or use insert_at_text_match instead.",
    );
  }

  if (position === "before") {
    lines.splice(idx, 0, insertText, "");
    return lines.join("\n");
  }

  let endIdx = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const m = /^(#{1,6})\s+/.exec(lines[i] ?? "");
    if (m && m[1]!.length <= level) {
      endIdx = i;
      break;
    }
  }

  if (position === "replace") {
    lines.splice(idx + 1, endIdx - idx - 1, insertText);
    return lines.join("\n");
  }

  // after: insert at end of section
  while (endIdx > idx + 1 && (lines[endIdx - 1] ?? "").trim() === "") {
    endIdx--;
  }
  lines.splice(endIdx, 0, insertText);
  return lines.join("\n");
}

export function insertAtBlockId(
  content: string,
  blockId: string,
  insertText: string,
  position: "before" | "after" | "replace" = "after",
): string {
  const lines = content.split("\n");
  const marker = `^${blockId.replace(/^\^/, "")}`;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] ?? "").includes(marker)) {
      idx = i;
      break;
    }
  }
  if (idx === -1) {
    throw new VaultError(`Block id "${blockId}" not found.`);
  }
  if (position === "replace") {
    lines.splice(idx, 1, insertText);
  } else if (position === "before") {
    lines.splice(idx, 0, insertText);
  } else {
    lines.splice(idx + 1, 0, insertText);
  }
  return lines.join("\n");
}

export function insertAtTextMatch(
  content: string,
  match: string,
  insertText: string,
  position: "before" | "after" | "replace" = "after",
): string {
  const idx = content.indexOf(match);
  if (idx === -1) {
    throw new VaultError(
      `Text "${match}" not found in note.`,
      "Read the note first to confirm the exact text or use search_vault to locate it.",
    );
  }
  if (position === "replace") {
    return content.slice(0, idx) + insertText + content.slice(idx + match.length);
  }
  if (position === "before") {
    return content.slice(0, idx) + insertText + "\n" + content.slice(idx);
  }
  const endIdx = idx + match.length;
  return content.slice(0, endIdx) + "\n" + insertText + content.slice(endIdx);
}

export function updateFrontmatter(
  content: string,
  updates: Record<string, unknown>,
): string {
  const fmRegex = /^---\n([\s\S]*?)\n---\n?/;
  const m = fmRegex.exec(content);
  const existing: Record<string, unknown> = {};
  let body = content;

  if (m) {
    body = content.slice(m[0].length);
    const fmText = m[1] ?? "";
    for (const line of fmText.split("\n")) {
      const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      if (kv) {
        existing[kv[1]!] = kv[2];
      }
    }
  }

  const merged = { ...existing, ...updates };
  const fmLines: string[] = [];
  for (const [k, v] of Object.entries(merged)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      fmLines.push(`${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`);
    } else if (typeof v === "object") {
      fmLines.push(`${k}: ${JSON.stringify(v)}`);
    } else {
      fmLines.push(`${k}: ${String(v)}`);
    }
  }
  return `---\n${fmLines.join("\n")}\n---\n${body.startsWith("\n") ? body.slice(1) : body}`;
}

export function appendContent(content: string, addition: string): string {
  if (content.length === 0) return addition;
  if (content.endsWith("\n\n")) return content + addition;
  if (content.endsWith("\n")) return content + "\n" + addition;
  return content + "\n\n" + addition;
}

/**
 * Apply a unified diff patch. Strict matching — context lines must match exactly.
 * Supports a single hunk per call against the most common diff shape:
 *   @@ ... @@
 *    context
 *   -removed
 *   +added
 *
 * The output uses the content's dominant newline style. If content contains
 * CRLF anywhere, LF-only patch hunks are applied and the result is normalized
 * to CRLF so Windows checkouts do not fail context matching.
 */
export function applyUnifiedPatch(content: string, patch: string): string {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(/\r?\n/);
  const patchLines = patch.split(/\r?\n/);
  const result = [...lines];

  let i = 0;
  while (i < patchLines.length) {
    const line = patchLines[i] ?? "";
    if (!line.startsWith("@@")) {
      i++;
      continue;
    }
    const hunkHeader = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
    if (!hunkHeader) {
      throw new VaultError(`Malformed hunk header: ${line}`);
    }
    const startLine = Number(hunkHeader[1]) - 1;
    let cursor = startLine;
    i++;
    while (i < patchLines.length && !(patchLines[i] ?? "").startsWith("@@")) {
      const pl = patchLines[i] ?? "";
      const tag = pl[0];
      const text = pl.slice(1);
      if (tag === " " || pl === "") {
        if ((result[cursor] ?? "") !== text && pl !== "") {
          throw new VaultError(
            `Patch context mismatch at line ${cursor + 1}: expected "${text}", found "${result[cursor] ?? ""}"`,
            "Read the file fresh and regenerate the patch with current context.",
          );
        }
        cursor++;
      } else if (tag === "-") {
        if ((result[cursor] ?? "") !== text) {
          throw new VaultError(
            `Patch removal mismatch at line ${cursor + 1}: expected "${text}", found "${result[cursor] ?? ""}"`,
          );
        }
        result.splice(cursor, 1);
      } else if (tag === "+") {
        result.splice(cursor, 0, text);
        cursor++;
      }
      i++;
    }
  }
  return result.join(newline);
}

export function addTagToContent(content: string, tag: string): string {
  const cleanTag = tag.replace(/^#/, "");
  const fmRegex = /^---\n([\s\S]*?)\n---\n?/;
  const m = fmRegex.exec(content);
  if (m) {
    const fmText = m[1] ?? "";
    const tagLineMatch = /^tags:\s*(.*)$/m.exec(fmText);
    if (tagLineMatch) {
      const value = tagLineMatch[1] ?? "";
      const arrMatch = /^\[(.*)\]$/.exec(value.trim());
      if (arrMatch) {
        const items = arrMatch[1]!
          .split(",")
          .map((s) => s.trim().replace(/^"|"$/g, ""))
          .filter(Boolean);
        if (!items.includes(cleanTag)) items.push(cleanTag);
        const newLine = `tags: [${items.map((t) => JSON.stringify(t)).join(", ")}]`;
        return content.replace(/^tags:\s*.*$/m, newLine);
      }
    }
    return updateFrontmatter(content, { tags: [cleanTag] });
  }
  return updateFrontmatter(content, { tags: [cleanTag] });
}

export function removeTagFromContent(content: string, tag: string): string {
  const cleanTag = tag.replace(/^#/, "");
  let out = content.replace(new RegExp(`(^|\\s)#${cleanTag}\\b`, "g"), "$1");
  const fmRegex = /^---\n([\s\S]*?)\n---\n?/;
  const m = fmRegex.exec(out);
  if (m) {
    const fmText = m[1] ?? "";
    const tagLineMatch = /^tags:\s*\[(.*)\]$/m.exec(fmText);
    if (tagLineMatch) {
      const items = tagLineMatch[1]!
        .split(",")
        .map((s) => s.trim().replace(/^"|"$/g, ""))
        .filter((t) => t && t !== cleanTag);
      const newLine = `tags: [${items.map((t) => JSON.stringify(t)).join(", ")}]`;
      out = out.replace(/^tags:\s*\[.*\]$/m, newLine);
    }
  }
  return out;
}
