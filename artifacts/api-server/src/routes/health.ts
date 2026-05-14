import { Router, type IRouter } from "express";
import fs from "node:fs/promises";
import { vaultService } from "../vault/service";
import { getActiveSessionCount, isMcpRouterMounted } from "../mcp/transport";
import { logger } from "../lib/logger";
import { redactError } from "../lib/redact";
import { getConfig } from "../lib/config";

const router: IRouter = Router();

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

router.get("/healthz", async (_req, res) => {
  const checks: CheckResult[] = [];
  const start = Date.now();

  // 1. /vault-cache mount actually exists, is a directory, and is readable+writable.
  try {
    const cfg = getConfig();
    const dir = cfg.vault.cacheDir;
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) {
      throw new Error(`${dir} exists but is not a directory`);
    }
    await fs.access(dir, fs.constants.R_OK | fs.constants.W_OK);
    checks.push({
      name: "vault_cache_present",
      ok: true,
      detail: dir,
    });
  } catch (err) {
    checks.push({
      name: "vault_cache_present",
      ok: false,
      detail: redactError(err),
    });
  }

  // 2. Real git fetch dry-run against the configured remote.
  try {
    await vaultService.dryRunFetch();
    checks.push({ name: "git_fetch_dry_run", ok: true });
  } catch (err) {
    checks.push({
      name: "git_fetch_dry_run",
      ok: false,
      detail: redactError(err),
    });
  }

  // 3. MCP router mounted and ready (real registration check).
  const mounted = isMcpRouterMounted();
  checks.push({
    name: "mcp_handler_registered",
    ok: mounted,
    detail: mounted
      ? `${getActiveSessionCount()} active sessions`
      : "MCP router has not been mounted on the express app yet",
  });

  const ok = checks.every((c) => c.ok);
  const elapsedMs = Date.now() - start;

  if (!ok) {
    logger.warn({ checks, elapsedMs }, "healthz failure");
  }

  res.status(ok ? 200 : 500).json({
    status: ok ? "ok" : "fail",
    elapsedMs,
    checks,
  });
});

export default router;
