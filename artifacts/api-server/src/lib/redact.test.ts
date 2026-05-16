import "../test/env";
import { describe, it, expect } from "vitest";
import { redactSecrets, redactError } from "./redact";

describe("redactSecrets", () => {
  it("redacts the configured GitHub PAT from arbitrary strings", () => {
    const pat = process.env["GITHUB_PAT"]!;
    const input = `git error: failed pushing with token ${pat} to remote`;
    const out = redactSecrets(input);
    expect(out).not.toContain(pat);
    expect(out).toContain("[REDACTED]");
  });

  it("redacts basic-auth credentials embedded in URLs", () => {
    const input =
      "fatal: unable to access 'https://x-access-token:ghp_AAAAAAAAAAAA@github.com/foo/bar.git/'"; // secret-scan: allow (test fixture, fake credentials)
    const out = redactSecrets(input);
    expect(out).not.toContain("ghp_AAAAAAAAAAAA");
    expect(out).not.toContain("x-access-token");
    expect(out).toContain("[REDACTED]:[REDACTED]@github.com");
  });

  it("redacts the OAuth client secret and personal auth token", () => {
    const sec = process.env["OAUTH_CLIENT_SECRET"]!;
    const tok = process.env["PERSONAL_AUTH_TOKEN"]!;
    const out = redactSecrets(`secrets: ${sec} and ${tok}`);
    expect(out).not.toContain(sec);
    expect(out).not.toContain(tok);
  });

  it("is a no-op for strings that contain no secrets", () => {
    const out = redactSecrets("nothing sensitive here");
    expect(out).toBe("nothing sensitive here");
  });

  it("redactError extracts and redacts the message of an Error", () => {
    const pat = process.env["GITHUB_PAT"]!;
    const err = new Error(`leak: ${pat}`);
    const out = redactError(err);
    expect(out).not.toContain(pat);
    expect(out).toContain("[REDACTED]");
  });
});
