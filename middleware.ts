import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";

function getCleanSecret(raw?: string): string | undefined {
  if (!raw) return undefined;
  return raw
    .replace(/^NEXTAUTH_SECRET\s*=\s*/i, "")
    .replace(/^["']+|["']+$/g, "")
    .trim();
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const secret = getCleanSecret(process.env.NEXTAUTH_SECRET);
  let token = await getToken({
    req,
    secret,
    secureCookie: req.nextUrl.protocol === "https:",
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
    "/api/:path((?!auth/).*)",
  ],
};
