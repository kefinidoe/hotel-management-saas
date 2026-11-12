import { isIP } from "node:net";

/** A single shared bucket when the deployment's trusted header is unavailable. */
export const UNKNOWN_CLIENT_IP = "unknown";

/**
 * Read exactly one IP address from the deployment-configured trusted header.
 * TRUSTED_IP_HEADER must name a header that the hosting platform overwrites
 * with the client IP; this cannot be established by application code. Never
 * configure a header that clients can supply or a proxy appends to untrusted
 * values. Verify the header's behavior after the first real deployment.
 *
 * Multiple addresses, ports, zone identifiers, and malformed values are
 * rejected, rather than guessing which hop in a forwarding chain is trusted.
 */
export function getClientIp(request: Request): string {
  const header = process.env.TRUSTED_IP_HEADER?.trim();
  if (!header || !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(header)) {
    return UNKNOWN_CLIENT_IP;
  }

  const value = request.headers.get(header)?.trim();
  if (!value || value.includes("%") || isIP(value) === 0) return UNKNOWN_CLIENT_IP;
  if (isIP(value) === 4) return value;

  // Canonicalize IPv6 so alternate spellings cannot evade an IP bucket.
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1);
  // IPv4-mapped IPv6 must share the same bucket as its IPv4 representation.
  const mapped = canonical.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    const high = parseInt(mapped[1], 16);
    const low = parseInt(mapped[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return canonical;
}
