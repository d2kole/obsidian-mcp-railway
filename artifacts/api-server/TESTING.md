# Testing & Verification Gate

This artifact uses a **verification gate** convention: every task that
adds or changes behavior must add a `verify:<feature>` script and run
it green before the task is marked complete. `pnpm verify` is the
union of all gates and is the single command that confirms the artifact
still works end-to-end.

## Test runners

- **Vitest** — unit + integration tests. Picks up
  `src/**/*.test.ts`, `tests/unit/**/*.test.ts`, and
  `tests/integration/**/*.test.ts`.
- **Playwright** — browser-driven E2E tests. Picks up
  `tests/e2e/**/*.spec.ts`. The `webServer` in `playwright.config.ts`
  boots the api-server with fake env vars so no real GitHub, Railway
  volume, or Pushover account is required.

## Scripts

| Script | What it does |
| --- | --- |
| `pnpm --filter @workspace/api-server test` | Runs all Vitest suites once and exits. |
| `pnpm --filter @workspace/api-server test:watch` | Re-runs Vitest on change. |
| `pnpm --filter @workspace/api-server test:coverage` | Runs Vitest with v8 coverage. Reports go to `coverage/`. Starting threshold is 70% lines (raise per task). |
| `pnpm --filter @workspace/api-server test:e2e` | Boots the api-server and runs Playwright. |
| `pnpm --filter @workspace/api-server typecheck` | `tsc --noEmit`. |
| `pnpm --filter @workspace/api-server verify` | Chains `typecheck → test → test:e2e`. This is the verification gate union. |

## Verification gate convention

For every feature task in this batch:

1. **Add a `verify:<feature>` script.** It must run only the tests
   relevant to that feature (e.g. `verify:rate-limit` runs the rate
   limiter unit tests + any integration test that exercises the
   limiter). Use Vitest's `--run <pattern>` for unit/integration and
   Playwright's `--grep` for E2E.
2. **Run it green locally.** The script must exit 0 with no skipped
   tests in the relevant area.
3. **Paste the trimmed output into the task** before calling
   `mark_task_complete`. This is what reviewers look at — claims
   without evidence do not count.
4. **Roll the gate into `pnpm verify`.** Add the new `verify:<feature>`
   script to `package.json` and (only if it isn't already covered by
   `test` + `test:e2e`) chain it into `verify` so future tasks cannot
   regress your feature silently.

Example for a hypothetical Task #N adding a "search ranker" feature:

```jsonc
"scripts": {
  "verify:search": "vitest run -t 'search ranker' && playwright test --grep @search"
}
```

## Ephemeral git remote (for VaultService tests)

Tests that need a real `simple-git` push/pull cycle must use an
**ephemeral bare repo** rather than the live GitHub vault. The fixture
helper lives in `tests/fixtures/git-remote.ts` (added in Task #7) and
should be used like this:

```ts
import { createEphemeralRemote } from "../fixtures/git-remote";

const remote = await createEphemeralRemote(); // tmp dir, bare init, returns file:// URL
// ...point VaultService at remote.url, exercise it...
await remote.cleanup();
```

Rules:

- Never point a test at the production `VAULT_REPO_URL`.
- Never write to `/vault-cache` from a test. Tests use
  `tests/.tmp/vault-cache-<random>` and clean up in `afterAll`.
- The ephemeral remote runs entirely on the local filesystem (no
  network).

## Out of scope for this gate

- ESLint is not yet wired into the artifact. If a future task adds it,
  prepend `lint &&` to the `verify` chain.
- CI thresholds and PR gating live in the CI pipeline task; this
  document covers local verification only.
