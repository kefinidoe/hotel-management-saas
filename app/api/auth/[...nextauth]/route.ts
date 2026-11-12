import NextAuth from "next-auth";
import { NextResponse, type NextRequest } from "next/server";
import { isDatabaseConfigured } from "@/lib/db-safety-guard";

type AuthRouteContext = { params: Promise<{ nextauth: string[] }> };

async function handler(req: NextRequest, context: AuthRouteContext) {
  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      { error: "DATABASE_UNAVAILABLE", message: "Authentication is unavailable while the database is not configured." },
      { status: 503 }
    );
  }

  // Only the credentials callback is a login attempt; session, CSRF and signout
  // requests must not consume the login budget. Read a clone for NextAuth.
  const { nextauth } = await context.params;
  if (req.method === "POST" && nextauth.length === 2 && nextauth[0] === "callback" && nextauth[1] === "credentials") {
    let email = "";
    try {
      const contentType = req.headers.get("content-type") || "";
      if (contentType.toLowerCase().startsWith("application/json")) {
        const body = await req.clone().json();
        email = typeof body?.email === "string" ? body.email : "";
      } else {
        const form = await req.clone().formData();
        const emails = form.getAll("email");
        if (emails.length > 1) return NextResponse.json({ error: "INVALID_REQUEST_BODY" }, { status: 400 });
        email = typeof emails[0] === "string" ? emails[0] : "";
      }
    } catch {
      return NextResponse.json({ error: "INVALID_REQUEST_BODY" }, { status: 400 });
    }
    const { limitAuthRequest } = await import("@/lib/auth-rate-limit");
    const limited = await limitAuthRequest(req, "login", email);
    if (limited) return limited;
  }

  // Load database-backed credentials/session callbacks only when the database is configured.
  const { authOptions } = await import("@/lib/auth");
  return NextAuth(req, context, authOptions);
}

export { handler as GET, handler as POST };
