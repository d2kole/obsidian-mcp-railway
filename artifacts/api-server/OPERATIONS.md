# obsidian-mcp-railway — Operations

Single-user remote MCP server that exposes a git-backed Obsidian vault to Claude.ai (web), Claude iOS, and Claude Code CLI. The vault lives in a private GitHub repo; this server runs on Railway and clones the vault into a persistent volume.

## Required environment variables (HTTP mode)

| Variable | Required | Description |
| --- | --- | --- |
| `VAULT_REPO_URL` | yes | HTTPS URL of the private vault repo, e.g. `https://github.com/d2kole/obsidian-vault.git`. |
| `VAULT_BRANCH` | no (default `main`) | Branch the server tracks. |
| `GITHUB_PAT` | yes (Sealed) | Fine-grained PAT with `contents: read+write` scoped to the vault repo only. 90-day expiry recommended. |
| `OAUTH_CLIENT_ID` | no (default `obsidian-mcp-railway`) | Client identifier returned by `/oauth/register`. |
| `OAUTH_CLIENT_SECRET` | yes (Sealed) | Random 32-byte secret used to sign tokens. Generate with `openssl rand -base64 32`. |
| `SESSION_ENCRYPTION_KEY` | yes (Sealed) | 32-byte secret for session integrity. Generate with `openssl rand -base64 32`. |
| `PERSONAL_AUTH_TOKEN` | yes (Sealed) | The single-user password you type into the OAuth login form. Generate with `openssl rand -base64 24`. |
| `BASE_URL` | yes | The public Railway URL, e.g. `https://obsidian-mcp-railway.up.railway.app`. Used in OAuth metadata. |
| `OBSIDIAN_WRITE_PATHS` | no | Comma-separated list of vault-relative folders Claude is allowed to write to. Default: `00-Inbox,01-Daily,Captures,Journal`. |
| `MAX_WRITES_PER_HOUR` | no (default `20`) | Server-side rolling-window cap on write tool calls per session. |
| `OAUTH_ACCESS_TOKEN_TTL_SEC` | no (default `86400`) | Access token lifetime in seconds. |
| `OAUTH_ALLOWED_REDIRECT_PREFIXES` | no | Comma-separated allowlist of `redirect_uri` prefixes. Default: `https://claude.ai/,https://claude.com/,http://localhost,http://127.0.0.1`. Tighten this if you only use one client. |
| `JOURNAL_PATH_TEMPLATE` | no (default `Journal/{{date}}.md`) | Path of the daily note used by `log_to_journal`. |
| `JOURNAL_DATE_FORMAT` | no (default `YYYY-MM-DD`) | Date format substituted into `JOURNAL_PATH_TEMPLATE`. |
| `JOURNAL_ACTIVITY_SECTION` | no (default `## Activity`) | Heading under which `log_to_journal` appends entries. |
| `VAULT_CACHE_DIR` | no (default `/vault-cache`) | Mount point of the Railway volume. |
| `OAUTH_STORE_PATH` | no (default `${VAULT_CACHE_DIR}/.oauth-store.json`) | File path where OAuth auth codes and revoked-token IDs are persisted so they survive process restarts (Railway redeploys, crashes). Must live on a persistent volume. |
| `PORT` | no (default `3000`) | HTTP port. Railway injects this automatically. |

## First-time Railway setup

1. **Create the Railway project** and connect this repo.
2. **Add a 1 GB volume** mounted at `/vault-cache` (Service → Settings → Volumes).
3. **Set environment variables** above. Mark `GITHUB_PAT`, `OAUTH_CLIENT_SECRET`, `SESSION_ENCRYPTION_KEY`, and `PERSONAL_AUTH_TOKEN` as **Sealed Variables**.
4. **Region**: pick `us-east4` (Virginia) for low latency from US East.
5. **Healthcheck**: confirm Service Settings shows `/api/healthz` (this is set in `railway.toml`).
6. **Deploy.** First boot will clone the vault into `/vault-cache` (may take a few minutes for large vaults).

## Connecting Claude.ai (web / iOS)

1. In Claude.ai, open the connectors panel and add a custom MCP server.
2. URL: `https://<your-railway-domain>/mcp`
3. Claude will discover the OAuth metadata at `/.well-known/oauth-authorization-server` and start the OAuth flow.
4. When the login form appears, paste your `PERSONAL_AUTH_TOKEN` and submit.
5. Claude.ai stores the access token and reuses it (default 24 h). Reconnect daily as needed — the iOS/Claude.ai remote MCP UI is still maturing.

