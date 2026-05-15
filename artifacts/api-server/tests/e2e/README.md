# tests/e2e

End-to-end browser tests driven by Playwright. The Playwright config
boots a real instance of the api-server with fake env vars (no real
GitHub, no real Railway volume) and runs specs against it.

## What belongs here

- Browser-driven tests of the OAuth login flow.
- Multi-step user journeys that span OAuth → MCP `initialize` → tool
  call.
- Smoke checks of public endpoints (e.g. `/api/healthz`, `/`) reached
  via a real HTTP client.

## What does NOT belong here

- Pure logic tests — those belong in `tests/unit`.
- Tests that rely on a real GitHub repo or real network — fixtures
  must be hermetic.

## How the server boots

`playwright.config.ts` sets `webServer.command` to `pnpm run start:http`
and provides fake values for `VAULT_REPO_URL`, `GITHUB_PAT`,
`OAUTH_CLIENT_SECRET`, `SESSION_ENCRYPTION_KEY`, and
`PERSONAL_AUTH_TOKEN` so the process can boot without real credentials.
The vault clone will fail; that's expected for the smoke test (it
verifies `/api/healthz` returns a binary 200/500). E2E specs that need
a working vault must override `VAULT_CACHE_DIR` and seed it from a
fixture before the server starts.

## Conventions

- Spec files are named `*.spec.ts` (Vitest picks up `*.test.ts`;
  Playwright picks up `*.spec.ts`). This separation keeps the two
  runners from stepping on each other.
- Each spec is responsible for cleaning up any state it creates.
