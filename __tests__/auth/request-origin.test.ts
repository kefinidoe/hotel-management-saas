import { describe, expect, it, beforeEach, afterAll, vi } from "vitest";
import { isSameOriginRequest } from "@/lib/request-origin";

/**
 * Hotel switching used to reject the application's own fetch() calls: Chromium
 * omits `Origin` on same-origin POSTs, and the route demanded it. The HTTP
 * harness never noticed because it always sends the header. These cases pin the
 * behaviour that matters in both directions — the app's own requests pass, and
 * cross-site requests do not.
 */

const BASE = "http://127.0.0.1:3100";

function request(headers: Record<string, string>): Request {
  return new Request(`${BASE}/api/auth/switch-hotel`, { method: "POST", headers });
}

describe("isSameOriginRequest", () => {
  beforeEach(() => {
    process.env.NEXTAUTH_URL = BASE;
  });

  afterAll(() => {
    delete process.env.NEXTAUTH_URL;
    delete process.env.SAAS_ALLOW_REQUEST_HOST_ORIGIN;
  });

  it("accepts a same-origin fetch that carries Origin", () => {
    expect(isSameOriginRequest(request({ origin: BASE }))).toBe(true);
  });

  it("accepts a same-origin fetch that carries Sec-Fetch-Site instead of Origin", () => {
    // This is exactly what Chromium sends for `fetch("/api/...")` from the app.
    expect(isSameOriginRequest(request({ "sec-fetch-site": "same-origin" }))).toBe(true);
  });

  it("rejects a cross-site Origin even when Sec-Fetch-Site says same-origin", () => {
    expect(
      isSameOriginRequest(request({ origin: "https://evil.example", "sec-fetch-site": "same-origin" }))
    ).toBe(false);
  });

  it("rejects Sec-Fetch-Site: cross-site whatever Origin claims", () => {
    expect(isSameOriginRequest(request({ origin: BASE, "sec-fetch-site": "cross-site" }))).toBe(false);
  });

  it("rejects a sibling subdomain (same-site is not same-origin)", () => {
    expect(
      isSameOriginRequest(request({ origin: "http://app.example.test", "sec-fetch-site": "same-site" }))
    ).toBe(false);
  });

  it("rejects a different port on the same host", () => {
    expect(isSameOriginRequest(request({ origin: "http://127.0.0.1:3101" }))).toBe(false);
  });

  it("accepts a request with neither header when it is addressed to this host", () => {
    // Some proxies and non-browser clients drop the fetch metadata entirely.
    // The Host header still has to be ours, and no browser sends a cross-site
    // POST without Origin, so this cannot be a forged cross-site request.
    expect(isSameOriginRequest(request({ host: "127.0.0.1:3100" }))).toBe(true);
  });

  it("rejects a request with neither header addressed to another host", () => {
    expect(isSameOriginRequest(request({ host: "attacker.example" }))).toBe(false);
  });

  it("fails closed when neither signal is present", () => {
    expect(isSameOriginRequest(request({}))).toBe(false);
  });

  it("rejects a host that only the request itself names, by default", () => {
    // A hosted preview whose URL differs from NEXTAUTH_URL must not silently
    // widen the check: same-origin only follows the configured origin unless the
    // deployment opts in.
    delete process.env.SAAS_ALLOW_REQUEST_HOST_ORIGIN;
    process.env.NEXTAUTH_URL = "https://canonical.example";
    expect(isSameOriginRequest(request({ origin: BASE, host: "127.0.0.1:3100" }))).toBe(false);
    process.env.NEXTAUTH_URL = BASE;
  });

  it("accepts the request host as the origin when the preview opt-in is set", () => {
    process.env.SAAS_ALLOW_REQUEST_HOST_ORIGIN = "true";
    try {
      process.env.NEXTAUTH_URL = "https://3100-sandbox.example";
      expect(isSameOriginRequest(request({ origin: BASE, host: "127.0.0.1:3100" }))).toBe(true);
      // The opt-in does not accept arbitrary origins.
      expect(isSameOriginRequest(request({ origin: "https://evil.example" }))).toBe(false);
      expect(isSameOriginRequest(request({ origin: BASE, "sec-fetch-site": "cross-site" }))).toBe(false);
    } finally {
      delete process.env.SAAS_ALLOW_REQUEST_HOST_ORIGIN;
      process.env.NEXTAUTH_URL = BASE;
    }
  });

  it("permits a matching loopback fallback port only in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    try {
      const local = new Request("http://127.0.0.1:3101/api/auth/switch-hotel", {
        method: "POST", headers: { origin: "http://127.0.0.1:3101", host: "127.0.0.1:3101" },
      });
      expect(isSameOriginRequest(local)).toBe(true);
      expect(isSameOriginRequest(new Request("http://127.0.0.1:3101/api/auth/switch-hotel", { method: "POST", headers: { host: "127.0.0.1:3101" } }))).toBe(true);
      expect(isSameOriginRequest(request({ origin: "http://127.0.0.1:3101", host: "127.0.0.1:3100" }))).toBe(false);
      vi.stubEnv("NODE_ENV", "production");
      expect(isSameOriginRequest(local)).toBe(false);
    } finally { vi.unstubAllEnvs(); }
  });

  it("fails closed on a malformed Origin", () => {
    expect(isSameOriginRequest(request({ origin: "not a url" }))).toBe(false);
  });
});