## Connecting Claude Code CLI (most reliable path)

Two options:

**A. Remote (HTTP):** add to `~/.config/claude-code/mcp.json`:
```json
{
  "mcpServers": {
    "obsidian-railway": {
      "url": "https://<your-railway-domain>/mcp",
      "transport": "http"
    }
  }
}
```

**B. Local (stdio):** point Claude Code at the same image running locally with the same env vars. The `stdio` mode can also be invoked directly (`node dist/index.mjs stdio`) for offline development.

## PAT rotation runbook

1. Open GitHub → Settings → Developer settings → Personal access tokens (fine-grained).
2. Revoke the existing PAT.
3. Create a new fine-grained PAT scoped only to the vault repo, with `contents: read+write`. Set a 90-day expiry.
4. In Railway → Variables, edit the `GITHUB_PAT` Sealed Variable and paste the new value.
5. Trigger a redeploy (Service → Deployments → Redeploy). The server re-clones using the new PAT on startup.
6. Confirm `/api/healthz` returns 200 with `git_fetch_dry_run.ok: true`.

## Volume disaster-recovery drill (run once after first deploy)

1. Note the current vault SHA in GitHub.
2. Railway → Service → Volumes → delete `vault-cache` volume.
3. Re-attach an empty 1 GB volume at `/vault-cache`.
4. Trigger redeploy. Confirm logs show `Vault cache empty, cloning from GitHub` followed by `Vault clone complete`.
5. Confirm `/api/healthz` returns 200 and `read_note` works on a known file via Claude.

## Architecture notes

- **Source of truth: GitHub.** Desktop, Railway volume, and any client are caches.
- **Single-writer.** Desktop (Obsidian Git plugin) auto-pushes every 10 min; iOS Obsidian Git plugin is disabled. Mobile capture goes through Claude/MCP only.
- **Every Claude write is a git commit.** Reverting a bad LLM session = `git revert` on GitHub.
- **`MAX_WRITES_PER_HOUR=20`** is the safety net against runaway tool calls. Adjust upward only when you trust the workflow.
- **`obsidian_execute_command` is intentionally not implemented** (too much blast radius — vault contents only, no command-palette dispatch).

## Pushover alerting (uptime monitor)

A GitHub Actions cron at `.github/workflows/healthz-monitor.yml` probes
`/api/healthz` every minute and pages via Pushover after **3 consecutive
non-200 responses**. The monitor is intentionally hosted on GitHub Actions
(not Railway cron) so it still fires when Railway itself is unreachable.

Each run performs 3 probes, 20 seconds apart, and only sends a notification
when all 3 fail. The notification body includes the failing check name(s)
parsed from the `/api/healthz` JSON response (e.g. `git_fetch_dry_run`,
`vault_cache_present`, `mcp_handler_registered`) and the last HTTP status.

### Setup (one time)

