import { defineConfig } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 5179);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
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
    command: "pnpm run build && pnpm run start:http",
    url: `${BASE_URL}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    cwd: ".",
    env: {
      NODE_ENV: "test",
      PORT: String(PORT),
      BASE_URL,
      // Fake config so the server can boot without a real GitHub repo or Railway volume.
      VAULT_REPO_URL: "https://github.com/example/fake-vault.git",
      GITHUB_PAT: "ghp_e2e_smoke_fake_token_do_not_use",
      OAUTH_CLIENT_ID: "obsidian-mcp-railway-e2e",
      OAUTH_CLIENT_SECRET: "e2e-client-secret-do-not-use",
      SESSION_ENCRYPTION_KEY:
        "e2e-session-encryption-key-32bytes-min-length-aaaa",
      PERSONAL_AUTH_TOKEN: "e2e-personal-auth-token",
      VAULT_CACHE_DIR: "./tests/.tmp/vault-cache-e2e",
      OAUTH_STORE_PATH: "./tests/.tmp/oauth-store-e2e.json",
      OBSIDIAN_WRITE_PATHS: "00-Inbox,Journal",
      MAX_WRITES_PER_HOUR: "20",
      OAUTH_ALLOWED_REDIRECT_PREFIXES: "http://127.0.0.1,http://localhost",
    },
  },
});
