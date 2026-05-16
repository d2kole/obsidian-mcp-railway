/**
 * OAuth redirect_uri allowlist matching (RFC 6749 §3.1.2).
 *
 * - Exact hostname match (prevents `localhost.evil.com` when prefix is `localhost`).
 * - Path must start with the prefix URL's pathname (default `/`).
 * - Fragments on the target redirect_uri are rejected.
 * - For **loopback** hosts only (`127.0.0.1`, `localhost`, `::1`): if the allowlist
 *   entry omits an explicit port (e.g. `http://127.0.0.1`), any target port on that
 *   host is allowed so local dev servers on arbitrary ports work.
 * - For all other hosts, or when the prefix includes an explicit port, ports must
 *   match after normalizing default HTTP/HTTPS ports.
 */

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);

/** Node reports IPv6 literals as `[::1]`; normalize for loopback set lookup. */
function canonicalHostname(hostname: string): string {
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return hostname.slice(1, -1);
  }
  return hostname;
}

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(canonicalHostname(hostname));
}

function effectivePort(u: URL): string {
  if (u.port) return u.port;
  if (u.protocol === "https:") return "443";
  if (u.protocol === "http:") return "80";
  return "";
}

/** True when `uri` is allowed by any entry in `prefixes` (each a full URL prefix). */
export function isAllowedRedirectUri(uri: string, prefixes: string[]): boolean {
  let target: URL;
  try {
    target = new URL(uri);
  } catch {
    return false;
  }
  if (target.hash) return false;

  return prefixes.some((prefixStr) => {
    let allowed: URL;
    try {
      allowed = new URL(prefixStr);
    } catch {
      return false;
    }
    if (target.protocol !== allowed.protocol) return false;
    if (target.hostname !== allowed.hostname) return false;

    const loopback = isLoopbackHost(allowed.hostname);
    const prefixOmittedPort = allowed.port === "";

    if (loopback && prefixOmittedPort) {
      // Dev-friendly: http://127.0.0.1 with no port matches :5179, :8080, etc.
    } else if (effectivePort(allowed) !== effectivePort(target)) {
      return false;
    }

    const allowedPath = allowed.pathname || "/";
    if (!target.pathname.startsWith(allowedPath)) return false;
    return true;
  });
}
