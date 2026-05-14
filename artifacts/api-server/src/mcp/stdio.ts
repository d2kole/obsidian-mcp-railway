import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./server";
import { vaultService } from "../vault/service";
import { loadConfig } from "../lib/config";
import { logger } from "../lib/logger";

export async function runStdio(): Promise<void> {
  const cfg = loadConfig("stdio");
  await vaultService.init();
  const server = createMcpServer({
    sessionKey: "stdio-local",
    maxWritesPerHour: cfg.rateLimit.maxWritesPerHour,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("stdio MCP server connected");
}
