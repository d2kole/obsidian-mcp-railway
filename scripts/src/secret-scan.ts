#!/usr/bin/env node
/**
 * secret-scan — portable secret scanner used by both the local pre-commit
 * hook and CI. No external binary required (no gitleaks install on dev
 * machines), so the local + CI behaviour is identical.
 *
 * Usage:
 *   tsx scripts/src/secret-scan.ts --staged   # scan staged hunks (pre-commit)
 *   tsx scripts/src/secret-scan.ts --all      # scan every tracked file (CI)
 *
 * Exit codes:
 *   0 — clean
 *   1 — at least one finding (block the commit / fail CI)
 *   2 — invocation/environment error (e.g. not a git repo)
 *
 * Allowlist (so the scanner stays useful, not noisy):
 *   - Add the literal marker `secret-scan: allow` on the same line as a
 *     deliberate placeholder/test token.
 *   - Add a path glob to `.secretscanignore` (one per line, # for comments)
 *     to skip whole files (test fixtures, evidence logs, etc).
 *   - Built-in placeholder allowlist below catches the obvious dummies
 *     (`stdio-not-used`, `your-token-here`, etc).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";

interface Finding {
  file: string;
  line: number;
  rule: string;
  preview: string;
}

interface Rule {
  name: string;
  re: RegExp;
}

const RULES: Rule[] = [
  { name: "github-pat-classic", re: /\bghp_[A-Za-z0-9]{36,}\b/ },
  { name: "github-pat-fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{82,}\b/ },
  { name: "github-oauth-token", re: /\bgho_[A-Za-z0-9]{36,}\b/ },
  { name: "github-app-token", re: /\bghs_[A-Za-z0-9]{36,}\b/ },
  { name: "github-refresh-token", re: /\bghr_[A-Za-z0-9]{36,}\b/ },
  { name: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "aws-secret-access-key", re: /\baws_secret_access_key\s*=\s*["']?[A-Za-z0-9/+=]{40}["']?/i },
  { name: "openai-api-key", re: /\bsk-[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,}\b/ },
  { name: "anthropic-api-key", re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{40,}\b/ },
  { name: "slack-token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "stripe-secret-key", re: /\bsk_live_[A-Za-z0-9]{20,}\b/ },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "private-key-block", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { name: "basic-auth-in-url", re: /https?:\/\/[^\s/:@]+:([^\s/@]{8,})@/ },
  { name: "jwt-token", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

const PLACEHOLDER_ALLOWLIST: RegExp[] = [
  /stdio-not-used/i,
  /your[-_ ]?(?:token|secret|key|password)[-_ ]?here/i,
  /<your[-_ ].*?>/i,
  /xxxxxxxx/i,
  /placeholder/i,
  /example\.com/i,
  /dummy[-_ ]?(?:token|secret|key)/i,
  // Conventional `.env.example`-style values
  /=\s*"?(?:changeme|replace[-_ ]?me|todo)"?\s*$/i,
];

const ALLOW_MARKER = /secret-scan:\s*allow/i;

// Always-skip paths (no-brainers — test evidence, build output, lock files,
// and our own scanner / ignore file). Patterns are simple substring matches
// against the repo-relative path with forward slashes.
const HARD_SKIP_SUBSTRINGS = [
  "node_modules/",
  "/dist/",
  "/coverage/",
  "/.git/",
  "/tests/.evidence/",
  "/tests/.tmp/",
  "/playwright-report/",
  "/test-results/",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "scripts/src/secret-scan.ts",
  ".secretscanignore",
];

function git(args: string[], opts: { cwd?: string } = {}): string {
  // execFileSync without a shell — argv is passed directly to git(1), so
  // filenames containing shell metacharacters (`$()`, backticks, `;`, …)
  // cannot trigger shell expansion. This is load-bearing security: the
  // scanner runs on untrusted PR content in CI.
  return execFileSync("git", args, {
    encoding: "utf8",
    cwd: opts.cwd,
    maxBuffer: 64 * 1024 * 1024,
  });
}

function repoRoot(): string {
  return git(["rev-parse", "--show-toplevel"]).trim();
}

function loadIgnoreGlobs(root: string): string[] {
  const file = join(root, ".secretscanignore");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

function matchesGlob(path: string, glob: string): boolean {
  // Minimal glob — `*` -> `[^/]*`, `**` -> `.*`. Good enough for ignore lists.
  const re = new RegExp(
    "^" +
      glob
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "::DOUBLESTAR::")
        .replace(/\*/g, "[^/]*")
        .replace(/::DOUBLESTAR::/g, ".*") +
      "$",
  );
  return re.test(path);
}

