import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { VaultError } from "./errors";

/**
 * Pure write-path enforcement. Every write operation must funnel through
 * here — the rules are:
 *   1. Path must not traverse outside the vault cache (`..`, absolute paths,
 *      URL-encoded variants, Windows separators).
 *   2. Resolved path's nearest existing ancestor must realpath back inside
 *      the cache (no symlink escape).
 *   3. Path must lie under one of the configured `OBSIDIAN_WRITE_PATHS`
 *      allowlist entries; an empty allowlist rejects everything.
 *
 * Functions that just inspect a string are pure and synchronous so they
 * can be hammered with property tests; the symlink check is async because
 * it needs to touch the filesystem.
 */

/** Normalize a candidate path to a vault-relative posix string. */
export function normalizeRelativePath(relPath: string): string {
  // Convert backslashes first so a Windows-style "\foo" gets stripped
  // by the leading-slash collapse below.
  return relPath.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Build a descriptive VaultError for a rejected write, naming the allowlist
 * and giving the user a concrete next action.
 */
export function buildWriteRejection(
  relPath: string,
  allowedPaths: readonly string[],
): VaultError {
  const list =
    allowedPaths.length === 0
      ? "(none — OBSIDIAN_WRITE_PATHS is empty, all writes are rejected)"
      : allowedPaths.join(", ");
  const hint =
    allowedPaths.length === 0
      ? "Set OBSIDIAN_WRITE_PATHS on Railway to a comma-separated list of folders the server may write to (e.g. '00-Inbox,Journal')."
      : `Allowed write paths: ${list}. Either choose a path inside one of those folders, or update the OBSIDIAN_WRITE_PATHS environment variable on Railway.`;
  return new VaultError(
    `Write rejected: "${relPath}" is outside the allowed write paths.`,
    hint,
  );
}

/** True when `relPath` lies inside one of the allowlist entries. */
export function isWriteAllowed(
  relPath: string,
  allowedPaths: readonly string[],
): boolean {
  if (allowedPaths.length === 0) return false;
  const cleaned = normalizeRelativePath(relPath);
  if (cleaned === "" || cleaned === "/") return false;
  if (containsTraversal(cleaned)) return false;
  return allowedPaths.some((allowedRaw) => {
    const allowed = allowedRaw.replace(/^\/+/, "").replace(/\/+$/, "");
    if (allowed === "") return false;
    return cleaned === allowed || cleaned.startsWith(allowed + "/");
  });
}

/** Throws a descriptive `VaultError` if `relPath` is outside the allowlist. */
export function assertWriteAllowed(
  relPath: string,
  allowedPaths: readonly string[],
): void {
  if (!isWriteAllowed(relPath, allowedPaths)) {
    throw buildWriteRejection(relPath, allowedPaths);
  }
}

/**
 * True if `cleaned` contains a parent-traversal sequence in any common
 * encoding (literal `..`, `%2e%2e` / `%2E%2E`, mixed `.%2e`).
 */
export function containsTraversal(cleaned: string): boolean {
  if (cleaned.includes("..")) return true;
  // URL-encoded dots (any case).
  const lowered = cleaned.toLowerCase();
  if (lowered.includes("%2e%2e")) return true;
  if (lowered.includes(".%2e")) return true;
  if (lowered.includes("%2e.")) return true;
  return false;
}

/**
 * Resolve `relPath` against `cacheDir` and assert the result stays inside
 * the cache. Synchronous string-level guard — does not touch the filesystem.
 */
export function resolveSafePath(cacheDir: string, relPath: string): string {
  const cleaned = normalizeRelativePath(relPath);

  if (containsTraversal(cleaned)) {
    throw new VaultError(
      `Invalid path: "${relPath}" — parent traversal is not allowed.`,
      "Use a path relative to the vault root (e.g. '00-Inbox/note.md').",
    );
  }

  // Reject embedded NUL bytes outright.
  if (cleaned.includes("\0")) {
    throw new VaultError(
      `Invalid path: "${relPath}" contains a NUL byte.`,
      "Use a plain UTF-8 path relative to the vault root.",
    );
  }

  const abs = path.resolve(cacheDir, cleaned);
  if (abs !== cacheDir && !abs.startsWith(cacheDir + path.sep)) {
    throw new VaultError(
      `Invalid path: "${relPath}" escapes the vault root.`,
      "Use a path relative to the vault root.",
    );
  }
  return abs;
}

/**
 * Walk up the path until we find an existing ancestor, then assert its
 * `realpath` is inside `realpath(cacheDir)`. Catches symlink escapes where
 * a directory inside the cache points to somewhere outside.
 */
export async function assertNoSymlinkEscape(
  cacheDir: string,
  abs: string,
): Promise<void> {
  const realCache = await fsp.realpath(cacheDir);
  // Walk up to the nearest existing ancestor and check ITS realpath.
  // The cache dir itself always exists (init() mkdir's it), and abs is
  // always rooted under cacheDir thanks to resolveSafePath, so the
  // walk is guaranteed to terminate on cacheDir at the latest.
  let probe = abs;
  while (!fs.existsSync(probe)) {
    probe = path.dirname(probe);
  }
  const realProbe = await fsp.realpath(probe);
  if (realProbe !== realCache && !realProbe.startsWith(realCache + path.sep)) {
    throw new VaultError(
      `Write rejected: "${abs}" resolves outside the vault root via a symlink.`,
      "Remove the symlink from the vault cache or restrict OBSIDIAN_WRITE_PATHS so it cannot reach it.",
    );
  }
}
