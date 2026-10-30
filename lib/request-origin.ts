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
 *   2. If `Origin` is present it must match the configured origin exactly.
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
    return (
      parsed.protocol === expected.protocol &&
      parsed.hostname === expected.hostname &&
      parsed.port === expected.port
    );
  }

  if (fetchSite) return fetchSite === "same-origin";

  // Neither header. No browser sends a cross-site POST without `Origin`, so this
  // is either a same-origin request from a browser/proxy that drops the fetch
  // metadata, or a non-browser client. Accept only if the request is addressed
  // to this application's own host.
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    return new URL(process.env.NEXTAUTH_URL || "http://localhost:3000").host === host;
  } catch {
    return false;
  }
}
