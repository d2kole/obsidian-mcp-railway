# tests/fixtures

Reusable test fixtures shared across unit, integration, and E2E tests.

## What belongs here

- **Ephemeral git remotes.** Helpers that initialize a bare git repo in
  a temp directory and return its file:// URL, so write-flow tests can
  push/pull without touching real GitHub. See `git-remote.ts` (added by
  Task #7 / #14).
- **Sample vault trees.** Tiny markdown directory structures used to
  seed a `VaultService` under test (e.g. `vaults/minimal/`,
  `vaults/with-frontmatter/`).
- **Static request payloads.** JSON bodies for OAuth, MCP
  initialize/list/call requests that multiple tests reuse.
- **OAuth helpers.** Functions that generate a PKCE code verifier +
  challenge pair and walk the auth flow to mint a usable access token
  for protected-route tests.

## What does NOT belong here

- Test cases themselves — those go in `tests/unit`, `tests/integration`,
  or `tests/e2e`.
- Production code helpers — those go in `src/`.
- Anything that talks to a real GitHub repo, real Railway volume, or
  real Pushover account. Fixtures must be hermetic.

## Conventions

- Every fixture file exports a typed factory (no top-level side effects
  — fixtures are imported by many tests in parallel).
- Temp directories go under `tests/.tmp/` (gitignored) and must be
  cleaned up in `afterAll`.
