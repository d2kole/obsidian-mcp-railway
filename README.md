# obsidian-mcp-railway

Remote MCP server that exposes a git-backed Obsidian vault to Claude (Claude.ai web, Claude iOS, Claude Code CLI) over HTTPS. Runs always-on on Railway so the vault is reachable even when your Desktop is off.

**How it works:** Your Desktop's Obsidian Git plugin pushes notes to a private GitHub repo every 10 minutes. This server runs on Railway, clones the repo into a persistent volume, and serves the vault to Claude through a Streamable HTTP MCP endpoint protected by OAuth 2.0 + PKCE. Every Claude write becomes a git commit pushed back to GitHub.

---

## Quick links

| Document | What it covers |
|---|---|
| [`RAILWAY_SETUP.md`](./RAILWAY_SETUP.md) | Step-by-step: create the GitHub repo, push this code, configure Railway, connect Claude |
| [`artifacts/api-server/OPERATIONS.md`](./artifacts/api-server/OPERATIONS.md) | All environment variables, PAT rotation, volume DR, admin endpoints, Pushover alerting |

---

## Local development

The API server boots automatically in Replit. It uses a local ephemeral git repo so no real GitHub credentials are needed for development.

```bash
# Install dependencies
pnpm install

# Start the API server (runs on PORT env var, default 8080 in Replit)
pnpm --filter @workspace/api-server run dev

# Run all tests
pnpm --filter @workspace/api-server test

# Run the full verification gate (lint + typecheck + unit + integration + e2e)
pnpm --filter @workspace/api-server run verify
```

---

## Architecture

```
Desktop Obsidian (Obsidian Git plugin)
        │  push every 10 min
        ▼
GitHub repo (private, single branch)
        ▲                                ▲
        │  push on every Claude write    │  pull before every Claude read
        │                                │
Railway service  ◄──── /vault-cache ────►
   ▲              (persistent volume)
   │  HTTPS + OAuth 2.0 + PKCE + Streamable HTTP
   │
Claude.ai web · Claude iOS · Claude Code CLI
```

See [`RAILWAY_SETUP.md`](./RAILWAY_SETUP.md) to get it running.
