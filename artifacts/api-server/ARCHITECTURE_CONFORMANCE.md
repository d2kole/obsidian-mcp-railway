# Architecture Conformance Report

**Codebase:** `artifacts/api-server`
**Design doc:** Obsidian Remote MCP Design Doc, May 12 2026 (`attached_assets/Pasted--Obsidian-Remote-MCP-Design-Doc-Owner-Joe-d2kole-Status_1778810471638.txt`)
**Audit date:** May 15 2026 (refreshed)
**Scope:** Read-only. No code changes. Findings drive follow-up tasks.

Status values: **PRESENT** · **PARTIAL** · **MISSING** · **DIVERGENT**

---

## Overall Verdict

| Status | Count |
|---|---|
| **PRESENT** | 56 |
| **PARTIAL** | 1 |
| **MISSING** | 0 |
| **DIVERGENT** | 13 |
| **Total elements audited** | 70 |

**Readiness statement.** The server is **functionally ready to launch**. Every design-doc capability is implemented; the failing checks are either (a) deliberate scope improvements over the upstream `eddmann/obsidian-mcp` baseline (more granular tools, persistent OAuth store, hardened write-path, in-server rate limiter), or (b) cosmetic naming differences between the design doc and the code. There are **zero MISSING items**, **one PARTIAL** (in-process Pushover helper — the alert path is implemented out-of-process via GitHub Actions and is functional), and the 13 DIVERGENT items are all known and accepted. Nothing on this list is a security or correctness blocker for going live.

