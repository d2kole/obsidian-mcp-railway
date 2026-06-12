# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

All commands run from the monorepo root or filtered to the api-server workspace:

```bash
# Install dependencies
pnpm install

# Build (esbuild, outputs to artifacts/api-server/dist/)
pnpm --filter @workspace/api-server run build

# Dev server (builds then runs with local ephemeral git repo via dev-bootstrap.sh)
pnpm --filter @workspace/api-server run dev

# TypeScript typecheck only
pnpm --filter @workspace/api-server run typecheck

# Run all tests (unit + integration; excludes e2e)
pnpm --filter @workspace/api-server test

# Run a single test file
pnpm --filter @workspace/api-server exec vitest run src/vault/service.test.ts

# Watch mode
pnpm --filter @workspace/api-server run test:watch

# Coverage report
pnpm --filter @workspace/api-server run test:coverage

# Full verification gate (lint + typecheck + unit + integration + e2e) — required before merge/deploy
pnpm --filter @workspace/api-server run verify:all

# Per-feature coverage gates (each has its own threshold floor)
pnpm --filter @workspace/api-server run verify:vault
pnpm --filter @workspace/api-server run verify:write-path
pnpm --filter @workspace/api-server run verify:rate-limit
pnpm --filter @workspace/api-server run verify:oauth
pnpm --filter @workspace/api-server run verify:tools
pnpm --filter @workspace/api-server run verify:routes

# E2E (Playwright)
pnpm --filter @workspace/api-server run test:e2e
```

`verify:all` is the **pre-merge gate** — never merge without a green run. Railway redeploys on every push to the watched branch; there is no automatic deploy gate on CI status.

> `lint` is currently a no-op stub (no ESLint wired yet — see `TESTING.md`); `verify:all` runs `node ./scripts/verify.mjs`, not the npm-script chain literally. The shippable artifact is **only** `@workspace/api-server` — `artifacts/mockup-sandbox` is a design scratchpad, not deployed.

## Monorepo & toolchain constraints

This is a pnpm workspace (`packageManager: pnpm@11.1.2`), not a single package. The api-server consumes two workspace libraries via `workspace:*` — changing their public API requires rebuilding the consumer:

- `lib/api-zod` (`@workspace/api-zod`) — shared Zod schemas
- `lib/db` (`@workspace/db`) — Drizzle ORM layer

`lib/*` packages typecheck through TypeScript project references (`pnpm run typecheck:libs` = `tsc --build`); the root `typecheck` runs that first, then the per-package typechecks. Build the libs before the server when their types change.

Hard constraints (enforced by tooling — do not work around them):

- **pnpm only.** The root `preinstall` hook aborts if invoked via npm/yarn. Never generate `package-lock.json`/`yarn.lock`.
- **`minimumReleaseAge: 1440` in `pnpm-workspace.yaml`** blocks installing any npm package version less than 1 day old (supply-chain defense). Do not lower or remove it; add to `minimumReleaseAgeExclude` only for a trusted publisher when truly urgent.
- esbuild and Tailwind/rollup/lightningcss native binaries are pinned to **linux-x64 only** via `overrides` (Railway target). Don't add other-platform binaries.
- `pnpm secret-scan` (root) runs the repo's secret scanner; a Husky `prepare` hook wires `.husky` git hooks.

The MCP server has **two transports**: `start:http` (Streamable HTTP, the Railway/production path) and `start:stdio` (local stdio). The entrypoint `dist/index.mjs` dispatches on the `http`/`stdio` argv.

## Architecture

```
Desktop Obsidian (Obsidian Git plugin)
        │  push every 10 min
        ▼
GitHub repo (private, single branch: main)
        ▲                                ▲
        │  push on every Claude write    │  pull --rebase before every tool call
        │                                │
Railway service  ◄──── /vault-cache ────►
   ▲              (persistent volume)
   │  HTTPS + OAuth 2.0 + PKCE + Streamable HTTP (MCP)
   │
Claude.ai web · Claude iOS · Claude Code CLI
```

**Source of truth: GitHub.** The Railway volume is a hot cache, not the canonical store. Desktop is the only automatic writer; Claude/MCP writes are the only other writer. Simultaneous writes from both are the concurrency scenario to watch for.

## Key files

