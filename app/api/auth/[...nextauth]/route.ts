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

  // Load database-backed credentials/session callbacks only when the database is configured.
  const { authOptions } = await import("@/lib/auth");
  return NextAuth(req, context, authOptions);
}

export { handler as GET, handler as POST };