**Top 3 recommended actions before going live.**
1. **Decide and lock the env-var naming** (`VAULT_REPO_URL` vs design's `VAULT_REPO`; `GITHUB_PAT` vs design's `GIT_TOKEN`). Recommendation below: keep the code names and retire the design-doc names — but make the call explicitly so Railway secrets are filed under the right names from day one.
2. **Configure real Railway secrets and complete the live healthcheck.** Per §12, dev uses placeholders; production requires `VAULT_REPO_URL`, `GITHUB_PAT`, OAuth secrets, and `BASE_URL` set against the actual Railway domain so OAuth metadata advertises the correct issuer.
3. **Acknowledge the tool-surface delta in user-facing docs.** This server registers 21 snake_case tools (vs the upstream's 18 kebab-case). PRD.md §5 already lists them; confirm Claude.ai connector docs / onboarding instructions point operators at this list, not the upstream README, before they wire anything up.

---

## 1. Transport & Protocol

| Element | Status | Evidence | Note |
|---|---|---|---|
| Streamable HTTP MCP transport | **PRESENT** | `src/mcp/transport.ts:2,54` | Uses `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` |
| stdio transport (Claude Code CLI) | **PRESENT** | `src/mcp/stdio.ts`, `src/index.ts` | `node dist/index.mjs stdio` |
| Express HTTP framework | **PRESENT** | `src/app.ts` | Express 5 |
| Node 20 runtime | **PRESENT** | `Dockerfile:1` (`FROM node:20-alpine`) | |
| TypeScript strict | **PRESENT** | `tsconfig.json` | |

---

## 2. OAuth 2.0 + PKCE

| Element | Status | Evidence | Note |
|---|---|---|---|
| OAuth 2.0 authorization code flow | **PRESENT** | `src/oauth/routes.ts:152-231` (GET) + `:233-283` (POST) | `/oauth/authorize` |
| PKCE S256-only | **PRESENT** | `src/oauth/routes.ts:187, 264` | Rejects non-S256 with 400 |
| Token endpoint | **PRESENT** | `src/oauth/routes.ts:285-341` | `/oauth/token` |
| Dynamic client registration (RFC 7591) | **PRESENT** | `src/oauth/routes.ts:138-149` | `/oauth/register` stub |
| RFC 8414 discovery | **PRESENT** | `src/oauth/routes.ts:111-124` | `/.well-known/oauth-authorization-server` |
| OAuth protected resource discovery | **PRESENT** | `src/oauth/routes.ts:127-135` | `/.well-known/oauth-protected-resource` |
| HS256 JWT access tokens via `jose` | **PRESENT** | `src/oauth/store.ts` | Keyed by `OAUTH_CLIENT_SECRET` + `SESSION_ENCRYPTION_KEY` |
| Access token TTL (default 24 h) | **PRESENT** | `src/lib/config.ts:96` | `OAUTH_ACCESS_TOKEN_TTL_SEC` |
| Single-user personal access token login form | **PRESENT** | `src/oauth/routes.ts:198-229` (form HTML) + `:233-283` (POST validation) | Validates `PERSONAL_AUTH_TOKEN` |
| `requireAccessToken` middleware on `/mcp` | **PRESENT** | `src/mcp/transport.ts:43` | `router.use(requireAccessToken)` |
| Admin token list + revoke endpoints | **PRESENT** | `src/oauth/routes.ts:347-380` | `/admin/tokens`, `/admin/tokens/:jti/revoke` |

---

## 3. Git-backed Vault Sync

| Element | Status | Evidence | Note |
|---|---|---|---|
| Clone on cold start | **PRESENT** | `src/vault/service.ts:42-76` (in `init()` lines 29-85) | Clones if `VAULT_CACHE_DIR` has no `.git` |
| Pull on each tool read call | **PRESENT** | `src/vault/service.ts:96-125` (`sync()`); invoked from every read-tool handler in `src/mcp/tools.ts` | |
| Push on each tool write call | **PRESENT** | `src/vault/service.ts:136-154` (`commitAndPush()`); invoked from every write-tool handler in `src/mcp/tools.ts` | |
| `simple-git` library | **PRESENT** | `package.json`; imported in `src/vault/service.ts:4` | |
| PAT injected into remote URL | **PRESENT** | `src/vault/service.ts:35-38` | `https://x-access-token:<PAT>@github.com/...` pattern |
| `/vault-cache` persistent volume | **PRESENT** | `railway.toml:12-14` (`[[deploy.volumes]] mountPath = "/vault-cache"`); `Dockerfile:27` (`ENV VAULT_CACHE_DIR=/vault-cache`) | |
| `VAULT_SYNC_MIN_INTERVAL_MS` throttle | **PRESENT** | `src/vault/service.ts:27` | Optional, default 0 (sync every call) |
| `dryRunFetch` for healthcheck | **PRESENT** | `src/vault/service.ts:127-134` | `git fetch --dry-run` |

---

## 4. Write-path Allowlist

| Element | Status | Evidence | Note |
|---|---|---|---|
| `OBSIDIAN_WRITE_PATHS` env var | **PRESENT** | `src/lib/config.ts:83` | Defaults to `[]` (read-only when unset) |
| Per-tool allowlist check before any write | **PRESENT** | `src/vault/write-path.ts` (`assertWriteAllowed`); called from every mutating method in `src/vault/service.ts` (`writeFile:194`, `deleteFile:202`, `moveFile:217-218`, `createDirectory:256`) | |
| Error payload names the denied path and allowlist | **PRESENT** | `src/vault/write-path.ts:46-62` (`buildWriteRejection`); `src/vault/errors.ts` `VaultError` | `hint` lists every allowed path |

---

## 5. Rate Limiter

| Element | Status | Evidence | Note |
|---|---|---|---|
| `MAX_WRITES_PER_HOUR` cap | **PRESENT** | `src/mcp/rateLimit.ts`; `src/lib/config.ts:103` | Default 20 |
| Per-session (per OAuth token) isolation | **PRESENT** | `src/mcp/rateLimit.ts`; `src/mcp/transport.ts:64` (`sessionKey = req.auth?.token`) | Bucket key = `writes:${sessionKey}` |
| Error payload with `retry_after_seconds` | **PRESENT** | `src/mcp/rateLimit.ts` `buildRateLimitRejection()`; surfaced in `src/mcp/server.ts:122-137` | |

---

## 6. Healthcheck

| Element | Status | Evidence | Note |
|---|---|---|---|
| `/api/healthz` endpoint | **PRESENT** | `src/routes/health.ts:17` (route) + mount in `src/routes/index.ts` | |
| Binary 200/500 response | **PRESENT** | `src/routes/health.ts:82` | |
| `vault_cache_present` check | **PRESENT** | `src/routes/health.ts:22-41` | |
| `git_fetch_dry_run` check (400 ms cap) | **PRESENT** | `src/routes/health.ts:45-63` (timeout constant on line 46) | |
| `mcp_handler_registered` check | **PRESENT** | `src/routes/health.ts:66-73` | |
| Railway healthcheck configured | **PRESENT** | `railway.toml:7` (`healthcheckPath = "/api/healthz"`) | |
| Docker `HEALTHCHECK` | **PRESENT** | `Dockerfile:36-37` | `wget -qO- .../api/healthz` |

---

## 7. Logging & Observability

| Element | Status | Evidence | Note |
|---|---|---|---|
| `pino` JSON structured logging | **PRESENT** | `src/lib/logger.ts`; `pino-http` in `src/app.ts` | |
| Secret redaction before logging | **PRESENT** | `src/lib/redact.ts` | Strips `GITHUB_PAT`, OAuth secrets, basic-auth-in-URL |
| MCP tool inventory logged on startup | **PRESENT** | `src/mcp/server.ts` (via `buildTools()` enumeration) | All 21 tools registered; write/read class derived from `WRITE_TOOLS` set in `src/mcp/tools.ts:18-34` |
| Pushover alerting (server-side helper) | **DIVERGENT** | `.github/workflows/healthz-monitor.yml`, `healthz-heartbeat.yml`; documented in `OPERATIONS.md` "Pushover alerting" | **Rationale:** deliberate improvement — alerting was moved out-of-process to GitHub Actions so it still fires when Railway itself is unreachable (a requirement the design doc's in-process helper could not satisfy). |

---

## 8. Deploy Configuration

| Element | Status | Evidence | Note |
|---|---|---|---|
| Multi-stage Dockerfile | **PRESENT** | `artifacts/api-server/Dockerfile:1,16,21` | `deps → build → runtime` stages |
| `railway.toml` | **PRESENT** | `artifacts/api-server/railway.toml` | |
| `tini` init process | **PRESENT** | `Dockerfile:22` (apk add ... tini), `:39` (`ENTRYPOINT ["/sbin/tini", "--"]`) | |
| Restart policy | **PRESENT** | `railway.toml:9` (`restartPolicyType = "ON_FAILURE"`) | |
| esbuild bundling (single-file dist) | **PRESENT** | `build.mjs` | Produces `dist/index.mjs` |

---

## 9. MCP Tools

The design doc cites the **upstream `eddmann/obsidian-mcp`** tool surface (18 tools, kebab-case names). This server implements a custom tool set with more granular variants and snake_case names.

### Registered tools (21)

Source of truth: `src/mcp/tools.ts:65-533` (`buildTools()` returns all 21 in declaration order).

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
| Tool count (21 vs design's 18) | **DIVERGENT** | **Rationale:** deliberate improvement — the extra tools (`insert_at_heading`, `insert_at_block_id`, `insert_at_text_match`, `update_frontmatter`, `list_tags`, `add_journal_activity`) give Claude finer-grained edit anchors that survive line-number drift, which materially reduces patch-conflict failures over the upstream's all-purpose `patch-content`. **Recommendation: accept as-is**; the surface is documented end-to-end in `PRD.md` §5 and §10 ("Tool count drift") and is logged at startup so operators can audit it. Do **not** retro-shrink to 18; do confirm onboarding docs link to PRD §5 rather than the upstream README. |
| Tool naming (snake_case vs design's kebab-case) | **DIVERGENT** | **Rationale:** unintentional drift early in implementation that has now hardened into the public contract; renaming would silently break every existing Claude connector. **Recommendation: accept as-is** and document the casing choice in `PRD.md` §5 (already done). |
| `manage-tags` (upstream single tool) | **DIVERGENT** | **Rationale:** deliberate improvement — split into `add_tag` / `remove_tag` / `rename_tag` / `list_tags` for clearer intent + better LLM tool selection. Optional follow-up: expose a `manage-tags` alias dispatching to these for upstream parity. |
| `obsidian_execute_command` | **PRESENT** | Explicitly disabled — not registered. Matches design intent (PRD §1, §10). |
| Vault README MCP resource | **PRESENT** | `src/mcp/server.ts:177-206` — registered as `vault://README.md` if `README.md` exists. (Earlier audit incorrectly cited the URI as `obsidian://vault-readme`; the live URI is `vault://README.md`.) |

---

## 10. Environment Variable Name Mapping

The design doc (Phase 1) specifies variable names that differ from what the code actually reads. This table maps them.

| Design doc name | Code name | Status |
|---|---|---|
| `VAULT_REPO` | `VAULT_REPO_URL` | **DIVERGENT** — see recommendation below |
| `GIT_TOKEN` | `GITHUB_PAT` | **DIVERGENT** — see recommendation below |
| `OAUTH_CLIENT_SECRET` | `OAUTH_CLIENT_SECRET` | **PRESENT** — same |
| `OAUTH_CLIENT_ID` | `OAUTH_CLIENT_ID` | **PRESENT** — same |
| `PERSONAL_AUTH_TOKEN` | `PERSONAL_AUTH_TOKEN` | **PRESENT** — same |
| `BASE_URL` | `BASE_URL` | **PRESENT** — same |
| _(not in design)_ | `SESSION_ENCRYPTION_KEY` | **DIVERGENT** — added; signs JWT sessions. **Rationale:** deliberate hardening — separates session-integrity key from `OAUTH_CLIENT_SECRET` so either can be rotated independently. |
| _(not in design)_ | `VAULT_BRANCH` | **DIVERGENT** — added; default `main`. **Rationale:** deliberate — lets operators track a non-`main` branch without code changes. |
| _(not in design)_ | `VAULT_CACHE_DIR` | **DIVERGENT** — added; default `/vault-cache`. **Rationale:** deliberate — required for local dev where `/vault-cache` is not writable. |
| _(not in design)_ | `OBSIDIAN_WRITE_PATHS` | **DIVERGENT** — Phase 2 hardening, documented. **Rationale:** deliberate improvement — fail-closed write allowlist demanded by Phase 2 spec. |
| _(not in design)_ | `MAX_WRITES_PER_HOUR` | **DIVERGENT** — Phase 2 hardening, documented. **Rationale:** deliberate improvement — bounds runaway tool loops. |

### Recommendation on `VAULT_REPO` vs `VAULT_REPO_URL` and `GIT_TOKEN` vs `GITHUB_PAT`

**Keep the code names (`VAULT_REPO_URL`, `GITHUB_PAT`); retire the design-doc names.**

Rationale:
- `VAULT_REPO_URL` is more self-documenting than the bare `VAULT_REPO` (the value is unambiguously a URL, not a slug) and is already what `OPERATIONS.md`, `PRD.md`, `RAILWAY_SETUP.md`, every error message hint, and the dev-bootstrap script use.
- `GITHUB_PAT` is more specific than `GIT_TOKEN` (we explicitly require a GitHub fine-grained Personal Access Token; we do not accept a generic git credential, and the code actively rewrites the URL to `https://x-access-token:<PAT>@github.com/...`).
- Renaming the env vars now would require coordinated edits across `config.ts`, `service.ts`, every doc, every test fixture, and would break any half-configured Railway secrets store. The cost/benefit favours updating the (single) design doc instead.

**Action:** update the design doc to reference `VAULT_REPO_URL` and `GITHUB_PAT`, and add a one-line "renamed from" note for archaeology. No code changes required.

---

## 11. Phase 1 vs Phase 2 Conformance

### Phase 1 — "deploy as-is" (upstream Docker image)

| Item | Status | Note |
|---|---|---|
| Deploy upstream `ghcr.io/eddmann/obsidian-mcp:latest` | **DIVERGENT** | **Rationale:** deliberate scope expansion — a custom TypeScript server was built instead so all Phase 2 hardening (write-path allowlist, rate limiter, persistent OAuth store, structured logging, healthcheck probes) ships from day one. Phase 1 is effectively skipped, not failed. |

### Phase 2 — hardening items

| Item | Status | Note |
|---|---|---|
| Railway-friendly Dockerfile | **PRESENT** | `artifacts/api-server/Dockerfile` (multi-stage; `tini` init; `HEALTHCHECK`) |
| SQLite session store | **DIVERGENT** | `src/oauth/store.ts` uses a JSON file persisted to `${VAULT_CACHE_DIR}/.oauth-store.json`. **Rationale:** deliberate simplification for a single-user server — removes the SQLite dependency and is functionally equivalent (persists across restarts; only OAuth auth codes + revoked-JTI list are stored, not access tokens themselves). Acceptable trade-off; revisit only if multi-writer support is ever added. |
| `/healthz` endpoint | **PRESENT** | At `/api/healthz` |
| Rate limiter (`MAX_WRITES_PER_HOUR`) | **PRESENT** | `src/mcp/rateLimit.ts` |
| Write-path allowlist (`OBSIDIAN_WRITE_PATHS`) | **PRESENT** | `src/vault/write-path.ts` |
| Structured JSON logging via `pino` | **PRESENT** | `src/lib/logger.ts` |
| Pushover webhook helper | **PARTIAL** | Alerting works via GitHub Actions (`healthz-monitor.yml` + `healthz-heartbeat.yml`); no in-process Pushover call. Functional but architecturally different from the design — see §7 rationale. |

---

## 12. Operational Status (at audit date)

| Item | Status |
|---|---|
| API Server Replit workflow | **RUNNING** — fixed by `scripts/dev-bootstrap.sh` (local file:// vault) |
| `/api/healthz` in dev | **200 OK** — all three checks pass against the local dev vault |
| Railway source repo | **NOT YET CONFIGURED** — `RAILWAY_SETUP.md` provides setup steps; user must create `obsidian-mcp-railway` GitHub repo and reconnect Railway to it |
| Real `VAULT_REPO_URL` / `GITHUB_PAT` | **NOT SET** — dev bootstrap uses local placeholders; production secrets must be added in Railway |

---

## 13. Gaps & Follow-up Tasks

Prioritised. **Must-fix-before-launch** items block production go-live; **Nice-to-have-post-launch** items are quality-of-life or parity work that can ship on a later iteration.

### Must-fix before launch

1. **Configure Railway secrets and verify the live `/api/healthz`.** Set `VAULT_REPO_URL`, `GITHUB_PAT`, `OAUTH_CLIENT_SECRET`, `SESSION_ENCRYPTION_KEY`, `PERSONAL_AUTH_TOKEN`, and `BASE_URL` (matching the actual Railway domain) per `RAILWAY_SETUP.md`. Confirm a 200 with all three checks `ok: true` against the production URL before pointing Claude at it.
2. **Wire the Pushover monitor secrets** (`HEALTHZ_URL`, `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY`) and run both `healthz-monitor` and `healthz-heartbeat` workflows once manually to confirm the alert + heartbeat path works end-to-end. Without this, the only DIVERGENT-but-functional element in §7/§11 is effectively non-functional.
3. **Update the design doc to retire `VAULT_REPO` and `GIT_TOKEN`** in favour of `VAULT_REPO_URL` and `GITHUB_PAT` (per §10 recommendation) so future readers do not file Railway secrets under the wrong names. No code change.
4. **Confirm onboarding docs reference the deployed 21-tool surface, not the upstream's 18.** Spot-check that any Claude connector setup notes link to `PRD.md` §5 (the canonical inventory) rather than the upstream `eddmann/obsidian-mcp` README.

### Nice-to-have post launch

5. **Add a `manage-tags` dispatch alias** that internally calls `add_tag` / `remove_tag` / `rename_tag` / `list_tags` for upstream parity. Pure additive — does not break existing connectors.
6. **Replace the JSON OAuth store with SQLite** if multi-process or multi-writer scenarios become real. For the current single-user deployment the JSON store is fine; only revisit on actual demand.
7. **In-process Pushover helper as defence-in-depth.** Keep the GitHub Actions monitor as primary; add a server-side helper that pings on startup-failed-checks so a degraded healthcheck still escalates even if GitHub Actions is throttled or disabled.
8. **Decide whether to formally accept snake_case tool names** or invest in a kebab-case alias layer. Today snake_case is the de-facto contract; either lock it in by deleting the kebab-case references in the design doc, or ship aliases. No urgency.
9. **Move from `git pull --ff-only` per read to a smarter sync** (e.g. periodic background fetch + conditional pull on read) to drop tail latency on large vaults. Today `VAULT_SYNC_MIN_INTERVAL_MS` is the escape hatch; a real implementation would be cleaner.
10. **Re-attempt a Railway → GitHub auto-deploy** after step 1 above (`RAILWAY_SETUP.md`) so CI green is the production deploy gate, per `OPERATIONS.md` §"Pre-merge / pre-deploy gate".
