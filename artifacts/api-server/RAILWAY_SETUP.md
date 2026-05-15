# Railway Setup

The full step-by-step Railway + GitHub setup guide lives at the repo root:

- [`../../RAILWAY_SETUP.md`](../../RAILWAY_SETUP.md)

It covers the two-repo model (`d2kole/obsidian-mcp-railway` for service code vs. `d2kole/obsidian-my-second-brain` for vault content), pushing this monorepo to GitHub, configuring the Railway service, the `/vault-cache` volume, all required environment variables, and verifying the healthcheck.

For runtime operations (PAT rotation, volume DR, admin endpoints, alerting) see [`OPERATIONS.md`](./OPERATIONS.md).
