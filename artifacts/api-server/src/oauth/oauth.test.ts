import "../test/env";
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { buildOAuthRouter } from "./routes";
import {
  createAuthCode,
  consumeAuthCode,
  issueAccessToken,
  lookupAccessToken,
  verifyPkce,
} from "./store";
import { getConfig } from "../lib/config";

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(buildOAuthRouter());
  return app;
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return { verifier, challenge };
}

describe("OAuth PKCE flow", () => {
  it("happy path: S256 PKCE issues access token", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const { verifier, challenge } = pkcePair();

    const authRes = await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({
        response_type: "code",
        client_id: cfg.oauth.clientId,
        redirect_uri: "https://claude.ai/cb",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "mcp",
        state: "xyz",
        auth_token: cfg.oauth.personalAuthToken,
      });

    expect(authRes.status).toBe(302);
    const loc = new URL(authRes.headers["location"] as string);
    const code = loc.searchParams.get("code");
    expect(code).toBeTruthy();
    expect(loc.searchParams.get("state")).toBe("xyz");

    const tokRes = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code: code!,
        redirect_uri: "https://claude.ai/cb",
        code_verifier: verifier,
        client_id: cfg.oauth.clientId,
      });

    expect(tokRes.status).toBe(200);
    expect(tokRes.body.access_token).toBeTruthy();
    expect(tokRes.body.token_type).toBe("Bearer");

    const looked = await lookupAccessToken(tokRes.body.access_token);
    expect(looked).not.toBeNull();
    expect(looked!.clientId).toBe(cfg.oauth.clientId);
  });

  it("rejects non-S256 code_challenge_method on GET /oauth/authorize", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const res = await request(app)
      .get("/oauth/authorize")
      .query({
        response_type: "code",
        client_id: cfg.oauth.clientId,
        redirect_uri: "https://claude.ai/cb",
        code_challenge: "abc",
        code_challenge_method: "plain",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.error_description).toMatch(/S256/);
  });

  it("rejects redirect_uri outside the allowlist", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const res = await request(app)
      .get("/oauth/authorize")
      .query({
        response_type: "code",
        client_id: cfg.oauth.clientId,
        redirect_uri: "https://evil.example.com/cb",
        code_challenge: "abc",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.error_description).toMatch(/allowlist/);
  });

  it("rejects client_id mismatch", async () => {
    const app = makeApp();
    const res = await request(app)
      .get("/oauth/authorize")
      .query({
        response_type: "code",
        client_id: "not-the-real-client",
        redirect_uri: "https://claude.ai/cb",
        code_challenge: "abc",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unauthorized_client");
  });

  it("rejects expired authorization code", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const { verifier, challenge } = pkcePair();
    // Create a code with negative TTL so it's already expired.
    const code = createAuthCode({
      clientId: cfg.oauth.clientId,
      redirectUri: "https://claude.ai/cb",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: "mcp",
      ttlMs: -1000,
    });
    const res = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://claude.ai/cb",
        code_verifier: verifier,
        client_id: cfg.oauth.clientId,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("rejects expired access token via lookupAccessToken", async () => {
    const tok = await issueAccessToken({
      clientId: getConfig().oauth.clientId,
      scope: "mcp",
      ttlSec: -10,
    });
    const looked = await lookupAccessToken(tok.token);
    expect(looked).toBeNull();
  });

  it("verifyPkce: matching verifier validates, non-matching does not", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce("wrong-verifier", challenge)).toBe(false);
  });

  it("consumeAuthCode is single-use", () => {
    const cfg = getConfig();
    const code = createAuthCode({
      clientId: cfg.oauth.clientId,
      redirectUri: "https://claude.ai/cb",
      codeChallenge: "x",
      codeChallengeMethod: "S256",
      scope: "mcp",
    });
    expect(consumeAuthCode(code)).not.toBeNull();
    expect(consumeAuthCode(code)).toBeNull();
  });
});
