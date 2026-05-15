# tests/unit

Pure unit tests. Each test exercises one module in isolation with no
network, no filesystem outside `tests/.tmp/`, and no spawned
subprocesses.

## What belongs here

- Tests for a single function, class, or small module.
- Tests that mock out `simple-git`, `fetch`, and `fs` boundaries.
- Tests that finish in well under a second each.

## What does NOT belong here

- Tests that boot Express — those go in `tests/integration`.
- Tests that need a real browser — those go in `tests/e2e`.
- Tests that hit a real git remote — those go in `tests/integration`
  (with an ephemeral local remote from `tests/fixtures/git-remote.ts`).

## Naming

`tests/unit/<area>/<thing>.test.ts` — e.g.
`tests/unit/oauth/pkce.test.ts`. The vitest config also picks up legacy
co-located tests under `src/**/*.test.ts`; new tests should prefer
this directory.
