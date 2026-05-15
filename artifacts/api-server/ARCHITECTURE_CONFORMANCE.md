# Architecture Conformance Report

**Codebase:** `artifacts/api-server`
**Design doc:** Obsidian Remote MCP Design Doc, May 12 2026 (`attached_assets/Pasted--Obsidian-Remote-MCP-Design-Doc-Owner-Joe-d2kole-Status_1778810471638.txt`)
**Audit date:** May 15 2026
**Scope:** Read-only. No code changes. Findings drive follow-up tasks.

Status values: **PRESENT** · **PARTIAL** · **MISSING** · **DIVERGENT**

---

## 1. Transport & Protocol

| Element | Status | Evidence | Note |
|---|---|---|---|
| Streamable HTTP MCP transport | **PRESENT** | `src/mcp/transport.ts` | Uses `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` |
| stdio transport (Claude Code CLI) | **PRESENT** | `src/mcp/stdio.ts`, `src/index.ts` | `node dist/index.mjs stdio` |
| Express HTTP framework | **PRESENT** | `src/app.ts` | Express 5 |
| Node 20 runtime | **PRESENT** | `Dockerfile` line 1: `FROM node:20-alpine` | |
| TypeScript strict | **PRESENT** | `tsconfig.json` | |

---

## 2. OAuth 2.0 + PKCE

| Element | Status | Evidence | Note |
|---|---|---|---|
| OAuth 2.0 authorization code flow | **PRESENT** | `src/oauth/routes.ts` lines 152-283 | GET + POST `/oauth/authorize` |
| PKCE S256-only | **PRESENT** | `src/oauth/routes.ts:187, 264` | Rejects non-S256 with 400 |
| Token endpoint | **PRESENT** | `src/oauth/routes.ts:285-341` | `/oauth/token` |
| Dynamic client registration (RFC 7591) | **PRESENT** | `src/oauth/routes.ts:138-149` | `/oauth/register` stub |
| RFC 8414 discovery | **PRESENT** | `src/oauth/routes.ts:111-124` | `/.well-known/oauth-authorization-server` |
| OAuth protected resource discovery | **PRESENT** | `src/oauth/routes.ts:127-135` | `/.well-known/oauth-protected-resource` |
| HS256 JWT access tokens via `jose` | **PRESENT** | `src/oauth/store.ts` | Keyed by `OAUTH_CLIENT_SECRET` + `SESSION_ENCRYPTION_KEY` |
| Access token TTL (default 24 h) | **PRESENT** | `src/lib/config.ts:96` | `OAUTH_ACCESS_TOKEN_TTL_SEC` |
| Single-user personal access token login form | **PRESENT** | `src/oauth/routes.ts:198-231` | HTML form, `/oauth/authorize` POST validates `PERSONAL_AUTH_TOKEN` |
| `requireAccessToken` middleware on `/mcp` | **PRESENT** | `src/mcp/transport.ts:43` | |
| Admin token list + revoke endpoints | **PRESENT** | `src/oauth/routes.ts:347-380` | `/admin/tokens`, `/admin/tokens/:jti/revoke` |

---

## 3. Git-backed Vault Sync

| Element | Status | Evidence | Note |
|---|---|---|---|
| Clone on cold start | **PRESENT** | `src/vault/service.ts:29-56` | Clones if `VAULT_CACHE_DIR` has no `.git` |
| Pull on each tool read call | **PRESENT** | `src/vault/service.ts:96-125` | `sync()` called in every read-tool handler |
| Push on each tool write call | **PRESENT** | `src/vault/service.ts:136-155` | `commitAndPush()` called in every write-tool handler |
| `simple-git` library | **PRESENT** | `package.json` | |
| PAT injected into remote URL | **PRESENT** | `src/vault/service.ts:37-42` | `https://<PAT>@github.com/...` pattern |
| `/vault-cache` persistent volume | **PRESENT** | `railway.toml` `[[deploy.volumes]]`, `Dockerfile ENV VAULT_CACHE_DIR=/vault-cache` | |
| `VAULT_SYNC_MIN_INTERVAL_MS` throttle | **PRESENT** | `src/vault/service.ts:27` | Optional, default 0 (sync every call) |
| `dryRunFetch` for healthcheck | **PRESENT** | `src/vault/service.ts:127-134` | `git fetch --dry-run` |

---

## 4. Write-path Allowlist

| Element | Status | Evidence | Note |
|---|---|---|---|
| `OBSIDIAN_WRITE_PATHS` env var | **PRESENT** | `src/lib/config.ts:83` | Defaults to `[]` (read-only when unset) |
| Per-tool allowlist check before any write | **PRESENT** | `src/vault/write-path.ts`, called in every write-tool handler | |
| Error payload names the denied path and allowlist | **PRESENT** | `src/vault/errors.ts` `WritePathError` | `allowed_paths` field in MCP error |

---

## 5. Rate Limiter

