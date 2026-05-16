import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { buildOAuthRouter } from "./oauth/routes";
import { logger } from "./lib/logger";

const app: Express = express();

// Railway terminates TLS at its edge proxy and forwards via X-Forwarded-For.
// Trust a single hop so req.ip reflects the real client (used by the OAuth
// store's last_used_ip telemetry on /admin/tokens — see OPERATIONS.md).
// "1" rather than "true" prevents an attacker from spoofing the IP by
// chaining their own X-Forwarded-For values; only the proxy hop is honored.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(
  cors({
    origin: true,
    credentials: false,
    exposedHeaders: ["mcp-session-id", "WWW-Authenticate"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "mcp-session-id",
      "Mcp-Session-Id",
    ],
  }),
);
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: true }));

// OAuth and discovery endpoints are mounted at the root (Claude.ai expects /.well-known/* and /oauth/* at the apex).
app.use(buildOAuthRouter());

import { buildMcpRouter } from "./mcp/transport";
app.use("/mcp", buildMcpRouter());
app.use("/api", router);

app.get("/", (_req, res) => {
  res.json({
    name: "obsidian-mcp-railway",
    mcp_endpoint: "/mcp",
    health: "/api/healthz",
    oauth_metadata: "/.well-known/oauth-authorization-server",
  });
});

export default app;
