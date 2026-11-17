import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { isSameOriginRequest } from "@/lib/request-origin";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
function hasCanonicalOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return false;
  try {
    const expected = process.env.NEXTAUTH_URL || (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
    const parsed = new URL(origin);
    return origin === parsed.origin && parsed.origin === new URL(expected).origin;
  } catch {
    return false;
  }
}

function getCleanSecret(raw?: string): string | undefined {
  if (!raw) return undefined;
  return raw
    .replace(/^NEXTAUTH_SECRET\s*=\s*/i, "")
    .replace(/^["']+|["']+$/g, "")
    .trim();
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  // Preserve the existing public auth-route middleware behavior. NextAuth and
  // application auth handlers remain responsible for their own protections.
  if (pathname.startsWith("/api/auth/")) return NextResponse.next();

  if (pathname.startsWith("/api/") && MUTATING_METHODS.has(req.method)) {
    // Require Origin even when fetch metadata or Host alone looks trustworthy.
    if (!hasCanonicalOrigin(req) || !isSameOriginRequest(req)) {
      return NextResponse.json({ error: "CSRF_ORIGIN_INVALID" }, { status: 403 });
    }
  }

  const secret = getCleanSecret(process.env.NEXTAUTH_SECRET);
  let token = await getToken({
    req,
    secret,
    secureCookie: process.env.NODE_ENV === "production" || req.nextUrl.protocol === "https:",
  });
  if (!token) {
    token = await getToken({ req, secret });
  }
  if (token) {
    if (!process.env.DATABASE_URL?.trim()) {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json(
          { error: "DATABASE_UNAVAILABLE", message: "Database-backed actions are unavailable in offline preview." },
          { status: 503 }
        );
      }

      const offlineLoginUrl = new URL("/login", req.url);
      offlineLoginUrl.searchParams.set("error", "DATABASE_UNAVAILABLE");
      offlineLoginUrl.searchParams.set("callbackUrl", `${pathname}${search}`);
      return NextResponse.redirect(offlineLoginUrl);
    }
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("callbackUrl", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/platform/:path*",
    "/api/:path*",
  ],
};
