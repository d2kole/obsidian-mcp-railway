import crypto from "node:crypto";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { getConfig } from "../lib/config";

interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scope: string;
  expiresAt: number;
}

const codes = new Map<string, AuthCode>();
const revoked = new Set<string>();

function signingKey(): Uint8Array {
  const cfg = getConfig();
  // Bind both secrets so leaking one alone is insufficient.
  const material = `${cfg.oauth.clientSecret}:${cfg.oauth.sessionSecret}`;
  return new TextEncoder().encode(material);
}

export function createAuthCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scope: string;
  ttlMs?: number;
}): string {
  const code = crypto.randomBytes(32).toString("base64url");
  codes.set(code, {
    code,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    codeChallenge: input.codeChallenge,
    codeChallengeMethod: input.codeChallengeMethod,
    scope: input.scope,
    expiresAt: Date.now() + (input.ttlMs ?? 5 * 60 * 1000),
  });
  return code;
}

export function consumeAuthCode(code: string): AuthCode | null {
  const entry = codes.get(code);
  if (!entry) return null;
  codes.delete(code);
  if (entry.expiresAt < Date.now()) return null;
  return entry;
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  const hash = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return hash === challenge;
}

export interface AccessToken {
  token: string;
  clientId: string;
  scope: string;
  jti: string;
  expiresAt: number;
}

export async function issueAccessToken(input: {
  clientId: string;
  scope: string;
  ttlSec: number;
}): Promise<AccessToken> {
  const cfg = getConfig();
  const jti = crypto.randomBytes(16).toString("base64url");
  const expSec = Math.floor(Date.now() / 1000) + input.ttlSec;
  const token = await new SignJWT({ scope: input.scope })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(cfg.baseUrl)
    .setAudience(cfg.baseUrl)
    .setSubject(input.clientId)
    .setJti(jti)
    .setIssuedAt()
    .setExpirationTime(expSec)
    .sign(signingKey());
  return {
    token,
    clientId: input.clientId,
    scope: input.scope,
    jti,
    expiresAt: expSec * 1000,
  };
}

export async function lookupAccessToken(
  token: string,
): Promise<AccessToken | null> {
  const cfg = getConfig();
  try {
    const { payload } = await jwtVerify(token, signingKey(), {
      issuer: cfg.baseUrl,
      audience: cfg.baseUrl,
    });
    const p = payload as JWTPayload & { scope?: string; sub?: string; jti?: string };
    if (!p.sub || !p.jti || !p.exp) return null;
    if (revoked.has(p.jti)) return null;
    return {
      token,
      clientId: p.sub,
      scope: typeof p.scope === "string" ? p.scope : "",
      jti: p.jti,
      expiresAt: p.exp * 1000,
    };
  } catch {
    return null;
  }
}

export function revokeJti(jti: string): void {
  revoked.add(jti);
}

export function clearExpired(): void {
  const now = Date.now();
  for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k);
}
