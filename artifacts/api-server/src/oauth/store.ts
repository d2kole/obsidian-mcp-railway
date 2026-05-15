import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";
import { getConfig } from "../lib/config";
import { logger } from "../lib/logger";

interface AuthCode {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  scope: string;
  expiresAt: number;
}

interface PersistedState {
  version: 1;
  codes: AuthCode[];
  revoked: Array<{ jti: string; expiresAt: number }>;
}

const codes = new Map<string, AuthCode>();
const revoked = new Map<string, number>();

let loaded = false;

function storePath(): string {
  // Honor OAUTH_STORE_PATH at call time so tests (which import this module
  // after config is already cached) can redirect the file. In production,
  // config.oauth.storePath has already absorbed this env var.
  const override = process.env["OAUTH_STORE_PATH"];
  if (override && override.trim() !== "") return override;
  return getConfig().oauth.storePath;
}

function ensureLoaded(): void {
  if (loaded) return;
  loaded = true;
  const file = storePath();
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed || parsed.version !== 1) {
      logger.warn(
        { file, version: parsed?.version },
        "oauth store file has unsupported version; starting empty",
      );
    } else {
      const now = Date.now();
      let pruned = false;
      for (const c of parsed.codes ?? []) {
        if (c.expiresAt > now) codes.set(c.code, c);
        else pruned = true;
      }
      for (const r of parsed.revoked ?? []) {
        if (r.expiresAt > now) revoked.set(r.jti, r.expiresAt);
        else pruned = true;
      }
      logger.info(
        { file, codes: codes.size, revoked: revoked.size },
        "oauth store loaded from disk",
      );
      if (pruned) persist();
    }
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e && e.code === "ENOENT") {
      logger.info({ file }, "oauth store file not found, starting empty");
    } else {
      logger.warn({ file, err: e?.message }, "failed to load oauth store; starting empty");
    }
  }
}

function persist(): void {
  const file = storePath();
  const state: PersistedState = {
    version: 1,
    codes: Array.from(codes.values()),
    revoked: Array.from(revoked.entries()).map(([jti, expiresAt]) => ({ jti, expiresAt })),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    logger.warn({ file, err: e?.message }, "failed to persist oauth store");
  }
}

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
  ensureLoaded();
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
  persist();
  return code;
}

export function consumeAuthCode(code: string): AuthCode | null {
  ensureLoaded();
  const entry = codes.get(code);
  if (!entry) return null;
  codes.delete(code);
  persist();
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
  ensureLoaded();
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

export function revokeJti(jti: string, expiresAt?: number): void {
  ensureLoaded();
  // Keep revocation entries until the token would naturally expire, so they
  // don't grow unboundedly. Default to access-token TTL when unspecified.
  const cfg = getConfig();
  const ttlMs = cfg.oauth.accessTokenTtlSec * 1000;
  revoked.set(jti, expiresAt ?? Date.now() + ttlMs);
  persist();
}

export function clearExpired(): void {
  ensureLoaded();
  const now = Date.now();
  let changed = false;
  for (const [k, v] of codes) {
    if (v.expiresAt < now) {
      codes.delete(k);
      changed = true;
    }
  }
  for (const [k, exp] of revoked) {
    if (exp < now) {
      revoked.delete(k);
      changed = true;
    }
  }
  if (changed) persist();
}

// Test-only helper so unit tests can isolate state between cases.
export function _resetStoreForTests(): void {
  codes.clear();
  revoked.clear();
  loaded = false;
}
