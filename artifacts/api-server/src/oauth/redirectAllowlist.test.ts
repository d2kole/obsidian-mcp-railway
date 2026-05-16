import { describe, it, expect } from "vitest";
import { isAllowedRedirectUri } from "./redirectAllowlist";

describe("isAllowedRedirectUri", () => {
  it("allows exact host and explicit port match", () => {
    const prefixes = ["http://127.0.0.1:8080/cb"];
    expect(isAllowedRedirectUri("http://127.0.0.1:8080/cb/done", prefixes)).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:9090/cb", prefixes)).toBe(false);
  });

  it("treats loopback prefix without explicit port as any port on that host", () => {
    const prefixes = ["http://127.0.0.1"];
    expect(isAllowedRedirectUri("http://127.0.0.1:5179/cb", prefixes)).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:80/cb", prefixes)).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1/cb", prefixes)).toBe(true);
  });

  it("still requires exact port for loopback when prefix port is explicit", () => {
    const prefixes = ["http://127.0.0.1:8080"];
    expect(isAllowedRedirectUri("http://127.0.0.1:8080/cb", prefixes)).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:5179/cb", prefixes)).toBe(false);
  });

  it("does not treat non-loopback no-port prefix as any-port", () => {
    const prefixes = ["https://claude.ai/"];
    expect(isAllowedRedirectUri("https://claude.ai/cb", prefixes)).toBe(true);
    expect(isAllowedRedirectUri("https://claude.ai:443/cb", prefixes)).toBe(true);
    expect(isAllowedRedirectUri("https://claude.ai:444/cb", prefixes)).toBe(false);
  });

  it("rejects redirect_uri with a fragment", () => {
    const prefixes = ["https://claude.ai/"];
    expect(isAllowedRedirectUri("https://claude.ai/cb#frag", prefixes)).toBe(false);
  });

  it("requires path to be under the prefix pathname", () => {
    const prefixes = ["http://127.0.0.1/app"];
    expect(isAllowedRedirectUri("http://127.0.0.1:9999/app/callback", prefixes)).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:9999/other/callback", prefixes)).toBe(false);
  });

  it("rejects localhost.evil.com when prefix is localhost (exact hostname)", () => {
    const prefixes = ["http://localhost"];
    expect(isAllowedRedirectUri("http://localhost:5179/cb", prefixes)).toBe(true);
    expect(isAllowedRedirectUri("http://localhost.evil.com/cb", prefixes)).toBe(false);
  });

  it("matches ::1 loopback with omitted port on prefix", () => {
    const prefixes = ["http://[::1]"];
    expect(isAllowedRedirectUri("http://[::1]:3000/cb", prefixes)).toBe(true);
  });

  it("skips malformed prefix strings without throwing", () => {
    const prefixes = ["::not-a-url::", "http://127.0.0.1"];
    expect(isAllowedRedirectUri("http://127.0.0.1:1/x", prefixes)).toBe(true);
  });
});
