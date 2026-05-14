import crypto from "node:crypto";

interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256" | "plain";
  scope: string;
  expiresAt: number;
}

interface AccessToken {
  token: string;
  clientId: string;
  scope: string;
  expiresAt: number;
}

const codes = new Map<string, AuthCode>();
const tokens = new Map<string, AccessToken>();

export function createAuthCode(input: {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256" | "plain";
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

export function verifyPkce(
  verifier: string,
  challenge: string,
  method: "S256" | "plain",
): boolean {
  if (method === "plain") return verifier === challenge;
  const hash = crypto
    .createHash("sha256")
    .update(verifier)
    .digest("base64url");
  return hash === challenge;
}

export function issueAccessToken(input: {
  clientId: string;
  scope: string;
  ttlSec: number;
}): AccessToken {
  const token = crypto.randomBytes(32).toString("base64url");
  const entry: AccessToken = {
    token,
    clientId: input.clientId,
    scope: input.scope,
    expiresAt: Date.now() + input.ttlSec * 1000,
  };
  tokens.set(token, entry);
  return entry;
}

export function lookupAccessToken(token: string): AccessToken | null {
  const entry = tokens.get(token);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    tokens.delete(token);
    return null;
  }
  return entry;
}

export function clearExpired(): void {
  const now = Date.now();
  for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k);
  for (const [k, v] of tokens) if (v.expiresAt < now) tokens.delete(k);
}
