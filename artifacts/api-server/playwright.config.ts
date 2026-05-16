import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 5179);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  env: {
    E2E_PORT: String(PORT),
  },
  testDir: "./tests/e2e",
  testMatch: /.*\.spec\.ts$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
  },
  webServer: {
    // e2e-bootstrap.mjs creates an ephemeral bare git repo seeded with vault
    // content, exports VAULT_REPO_URL/VAULT_CACHE_DIR pointing at it, then
    // exec's the api-server. This makes the OAuth + MCP browser flow exercise
    // a real git pipeline without touching github.com.
    command: "pnpm run build && node ./scripts/e2e-bootstrap.mjs",
    // Wait until OAuth metadata responds — `/` can answer before routes are
    // fully exercised; this endpoint proves the HTTP stack is ready.
    url: `${BASE_URL}/.well-known/oauth-protected-resource`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    cwd: ".",
    env: {
      NODE_ENV: "test",
      PORT: String(PORT),
      BASE_URL,
      // VAULT_REPO_URL / VAULT_CACHE_DIR are set inside e2e-bootstrap.mjs.
      GITHUB_PAT: "ghp_e2e_unused_local_remote_no_network",
      OAUTH_CLIENT_ID: "obsidian-mcp-railway-e2e",
      OAUTH_CLIENT_SECRET: "e2e-client-secret-do-not-use",
      SESSION_ENCRYPTION_KEY:
        "e2e-session-encryption-key-32bytes-min-length-aaaa",
      PERSONAL_AUTH_TOKEN: "e2e-personal-auth-token",
      OBSIDIAN_WRITE_PATHS: "00-Inbox,Journal",
      MAX_WRITES_PER_HOUR: "20",
      // Explicit dev ports + bare loopback entries (any port on 127.0.0.1/localhost
      // via isAllowedRedirectUri loopback wildcard when prefix omits port).
      OAUTH_ALLOWED_REDIRECT_PREFIXES: [
        `http://127.0.0.1:${PORT}`,
        `http://localhost:${PORT}`,
        "http://127.0.0.1:5179",
        "http://localhost:5179",
        "http://127.0.0.1",
        "http://localhost",
      ].join(","),
    },
  },
});
