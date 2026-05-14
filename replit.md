# obsidian-mcp-railway

Remote MCP server that exposes a git-backed Obsidian vault to Claude.ai (web), Claude iOS, and Claude Code CLI. The vault lives in a private GitHub repo; the server runs on Railway 24/7 so the vault is reachable even when the owner's Desktop is off.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — build + run the MCP server in HTTP mode (port from `PORT`)
- `pnpm --filter @workspace/api-server run start:stdio` — run in stdio mode for Claude Code CLI
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- See `artifacts/api-server/OPERATIONS.md` for the full env var reference, Railway setup, and PAT rotation runbook.

## Stack

- pnpm workspaces, Node.js 20+, TypeScript 5.9
- API: Express 5 + `@modelcontextprotocol/sdk` (Streamable HTTP transport)
- Git ops: `simple-git` against a persistent volume at `/vault-cache`
- Auth: OAuth 2.0 + PKCE (single-user, in-memory session store)
- Logging: structured JSON via `pino`
- Build: esbuild (single bundled `dist/index.mjs`)
- Deploy: Railway (Dockerfile + `railway.toml` with `/vault-cache` volume)

## Where things live

- MCP tools: `artifacts/api-server/src/mcp/tools.ts` (18 tools)
- MCP HTTP transport: `artifacts/api-server/src/mcp/transport.ts`
- MCP stdio entrypoint: `artifacts/api-server/src/mcp/stdio.ts`
- Git-backed vault service: `artifacts/api-server/src/vault/service.ts`
- Surgical edit helpers (heading/block/text/frontmatter/patch): `artifacts/api-server/src/vault/edits.ts`
- OAuth 2.0 + PKCE: `artifacts/api-server/src/oauth/`
- Health check: `artifacts/api-server/src/routes/health.ts`
- Runtime config: `artifacts/api-server/src/lib/config.ts`
- Deployment: `artifacts/api-server/Dockerfile`, `artifacts/api-server/railway.toml`
- Operations runbook: `artifacts/api-server/OPERATIONS.md`

## Architecture decisions

- **Source of truth is GitHub.** Desktop, Railway volume, and any client are caches. Sync every 10 min from Desktop via the Obsidian Git plugin.
- **Single-writer pattern.** Desktop pushes; iOS Obsidian Git is disabled; mobile capture goes through Claude/MCP only. Avoids cross-writer merge conflicts.
- **Every Claude write is a git commit** pushed to GitHub immediately — fully reversible via `git revert`.
- **In-memory OAuth sessions** instead of DynamoDB. Healthcheck-driven Railway restart handles process death.
- **Write-path allowlist (`OBSIDIAN_WRITE_PATHS`)** plus rolling `MAX_WRITES_PER_HOUR` rate limit are the safety net against runaway tool calls.
- **`obsidian_execute_command` is intentionally not implemented** (too much blast radius — vault contents only).

## Product

Single-user remote MCP server. Tools: read/write notes (single + batch), search (fuzzy via fuse.js + exact with context), surgical edits (heading/block-id/text-match/frontmatter/unified-diff patch), tag management (add/remove/rename/list), directory operations, and dated journal logging. All write operations are scoped to capture folders and rate-limited per session.

## User preferences

- No emojis anywhere in UI, logs, or JSON responses.
- No partial/degraded healthcheck states — `/api/healthz` returns either 200 OK (every check passing) or 500.
- Every error message must suggest the next action (no dead-end errors).

## Gotchas

- `dev` workflow will fail to start without `VAULT_REPO_URL`, `GITHUB_PAT`, `OAUTH_CLIENT_SECRET`, `SESSION_ENCRYPTION_KEY`, and `PERSONAL_AUTH_TOKEN`. This is expected — the server is meant to run on Railway. For local stdio testing, set the same env vars and run `start:stdio`.
- Railway PAT rotation: see `OPERATIONS.md` — must update the Sealed Variable AND trigger a redeploy so the in-memory git remote URL refreshes.
- Claude.ai/iOS remote MCP UI is still maturing — daily reconnects may be needed. Claude Code CLI is the rock-solid path.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.
- Inspiration: https://github.com/eddmann/obsidian-mcp (MIT licensed; tool surface adapted, AWS Lambda/DynamoDB stripped in favor of Railway + persistent volume).