1. Create a [Pushover](https://pushover.net) account and install the app on your phone.
2. On the Pushover dashboard, copy your **User Key**.
3. Create a new **Application/API Token** named `obsidian-mcp-railway` and copy its token.
4. In this GitHub repo → Settings → Secrets and variables → Actions, add:
   - `HEALTHZ_URL` = `https://<your-railway-domain>/api/healthz`
   - `PUSHOVER_APP_TOKEN` = the application token from step 3
   - `PUSHOVER_USER_KEY` = your user key from step 2
5. Trigger the workflow once manually (Actions → `healthz-monitor` → Run workflow) to verify
   it succeeds against a healthy server. To verify the alert path, temporarily point
   `HEALTHZ_URL` at an unreachable URL and re-run; you should receive a Pushover ping.

### Tuning

- Change probe count or spacing by editing `ATTEMPTS` / `SLEEP_SECONDS` in the workflow.
- Raise `priority=1` to `priority=2` in the workflow if you want emergency-priority pages
  that bypass quiet hours (Pushover will require acknowledgement).
- GitHub's scheduled workflows can be delayed under load; expect best-effort 1-minute cadence.

## Daily heartbeat ("still alive" ping)

The healthz-monitor above only fires when `/api/healthz` fails. If the
monitor itself silently breaks (workflow disabled, secrets rotated, GitHub
Actions outage), you'd never know — silence would look identical to "all
healthy". To close that gap, a second scheduled workflow at
`.github/workflows/healthz-heartbeat.yml` runs **once per day** (14:00 UTC),
hits `/api/healthz`, and on a 200 sends a **low-priority** (`priority=-2`,
silent) Pushover notification reading `vault server healthy`.

Treat its **absence** as the signal: if you don't see a heartbeat for >24h,
assume the monitor pipeline is broken even if healthz-monitor is quiet, and
manually re-run the heartbeat workflow (Actions → `healthz-heartbeat` → Run
workflow) to investigate.

The heartbeat reuses the same three secrets as healthz-monitor
(`HEALTHZ_URL`, `PUSHOVER_APP_TOKEN`, `PUSHOVER_USER_KEY`) — no extra setup
beyond the alerting runbook above. Adjust the cron in the workflow file to
change the time of day.

## Revoking a single device's session

If you need to kick a specific Claude client off the server (lost iPad, leaked
token, suspicious access from a device you don't recognize) without logging
out every other device, use the admin endpoints. They're gated by the same
`PERSONAL_AUTH_TOKEN` you type into the OAuth login form, sent as a Bearer
credential. Revocations are written to the OAuth store on the persistent
volume and survive restarts.

**1. List active access tokens:**

```bash
curl -s https://<your-railway-domain>/admin/tokens \
  -H "Authorization: Bearer $PERSONAL_AUTH_TOKEN" | jq
```

Each entry has a `jti` (token id), `client_id`, `scope`, `issued_at`,
`expires_at`, `last_used_at`, `last_used_ip`, and `last_user_agent`.
Timestamps are ms since epoch; `last_used_*` fields are `null` until the
token has been used at least once after the server learned to record them.

In practice, **`last_used_at` is the field to look at first** when deciding
which session to revoke — a session that's been quiet for a week is almost
certainly a forgotten device, while one that just made a call from an
unfamiliar `last_used_ip` or `last_user_agent` is the suspicious one. Sort
the output by `last_used_at` to spot stale or anomalous sessions:

```bash
curl -s https://<your-railway-domain>/admin/tokens \
  -H "Authorization: Bearer $PERSONAL_AUTH_TOKEN" \
  | jq '.tokens | sort_by(.last_used_at // 0)'
```

`last_used_*` is updated on every successful token lookup (i.e. every
authenticated `/mcp` request) and persists across restarts via the OAuth
store on the Railway volume.

`last_used_ip` reflects the client IP as resolved through Express's
`trust proxy = 1` setting (see `src/app.ts`). This trusts exactly one
hop — Railway's edge proxy — so `X-Forwarded-For` from the proxy is
honored but a hostile client cannot spoof their IP by injecting their own
`X-Forwarded-For` chain. If you ever front this server with an additional
proxy (e.g. Cloudflare in front of Railway), bump that hop count to
match, otherwise the field will pin to the inner proxy instead of the
real client.

**2. Revoke that token:**

```bash
curl -s -X POST \
  https://<your-railway-domain>/admin/tokens/<jti>/revoke \
  -H "Authorization: Bearer $PERSONAL_AUTH_TOKEN"
```

A `200` with `{"revoked": true, "jti": "..."}` confirms the kill. The next
`/mcp` call from that device returns `401 invalid_token`; other devices keep
working. The affected client just needs to re-run the OAuth flow to get a
fresh token.

If you suspect every device is compromised, rotate `OAUTH_CLIENT_SECRET` and
`SESSION_ENCRYPTION_KEY` in Railway and redeploy — that invalidates every
issued token at once.

## Pre-commit secret scan

A lightweight Node-based scanner (`scripts/src/secret-scan.ts`) runs as
both a local pre-commit hook and a CI job, so a secret pasted into a
tracked source file is caught before it ever reaches the remote.

- **Local hook**: `.husky/pre-commit` invokes the scanner with `--staged`
  on every `git commit`. Hooks are wired up automatically by the root
  `prepare` npm script (`git config core.hooksPath .husky`) — any
  contributor who runs `pnpm install` gets the hook for free, no extra
  setup. The hook is a portable shell script with no native binary
  dependency (no gitleaks install required).
- **CI**: `.github/workflows/ci.yml` runs `pnpm run secret-scan` (i.e.
  the same scanner with `--all`) against every tracked file, so PRs from
  forks that bypass the local hook are still gated.

### Allowlisting false positives

Real secrets must be removed **and rotated** before committing — never
allowlist around a real leak. For deliberate placeholders / test
fixtures the scanner supports two opt-outs:

1. **Inline marker** (preferred): append `secret-scan: allow` as a
   comment on the same line. Example:
   ```ts
   const input = "https://x-access-token:ghp_AAAAAAAAAAAA@github.com/foo/bar.git"; // secret-scan: allow (test fixture)
   ```
2. **Path glob** in repo-root `.secretscanignore` (one glob per line,
   `#` for comments) when an entire file is unavoidably noisy. Prefer
   the inline marker — file-level ignores are blunt and easy to forget.

The scanner also has a built-in placeholder allowlist for obvious
dummies (`stdio-not-used`, `your-token-here`, `xxxxxxxx`,
`example.com`, `changeme`, …), so most `.env.example`-style values pass
without ceremony.

## Pre-merge / pre-deploy gate (Task #16, Task #17)

Before merging or deploying any change to this artifact:

1. Run `pnpm --filter @workspace/api-server run verify:all` locally and
   confirm it exits 0. The evidence log at
   `artifacts/api-server/tests/.evidence/<timestamp>.log` is the audit
   trail — keep the path in your task notes.
2. Confirm the latest CI run on the deploying commit is green
   (`.github/workflows/ci.yml`). The CI job uploads the same evidence
   log and the coverage HTML as build artifacts; download them from
   the run's "Artifacts" panel if you need to investigate.
3. Railway does **not** automatically gate deploy on CI status — it
   redeploys whenever the watched branch advances. Treat a red CI run
   as a hard "do not merge"; if a deploy slipped out before CI
   completed, roll back via the Railway dashboard rather than
   patching forward.

A failing `verify:all` is **never** OK to merge — fix the test gap or
revert the change. Coverage thresholds (vault 90%, oauth 90%,
write-path 95%, rate-limit 95%, tools 85%, routes 80%, project-wide
80% lines / 75% branches) are intentionally hard floors.

## Git history secret audit (Task #30)

A one-time secret-scanning audit of the full git history was performed on
**2026-05-16** before the repo was pushed to GitHub.

- Tool: `gitleaks` v7.5.0 (`gitleaks detect --path . --redact -v`).
- Scope: all 94 commits, every branch, working tree included.
- Files-added review: `git log --all --diff-filter=A` was also run to
  confirm no `.env`, `.oauth-store.json`, `*.pem`, `*.key`, `id_rsa`,
  or `credentials*` file has ever been added to history. The only
  env-shaped file ever committed is `artifacts/api-server/.env.example`
  (placeholders only).
- Sensitive env-var search (`git log -S` for `GITHUB_PAT=`,
  `OAUTH_CLIENT_SECRET=`, `SESSION_ENCRYPTION_KEY=`,
  `PERSONAL_AUTH_TOKEN=`) returned only the obviously-fake
  `dev-*` placeholders inside
  `artifacts/api-server/scripts/dev-bootstrap.sh` (e.g.
  `OAUTH_CLIENT_SECRET="dev-client-secret"`). These are intentional
  local-development placeholders, never used against any real client,
  and pose no rotation risk.

### Findings

`gitleaks` reported 6 matches, all in the now-deleted file
`attached_assets/logoHref.html` (a scraped marketing/HTML asset that
was attached during an earlier session and later removed):

| Rule | File | Status |
| --- | --- | --- |
| Facebook Client ID (×4) | `attached_assets/logoHref.html` | False positive — public OAuth client IDs embedded in third-party social-login widgets on a scraped HTML page. Not our credentials. |
| LinkedIn Client ID (×2) | `attached_assets/logoHref.html` | False positive — same as above. |

No production credentials (`GITHUB_PAT`, `OAUTH_CLIENT_SECRET`,
`SESSION_ENCRYPTION_KEY`, `PERSONAL_AUTH_TOKEN`, private keys) were
found in any commit. **No `git filter-repo` rewrite or secret
rotation is required.**

### Re-running the audit

Run from the repo root. The `--log-opts="--all"` flag is important —
without it, `gitleaks` v7 only walks the current branch and you can
miss secrets sitting on other refs:

```bash
gitleaks detect \
  --path . \
  --redact \
  -v \
  --log-opts="--all --full-history" \
  --report=artifacts/api-server/tests/.evidence/gitleaks-$(date +%Y%m%d).json
```

Keep the JSON report alongside the other verification evidence under
`artifacts/api-server/tests/.evidence/` so the audit trail is
reproducible.

If new findings ever appear, triage them here and either (a) document
them as false positives in this section, or (b) rotate the leaked
credential immediately and rewrite history with `git filter-repo`
**before** the next push.

## Out of scope (future work)

- Conflict resolution on simultaneous Desktop + MCP writes (single-writer pattern avoids this for now).
