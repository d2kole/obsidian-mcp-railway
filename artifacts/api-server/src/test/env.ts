process.env["VAULT_REPO_URL"] = "https://github.com/example/vault.git";
process.env["GITHUB_PAT"] = "ghp_supersecretpattokenvalue1234567890";
process.env["OAUTH_CLIENT_ID"] = "obsidian-mcp-railway";
process.env["OAUTH_CLIENT_SECRET"] = "test-client-secret-12345678";
process.env["SESSION_ENCRYPTION_KEY"] = "test-session-encryption-key-32chars!!";
process.env["PERSONAL_AUTH_TOKEN"] = "test-personal-auth-token";
process.env["BASE_URL"] = "http://localhost:3000";
process.env["OAUTH_ALLOWED_REDIRECT_PREFIXES"] =
  "https://claude.ai/,http://localhost:8080/cb";
process.env["OBSIDIAN_WRITE_PATHS"] = "00-Inbox,01-Daily,Captures";
process.env["MAX_WRITES_PER_HOUR"] = "3";
process.env["VAULT_CACHE_DIR"] = "/tmp/vault-cache-test";

import { loadConfig } from "../lib/config";
loadConfig("http");
