import { logger } from "./logger";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. See OPERATIONS.md for the full list.`,
    );
  }
  return v;
}

function optional(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.trim() !== "" ? v : fallback;
}

function optionalNum(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseList(name: string, fallback: string[]): string[] {
  const v = process.env[name];
  if (!v) return fallback;
  return v
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export interface AppConfig {
  mode: "http" | "stdio";
  port: number;
  baseUrl: string;
  vault: {
    repoUrl: string;
    branch: string;
    cacheDir: string;
    githubPat: string;
    writePaths: string[];
  };
  oauth: {
    clientId: string;
    clientSecret: string;
    sessionSecret: string;
    personalAuthToken: string;
    accessTokenTtlSec: number;
    storePath: string;
  };
  rateLimit: {
    maxWritesPerHour: number;
  };
  oauthAllowedRedirectPrefixes: string[];
  journal: {
    pathTemplate: string;
    dateFormat: string;
    activitySection: string;
  };
}

let cached: AppConfig | null = null;

export function loadConfig(mode: "http" | "stdio"): AppConfig {
  if (cached) return cached;

  const isStdio = mode === "stdio";

  cached = {
    mode,
    port: Number(optional("PORT", "3000")),
    baseUrl: optional("BASE_URL", "http://localhost:3000"),
    vault: {
      repoUrl: required("VAULT_REPO_URL"),
      branch: optional("VAULT_BRANCH", "main"),
      cacheDir: optional("VAULT_CACHE_DIR", "/vault-cache"),
      githubPat: required("GITHUB_PAT"),
      writePaths: parseList("OBSIDIAN_WRITE_PATHS", [
        "00-Inbox",
        "01-Daily",
        "Captures",
        "Journal",
      ]),
    },
    oauth: {
      clientId: optional("OAUTH_CLIENT_ID", "obsidian-mcp-railway"),
      clientSecret: isStdio
        ? optional("OAUTH_CLIENT_SECRET", "stdio-not-used")
        : required("OAUTH_CLIENT_SECRET"),
      sessionSecret: isStdio
        ? optional("SESSION_ENCRYPTION_KEY", "stdio-not-used-padding-padding-pa")
        : required("SESSION_ENCRYPTION_KEY"),
      personalAuthToken: isStdio
        ? optional("PERSONAL_AUTH_TOKEN", "stdio-not-used")
        : required("PERSONAL_AUTH_TOKEN"),
      accessTokenTtlSec: optionalNum("OAUTH_ACCESS_TOKEN_TTL_SEC", 86400),
      storePath: optional(
        "OAUTH_STORE_PATH",
        `${optional("VAULT_CACHE_DIR", "/vault-cache")}/.oauth-store.json`,
      ),
    },
    rateLimit: {
      maxWritesPerHour: optionalNum("MAX_WRITES_PER_HOUR", 20),
    },
    oauthAllowedRedirectPrefixes: parseList("OAUTH_ALLOWED_REDIRECT_PREFIXES", [
      "https://claude.ai/",
      "https://claude.com/",
      "http://localhost",
      "http://127.0.0.1",
    ]),
    journal: {
      pathTemplate: optional("JOURNAL_PATH_TEMPLATE", "Journal/{{date}}.md"),
      dateFormat: optional("JOURNAL_DATE_FORMAT", "YYYY-MM-DD"),
      activitySection: optional("JOURNAL_ACTIVITY_SECTION", "## Activity"),
    },
  };

  logger.info(
    {
      mode: cached.mode,
      port: cached.port,
      vaultBranch: cached.vault.branch,
      vaultCacheDir: cached.vault.cacheDir,
      writePaths: cached.vault.writePaths,
      maxWritesPerHour: cached.rateLimit.maxWritesPerHour,
    },
    "Configuration loaded",
  );

  return cached;
}

export function getConfig(): AppConfig {
  if (!cached) {
    throw new Error("Config has not been loaded yet. Call loadConfig() first.");
  }
  return cached;
}
