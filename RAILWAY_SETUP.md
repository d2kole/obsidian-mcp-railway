# Railway Setup Guide

Step-by-step instructions for pushing this project to GitHub and wiring it up to Railway so Claude can reach your Obsidian vault from anywhere.

**Time required:** ~20 minutes the first time.

---

## Two repos, two different roles — do not mix them up

This project depends on **two separate GitHub repos** under your account (examples below use `d2kole`):

| Repo | Role | Who touches it |
|---|---|---|
| **`d2kole/obsidian-mcp-railway`** | The **service code** — what you are setting up now. Railway builds and redeploys from this repo on every push. | You push code here from Replit. Railway pulls from here. |
| **`d2kole/obsidian-my-second-brain`** | The **vault content** — your actual Obsidian notes. The running server clones it on startup with the `GITHUB_PAT`, and commits Claude's writes back to it. | Your Desktop's Obsidian Git plugin pushes notes here. Railway never builds from this repo. |

**Do not push this project's code into the vault repo, and do not point Railway at the vault repo.** The two are referenced via different settings: Railway's GitHub integration points at the **service code** repo (`obsidian-mcp-railway`); the `VAULT_REPO_URL` env var points at the **vault content** repo (`obsidian-my-second-brain`).

---

## Before you start

You need:
- A GitHub account (the one that owns the vault repo — `d2kole` in these examples)
- A Railway account at [railway.app](https://railway.app) (Hobby plan, ~$5/mo)
- This Replit project open in a browser tab

---

## Step 1 — Create the `obsidian-mcp-railway` GitHub repo (service code)

This is the **service code** repo. The vault content repo (`obsidian-my-second-brain`) already exists; do not recreate it here.

1. Go to [github.com/new](https://github.com/new).
2. Name it **`obsidian-mcp-railway`**, set it to **Private**, leave everything else unchecked (no README, no .gitignore, no license).
3. Click **Create repository**.
4. Copy the HTTPS URL — it will be `https://github.com/d2kole/obsidian-mcp-railway.git`.

---

## Step 2 — Push this project's code to the new repo

Run these commands in the Replit shell (the Terminal tab at the bottom):

```bash
# Check you are in the workspace root
pwd   # should print /home/runner/workspace

# Set your git identity if not already set
git config --global user.email "you@example.com"
git config --global user.name "Your Name"

# Add the service code repo as a remote
git remote add github https://github.com/d2kole/obsidian-mcp-railway.git

# Push the main branch
git push github main
```

If prompted for a password, use a GitHub **Personal Access Token** (not your GitHub password). Generate one at GitHub → Settings → Developer settings → Personal access tokens (classic) → Generate new token. Give it the `repo` scope.

---

## Step 3 — Create env vars — generate the secrets first

Run these three commands in the Replit shell to generate your production secrets:

```bash
openssl rand -base64 32   # paste this as OAUTH_CLIENT_SECRET
openssl rand -base64 32   # paste this as SESSION_ENCRYPTION_KEY
openssl rand -base64 24   # paste this as PERSONAL_AUTH_TOKEN (this is your login password)
```

Keep the terminal output somewhere safe — you will not be able to retrieve these values after they are entered as Railway Sealed Variables.

---

## Step 4 — Set up the Railway service

1. Go to [railway.app](https://railway.app) and open your project (or create a new one).
2. Click **New Service → GitHub Repo**.
3. If Railway is currently connected to **`obsidian-my-second-brain`** (the vault content repo) — that is the wrong repo. Open its settings, scroll to the bottom, and **disconnect** it before proceeding. Railway must build from the service code repo, not the vault.
4. Find and select **`d2kole/obsidian-mcp-railway`** (the service code repo you pushed in Step 2). If you don't see it, click **Configure GitHub App** and grant access to that repo only.
5. Railway will detect the `Dockerfile` automatically.

---

## Step 5 — Add the persistent volume

1. In your Railway service, click **Settings → Volumes → Add Volume**.
2. Mount path: `/vault-cache`
3. Size: `1 GB`
4. Click **Add**.

---

## Step 6 — Set environment variables in Railway

In your Railway service, go to **Variables** and add each one below. Mark every row tagged **Sealed** as a Sealed Variable (click the lock icon) so its value is hidden from logs.

| Variable | Value |
|---|---|
| `VAULT_REPO_URL` | `https://github.com/d2kole/obsidian-my-second-brain.git` (the **vault content** repo, not the service code repo) |
| `VAULT_BRANCH` | `main` |
| `GITHUB_PAT` | Fine-grained GitHub PAT scoped to **`obsidian-my-second-brain` only** with contents: read+write — **Sealed** |
| `OAUTH_CLIENT_SECRET` | Output of first `openssl rand` command — **Sealed** |
| `SESSION_ENCRYPTION_KEY` | Output of second `openssl rand` command — **Sealed** |
| `PERSONAL_AUTH_TOKEN` | Output of third `openssl rand` command — **Sealed** — this is your login password |
| `BASE_URL` | `https://<your-railway-domain>` (find this under Service → Settings → Domains) |
| `OBSIDIAN_WRITE_PATHS` | `00-Inbox,Journal` (add any other folders Claude should be able to write to) |
| `MAX_WRITES_PER_HOUR` | `20` |

**How to create a fine-grained GitHub PAT for the vault repo:**
1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
2. Resource owner: `d2kole`. Repository access: **Only select repositories** → pick **`obsidian-my-second-brain`** (the vault content repo). Do NOT grant access to `obsidian-mcp-railway` — the service code repo never needs PAT access at runtime.
3. Permissions: Repository permissions → Contents → **Read and write**.
4. Expiry: 90 days. Click Generate. Copy the token immediately.

---

## Step 7 — Confirm the domain and deploy

1. In Railway, go to **Settings → Domains** and note your public URL (e.g. `https://obsidian-mcp-railway.up.railway.app`). If there is no domain yet, click **Generate Domain**.
2. Make sure `BASE_URL` in Variables matches this domain exactly (no trailing slash).
3. Click **Deploy** (or Railway will deploy automatically on the next push).
4. Watch the build logs — the first deploy clones your vault, which may take a minute for large vaults.

---

## Step 8 — Verify the deploy

Once the build log shows "Server listening", open:

```
https://<your-railway-domain>/api/healthz
```

You should see JSON like:

```json
{
  "status": "ok",
  "checks": [
    { "name": "vault_cache_present", "ok": true },
    { "name": "git_fetch_dry_run", "ok": true },
    { "name": "mcp_handler_registered", "ok": true }
  ]
}
```

All three `ok: true` means you are good. If any check fails, see the troubleshooting section below.

---

## Step 9 — Connect Claude.ai

1. Open Claude.ai → click your name → **Integrations** (or **Connectors**).
2. Click **Add custom integration** → paste `https://<your-railway-domain>/mcp`.
3. Claude will redirect you to the OAuth login form. Enter the `PERSONAL_AUTH_TOKEN` value from Step 3.
4. Done. Try: "List the notes in my 00-Inbox folder."

**For Claude Code CLI**, add to `~/.config/claude-code/mcp.json`:

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

---

## Troubleshooting

**Railway can't see the `obsidian-mcp-railway` repo after step 4**

Click **Configure GitHub App** in Railway's repo picker and grant access to the new repo. Railway's GitHub App only sees repos you explicitly allow.

**Healthcheck fails with `git_fetch_dry_run: false`**

- Check that `VAULT_REPO_URL` points to **`obsidian-my-second-brain`** (the vault content repo), not `obsidian-mcp-railway` (the service code repo). This is the most common mistake.
- Check that `GITHUB_PAT` has `contents: read+write` scope on `obsidian-my-second-brain` and has not expired.
- In Railway logs, look for "git fetch" error lines. They will show a redacted error — if it says "authentication failed", the PAT is wrong or expired.

**Healthcheck fails with `vault_cache_present: false`**

The `/vault-cache` volume is not mounted. Go to Service → Settings → Volumes and confirm the volume is attached at `/vault-cache`. Then redeploy.

**Claude.ai says "could not connect" or OAuth fails**

- Confirm `BASE_URL` matches your Railway public domain exactly (https, no trailing slash).
- The Claude.ai MCP connector has known intermittent OAuth bugs. Claude Code CLI on Desktop is more reliable. Try that first.
- Check Railway logs for any `401` or `400` responses from `/oauth/authorize` or `/oauth/token`.

---

## Keeping things up to date

**PAT rotation (every 90 days):** See `OPERATIONS.md` → "PAT rotation runbook."

**Pushing code updates:** Run `git push github main` from Replit. Railway rebuilds automatically.

**Revoking a device's access:** See `OPERATIONS.md` → "Revoking a single device's session."
