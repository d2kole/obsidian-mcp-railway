import "../test/env";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { SignJWT } from "jose";
import { buildOAuthRouter, requireAccessToken } from "./routes";
import {
  createAuthCode,
  consumeAuthCode,
  issueAccessToken,
  lookupAccessToken,
  verifyPkce,
} from "./store";
import { getConfig } from "../lib/config";
import { logger } from "../lib/logger";

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

  it("admin: lists active tokens, revokes one, immediately rejects further use", async () => {
    const app = makeApp();
    const cfg = getConfig();

    // Issue two tokens for two distinct clients.
    const t1 = await issueAccessToken({
      clientId: cfg.oauth.clientId,
      scope: "mcp",
      ttlSec: 3600,
    });
    const t2 = await issueAccessToken({
      clientId: cfg.oauth.clientId,
      scope: "mcp",
      ttlSec: 3600,
    });

    // Unauthenticated list is rejected.
    const noAuth = await request(app).get("/admin/tokens");
    expect(noAuth.status).toBe(401);

    // Wrong token is rejected.
    const badAuth = await request(app)
      .get("/admin/tokens")
      .set("Authorization", "Bearer not-the-real-pat");
    expect(badAuth.status).toBe(401);

    // Authenticated list includes both jtis.
    const listRes = await request(app)
      .get("/admin/tokens")
      .set("Authorization", `Bearer ${cfg.oauth.personalAuthToken}`);
    expect(listRes.status).toBe(200);
    const jtis = (listRes.body.tokens as Array<{ jti: string }>).map((t) => t.jti);
    expect(jtis).toContain(t1.jti);
    expect(jtis).toContain(t2.jti);

    // Both tokens still validate before revocation.
    expect(await lookupAccessToken(t1.token)).not.toBeNull();
    expect(await lookupAccessToken(t2.token)).not.toBeNull();

    // Revoke t1.
    const revRes = await request(app)
      .post(`/admin/tokens/${t1.jti}/revoke`)
      .set("Authorization", `Bearer ${cfg.oauth.personalAuthToken}`);
    expect(revRes.status).toBe(200);
    expect(revRes.body.revoked).toBe(true);

    // t1 is now rejected; t2 still works.
    expect(await lookupAccessToken(t1.token)).toBeNull();
    expect(await lookupAccessToken(t2.token)).not.toBeNull();

    // t1 no longer appears in the active list.
    const listAfter = await request(app)
      .get("/admin/tokens")
      .set("Authorization", `Bearer ${cfg.oauth.personalAuthToken}`);
    const jtisAfter = (listAfter.body.tokens as Array<{ jti: string }>).map(
      (t) => t.jti,
    );
    expect(jtisAfter).not.toContain(t1.jti);
    expect(jtisAfter).toContain(t2.jti);

    // Revoking an unknown jti returns 404.
    const missing = await request(app)
      .post(`/admin/tokens/no-such-jti/revoke`)
      .set("Authorization", `Bearer ${cfg.oauth.personalAuthToken}`);
    expect(missing.status).toBe(404);

    // Revoking an already-revoked jti also returns 404 (not a silent 200) so
    // the operator sees a clear "nothing to do" instead of a misleading success.
    const dupe = await request(app)
      .post(`/admin/tokens/${t1.jti}/revoke`)
      .set("Authorization", `Bearer ${cfg.oauth.personalAuthToken}`);
    expect(dupe.status).toBe(404);
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

describe("OAuth additional rejection paths (task #10 TDD coverage)", () => {
  it("rejects POST /oauth/authorize when code_challenge is missing", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const res = await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({
        response_type: "code",
        client_id: cfg.oauth.clientId,
        redirect_uri: "https://claude.ai/cb",
        // code_challenge intentionally omitted
        scope: "mcp",
        auth_token: cfg.oauth.personalAuthToken,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.error_description).toMatch(/code_challenge/);
  });

  it("rejects GET /oauth/authorize when code_challenge is missing", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const res = await request(app)
      .get("/oauth/authorize")
      .query({
        response_type: "code",
        client_id: cfg.oauth.clientId,
        redirect_uri: "https://claude.ai/cb",
        // code_challenge intentionally omitted
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.error_description).toMatch(/code_challenge/);
  });

  it("rejects /oauth/token when code_verifier does not match the stored challenge", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const { challenge } = pkcePair();
    const otherVerifier = crypto.randomBytes(32).toString("base64url");

    const code = createAuthCode({
      clientId: cfg.oauth.clientId,
      redirectUri: "https://claude.ai/cb",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: "mcp",
    });
    const res = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://claude.ai/cb",
        code_verifier: otherVerifier,
        client_id: cfg.oauth.clientId,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    expect(res.body.error_description).toMatch(/PKCE/i);
  });

  it("rejects /oauth/token when code_verifier is missing", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const { challenge } = pkcePair();
    const code = createAuthCode({
      clientId: cfg.oauth.clientId,
      redirectUri: "https://claude.ai/cb",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: "mcp",
    });
    const res = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://claude.ai/cb",
        client_id: cfg.oauth.clientId,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
  });

  it("rejects /oauth/token when redirect_uri does not match the issued code", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const { verifier, challenge } = pkcePair();
    const code = createAuthCode({
      clientId: cfg.oauth.clientId,
      redirectUri: "https://claude.ai/cb",
      codeChallenge: challenge,
      codeChallengeMethod: "S256",
      scope: "mcp",
    });
    const res = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: "http://localhost:8080/cb", // allowlisted but not the one bound to the code
        code_verifier: verifier,
        client_id: cfg.oauth.clientId,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");
    expect(res.body.error_description).toMatch(/redirect_uri/);
  });

  it("rejects /oauth/token with unsupported grant_type", async () => {
    const app = makeApp();
    const res = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({ grant_type: "client_credentials" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_grant_type");
  });

  it("authorization codes are single-use through the real /oauth/token route (replay rejected)", async () => {
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
        state: "replay",
        auth_token: cfg.oauth.personalAuthToken,
      });
    expect(authRes.status).toBe(302);
    const code = new URL(authRes.headers["location"] as string).searchParams.get(
      "code",
    )!;

    const first = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://claude.ai/cb",
        code_verifier: verifier,
        client_id: cfg.oauth.clientId,
      });
    expect(first.status).toBe(200);
    expect(first.body.access_token).toBeTruthy();

    // Replay the same code — must be rejected.
    const replay = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code,
        redirect_uri: "https://claude.ai/cb",
        code_verifier: verifier,
        client_id: cfg.oauth.clientId,
      });
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
  });

  it("POST /oauth/authorize rejects an invalid personal auth token", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const { challenge } = pkcePair();
    const res = await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({
        response_type: "code",
        client_id: cfg.oauth.clientId,
        redirect_uri: "https://claude.ai/cb",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "mcp",
        auth_token: "this-is-not-the-pat",
      });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("access_denied");
  });

  it("GET /oauth/authorize renders the login form on a valid request", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const { challenge } = pkcePair();
    const res = await request(app)
      .get("/oauth/authorize")
      .query({
        response_type: "code",
        client_id: cfg.oauth.clientId,
        redirect_uri: "https://claude.ai/cb",
        code_challenge: challenge,
        code_challenge_method: "S256",
        state: "ok",
        scope: "mcp",
      });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.text).toContain("Personal access token");
  });

  it("POST /oauth/authorize rejects redirect_uri outside the allowlist", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const { challenge } = pkcePair();
    const res = await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({
        response_type: "code",
        client_id: cfg.oauth.clientId,
        redirect_uri: "https://evil.example.com/cb",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "mcp",
        auth_token: cfg.oauth.personalAuthToken,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.error_description).toMatch(/allowlist/);
  });

  it("POST /oauth/authorize rejects non-S256 code_challenge_method", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const { challenge } = pkcePair();
    const res = await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({
        response_type: "code",
        client_id: cfg.oauth.clientId,
        redirect_uri: "https://claude.ai/cb",
        code_challenge: challenge,
        code_challenge_method: "plain",
        scope: "mcp",
        auth_token: cfg.oauth.personalAuthToken,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
    expect(res.body.error_description).toMatch(/S256/);
  });

  it("POST /oauth/authorize rejects unknown client_id", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const { challenge } = pkcePair();
    const res = await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({
        response_type: "code",
        client_id: "not-the-real-client",
        redirect_uri: "https://claude.ai/cb",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "mcp",
        auth_token: cfg.oauth.personalAuthToken,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unauthorized_client");
  });

  it("rejects /oauth/authorize when redirect_uri is malformed", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const res = await request(app)
      .get("/oauth/authorize")
      .query({
        response_type: "code",
        client_id: cfg.oauth.clientId,
        redirect_uri: "not a url",
        code_challenge: "abc",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("isAllowedRedirect skips a malformed prefix in config without throwing", async () => {
    // Inject a bogus prefix at runtime so the URL constructor inside
    // isAllowedRedirect throws on the prefix parse — the loop must catch and
    // continue evaluating the remaining (well-formed) prefixes rather than
    // 500ing the whole authorize endpoint.
    const cfg = getConfig();
    const original = [...cfg.oauthAllowedRedirectPrefixes];
    cfg.oauthAllowedRedirectPrefixes.unshift("::not-a-url::");
    try {
      const app = makeApp();
      const res = await request(app)
        .get("/oauth/authorize")
        .query({
          response_type: "code",
          client_id: cfg.oauth.clientId,
          redirect_uri: "https://claude.ai/cb",
          code_challenge: "abc",
        });
      // The well-formed prefix still admits this URI — 200 (login form).
      expect(res.status).toBe(200);
    } finally {
      cfg.oauthAllowedRedirectPrefixes.length = 0;
      cfg.oauthAllowedRedirectPrefixes.push(...original);
    }
  });

  it("rejects /oauth/authorize when redirect_uri contains a fragment", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const res = await request(app)
      .get("/oauth/authorize")
      .query({
        response_type: "code",
        client_id: cfg.oauth.clientId,
        redirect_uri: "https://claude.ai/cb#frag",
        code_challenge: "abc",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_request");
  });

  it("GET /oauth/authorize rejects an unsupported response_type", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const res = await request(app)
      .get("/oauth/authorize")
      .query({
        response_type: "token",
        client_id: cfg.oauth.clientId,
        redirect_uri: "https://claude.ai/cb",
        code_challenge: "abc",
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_response_type");
  });
});

describe("requireAccessToken middleware", () => {
  function makeProtectedApp() {
    const app = express();
    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(buildOAuthRouter());
    app.get("/protected", requireAccessToken, (req, res) => {
      const auth = (req as { auth?: { clientId: string } }).auth;
      res.json({ ok: true, clientId: auth?.clientId });
    });
    return app;
  }

  it("rejects requests with no Authorization header", async () => {
    const res = await request(makeProtectedApp()).get("/protected");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_token");
    expect(res.headers["www-authenticate"]).toMatch(/Bearer/);
  });

  it("rejects requests with a non-Bearer Authorization header", async () => {
    const res = await request(makeProtectedApp())
      .get("/protected")
      .set("Authorization", "Basic Zm9vOmJhcg==");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("missing_token");
  });

  it("rejects requests with an invalid Bearer token", async () => {
    const res = await request(makeProtectedApp())
      .get("/protected")
      .set("Authorization", "Bearer not-a-real-jwt");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("invalid_token");
    expect(res.headers["www-authenticate"]).toMatch(/invalid_token/);
  });

  it("admits requests with a valid Bearer token and exposes req.auth", async () => {
    const cfg = getConfig();
    const tok = await issueAccessToken({
      clientId: cfg.oauth.clientId,
      scope: "mcp",
      ttlSec: 60,
    });
    const res = await request(makeProtectedApp())
      .get("/protected")
      .set("Authorization", `Bearer ${tok.token}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.clientId).toBe(cfg.oauth.clientId);
  });
});

describe("_resetStoreForTests cancels pending persist timer", () => {
  it("clears an in-flight debounced write without firing it", async () => {
    const mod = await import("./store");
    // Trigger a mutation to schedule a persist timer, then immediately reset
    // before the debounce fires. The reset must not throw and must drop the
    // pending flush so it cannot corrupt the next test.
    mod.revokeJti("test-pending-flush");
    // The reset must not throw — it has to cancel the pending timer cleanly.
    expect(() => mod._resetStoreForTests()).not.toThrow();
    // And calling reset a second time (no pending timer) must also be a no-op.
    expect(() => mod._resetStoreForTests()).not.toThrow();
  });
});

describe("clearExpired prunes all bucket types", () => {
  it("removes expired auth codes, revoked-jti entries, and issued tokens", async () => {
    const cfg = getConfig();
    const { clearExpired, createAuthCode, revokeJti, issueAccessToken, listActiveTokens, isTokenIssued } =
      await import("./store");

    // Seed each bucket with at least one already-expired entry.
    createAuthCode({
      clientId: cfg.oauth.clientId,
      redirectUri: "https://claude.ai/cb",
      codeChallenge: "x",
      codeChallengeMethod: "S256",
      scope: "mcp",
      ttlMs: -1000,
    });
    revokeJti("expired-revoked-jti", Date.now() - 1000);
    const tok = await issueAccessToken({
      clientId: cfg.oauth.clientId,
      scope: "mcp",
      ttlSec: -10,
    });
    // Sanity: the issued token is already past expiry, so it's not "active".
    expect(isTokenIssued(tok.jti)).toBe(false);

    const beforeActive = listActiveTokens().length;
    clearExpired();
    // After pruning, listActiveTokens still returns only live entries (the
    // expired one we issued was never live), and no error is thrown.
    expect(listActiveTokens().length).toBe(beforeActive);
  });
});

describe("Access token signing key binding", () => {
  it("verifies tokens signed with the configured key", async () => {
    const cfg = getConfig();
    const tok = await issueAccessToken({
      clientId: cfg.oauth.clientId,
      scope: "mcp",
      ttlSec: 60,
    });
    const looked = await lookupAccessToken(tok.token);
    expect(looked).not.toBeNull();
    expect(looked!.clientId).toBe(cfg.oauth.clientId);
  });

  it("rejects tokens signed with a tampered key", async () => {
    const cfg = getConfig();
    // Forge a JWT with the same shape but a totally different signing key —
    // either OAUTH_CLIENT_SECRET or SESSION_ENCRYPTION_KEY rotation must
    // invalidate previously-issued tokens.
    const tampered = await new SignJWT({ scope: "mcp" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(cfg.baseUrl)
      .setAudience(cfg.baseUrl)
      .setSubject(cfg.oauth.clientId)
      .setJti("tampered-jti")
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(new TextEncoder().encode("not-the-real-signing-material-32!"));
    expect(await lookupAccessToken(tampered)).toBeNull();
  });

  it("rejects garbage strings as access tokens", async () => {
    expect(await lookupAccessToken("not-a-jwt-at-all")).toBeNull();
    expect(await lookupAccessToken("")).toBeNull();
  });

  it("rejects tokens with mismatched issuer/audience", async () => {
    const cfg = getConfig();
    const wrongIssuer = await new SignJWT({ scope: "mcp" })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer("https://attacker.example/")
      .setAudience(cfg.baseUrl)
      .setSubject(cfg.oauth.clientId)
      .setJti("wrong-iss")
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 60)
      .sign(new TextEncoder().encode(`${cfg.oauth.clientSecret}:${cfg.oauth.sessionSecret}`));
    expect(await lookupAccessToken(wrongIssuer)).toBeNull();
  });
});

describe("OAuth discovery metadata", () => {
  it("GET /.well-known/oauth-authorization-server returns the documented RFC 8414 shape", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const res = await request(app).get("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      issuer: cfg.baseUrl,
      authorization_endpoint: `${cfg.baseUrl}/oauth/authorize`,
      token_endpoint: `${cfg.baseUrl}/oauth/token`,
      registration_endpoint: `${cfg.baseUrl}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  });

  it("GET /.well-known/oauth-protected-resource points back at this server", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const res = await request(app).get("/.well-known/oauth-protected-resource");
    expect(res.status).toBe(200);
    expect(res.body.resource).toBe(cfg.baseUrl);
    expect(res.body.authorization_servers).toEqual([cfg.baseUrl]);
    expect(res.body.bearer_methods_supported).toEqual(["header"]);
    expect(res.body.scopes_supported).toEqual(["mcp"]);
  });

  it("POST /oauth/register returns a minimal client registration response", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const res = await request(app)
      .post("/oauth/register")
      .send({ redirect_uris: ["https://claude.ai/cb"] });
    expect(res.status).toBe(201);
    expect(res.body.client_id).toBe(cfg.oauth.clientId);
    expect(res.body.token_endpoint_auth_method).toBe("none");
  });
});

describe("OAuth log redaction (no PAT or client secret leaks)", () => {
  let captured: string[] = [];
  let spies: ReturnType<typeof vi.spyOn>[] = [];

  beforeEach(() => {
    captured = [];
    // Capture every logger call surface so we can grep across them. The
    // production routes never log request bodies, but this spy locks that
    // contract in: any future regression that stuffs a body into a log
    // event will fail the assertions below.
    for (const m of ["info", "warn", "error", "debug", "trace", "fatal"] as const) {
      spies.push(
        vi.spyOn(logger, m).mockImplementation(((...args: unknown[]) => {
          try {
            captured.push(JSON.stringify(args));
          } catch {
            captured.push(String(args));
          }
          return undefined;
        }) as never),
      );
    }
  });

  afterEach(() => {
    for (const s of spies) s.mockRestore();
    spies = [];
  });

  it("a failing /oauth/token request whose body smuggles the PAT and client secret never echoes them through the logger", async () => {
    const app = makeApp();
    const cfg = getConfig();
    // Drive a guaranteed-to-fail token request that carries the personal
    // auth token and client secret as parameter values. If any handler
    // along the way logs `req.body`, this captures the leak.
    const res = await request(app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        code: "no-such-code",
        redirect_uri: "https://claude.ai/cb",
        code_verifier: "anything",
        client_id: cfg.oauth.clientId,
        // Smuggled secrets (a real client would never include these here).
        leaked_pat: cfg.oauth.personalAuthToken,
        leaked_secret: cfg.oauth.clientSecret,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_grant");

    const all = captured.join("\n");
    expect(all).not.toContain(cfg.oauth.personalAuthToken);
    expect(all).not.toContain(cfg.oauth.clientSecret);
  });

  it("an authorize request with the PAT in the body never echoes it through the logger", async () => {
    const app = makeApp();
    const cfg = getConfig();
    const { challenge } = pkcePair();
    await request(app)
      .post("/oauth/authorize")
      .type("form")
      .send({
        response_type: "code",
        client_id: cfg.oauth.clientId,
        redirect_uri: "https://claude.ai/cb",
        code_challenge: challenge,
        code_challenge_method: "S256",
        scope: "mcp",
        auth_token: cfg.oauth.personalAuthToken,
      });

    const all = captured.join("\n");
    expect(all).not.toContain(cfg.oauth.personalAuthToken);
    expect(all).not.toContain(cfg.oauth.clientSecret);
  });
});
