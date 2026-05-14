import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { buildOAuthRouter } from "./oauth/routes";
import { logger } from "./lib/logger";

const app: Express = express();

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

app.use("/api", router);

app.get("/", (_req, res) => {
  res.json({
    name: "obsidian-mcp-railway",
    mcp_endpoint: "/api/mcp",
    health: "/api/healthz",
    oauth_metadata: "/.well-known/oauth-authorization-server",
  });
});

export default app;