| File                                           | Role                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `artifacts/api-server/src/vault/service.ts`    | `VaultService` — git clone/pull/push, file I/O, the `sync()` call that runs before every tool        |
| `artifacts/api-server/src/vault/write-path.ts` | Pure write-path allowlist enforcement (path traversal, symlink escape, `OBSIDIAN_WRITE_PATHS`)       |
| `artifacts/api-server/src/mcp/tools.ts`        | All MCP tool definitions (`buildTools()`). `WRITE_TOOLS` set gates rate-limit and `sync()` placement |
| `artifacts/api-server/src/mcp/server.ts`       | Wires tools into `@modelcontextprotocol/sdk` `McpServer`                                             |
| `artifacts/api-server/src/mcp/transport.ts`    | Streamable HTTP transport, session management (in-memory map), MCP router                            |
| `artifacts/api-server/src/mcp/rateLimit.ts`    | Per-session rolling-window write cap (`MAX_WRITES_PER_HOUR`)                                         |
| `artifacts/api-server/src/oauth/`              | OAuth 2.0 + PKCE single-user flow; `store.ts` persists tokens to volume                              |
| `artifacts/api-server/src/lib/config.ts`       | `loadConfig()` / `getConfig()` — singleton from env vars                                             |
| `artifacts/api-server/src/routes/health.ts`    | `/api/healthz` — vault cache present + git fetch dry-run + MCP mounted                               |
| `artifacts/api-server/OPERATIONS.md`           | All env vars, PAT rotation, volume DR, admin token endpoints, Pushover alerting                      |

## Sync strategy (critical)

`VaultService.sync()` is called at the top of **every** tool handler that reads the vault. Write tools call it before reading the existing file content (so the patch is applied to the latest revision), then call `commitAndPush()` after the write.

The sync uses `git pull --rebase origin main`. This means:

- Any local commits that aren't on origin (e.g. from a previous MCP write that pushed successfully) are replayed on top of the fresh remote state.
- If Desktop pushes while Railway is idle, the next tool call fast-forwards cleanly via rebase.
- True content conflicts (same line edited both by Desktop and by a prior MCP commit) cause `rebase` to exit non-zero. The error is caught and surfaced as a `VaultError` with a hint to delete `/vault-cache` and let the server re-clone.

`VAULT_SYNC_MIN_INTERVAL_MS` (default `0`) throttles sync in dev to avoid hammering a local git remote — leave it at `0` on Railway.

## Write-path allowlist

`OBSIDIAN_WRITE_PATHS` (comma-separated, e.g. `00-Inbox,Journal`) is the only gate between Claude and the vault. Default is **empty → read-only**. All write tools call `assertWriteAllowed()` before touching the filesystem. `rename_tag` pre-flight checks every file in the batch before writing any of them.

## Rate limiting

`MAX_WRITES_PER_HOUR` (default `20`) is an in-memory per-session rolling-window counter. It is not shared across instances (single-instance Railway deployment). The counter is keyed by OAuth access token hash, not by session ID.

## OAuth / auth

Single-user. `PERSONAL_AUTH_TOKEN` is the password typed into the login form. `OAUTH_CLIENT_SECRET` and `SESSION_ENCRYPTION_KEY` sign tokens. Revoking all sessions = rotate those two secrets and redeploy. Revoking a single device = `POST /admin/tokens/<jti>/revoke` with `Authorization: Bearer $PERSONAL_AUTH_TOKEN`.

## Coverage floors (enforced by verify:all)

| Module                | Lines / Statements | Branches |
| --------------------- | ------------------ | -------- |
| vault service + edits | 90%                | 80%      |
| write-path            | 95%                | 95%      |
| rate-limit            | 95%                | 95%      |
| oauth                 | 90%                | 90%      |
| tools                 | 85%                | 70%      |
| routes + transport    | 80%                | 65%      |
| project-wide          | 80%                | 75%      |

## Environment variables (required on Railway)

`VAULT_REPO_URL`, `GITHUB_PAT`, `OAUTH_CLIENT_SECRET`, `SESSION_ENCRYPTION_KEY`, `PERSONAL_AUTH_TOKEN`, `BASE_URL`. See `artifacts/api-server/OPERATIONS.md` for the full table including optional vars.
