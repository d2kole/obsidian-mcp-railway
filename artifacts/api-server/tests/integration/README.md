# tests/integration

Integration tests. These boot real Express middleware stacks (via
supertest), real `VaultService` instances against ephemeral git
remotes, and real OAuth route handlers — but no browser and no
external network.

## What belongs here

- Supertest-driven tests of HTTP routes (`/api/healthz`, `/mcp`,
  `/.well-known/oauth-authorization-server`, `/oauth/*`).
- VaultService write-flow tests against a `tests/fixtures/git-remote.ts`
  bare repo.
- MCP tool contract tests that initialize a real MCP server in-process
  and call tools via the SDK client.

## What does NOT belong here

- Tests that require a browser (Playwright) — those go in `tests/e2e`.
- Tests that depend on real GitHub, real Railway volume, real Pushover.
  All external systems must be faked or run locally inside the test.

## Conventions

- Every test that creates a temp directory must clean it up in
  `afterAll`.
- Boot Express via `import app from "../../src/app"` and pass to
  supertest. Do not spawn the server as a child process.
- Set required env vars (`VAULT_REPO_URL`, `GITHUB_PAT`, etc.) at the
  top of each spec via `vi.stubEnv` so tests stay parallel-safe.