| Element | Status | Evidence | Note |
|---|---|---|---|
| `MAX_WRITES_PER_HOUR` cap | **PRESENT** | `src/mcp/rateLimit.ts`, `src/lib/config.ts:103` | Default 20 |
| Per-session (per OAuth token) isolation | **PRESENT** | `src/mcp/rateLimit.ts` | Keyed by SHA-256 of bearer token |
| Error payload with `retry_after_seconds` | **PRESENT** | `src/mcp/rateLimit.ts` `buildRateLimitRejection()` | |

---

## 6. Healthcheck

| Element | Status | Evidence | Note |
|---|---|---|---|
| `/api/healthz` endpoint | **PRESENT** | `src/routes/health.ts` | |
| Binary 200/500 response | **PRESENT** | `src/routes/health.ts:82` | |
| `vault_cache_present` check | **PRESENT** | `src/routes/health.ts:22-41` | |
| `git_fetch_dry_run` check (400 ms cap) | **PRESENT** | `src/routes/health.ts:44-63` | |
| `mcp_handler_registered` check | **PRESENT** | `src/routes/health.ts:66-73` | |
| Railway healthcheck configured | **PRESENT** | `railway.toml:healthcheckPath = "/api/healthz"` | |
| Docker `HEALTHCHECK` | **PRESENT** | `Dockerfile` line 35-37 | `wget -qO- .../api/healthz` |

---

## 7. Logging & Observability

| Element | Status | Evidence | Note |
|---|---|---|---|
| `pino` JSON structured logging | **PRESENT** | `src/lib/logger.ts`, `pino-http` in `src/app.ts` | |
| Secret redaction before logging | **PRESENT** | `src/lib/redact.ts` | Strips `GITHUB_PAT`, OAuth secrets, basic-auth-in-URL |
| MCP tool inventory logged on startup | **PRESENT** | `src/mcp/server.ts` | Logs all 21 tool names + write/read classification |
| Pushover alerting (server-side helper) | **MISSING** | — | Design doc listed "Pushover webhook helper" as Phase 2 item. Implemented via GitHub Actions (`.github/workflows/healthz-monitor.yml`, `healthz-heartbeat.yml`) rather than in the server process. Functional but diverges from the doc's implied in-process implementation. |

---

## 8. Deploy Configuration

| Element | Status | Evidence | Note |
|---|---|---|---|
| Multi-stage Dockerfile | **PRESENT** | `artifacts/api-server/Dockerfile` | `deps → build → runtime` stages |
| `railway.toml` | **PRESENT** | `artifacts/api-server/railway.toml` | |
| `tini` init process | **PRESENT** | `Dockerfile:RUN apk add ... tini`, `ENTRYPOINT ["/sbin/tini", "--"]` | |
| Restart policy | **PRESENT** | `railway.toml:restartPolicyType = "ON_FAILURE"` | |
| esbuild bundling (single-file dist) | **PRESENT** | `build.mjs` | Produces `dist/index.mjs` |

---

## 9. MCP Tools

The design doc cites the **upstream `eddmann/obsidian-mcp`** tool surface (18 tools, kebab-case names). This server implements a custom tool set with more granular variants and snake_case names.

### Registered tools (21)

| # | Tool name | Read/Write | Design-doc equivalent |
|---|---|---|---|
| 1 | `read_note` | read | `read-note` |
| 2 | `read_notes` | read | `read-notes` |
| 3 | `search_vault` | read | `search-vault` |
| 4 | `write_note` | write | `create-note` + `edit-note` |
| 5 | `append_to_note` | write | `append-content` |
| 6 | `delete_note` | write | `delete-note` |
| 7 | `move_note` | write | `move-note` |
| 8 | `insert_at_heading` | write | (not in upstream) |
| 9 | `insert_at_block_id` | write | (not in upstream) |
| 10 | `insert_at_text_match` | write | (not in upstream) |
| 11 | `update_frontmatter` | write | (not in upstream) |
| 12 | `apply_patch` | write | `apply-diff-patch` / `patch-content` |
| 13 | `list_notes` | read | `list-files-in-vault` |
| 14 | `list_directory` | read | `list-files-in-dir` |
| 15 | `create_directory` | write | `create-directory` |
| 16 | `add_tag` | write | part of `manage-tags` |
| 17 | `remove_tag` | write | part of `manage-tags` |
| 18 | `rename_tag` | write | `rename-tag` |
| 19 | `list_tags` | read | (not in upstream) |
| 20 | `log_journal_entry` | write | `log-journal-entry` |
| 21 | `add_journal_activity` | write | (not in upstream) |

### Tool surface divergences

| Item | Status | Note |
|---|---|---|
| Tool count | **DIVERGENT** | Design doc says 18 (upstream); implementation has 21 (more granular insert/frontmatter/journal tools) |
| Tool naming | **DIVERGENT** | Design doc uses kebab-case (`read-note`); implementation uses snake_case (`read_note`) |
| `manage-tags` (upstream) | **DIVERGENT** | Replaced by `add_tag` + `remove_tag` + `rename_tag` + `list_tags` (more granular) |
| `obsidian_execute_command` | **PRESENT** | Explicitly disabled — not registered. Matches design intent. |
| `vault-readme` MCP resource | **PRESENT** | `src/mcp/server.ts:177-204` — registered as `obsidian://vault-readme` if `README.md` exists |

