import app from "./app";
import { logger } from "./lib/logger";
import { loadConfig } from "./lib/config";
import { vaultService } from "./vault/service";
import { runStdio } from "./mcp/stdio";

async function main(): Promise<void> {
  const mode =
    process.argv.includes("stdio") || process.env["MCP_MODE"] === "stdio"
      ? "stdio"
      : "http";

  if (mode === "stdio") {
    await runStdio();
    return;
  }

  const cfg = loadConfig("http");
  try {
    await vaultService.init();
  } catch (err) {
    logger.error({ err: (err as Error).message }, "vault init failed; continuing so /healthz can report");
  }

  app.listen(cfg.port, (err?: Error) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }
    logger.info(
      { port: cfg.port, baseUrl: cfg.baseUrl },
      "obsidian-mcp-railway HTTP server listening",
    );
  });
}

main().catch((err) => {
  logger.error({ err: (err as Error).message }, "fatal startup error");
  process.exit(1);
});
