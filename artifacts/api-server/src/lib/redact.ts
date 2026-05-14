/**
 * Redact secrets that may appear in arbitrary error strings or log output.
 * Specifically targets the GitHub PAT injected into the git origin URL
 * (https://x-access-token:<PAT>@github.com/...) and the raw PAT itself.
 */
import { getConfig } from "./config";

const REDACTED = "[REDACTED]";

export function redactSecrets(input: string): string {
  if (!input) return input;
  let out = input;

  // Always redact basic-auth in URLs regardless of which secret is in there.
  out = out.replace(
    /([a-zA-Z][a-zA-Z0-9+\-.]*:\/\/)[^\s/@]+:[^\s/@]+@/g,
    `$1${REDACTED}:${REDACTED}@`,
  );

  try {
    const cfg = getConfig();
    const pat = cfg.vault.githubPat;
    if (pat && pat.length >= 8) {
      out = out.split(pat).join(REDACTED);
    }
    const sec = cfg.oauth.clientSecret;
    if (sec && sec.length >= 8) {
      out = out.split(sec).join(REDACTED);
    }
    const tok = cfg.oauth.personalAuthToken;
    if (tok && tok.length >= 8) {
      out = out.split(tok).join(REDACTED);
    }
  } catch {
    /* config not loaded yet — only generic URL redaction applied */
  }

  return out;
}

export function redactError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw);
}
