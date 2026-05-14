import { Router, type IRouter } from "express";
import { vaultService } from "../vault/service";
import { getActiveSessionCount } from "../mcp/transport";
import { logger } from "../lib/logger";

const router: IRouter = Router();

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
}

router.get("/healthz", async (_req, res) => {
  const checks: CheckResult[] = [];
  const start = Date.now();

  try {
    const dir = vaultService.getCacheDir();
    if (!dir) throw new Error("vault cache dir not configured");
    checks.push({ name: "vault_cache_present", ok: true, detail: dir });
  } catch (err) {
    checks.push({
      name: "vault_cache_present",
      ok: false,
      detail: (err as Error).message,
    });
  }

  try {
    await vaultService.dryRunFetch();
    checks.push({ name: "git_fetch_dry_run", ok: true });
  } catch (err) {
    checks.push({
      name: "git_fetch_dry_run",
      ok: false,
      detail: (err as Error).message,
    });
  }

  checks.push({
    name: "mcp_handler_registered",
    ok: true,
    detail: `${getActiveSessionCount()} active sessions`,
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
