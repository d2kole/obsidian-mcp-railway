import { Router, type IRouter, type Response, type Request } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { createMcpServer } from "./server";
import { requireAccessToken, type AuthedRequest } from "../oauth/routes";
import { getConfig } from "../lib/config";
import { logger } from "../lib/logger";

interface ActiveSession {
  transport: StreamableHTTPServerTransport;
  createdAt: number;
}

const sessions = new Map<string, ActiveSession>();

function reapStaleSessions(maxAgeMs: number): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > maxAgeMs) {
      try {
        s.transport.close();
      } catch {
        /* ignore */
      }
      sessions.delete(id);
    }
  }
}

setInterval(() => reapStaleSessions(2 * 60 * 60 * 1000), 5 * 60 * 1000).unref();

export function buildMcpRouter(): IRouter {
  const router = Router();

  router.use(requireAccessToken);

  router.post("/", async (req: AuthedRequest, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let session: ActiveSession | undefined = sessionId
        ? sessions.get(sessionId)
        : undefined;

      if (!session && isInitializeRequest(req.body)) {
        const cfg = getConfig();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newId) => {
            sessions.set(newId, { transport, createdAt: Date.now() });
            logger.info({ sessionId: newId }, "mcp session initialized");
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        const sessionKey = req.auth?.token ?? "anonymous";
        const server = createMcpServer({
          sessionKey,
          maxWritesPerHour: cfg.rateLimit.maxWritesPerHour,
        });
        await server.connect(transport);
        session = { transport, createdAt: Date.now() };
      }

      if (!session) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message:
              "Missing or invalid mcp-session-id. Send an initialize request first.",
          },
          id: null,
        });
        return;
      }

      await session.transport.handleRequest(req as unknown as Request, res, req.body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, "mcp transport error");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message },
          id: null,
        });
      }
    }
  });

  router.get("/", async (req: AuthedRequest, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(400).end("Unknown or missing mcp-session-id.");
      return;
    }
    await session.transport.handleRequest(req as unknown as Request, res);
  });

  router.delete("/", async (req: AuthedRequest, res: Response) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      res.status(204).end();
      return;
    }
    try {
      session.transport.close();
    } catch {
      /* ignore */
    }
    sessions.delete(sessionId!);
    res.status(204).end();
  });

  return router;
}

export function getActiveSessionCount(): number {
  return sessions.size;
}
