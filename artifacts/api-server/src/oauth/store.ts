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

interface IssuedTokenMeta {
  jti: string;
  clientId: string;
  scope: string;
  issuedAt: number;
  expiresAt: number;
}

interface PersistedState {
  version: 1;
  codes: AuthCode[];
  revoked: Array<{ jti: string; expiresAt: number }>;
  issued?: IssuedTokenMeta[];
}

const codes = new Map<string, AuthCode>();
const revoked = new Map<string, number>();
const issued = new Map<string, IssuedTokenMeta>();

let loaded = false;

// Debounce window for coalescing rapid mutations into a single fsync.
const PERSIST_DEBOUNCE_MS = 250;
// Hard cap on the number of revoked-jti entries kept in memory / on disk.
// Older entries (smallest expiresAt first) are evicted past this point so a
// runaway revocation loop cannot fill the volume.
const REVOKED_CAP = 10_000;

let persistTimer: NodeJS.Timeout | null = null;
let persistPending = false;
let exitHooksInstalled = false;

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
  installExitHooks();
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
      for (const t of parsed.issued ?? []) {
        if (t.expiresAt > now) issued.set(t.jti, t);
        else pruned = true;
      }
      enforceRevokedCap();
      logger.info(
        { file, codes: codes.size, revoked: revoked.size, issued: issued.size },
        "oauth store loaded from disk",
      );
      if (pruned) schedulePersist();
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

function enforceRevokedCap(): void {
  if (revoked.size <= REVOKED_CAP) return;
  // Evict entries with the soonest expiry first — they're closest to being
  // garbage-collected anyway, so dropping them costs the least security.
  const sorted = Array.from(revoked.entries()).sort((a, b) => a[1] - b[1]);
  const overflow = revoked.size - REVOKED_CAP;
  for (let i = 0; i < overflow; i++) {
    const entry = sorted[i];
    if (entry) revoked.delete(entry[0]);
  }
  logger.warn(
    { kept: revoked.size, evicted: overflow, cap: REVOKED_CAP },
    "oauth revoked-jti list exceeded cap; oldest entries evicted",
  );
}

function persistNow(): void {
  const file = storePath();
  const state: PersistedState = {
    version: 1,
    codes: Array.from(codes.values()),
    revoked: Array.from(revoked.entries()).map(([jti, expiresAt]) => ({ jti, expiresAt })),
    issued: Array.from(issued.values()),
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

function schedulePersist(): void {
  persistPending = true;
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (persistPending) {
      persistPending = false;
      persistNow();
    }
  }, PERSIST_DEBOUNCE_MS);
  // Don't keep the event loop alive solely for a pending flush; exit hooks
  // below ensure data is still flushed on shutdown.
  persistTimer.unref?.();
}

export function flushPersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (persistPending) {
    persistPending = false;
    persistNow();
  }
}

function installExitHooks(): void {
  if (exitHooksInstalled) return;
  exitHooksInstalled = true;
  // beforeExit fires when the loop is about to drain; sync flush is safe here.
  // We deliberately do NOT register SIGTERM/SIGINT handlers — installing a
  // signal listener overrides Node's default termination behavior and can
  // prevent the process from exiting. The host (server.ts) is responsible
  // for graceful shutdown; the worst case here is losing the last ~250ms
  // of debounced mutations on an abrupt kill, which is acceptable.
  process.on("beforeExit", () => {
    flushPersist();
  });
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
  schedulePersist();
  return code;
}

export function consumeAuthCode(code: string): AuthCode | null {
  ensureLoaded();
  const entry = codes.get(code);
  if (!entry) return null;
  codes.delete(code);
  schedulePersist();
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
  ensureLoaded();
  const expiresAt = expSec * 1000;
  issued.set(jti, {
    jti,
    clientId: input.clientId,
    scope: input.scope,
    issuedAt: Date.now(),
    expiresAt,
  });
  schedulePersist();
  return {
    token,
    clientId: input.clientId,
    scope: input.scope,
    jti,
    expiresAt,
  };
}

export interface ActiveTokenInfo {
  jti: string;
  clientId: string;
  scope: string;
  issuedAt: number;
  expiresAt: number;
}

export function listActiveTokens(): ActiveTokenInfo[] {
  ensureLoaded();
  const now = Date.now();
  const out: ActiveTokenInfo[] = [];
  for (const t of issued.values()) {
    if (t.expiresAt <= now) continue;
    if (revoked.has(t.jti)) continue;
    out.push({ ...t });
  }
  out.sort((a, b) => b.issuedAt - a.issuedAt);
  return out;
}

export function isTokenIssued(jti: string): boolean {
  ensureLoaded();
  const t = issued.get(jti);
  if (!t) return false;
  if (t.expiresAt <= Date.now()) return false;
  // A token that's already revoked is no longer "active" from the admin
  // endpoint's perspective — treat it as gone so repeated revoke calls
  // surface the documented 404 instead of pretending to do work.
  if (revoked.has(jti)) return false;
  return true;
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
  enforceRevokedCap();
  schedulePersist();
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
  for (const [k, t] of issued) {
    if (t.expiresAt < now) {
      issued.delete(k);
      changed = true;
    }
  }
  if (changed) schedulePersist();
}

// Test-only helper so unit tests can isolate state between cases.
export function _resetStoreForTests(): void {
  // Drop any pending debounced write from the previous test rather than let
  // it fire after we've cleared in-memory state and corrupt the next case.
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistPending = false;
  codes.clear();
  revoked.clear();
  issued.clear();
  loaded = false;
}

// Test-only knobs.
export const _internals = {
  REVOKED_CAP,
  PERSIST_DEBOUNCE_MS,
};
