# obsidian-mcp-railway — Product Requirements Document

## 1. Overview & goals

`obsidian-mcp-railway` is a single-user remote MCP (Model Context Protocol) server that exposes a git-backed Obsidian vault to Claude clients (Claude.ai web, Claude iOS, Claude Code CLI) over HTTPS. It runs always-on on Railway so the vault stays accessible to Claude even when the user's Desktop PC is off, while the Desktop's Obsidian Git plugin keeps the same GitHub repo in sync from the other side.

**Problem it solves.** Claude only sees Obsidian when the Desktop is awake and the local MCP bridge is running. With this service, the GitHub repo becomes the always-online source of truth: Desktop pushes notes up on a 10-minute cycle, Claude reads/writes through Railway, and Railway commits Claude's changes back to GitHub.

**Target user.** A single person operating their personal "second brain" vault. Multi-tenant access, sharing, and team workflows are explicitly out of scope.

**Non-goals.**
- No multi-user / role-based auth
- No database — the vault (markdown files in a git repo) is the data store
- No execution of arbitrary Obsidian commands (`obsidian_execute_command` is intentionally disabled)
- No web UI beyond the minimal OAuth login form
- No analytics, telemetry, or tracking
- No support for vaults that are not git-backed

## 2. Tech stack

- **Runtime:** Node 20 (Alpine in production)
- **Language:** TypeScript (strict)
- **HTTP framework:** Express 5
- **MCP transport:** `@modelcontextprotocol/sdk` Streamable HTTP transport (stdio also supported for Claude Code CLI on Desktop)
- **Auth:** OAuth 2.0 + PKCE (S256-only). Tokens are HS256 JWTs signed via `jose` keyed by `OAUTH_CLIENT_SECRET` + `SESSION_ENCRYPTION_KEY`.
- **Git:** `simple-git` against a private GitHub repo, PAT injected into the origin URL
- **Search:** `fuse.js` for fuzzy keyword search over the vault
- **Rate limiting:** `express-rate-limit` MemoryStore, scoped per OAuth session
- **IDs:** `uuid`
- **Logging:** `pino` + `pino-http`
- **Storage:** Railway persistent volume (mounted at `/vault-cache`) + GitHub remote
- **Hosting:** Railway (multi-stage Dockerfile, `railway.toml`, healthchecked at `/api/healthz`)
- **Tests:** Vitest + supertest (`pnpm --filter @workspace/api-server test`)
- **Based on:** [eddmann/obsidian-mcp](https://github.com/eddmann/obsidian-mcp) (MIT). This project is a Railway-hosted, OAuth-fronted, git-backed reimplementation in the same spirit.

## 3. Architecture

The data flow is one loop with two writers:

```
Desktop Obsidian (Obsidian Git plugin)
        │  push every 10 min
        ▼
GitHub repo (private, single branch)
        ▲                                ▲
        │  push on every Claude write    │
        │                                │  pull before every Claude read
        │                                │
Railway service  ◄──── /vault-cache ────►│
   ▲                  (persistent vol)
   │  HTTPS + OAuth + Streamable HTTP
   │
Claude.ai web · Claude iOS · Claude Code CLI
```

**On boot,** the service reads its env vars, mounts `/vault-cache`, and clones the repo into it if empty. Subsequent boots reuse the cache.

**On every read tool call,** `VaultService.sync()` runs `git pull --ff-only` so Claude always sees the latest commit pushed by Desktop. Throttling is opt-in (`VAULT_SYNC_MIN_INTERVAL_MS`, default 0).

**On every write tool call,** the path is checked against `OBSIDIAN_WRITE_PATHS`, the per-session write counter is incremented (cap: `MAX_WRITES_PER_HOUR`), the file is mutated, then `git add -A && git commit && git push` runs.

**Sessions** live in process memory (Streamable HTTP `mcp-session-id`). OAuth auth codes and the revoked-JTI list are persisted to `${VAULT_CACHE_DIR}/.oauth-store.json` so reconnects survive Railway restarts. Issued access tokens are signed JWTs and remain valid until their `exp` (default 24 h) regardless of restarts.

**Healthcheck (`/api/healthz`)** is binary 200/500. It runs three real probes: the volume mount is readable+writable, `git fetch --dry-run` succeeds (capped at 400 ms), and the MCP router is mounted. Any failure → 500 → Railway restarts the container.

**Secret hygiene.** `lib/redact.ts` strips `GITHUB_PAT`, OAuth secrets, and basic-auth-in-URL tokens out of every error message and log line before they leave the process.

## 4. User journey

### First-time setup (one-time, ~15 minutes)

1. From Desktop, install the **Obsidian Git** community plugin in your vault, point it at your private GitHub repo, set "auto pull/push every 10 minutes", and push once to seed `main`.
2. In Railway, create a project from this repo, attach a 1 GB volume at `/vault-cache`, fill in the env vars (see [`OPERATIONS.md`](./OPERATIONS.md)), and deploy.
3. In Claude.ai → Connectors → Add custom MCP server, paste `https://<your-railway-domain>/mcp`.
4. Claude redirects you through `/oauth/authorize`. Paste your `PERSONAL_AUTH_TOKEN` into the form. Done.

### Day in the life

- **Morning capture from iOS Claude.** "Capture this idea to my inbox: 'Try a 4-day work week experiment in Q3.'" → Claude calls `write_note` under `00-Inbox/`, commits, pushes. The note shows up in Obsidian on Desktop within ~10 min.
- **Mid-day search.** "What have I written about deep work in the last six months?" → Claude calls `search_vault`, summarizes hits.
- **Evening journal.** "Add to today's journal: 'Shipped the obsidian-mcp-railway PRD.'" → Claude calls `add_journal_activity`, which appends under today's `## Activity` heading.
- **Weekly review.** "Pull every note tagged `#weekly-review` from the last four weeks and summarize patterns." → Claude calls `list_tags` then `read_notes` in batch.

## 5. MCP tools reference

All tools require a valid Bearer access token. Write tools additionally enforce `OBSIDIAN_WRITE_PATHS` and the `MAX_WRITES_PER_HOUR` rate limit per session.

| Tool | Read/Write | Purpose |
| --- | --- | --- |
| `read_note` | read | Read a single note's full markdown contents. |
| `read_notes` | read | Batch-read multiple notes by relative path. |
| `search_vault` | read | Fuzzy keyword search across the whole vault (Fuse.js). |
| `list_notes` | read | List every markdown file in the vault. |
| `list_directory` | read | List the immediate children of a folder. |
| `list_tags` | read | List every tag with usage counts. |
| `write_note` | write* | Create or overwrite a note at a given path. |
| `append_to_note` | write* | Append content to the end of an existing note. |
| `delete_note` | write* | Delete a note. |
| `move_note` | write* | Move/rename a note (both source and destination must be allowed). |
| `insert_at_heading` | write* | Insert content above/below a markdown heading. |
| `insert_at_block_id` | write* | Insert content adjacent to an Obsidian `^block-id`. |
| `insert_at_text_match` | write* | Insert content at the first match of a literal string. |
| `update_frontmatter` | write* | Merge keys into a note's YAML frontmatter. |
| `apply_patch` | write* | Apply a unified diff to a note. |
| `create_directory` | write* | Create a folder (by writing a `.gitkeep`). |
| `add_tag` | write* | Add a tag to a note (frontmatter or inline). |
| `remove_tag` | write* | Remove a tag from a note. |
| `rename_tag` | write* | Rename a tag across the entire vault in one batched commit. |
| `log_journal_entry` | write* | Append a free-form entry to today's daily note. |
| `add_journal_activity` | write* | Append an audit-trail entry under today's `## Activity` section. |
| `obsidian_execute_command` | — | **Disabled.** Not registered. Re-enabling is intentionally a code change, not an env-var flip. |

`*` = subject to `OBSIDIAN_WRITE_PATHS` allowlist + `MAX_WRITES_PER_HOUR` rate limit.

## 6. Ten example prompts

Realistic things to paste into Claude once the connector is live.

1. **Quick capture to inbox.** "Save a new note in `00-Inbox/` titled `Q3 OKR ideas` with this content: 'Three big bets — ship MCP server, redesign weekly review, finish the Naval Almanac re-read.'"
2. **Append to today's journal.** "Append this to my journal today: 'Had a useful 1:1 with Sam about the new hiring loop. Action item: draft the new rubric by Friday.'"
3. **Log an activity.** "Log this activity in my journal: 'Reorganized 03-Areas/Health/ — split sleep, training, and nutrition into their own notes.'"
4. **Search across the vault.** "Find every note that mentions 'second brain' OR 'PKM workflow' from the last year, sorted by relevance."
5. **Read a specific note.** "Read `02-Projects/obsidian-mcp-railway.md` and tell me which acceptance criteria are still open."
6. **Batch-read related notes.** "Read these three notes and summarize the common themes: `03-Areas/Career/2026-Q1-review.md`, `03-Areas/Career/2025-Q4-review.md`, `03-Areas/Career/2025-Q3-review.md`."
7. **Insert under a heading.** "In `02-Projects/Onboarding-Redesign.md`, under the `## Open questions` heading, add: 'Do we need a separate flow for returning users?'"
8. **Update frontmatter tags.** "Open `01-Daily/2026-05-15.md` and add the tags `#weekly-review` and `#shipped` to its frontmatter."
9. **Apply a structured patch.** "Apply this diff to `03-Areas/Health/Sleep.md` to replace the 'Bedtime ritual' bullet list with the new 6-step version: ```diff … ```"
10. **Daily review.** "Find every note I created or modified in the last 7 days, group them by area (Projects, Areas, Resources, Archive), and write a one-paragraph summary of what I worked on this week. Then save the summary as `Journal/Reviews/2026-W20.md`."

## 7. How to deploy (pointer-level)

Full step-by-step in [`OPERATIONS.md`](./OPERATIONS.md). Short version:

1. Create the Railway project from this repo and attach a 1 GB volume mounted at `/vault-cache`.
2. Set the eight required env vars (`VAULT_REPO_URL`, `GITHUB_PAT`, `OAUTH_CLIENT_SECRET`, `SESSION_ENCRYPTION_KEY`, `PERSONAL_AUTH_TOKEN`, `BASE_URL`, plus the Sealed flag on the four secrets). All other env vars have sensible defaults.
3. Deploy. The Dockerfile is multi-stage; first boot clones the vault into the volume.
4. Hit `https://<your-domain>/api/healthz` and confirm a 200 with all three checks `ok: true`.
5. In Claude.ai → Connectors, register `https://<your-domain>/mcp`.
6. Complete the OAuth login form with your `PERSONAL_AUTH_TOKEN`.
7. (Optional) Wire the GitHub Actions uptime monitor + daily heartbeat documented in `OPERATIONS.md` to your Pushover account.

## 8. Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Claude.ai connector "Couldn't connect" | `BASE_URL` doesn't match the public Railway URL, so OAuth metadata advertises the wrong endpoints | Update `BASE_URL` in Railway to the exact `https://…` domain Claude is hitting, redeploy. |
| `/api/healthz` returns 500 with `git_fetch_dry_run: false` | `GITHUB_PAT` expired, was revoked, or lost the `contents: read+write` scope | Mint a new fine-grained PAT scoped to the vault repo, update `GITHUB_PAT`, redeploy. |
| `/api/healthz` returns 500 with `vault_cache_present: false` | Volume is not mounted at `/vault-cache`, or the path was overridden via `VAULT_CACHE_DIR` and the mount didn't follow | Re-attach the volume in Railway → Service → Settings → Volumes; confirm mount path matches `VAULT_CACHE_DIR`. |
| Tool error: "Write to `<path>` is not allowed" | The target file is outside `OBSIDIAN_WRITE_PATHS` | Either move the operation to an allowed folder, or expand `OBSIDIAN_WRITE_PATHS` (keep it as narrow as you can). |
| Tool error: "Write rate limit exceeded (20/hour)" | Hit `MAX_WRITES_PER_HOUR` for this session | Wait for the rolling-hour window to reset, or raise `MAX_WRITES_PER_HOUR`. |
| Claude reads stale notes | Desktop's Obsidian Git plugin hasn't pushed yet (default 10-min cycle) | In Obsidian Git settings, lower the auto-push interval, or run "Obsidian Git: Push" manually. |
| After a Railway redeploy, Claude.ai prompts to re-authorize | Streamable HTTP session IDs evaporated; the JWT itself is still valid but the session needs to re-initialize | Click reconnect in Claude — the OAuth login form should not reappear because access tokens persist. If it does, your `OAUTH_CLIENT_SECRET` or `SESSION_ENCRYPTION_KEY` was rotated. |
| `obsidian_execute_command` not found | Intentionally disabled | This tool is not registered. Use the specific read/write/edit tool that matches your intent. |

## 9. Do's and don'ts

**Do**
- Keep `OBSIDIAN_WRITE_PATHS` as narrow as possible — ideally just `00-Inbox`, `Journal`, and a couple of project folders. Treat write paths as an allowlist, not an afterthought.
- Rotate `GITHUB_PAT` quarterly. Use fine-grained PATs scoped to a single repo with the minimum `contents: read+write` scope.
- Treat every Claude write as a real git commit — review them periodically in your repo's commit history, not in Obsidian.
- Use `add_journal_activity` to keep a Claude-facing audit trail. Future-you will want to know which notes Claude touched.
- Mark all four secret env vars as **Sealed** in Railway.

**Don't**
- Don't enable `obsidian_execute_command` without a serious threat-model review. The whole point of this server is that the write surface is small and auditable.
- Don't store secrets, API keys, or credentials in vault notes — Claude can read every note, and a leaked access token would expose them.
- Don't edit the same note in Desktop Obsidian and via Claude at the same time. The Obsidian Git plugin's auto-merge is conservative and you'll get conflict markers in the file.
- Don't point `BASE_URL` at an `http://` origin. PKCE works without it but Claude.ai will refuse non-HTTPS redirect URIs.
- Don't share your `PERSONAL_AUTH_TOKEN`. It is the entire user authentication layer for this service.

## 10. Gotchas

- **In-memory MCP sessions evaporate on redeploy.** OAuth tokens persist (signed JWT + persisted JSON store), but the active Streamable HTTP session does not. Claude reconnects transparently in most cases.
- **Healthcheck is binary.** A single failed sub-check returns 500 and Railway will restart the container. Network blips on `git fetch --dry-run` will cause restarts; that's by design (the timeout is hard-capped at 400 ms).
- **`git pull` runs before every read.** On a vault with thousands of files this adds latency. If you notice it, set `VAULT_SYNC_MIN_INTERVAL_MS` to throttle pulls (at the cost of read freshness).
- **iOS Claude requires the OAuth metadata at exactly `/.well-known/oauth-authorization-server`.** Don't put the service behind a path-prefixed proxy.
- **Obsidian Git's 10-minute interval is the lower bound on Desktop→Claude freshness.** Edits made in the last few minutes on Desktop may not be visible until the next push. Run "Obsidian Git: Push" manually if you need immediacy.
- **Fuzzy search is in-memory and re-indexes on cold start.** First `search_vault` after a redeploy will be slower. Subsequent calls are fast.
- **Redirect URI allowlist matches scheme + host + port + path-prefix exactly.** If you connect from a new client surface, add its origin to `OAUTH_ALLOWED_REDIRECT_PREFIXES` — `startsWith`-style matches were intentionally removed for security.
- **Tool count drift.** This server registers 21 tools (the upstream `eddmann/obsidian-mcp` advertises "18"). The full list is in §5; the actual inventory is also logged at startup ("MCP tool inventory") so you can confirm what your deployed instance exposes.
