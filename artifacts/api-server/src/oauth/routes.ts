import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import {
  createAuthCode,
  consumeAuthCode,
  verifyPkce,
  issueAccessToken,
  lookupAccessToken,
  clearExpired,
} from "./store";
import { getConfig } from "../lib/config";
import { logger } from "../lib/logger";

setInterval(clearExpired, 5 * 60 * 1000).unref();

export interface AuthedRequest extends Request {
  auth?: { clientId: string; token: string };
}

export function requireAccessToken(
  req: AuthedRequest,
  res: Response,
  next: NextFunction,
): void {
  const header = req.headers.authorization ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m) {
    res.status(401)
      .header("WWW-Authenticate", `Bearer realm="obsidian-mcp-railway"`)
      .json({
        error: "missing_token",
        error_description:
          "Missing Bearer access token. Complete the OAuth authorization flow at /oauth/authorize first.",
      });
    return;
  }
  const entry = lookupAccessToken(m[1]!);
  if (!entry) {
    res.status(401)
      .header("WWW-Authenticate", `Bearer realm="obsidian-mcp-railway", error="invalid_token"`)
      .json({
        error: "invalid_token",
        error_description: "Access token is invalid or expired. Re-run the OAuth flow.",
      });
    return;
  }
  req.auth = { clientId: entry.clientId, token: entry.token };
  next();
}

export function buildOAuthRouter(): IRouter {
  const router = Router();

  // Discovery — RFC 8414
  router.get("/.well-known/oauth-authorization-server", (_req, res) => {
    const cfg = getConfig();
    res.json({
      issuer: cfg.baseUrl,
      authorization_endpoint: `${cfg.baseUrl}/oauth/authorize`,
      token_endpoint: `${cfg.baseUrl}/oauth/token`,
      registration_endpoint: `${cfg.baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256", "plain"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: ["mcp"],
    });
  });

  // OAuth 2.0 Protected Resource discovery — used by Claude.ai to find the AS.
  router.get("/.well-known/oauth-protected-resource", (_req, res) => {
    const cfg = getConfig();
    res.json({
      resource: cfg.baseUrl,
      authorization_servers: [cfg.baseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
    });
  });

  // Dynamic Client Registration — RFC 7591 (minimal stub returning the configured client).
  router.post("/oauth/register", (req, res) => {
    const cfg = getConfig();
    const body = (req.body ?? {}) as Record<string, unknown>;
    res.status(201).json({
      client_id: cfg.oauth.clientId,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      redirect_uris: body["redirect_uris"] ?? [],
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
  });

  // Authorize — render minimal login form.
  router.get("/oauth/authorize", (req, res) => {
    const params = req.query as Record<string, string | undefined>;
    const required = ["response_type", "client_id", "redirect_uri", "code_challenge"];
    for (const k of required) {
      if (!params[k]) {
        res.status(400).json({
          error: "invalid_request",
          error_description: `Missing required parameter: ${k}`,
        });
        return;
      }
    }
    if (params["response_type"] !== "code") {
      res.status(400).json({
        error: "unsupported_response_type",
        error_description: "Only response_type=code is supported.",
      });
      return;
    }

    const safe = (s: string | undefined): string =>
      (s ?? "").replace(/[<>&"']/g, (c) => `&#${c.charCodeAt(0)};`);

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>obsidian-mcp-railway sign-in</title>
<style>
  body { font-family: ui-sans-serif, system-ui, sans-serif; max-width: 380px; margin: 8vh auto; padding: 0 16px; color: #111; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  p { font-size: 14px; color: #555; margin: 0 0 16px; }
  label { display: block; font-size: 13px; margin: 12px 0 4px; }
  input[type=password] { width: 100%; padding: 10px; font-size: 14px; border: 1px solid #ccc; border-radius: 6px; box-sizing: border-box; }
  button { margin-top: 16px; width: 100%; padding: 10px; font-size: 14px; border: 0; border-radius: 6px; background: #111; color: #fff; cursor: pointer; }
</style>
</head>
<body>
  <h1>obsidian-mcp-railway</h1>
  <p>Enter your personal access token to authorize this MCP client.</p>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="response_type" value="${safe(params["response_type"])}" />
    <input type="hidden" name="client_id" value="${safe(params["client_id"])}" />
    <input type="hidden" name="redirect_uri" value="${safe(params["redirect_uri"])}" />
    <input type="hidden" name="state" value="${safe(params["state"])}" />
    <input type="hidden" name="scope" value="${safe(params["scope"] ?? "mcp")}" />
    <input type="hidden" name="code_challenge" value="${safe(params["code_challenge"])}" />
    <input type="hidden" name="code_challenge_method" value="${safe(params["code_challenge_method"] ?? "S256")}" />
    <label for="auth_token">Personal access token</label>
    <input id="auth_token" name="auth_token" type="password" autocomplete="current-password" required autofocus />
    <button type="submit">Authorize</button>
  </form>
</body>
</html>`;
    res.status(200).header("Content-Type", "text/html; charset=utf-8").send(html);
  });

  router.post("/oauth/authorize", (req, res) => {
    const cfg = getConfig();
    const body = req.body as Record<string, string>;
    if (body["auth_token"] !== cfg.oauth.personalAuthToken) {
      res.status(401).json({
        error: "access_denied",
        error_description: "Invalid personal access token.",
      });
      return;
    }
    if (!body["redirect_uri"] || !body["code_challenge"]) {
      res.status(400).json({
        error: "invalid_request",
        error_description: "Missing redirect_uri or code_challenge.",
      });
      return;
    }
    const method = (body["code_challenge_method"] ?? "S256") as "S256" | "plain";
    const code = createAuthCode({
      clientId: body["client_id"] ?? cfg.oauth.clientId,
      redirectUri: body["redirect_uri"],
      codeChallenge: body["code_challenge"],
      codeChallengeMethod: method,
      scope: body["scope"] ?? "mcp",
    });
    const url = new URL(body["redirect_uri"]);
    url.searchParams.set("code", code);
    if (body["state"]) url.searchParams.set("state", body["state"]);
    logger.info({ clientId: body["client_id"], redirectUri: body["redirect_uri"] }, "oauth code issued");
    res.redirect(302, url.toString());
  });

  router.post("/oauth/token", (req, res) => {
    const cfg = getConfig();
    const body = req.body as Record<string, string>;
    if (body["grant_type"] !== "authorization_code") {
      res.status(400).json({
        error: "unsupported_grant_type",
        error_description: "Only authorization_code is supported.",
      });
      return;
    }
    const entry = consumeAuthCode(body["code"] ?? "");
    if (!entry) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "Authorization code is invalid or expired. Restart the flow at /oauth/authorize.",
      });
      return;
    }
    if (entry.redirectUri !== body["redirect_uri"]) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "redirect_uri mismatch.",
      });
      return;
    }
    const verifier = body["code_verifier"];
    if (!verifier || !verifyPkce(verifier, entry.codeChallenge, entry.codeChallengeMethod)) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "PKCE verification failed.",
      });
      return;
    }
    const token = issueAccessToken({
      clientId: entry.clientId,
      scope: entry.scope,
      ttlSec: cfg.oauth.accessTokenTtlSec,
    });
    res.json({
      access_token: token.token,
      token_type: "Bearer",
      expires_in: cfg.oauth.accessTokenTtlSec,
      scope: entry.scope,
    });
  });

  return router;
}
