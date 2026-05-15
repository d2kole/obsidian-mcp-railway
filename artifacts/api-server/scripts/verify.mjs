#!/usr/bin/env node
import { readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const pkg = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));

const EXPECTED = [
  "verify:vault",
  "verify:write-path",
  "verify:rate-limit",
  "verify:oauth",
  "verify:tools",
  "verify:routes",
  "verify:e2e:write",
  "verify:e2e:oauth",
  "verify:e2e:failure",
];

const present = Object.keys(pkg.scripts ?? {}).filter(
  (s) => s.startsWith("verify:") && s !== "verify:all" && s !== "verify:test-infra",
);
const missing = EXPECTED.filter((s) => !present.includes(s));
if (missing.length > 0) {
  console.error(
    `verify:all gate failure — package.json is missing required verify scripts:\n  ${missing.join("\n  ")}\n` +
      `Add each one before re-running. Hint: each TDD task must add its own verify:<feature> script (see TESTING.md).`,
  );
  process.exit(2);
}

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const evidenceDir = path.join(pkgRoot, "tests", ".evidence");
mkdirSync(evidenceDir, { recursive: true });
const evidencePath = path.join(evidenceDir, `${ts}.log`);

const t0 = Date.now();
const results = [];

// SKIP_PLAYWRIGHT=1 — opt-out for environments without system libs needed by
// Chromium (e.g. Replit's NixOS sandbox lacks libglib-2.0). CI installs the
// deps via `playwright install --with-deps` so this should NEVER be set there.
const skipPlaywright = process.env.SKIP_PLAYWRIGHT === "1";
const PLAYWRIGHT_SCRIPTS = new Set(["verify:e2e:oauth"]);

for (const scriptName of EXPECTED) {
  if (skipPlaywright && PLAYWRIGHT_SCRIPTS.has(scriptName)) {
    console.log(
      `\n========== ${scriptName} SKIPPED (SKIP_PLAYWRIGHT=1) ==========`,
    );
    results.push({
      script: scriptName,
      ok: true,
      skipped: true,
      code: 0,
      ms: 0,
      stdout: "skipped (SKIP_PLAYWRIGHT=1)\n",
      stderr: "",
    });
    continue;
  }
  // Clear v8 coverage scratch between vitest runs — back-to-back invocations
  // race on `coverage/.tmp/coverage-*.json` and emit an Unhandled Rejection
  // even when every test passes. Wiping the temp dir up front fixes it.
  try {
    rmSync(path.join(pkgRoot, "coverage", ".tmp"), {
      recursive: true,
      force: true,
    });
  } catch {
    // best-effort
  }
  const featureT0 = Date.now();
  console.log(`\n========== ${scriptName} ==========`);
  const proc = spawnSync("pnpm", ["run", scriptName], {
    cwd: pkgRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    encoding: "utf8",
  });
  const ms = Date.now() - featureT0;
  const ok = proc.status === 0;
  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  results.push({
    script: scriptName,
    ok,
    code: proc.status,
    ms,
    stdout,
    stderr,
  });
  console.log(`---------- ${scriptName} ${ok ? "PASS" : "FAIL"} (${ms}ms) ----------`);
}

const totalMs = Date.now() - t0;
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;

const header =
  `verify:all evidence log\n` +
  `timestamp: ${new Date().toISOString()}\n` +
  `total: ${results.length}  passed: ${passed}  failed: ${failed}  wall: ${totalMs}ms\n` +
  `\nSummary:\n` +
  results
    .map(
      (r) =>
        `  ${r.skipped ? "SKIP" : r.ok ? "PASS" : "FAIL"}  ${r.script.padEnd(24)} ${r.ms}ms`,
    )
    .join("\n") +
  `\n\n========== full output ==========\n`;

const body = results
  .map(
    (r) =>
      `\n----- ${r.script} (${r.ok ? "PASS" : "FAIL"}, exit ${r.code}, ${r.ms}ms) -----\n` +
      `[stdout]\n${r.stdout}\n[stderr]\n${r.stderr}\n`,
  )
  .join("\n");

writeFileSync(evidencePath, header + body, "utf8");

console.log(`\n========== verify:all summary ==========`);
console.log(`  ${passed}/${results.length} passed in ${totalMs}ms`);
console.log(`  evidence: ${path.relative(pkgRoot, evidencePath)}`);

if (failed > 0) {
  console.error(`\nverify:all FAILED — ${failed} feature(s) red. See evidence above.`);
  process.exit(1);
}
console.log(`verify:all PASSED`);
