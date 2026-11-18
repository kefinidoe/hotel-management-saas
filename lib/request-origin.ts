/**
 * Same-origin enforcement for cookie-authenticated POST routes.
 *
 * The browser sends cookies on cross-site form posts, so a state-changing route
 * has to prove the request came from the application itself. The obvious check —
 * `Origin` must equal `NEXTAUTH_URL` — has a hole in the other direction:
 * **Chromium omits `Origin` for same-origin POSTs**. A route that demands the
 * header therefore rejects the application's own `fetch()` calls, which is how
 * hotel switching broke for real users while the HTTP test harness (which always
 * sends `Origin`) kept passing.
 *
 * The check below uses both signals browsers provide:
 *
 *   Origin            present on cross-site requests, and on some same-origin ones
 *   Sec-Fetch-Site    `same-origin` | `same-site` | `cross-site` | `none`
 *
 * Rules:
 *   1. `Sec-Fetch-Site: cross-site` is decisive — reject, whatever Origin claims.
 *   2. If `Origin` is present it must match the configured origin exactly. A
 *      hosted preview served on a host that `NEXTAUTH_URL` does not name can
 *      opt in (`SAAS_ALLOW_REQUEST_HOST_ORIGIN=true`) to accept the request's
 *      own `Host` as the expected origin instead — see the note below.
 *   3. If `Origin` is absent, accept only `Sec-Fetch-Site: same-origin`, which is
 *      what a same-origin `fetch()` from the app carries.
 *   4. If both headers are absent, the request is not a cross-site browser
 *      request (those always carry one of them), so accept it only when `Host`
 *      is the host this application is configured to serve.
 *
 * A cross-site attacker cannot forge either header from a browser, and a
 * non-browser client that can forge headers is not the threat model this
 * defends against (it would also carry the victim's cookies only if it already
 * had them).
 */
/**
 * Hosted previews are addressed by a host that changes with the deployment
 * (a sandbox id, a tunnel URL) while `NEXTAUTH_URL` is fixed at start-up. If the
 * two disagree, every same-origin `fetch()` from the app is answered with 403 —
 * the failure looks like "switching hotels is broken", not like a config error.
 *
 * The escape hatch is opt-in and compares `Origin` with the request's own `Host`,
 * which is still a same-origin test: a cross-site page cannot set either value.
 * It stays off by default because it widens the check for deployments that share
 * a cookie domain between subdomains — with the flag off, only the single
 * configured origin is accepted.
 */
function requestHostIsAcceptableOrigin(originHost: string, request: Request): boolean {
  if (process.env.SAAS_ALLOW_REQUEST_HOST_ORIGIN !== "true") return false;
  const host = request.headers.get("host");
  if (!host) return false;
  return originHost === host;
}

// Development may run on a fallback port when 3000 is occupied. Only accept
// the actual loopback Host, and only if the configured origin is loopback too.
function localDevelopmentOrigin(parsed: URL, expected: URL, request: Request): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
  return parsed.protocol === "http:" && expected.protocol === "http:" &&
    loopback.has(parsed.hostname) && parsed.hostname === expected.hostname &&
    parsed.host === request.headers.get("host") &&
    parsed.host === new URL(request.url).host;
}

export function isSameOriginRequest(request: Request): boolean {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");

  if (fetchSite === "cross-site") return false;

  if (origin) {
    let parsed: URL;
    let expected: URL;
    try {
      parsed = new URL(origin);
      expected = new URL(process.env.NEXTAUTH_URL || "http://localhost:3000");
    } catch {
      return false;
    }
    const matchesConfigured =
      parsed.protocol === expected.protocol &&
      parsed.hostname === expected.hostname &&
      parsed.port === expected.port;
    return matchesConfigured || localDevelopmentOrigin(parsed, expected, request) || requestHostIsAcceptableOrigin(parsed.host, request);
  }

  if (fetchSite) return fetchSite === "same-origin";

  // Neither header. No browser sends a cross-site POST without `Origin`, so this
  // is either a same-origin request from a browser/proxy that drops the fetch
  // metadata, or a non-browser client. Accept only if the request is addressed
  // to this application's own host.
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    const expected = new URL(process.env.NEXTAUTH_URL || "http://localhost:3000");
    return expected.host === host || localDevelopmentOrigin(new URL(request.url), expected, request);
  } catch {
    return false;
  }
}
