import app from "./app";
import { logger } from "./lib/logger";
import { loadConfig } from "./lib/config";
import { vaultService } from "./vault/service";
import { runStdio } from "./mcp/stdio";
import { redactError } from "./lib/redact";

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
    logger.error({ err: redactError(err) }, "vault init failed; continuing so /healthz can report");
  }

  // Log the final tool inventory at startup so ops can confirm parity.
  try {
    const { buildTools, isWriteTool } = await import("./mcp/tools");
    const tools = buildTools();
    logger.info(
      {
        count: tools.length,
        tools: tools.map((t) => ({ name: t.name, write: isWriteTool(t.name) })),
      },
      "MCP tool inventory",
    );
  } catch (err) {
    logger.warn({ err: redactError(err) }, "could not enumerate tools at startup");
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
  logger.error({ err: redactError(err) }, "fatal startup error");
  process.exit(1);
});