---

## 10. Environment Variable Name Mapping

The design doc (Phase 1) specifies variable names that differ from what the code actually reads. This table maps them.

| Design doc name | Code name | Status |
|---|---|---|
| `VAULT_REPO` | `VAULT_REPO_URL` | **DIVERGENT** — code uses full `_URL` suffix |
| `GIT_TOKEN` | `GITHUB_PAT` | **DIVERGENT** — code uses `GITHUB_PAT` |
| `OAUTH_CLIENT_SECRET` | `OAUTH_CLIENT_SECRET` | **PRESENT** — same |
| `OAUTH_CLIENT_ID` | `OAUTH_CLIENT_ID` | **PRESENT** — same |
| `PERSONAL_AUTH_TOKEN` | `PERSONAL_AUTH_TOKEN` | **PRESENT** — same |
| `BASE_URL` | `BASE_URL` | **PRESENT** — same |
| _(not in design)_ | `SESSION_ENCRYPTION_KEY` | **DIVERGENT** — added; signs JWT sessions |
| _(not in design)_ | `VAULT_BRANCH` | **DIVERGENT** — added; default `main` |
| _(not in design)_ | `VAULT_CACHE_DIR` | **DIVERGENT** — added; default `/vault-cache` |
| _(not in design)_ | `OBSIDIAN_WRITE_PATHS` | **DIVERGENT** — Phase 2 feature, documented |
| _(not in design)_ | `MAX_WRITES_PER_HOUR` | **DIVERGENT** — Phase 2 feature, documented |

---

## 11. Phase 1 vs Phase 2 Conformance

### Phase 1 — "deploy as-is" (upstream Docker image)

| Item | Status | Note |
|---|---|---|
| Deploy upstream `ghcr.io/eddmann/obsidian-mcp:latest` | **DIVERGENT** | Decision was made to build a custom TypeScript server instead of using the upstream image. This is a deliberate scope expansion: the custom server implements all Phase 2 hardening from the start. |

### Phase 2 — hardening items

| Item | Status | Note |
|---|---|---|
| Railway-friendly Dockerfile | **PRESENT** | `artifacts/api-server/Dockerfile` |
| SQLite session store | **DIVERGENT** | Design specified SQLite; implementation uses a JSON file store (`src/oauth/store.ts`). Functional equivalent: both persist to the `/vault-cache` volume and survive restarts. SQLite would be more robust under concurrent writes, but this server is single-user. |
| `/healthz` endpoint | **PRESENT** | At `/api/healthz` |
| Rate limiter (`MAX_WRITES_PER_HOUR`) | **PRESENT** | `src/mcp/rateLimit.ts` |
| Write-path allowlist (`OBSIDIAN_WRITE_PATHS`) | **PRESENT** | `src/vault/write-path.ts` |
| Structured JSON logging via `pino` | **PRESENT** | `src/lib/logger.ts` |
| Pushover webhook helper | **PARTIAL** | Alerting works via GitHub Actions; no in-process Pushover call. |

---

## 12. Operational Status (at audit date)

| Item | Status |
|---|---|
| API Server Replit workflow | **RUNNING** — fixed by `scripts/dev-bootstrap.sh` (local file:// vault) |
| `/api/healthz` in dev | **200 OK** — all three checks pass against the local dev vault |
| Railway source repo | **NOT YET CONFIGURED** — `RAILWAY_SETUP.md` provides the setup steps; user must create `obsidian-mcp-railway` GitHub repo and reconnect Railway to it |
| Real `VAULT_REPO_URL` / `GITHUB_PAT` | **NOT SET** — dev bootstrap uses local placeholders; production secrets must be added in Railway |

---

## 13. Gaps & Follow-up Tasks (titles only)

1. **Rename env vars to match design doc** — rename `VAULT_REPO_URL → VAULT_REPO` and `GITHUB_PAT → GIT_TOKEN` for consistency with the design doc, or update the design doc to reflect the chosen names.
2. **Replace JSON OAuth store with SQLite** — aligns with the Phase 2 spec; adds robustness if the store file is ever corrupted.
3. **Add `manage-tags` tool alias** — expose `manage-tags` as a single dispatch tool that delegates to `add_tag`/`remove_tag`/`rename_tag` for upstream compatibility.
4. **In-process Pushover helper** — move the Pushover notification call into the server (called from the healthcheck or a startup hook) so alerting works even if the GitHub Actions monitor fails.
5. **Railway setup & real credentials** — follow `RAILWAY_SETUP.md` to create the GitHub repo, push code, and configure production env vars.
6. **Align tool name casing** — decide between kebab-case (design doc / upstream) and snake_case (current implementation); update `OPERATIONS.md` and `PRD.md` to reflect the final choice.
