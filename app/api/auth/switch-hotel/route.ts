import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { isDatabaseConfigured } from "@/lib/db-safety-guard";

function validateOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) {
    // Browsers must provide Origin on POST requests
    return false;
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return false;
  }

  const expectedUrl = process.env.NEXTAUTH_URL || "http://localhost:3000";
  let expectedOrigin: URL;
  try {
    expectedOrigin = new URL(expectedUrl);
  } catch {
    return false;
  }

  return (
    parsedOrigin.protocol === expectedOrigin.protocol &&
    parsedOrigin.hostname === expectedOrigin.hostname &&
    parsedOrigin.port === expectedOrigin.port
  );
}

export async function POST(req: Request) {
  // 1. Strict Origin / CSRF Enforcement
  if (!validateOrigin(req)) {
    return NextResponse.json(
      { error: "CSRF_ORIGIN_INVALID", message: "Cross-origin request rejected" },
      { status: 403 }
    );
  }

  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      { error: "DATABASE_UNAVAILABLE", message: "Hotel switching is unavailable while the database is not configured." },
      { status: 503 }
    );
  }

  // Load database-backed session options only when the DB is configured.
  const { authOptions } = await import("@/lib/auth");
  const { prisma } = await import("@/lib/prisma");

  // 2. Authentication Check
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "UNAUTHENTICATED", message: "Sign-in required" },
      { status: 401 }
    );
  }

  const userId = session.user.id;

  // 3. Body Parsing
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "INVALID_REQUEST_BODY", message: "Malformed JSON body" },
      { status: 400 }
    );
  }

  const targetHotelId = typeof body?.hotelId === "string" ? body.hotelId.trim() : "";
  if (!targetHotelId) {
    return NextResponse.json(
      { error: "MISSING_HOTEL_ID", message: "hotelId is required" },
      { status: 400 }
    );
  }

  // 4. Authoritative Database Membership Check
  const membership = await prisma.hotelMembership.findUnique({
    where: { userId_hotelId: { userId, hotelId: targetHotelId } },
    include: { hotel: true },
  });

  if (!membership || membership.status !== "ACTIVE") {
    // Preserve existing cookie untouched on failure
    return NextResponse.json(
      { error: "NO_ACTIVE_MEMBERSHIP", message: "No active membership in target hotel" },
      { status: 403 }
    );
  }

  // 5. Authoritative Hotel Status Check
  if (
    membership.hotel.status !== "ACTIVE" &&
    membership.hotel.status !== "TRIALING"
  ) {
    return NextResponse.json(
      { error: "HOTEL_SUSPENDED", message: "Target hotel workspace is currently suspended" },
      { status: 403 }
    );
  }

  // 6. Success: Set HttpOnly, SameSite active_hotel_id cookie
  const response = NextResponse.json({
    ok: true,
    activeHotel: {
      id: membership.hotel.id,
      name: membership.hotel.name,
      slug: membership.hotel.slug,
      currency: membership.hotel.currency,
      timezone: membership.hotel.timezone,
      role: membership.role,
    },
  });

  response.cookies.set("active_hotel_id", membership.hotelId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });

  return response;
}
