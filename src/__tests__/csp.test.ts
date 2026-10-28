import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
const native = JSON.parse(
  readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
).app.security.csp as string;

const directive = (name: string) => {
  const entry = native.split(";").map((part) => part.trim().split(/\s+/))
    .find(([key]) => key === name);
  expect(entry, `missing ${name}`).toBeDefined();
  return entry!.slice(1);
};

describe("desktop CSP contract", () => {
  it("mirrors the native policy in the HTML preview without a second restrictive policy", () => {
    const metas = html.match(/<meta\b[^>]*http-equiv="Content-Security-Policy"[^>]*>/g) ?? [];
    expect(metas).toHaveLength(1);
    expect(metas[0]?.match(/\bcontent="([^"]*)"/)?.[1]).toBe(native);
  });

  it("supports selected HTTPS selfhost and loopback while denying broad plaintext", () => {
    expect(directive("connect-src")).toEqual([
      "'self'", "https:", "http://localhost:*", "http://127.0.0.1:*",
    ]);
    // CSP host-source grammar has no IPv6 literal form; "http://[::1]:*" was
    // silently ignored by the engine, so it must not appear in the policy.
    expect(native).not.toContain("[::1]");
  });

  it("preserves script, embedded-object and base URL restrictions", () => {
    expect(directive("script-src")).toEqual(["'self'"]);
    expect(directive("object-src")).toEqual(["'none'"]);
    expect(directive("base-uri")).toEqual(["'self'"]);
  });
});

describe("API origin policy matches the CSP loopback sources", () => {
  it("rejects plaintext IPv6 loopback that the CSP cannot allow, keeps the IPv4/localhost loopback", async () => {
    const { apiRequestUrl } = await import("../client");
    expect(() => apiRequestUrl("http://[::1]:8080/api/v1", "/health")).toThrow(/HTTPS or loopback/);
    expect(apiRequestUrl("http://127.0.0.1:8080/api/v1", "/health")).toBe("http://127.0.0.1:8080/api/v1/health");
    expect(apiRequestUrl("http://localhost:8080/api/v1", "/health")).toBe("http://localhost:8080/api/v1/health");
    expect(apiRequestUrl("https://[::1]:8443/api/v1", "/health")).toBe("https://[::1]:8443/api/v1/health");
  });
});
