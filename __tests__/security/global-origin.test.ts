import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { NextRequest } from "next/server";
import { getPathMatch } from "next/dist/shared/lib/router/utils/path-match";

const getToken = vi.hoisted(() => vi.fn());
vi.mock("next-auth/jwt", () => ({ getToken }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
import { config, middleware } from "@/middleware";

const root = resolve(__dirname, "../..");
const apiRoot = join(root, "app/api");
const methods = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Exact reviewed inventory: adding or changing a mutating route requires review.
const reviewed = [
  "DELETE api/inventory/[id]",
  "DELETE api/menu/categories/[id]",
  "DELETE api/menu/items/[id]",
  "DELETE api/pricing/[entity]",
  "DELETE api/recipes/[id]",
  "DELETE api/reservations/[id]",
  "DELETE api/room-types/[id]",
  "DELETE api/rooms/[id]",
  "DELETE api/settings/pricing/rules",
  "DELETE api/staff/[id]",
  "PATCH api/expenses/[id]",
  "PATCH api/guests/[id]",
  "PATCH api/hotel/settings",
  "PATCH api/inventory/[id]",
  "PATCH api/notifications",
  "PATCH api/platform/hotels/[id]/status",
  "PATCH api/platform/hotels/[id]/subscription",
  "PATCH api/pricing",
  "PATCH api/pricing/[entity]",
  "PATCH api/recipes/[id]",
  "PATCH api/settings/branding",
  "PATCH api/settings/hotel",
  "PATCH api/settings/pricing/rules",
  "PATCH api/staff/[id]",
  "POST api/auth/[...nextauth]",
  "POST api/auth/invitations/[id]",
  "POST api/auth/register",
  "POST api/auth/switch-hotel",
  "POST api/check-in",
  "POST api/check-out",
  "POST api/expenses",
  "POST api/hotel/onboarding",
  "POST api/inventory",
  "POST api/maintenance",
  "POST api/menu",
  "POST api/menu/categories",
  "POST api/payments",
  "POST api/pricing/[entity]",
  "POST api/pricing/room-rates",
  "POST api/profile/password",
  "POST api/purchases",
  "POST api/recipes",
  "POST api/reservations",
  "POST api/reservations/[id]/check-in",
  "POST api/reservations/[id]/check-out",
  "POST api/reservations/[id]/extend",
  "POST api/reservations/[id]/reprice",
  "POST api/reservations/quote",
  "POST api/restaurant/charge-to-room",
  "POST api/restaurant/pay-now",
  "POST api/room-types",
  "POST api/rooms",
  "POST api/settings/branding/upload",
  "POST api/settings/meals",
  "POST api/settings/pricing/rules",
  "POST api/staff",
  "POST api/wastage",
  "PUT api/housekeeping/[id]",
  "PUT api/maintenance/[id]",
  "PUT api/menu/items/[id]",
  "PUT api/reservations/[id]",
  "PUT api/room-types/[id]",
  "PUT api/rooms/[id]",
  "PUT api/settings/meals",
];

function enumerate(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) return enumerate(file);
    if (!/^route\.(ts|tsx|js|jsx)$/.test(entry.name)) return [];
    const ast = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    for (const statement of ast.statements) {
      const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (exported && ts.isFunctionDeclaration(statement) && statement.name && methods.has(statement.name.text)) found.push(statement.name.text);
      if (exported && ts.isVariableStatement(statement)) {
        for (const item of statement.declarationList.declarations) if (ts.isIdentifier(item.name) && methods.has(item.name.text)) found.push(item.name.text);
      }
      if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const item of statement.exportClause.elements) if (methods.has(item.name.text)) found.push(item.name.text);
      }
      if (ts.isExportDeclaration(statement) && !statement.exportClause) throw new Error(`Unreviewable wildcard route export: ${file}`);
    }
    const route = relative(join(root, "app"), dir).split(sep).join("/");
    return found.map((method) => `${method} ${route}`);
  });
}

function sample(route: string) {
  return "/" + route.replace(/\[\.\.\.[^\]]+\]/g, "callback/credentials").replace(/\[\[\.\.\.[^\]]+\]\]/g, "sample").replace(/\[[^\]]+\]/g, "sample");
}

const inventory = enumerate(apiRoot).sort();
const appRoutes = inventory.filter((entry) => !entry.split(" ")[1].startsWith("api/auth/"));
const authRoutes = inventory.filter((entry) => entry.split(" ")[1].startsWith("api/auth/"));

