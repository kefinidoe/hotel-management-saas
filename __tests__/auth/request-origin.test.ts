import { describe, expect, it, beforeEach, afterAll } from "vitest";
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

  it("fails closed when neither signal is present", () => {
    expect(isSameOriginRequest(request({}))).toBe(false);
  });

  it("fails closed on a malformed Origin", () => {
    expect(isSameOriginRequest(request({ origin: "not a url" }))).toBe(false);
  });
});
