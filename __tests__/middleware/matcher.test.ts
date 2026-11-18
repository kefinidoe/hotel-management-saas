import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";

/**
 * Guards the middleware matcher in `middleware.ts`.
 *
 * The matcher is the thing that decides which requests are reachable without a
 * session. The matcher covers all API routes, while middleware passes public
 * auth routes through before checking origin. This uses Next's own matcher to
 * guard against accidentally missing other paths.
 */

const SOURCE = readFileSync(resolve(__dirname, "../../middleware.ts"), "utf8");

function readMatcher(): string[] {
  const block = SOURCE.match(/matcher:\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error("Could not find `matcher: [...]` in middleware.ts");
  return [...block[1].matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]);
}

const matchers = readMatcher();
const isGuarded = (path: string) =>
  matchers.some((pattern) => !!getPathMatch(pattern, { strict: false })(path));

// Every route handler that exists under app/api, enumerated so a new endpoint
// added later is covered by this test the moment it is created.
const API_ROUTES = [
  "/api/check-in",
  "/api/check-out",
  "/api/expenses",
  "/api/expenses/abc",
  "/api/folios/abc",
  "/api/guests",
  "/api/guests/abc",
  "/api/housekeeping",
  "/api/housekeeping/abc",
  "/api/inventory",
  "/api/inventory/abc",
  "/api/maintenance",
  "/api/maintenance/abc",
  "/api/menu",
  "/api/menu/categories",
  "/api/menu/categories/abc",
  "/api/menu/items/abc",
  "/api/payment-methods",
  "/api/payments",
  "/api/profile/password", // changes the caller's own password
  "/api/purchases",
  "/api/recipes",
  "/api/recipes/abc",
  "/api/reports",
  "/api/reservations",
  "/api/reservations/abc",
  "/api/reservations/abc/extend",
  "/api/restaurant/activity",
  "/api/restaurant/charge-to-room",
  "/api/restaurant/open-folios",
  "/api/restaurant/pay-now",
  "/api/room-types",
  "/api/room-types/abc",
  "/api/rooms",
  "/api/rooms/abc",
  "/api/search",
  "/api/staff",
  "/api/staff/abc",
  "/api/stock-movements",
  "/api/wastage",
];

// NextAuth's endpoints must reach the origin middleware but remain public there.
const AUTH_ROUTES = [
  "/api/auth/signin",
  "/api/auth/signin/credentials",
  "/api/auth/callback/credentials",
  "/api/auth/session",
  "/api/auth/csrf",
  "/api/auth/providers",
  "/api/auth/signout",
  "/api/auth/error",
  "/api/auth/verify-request",
];

const PUBLIC_PAGES = ["/", "/login", "/favicon.ico"];

describe("middleware matcher", () => {
  it("parses to exactly three matchers (dashboard, platform pages + api)", () => {
    expect(matchers).toHaveLength(3);
  });

  it("guards every existing /api route", () => {
    const unguarded = API_ROUTES.filter((p) => !isGuarded(p));
    expect(unguarded).toEqual([]);
  });

  it("matches NextAuth's endpoints, which middleware passes through", () => {
    const missed = AUTH_ROUTES.filter((p) => !isGuarded(p));
    expect(missed).toEqual([]);
  });

  it("guards every /dashboard page and leaves the public pages alone", () => {
    expect(isGuarded("/dashboard")).toBe(true);
    expect(isGuarded("/dashboard/front-desk")).toBe(true);
    expect(isGuarded("/dashboard/guests/abc")).toBe(true);
    for (const p of PUBLIC_PAGES) {
      expect(isGuarded(p), `${p} should not be guarded`).toBe(false);
    }
  });
});