function shouldSkip(relPath: string, ignoreGlobs: string[]): boolean {
  const normalized = "/" + relPath.replace(/\\/g, "/");
  for (const sub of HARD_SKIP_SUBSTRINGS) {
    if (normalized.includes(sub)) return true;
  }
  const cleaned = relPath.replace(/\\/g, "/");
  return ignoreGlobs.some((g) => matchesGlob(cleaned, g));
}

function isAllowed(line: string): boolean {
  if (ALLOW_MARKER.test(line)) return true;
  return PLACEHOLDER_ALLOWLIST.some((re) => re.test(line));
}

function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isAllowed(line)) continue;
    for (const rule of RULES) {
      if (rule.re.test(line)) {
        findings.push({
          file,
          line: i + 1,
          rule: rule.name,
          preview: line.length > 160 ? line.slice(0, 157) + "..." : line,
        });
      }
    }
  }
  return findings;
}

function listStagedFiles(root: string): string[] {
  const out = git(
    ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
    { cwd: root },
  );
  return out.split("\0").filter((s) => s.length > 0);
}

function listAllTrackedFiles(root: string): string[] {
  const out = git(["ls-files", "-z"], { cwd: root });
  return out.split("\0").filter((s) => s.length > 0);
}

function readStagedBlob(root: string, path: string): string | null {
  // `git show :<path>` — `path` is passed as a separate argv element, so a
  // filename containing shell metacharacters cannot trigger expansion.
  // The leading `--` guards against a filename that starts with `-` being
  // interpreted as a git option.
  try {
    return git(["show", "--", `:${path}`], { cwd: root });
  } catch {
    return null;
  }
}

function readWorkingFile(root: string, path: string): string | null {
  const abs = join(root, path);
  if (!existsSync(abs)) return null;
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    if (st.size > 5 * 1024 * 1024) return null; // skip huge binaries
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const mode: "staged" | "all" = args.has("--all") ? "all" : "staged";

  let root: string;
  try {
    root = repoRoot();
  } catch {
    console.error("secret-scan: not a git repository");
    process.exit(2);
  }

  const ignoreGlobs = loadIgnoreGlobs(root);
  const files = mode === "staged" ? listStagedFiles(root) : listAllTrackedFiles(root);
  if (files.length === 0) {
    process.exit(0);
  }

  const findings: Finding[] = [];
  for (const file of files) {
    const rel = relative(root, join(root, file));
    if (shouldSkip(rel, ignoreGlobs)) continue;
    const text =
      mode === "staged" ? readStagedBlob(root, file) : readWorkingFile(root, file);
    if (text == null) continue;
    findings.push(...scanText(file, text));
  }

  if (findings.length === 0) {
    console.log(`secret-scan: clean (${files.length} file(s) scanned, mode=${mode})`);
    process.exit(0);
  }

  console.error(`\nsecret-scan: ${findings.length} potential secret(s) found:\n`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}  [${f.rule}]`);
    console.error(`    ${f.preview}\n`);
  }
  console.error(
    "If a finding is a deliberate placeholder or test value, append `secret-scan: allow` to the line, or add the path to .secretscanignore. Real secrets must be removed and rotated before committing.\n",
  );
  process.exit(1);
}

main();