describe("global API origin enforcement", () => {
  beforeEach(() => {
    vi.stubEnv("NEXTAUTH_URL", "https://hotel.example.test");
    vi.stubEnv("DATABASE_URL", "fictional-configured-value");
    vi.stubEnv("SAAS_ALLOW_REQUEST_HOST_ORIGIN", "false");
    getToken.mockReset().mockResolvedValue({ id: "fictional-user" });
  });
  afterEach(() => vi.unstubAllEnvs());

  it("requires review when a mutating route or export is added or changed", () => {
    expect(inventory).toEqual(reviewed);
  });

  it.each(appRoutes)("%s is matched and rejects cross-site or missing Origin, but passes matching Origin", async (entry) => {
    const [method, route] = entry.split(" ");
    const pathname = sample(route);
    expect(config.matcher.some((pattern) => !!getPathMatch(pattern, { strict: false })(pathname))).toBe(true);
    const rejectedHeaders: Record<string, string>[] = [
      { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
      { origin: "https://hotel.example.test", "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-origin" },
      {},
    ];
    for (const headers of rejectedHeaders) {
      const result = await middleware(new NextRequest(`https://hotel.example.test${pathname}`, { method, headers }));
      expect(result.status).toBe(403);
      expect(await result.json()).toEqual({ error: "CSRF_ORIGIN_INVALID" });
    }
    const result = await middleware(new NextRequest(`https://hotel.example.test${pathname}`, {
      method, headers: { origin: "https://hotel.example.test", "sec-fetch-site": "same-origin" },
    }));
    expect(result.headers.get("x-middleware-next")).toBe("1");
  });

  it.each(authRoutes)("%s bypasses global origin enforcement; its handler retains its own checks", async (entry) => {
    getToken.mockResolvedValue(null);
    const [method, route] = entry.split(" ");
    for (const headers of [{}, { origin: "https://identity.example", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
      const res = await middleware(new NextRequest(`https://hotel.example.test${sample(route)}`, { method, headers }));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
    expect(getToken).not.toHaveBeenCalled();
  });

  it("passes NextAuth sign-in, cross-site callbacks and public auth GETs through without a session", async () => {
    getToken.mockResolvedValue(null);
    for (const pathname of ["signin", "signin/credentials", "callback/credentials", "callback/provider", "signout", "session", "register"]) {
      for (const headers of [{}, { origin: "https://identity.example", "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
        const res = await middleware(new NextRequest(`https://hotel.example.test/api/auth/${pathname}`, { method: "POST", headers }));
        expect(res.headers.get("x-middleware-next")).toBe("1");
      }
    }
    const csrf = await middleware(new NextRequest("https://hotel.example.test/api/auth/csrf"));
    expect(csrf.headers.get("x-middleware-next")).toBe("1");
    expect(getToken).not.toHaveBeenCalled();
  });

  it("does not exempt similarly named paths outside the auth subtree", async () => {
    for (const pathname of ["/api/authentic", "/api/auth-other/session"]) {
      const res = await middleware(new NextRequest(`https://hotel.example.test${pathname}`, { method: "POST", headers: { origin: "https://evil.example" } }));
      expect(res.status).toBe(403);
    }
  });

  it("preserves the authentication guard for non-auth routes", async () => {
    getToken.mockResolvedValue(null);
    const res = await middleware(new NextRequest("https://hotel.example.test/api/staff", { method: "POST", headers: { origin: "https://hotel.example.test" } }));
    expect(res.status).toBe(401);
  });
});

describe("security header and cookie configuration", () => {
  it("configures CSP, HSTS, clickjacking, content-type, referrer and permissions headers", async () => {
    const nextConfig = require("../../next.config.js");
    const definitions = await nextConfig.headers();
    const headers = new Map<string, string>(definitions[0].headers.map((h: { key: string; value: string }) => [h.key, h.value]));
    expect(definitions[0].source).toBe("/:path*");
    expect(headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(headers.get("Content-Security-Policy")).toContain("object-src 'none'");
    expect(headers.get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(headers.get("X-Frame-Options")).toBe("DENY");
    expect(headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(headers.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(headers.get("Permissions-Policy")).toBe("camera=(), microphone=(), geolocation=()");
  });

  it("uses secure, HttpOnly, SameSite=Lax NextAuth defaults in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.resetModules();
    const { authOptions } = await import("@/lib/auth");
    expect(authOptions.useSecureCookies).toBe(true);
    const { defaultCookies } = require(join(dirname(require.resolve("next-auth")), "core/lib/cookie.js"));
    const cookies = defaultCookies(authOptions.useSecureCookies);
    for (const cookie of Object.values(cookies) as Array<{ options: Record<string, unknown> }>) {
      expect(cookie.options).toMatchObject({ secure: true, httpOnly: true, sameSite: "lax", path: "/" });
    }
    vi.unstubAllEnvs();
  });
});
