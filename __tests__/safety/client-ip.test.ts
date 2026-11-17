import { afterEach, describe, expect, it } from "vitest";
import { getClientIp, UNKNOWN_CLIENT_IP } from "@/lib/client-ip";

const originalHeader = process.env.TRUSTED_IP_HEADER;

afterEach(() => {
  if (originalHeader === undefined) delete process.env.TRUSTED_IP_HEADER;
  else process.env.TRUSTED_IP_HEADER = originalHeader;
});

function request(headers: Record<string, string>): Request {
  return new Request("https://hotel.example/api/auth/register", { headers });
}

describe("trusted client IP extraction", () => {
  it("uses only the configured trusted header, ignoring spoofed forwarding headers", () => {
    process.env.TRUSTED_IP_HEADER = "x-platform-client-ip";
    expect(getClientIp(request({
      "x-platform-client-ip": "192.0.2.1",
      "x-forwarded-for": "203.0.113.7, 192.0.2.99",
      "x-real-ip": "203.0.113.8",
    }))).toBe("192.0.2.1");
  });

  it("uses the shared unknown bucket when configuration or the trusted header is missing", () => {
    delete process.env.TRUSTED_IP_HEADER;
    expect(getClientIp(request({ "x-forwarded-for": "203.0.113.7" }))).toBe(UNKNOWN_CLIENT_IP);
    process.env.TRUSTED_IP_HEADER = "x-platform-client-ip";
    expect(getClientIp(request({ "x-forwarded-for": "203.0.113.7" }))).toBe(UNKNOWN_CLIENT_IP);
  });

  it.each(["not an ip", "203.0.113.7, 192.0.2.1", "192.0.2.1:443", "[2001:db8::1]", "fe80::1%eth0", "999.0.0.1"])(
    "rejects malformed or ambiguous trusted values: %s",
    (value) => {
      process.env.TRUSTED_IP_HEADER = "x-platform-client-ip";
      expect(getClientIp(request({ "x-platform-client-ip": value, "x-forwarded-for": "203.0.113.7" }))).toBe(UNKNOWN_CLIENT_IP);
    },
  );

  it("rejects invalid configured header names without falling back", () => {
    process.env.TRUSTED_IP_HEADER = "x-invalid header";
    expect(getClientIp(request({ "x-forwarded-for": "203.0.113.7" }))).toBe(UNKNOWN_CLIENT_IP);
  });

  it("canonicalizes IPv6 and IPv4-mapped IPv6 to prevent duplicate buckets", () => {
    process.env.TRUSTED_IP_HEADER = "x-platform-client-ip";
    expect(getClientIp(request({ "x-platform-client-ip": "2001:0DB8:0:0:0:0:0:1" }))).toBe("2001:db8::1");
    expect(getClientIp(request({ "x-platform-client-ip": "::ffff:192.0.2.1" }))).toBe("192.0.2.1");
  });

  it("rejects an attacker-prepended X-Forwarded-For chain even if that header is configured", () => {
    process.env.TRUSTED_IP_HEADER = "x-forwarded-for";
    expect(getClientIp(request({ "x-forwarded-for": "203.0.113.7, 192.0.2.1" }))).toBe(UNKNOWN_CLIENT_IP);
  });
});
