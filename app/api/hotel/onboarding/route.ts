import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { HotelRole, MembershipStatus } from "@prisma/client";

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SUPPORTED_CURRENCIES = ["KES", "USD", "EUR", "GBP", "TZS", "UGX", "RWF", "ZAR", "AED"];

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function POST(req: Request) {
  // 1. Authoritative Session Check
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json(
      { error: "UNAUTHENTICATED", message: "Sign-in required to create a hotel workspace." },
      { status: 401 }
    );
  }

  const userId = session.user.id;

  // Verify user is active in database
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, isActive: true },
  });

  if (!user || !user.isActive) {
    return NextResponse.json(
      { error: "ACCOUNT_INACTIVE", message: "User account is inactive or not found." },
      { status: 403 }
    );
  }

  // 2. Parse & Validate Payload
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "INVALID_REQUEST_BODY", message: "Malformed JSON body." },
      { status: 400 }
    );
  }

  const rawName = typeof body?.name === "string" ? body.name.trim() : "";
  let rawSlug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : "";
  const currency = typeof body?.currency === "string" ? body.currency.trim().toUpperCase() : "KES";
  const timezone = typeof body?.timezone === "string" ? body.timezone.trim() : "Africa/Nairobi";
  const email = typeof body?.email === "string" && body.email.trim() ? body.email.trim() : null;
  const phone = typeof body?.phone === "string" && body.phone.trim() ? body.phone.trim() : null;
  const address = typeof body?.address === "string" && body.address.trim() ? body.address.trim() : null;

  if (!rawName || rawName.length < 2 || rawName.length > 100) {
    return NextResponse.json(
      { error: "INVALID_NAME", message: "Hotel name must be between 2 and 100 characters." },
      { status: 400 }
    );
  }

  if (!rawSlug) {
    rawSlug = slugify(rawName);
  }

  if (!rawSlug || rawSlug.length < 2 || rawSlug.length > 60 || !SLUG_REGEX.test(rawSlug)) {
    return NextResponse.json(
      {
        error: "INVALID_SLUG",
        message: "Hotel workspace slug must contain only lowercase alphanumeric characters and single hyphens (2-60 chars).",
      },
      { status: 400 }
    );
  }

  if (!SUPPORTED_CURRENCIES.includes(currency)) {
    return NextResponse.json(
      {
        error: "INVALID_CURRENCY",
        message: `Unsupported currency. Choose one of: ${SUPPORTED_CURRENCIES.join(", ")}.`,
      },
      { status: 400 }
    );
  }

  if (timezone.length < 2 || timezone.length > 60) {
    return NextResponse.json(
      { error: "INVALID_TIMEZONE", message: "A valid timezone identifier is required." },
      { status: 400 }
    );
  }

  // 3. Atomic Hotel & Owner Membership Creation
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Check slug uniqueness
      const existingHotel = await tx.hotel.findUnique({
        where: { slug: rawSlug },
      });

      if (existingHotel) {
        throw new Error("SLUG_ALREADY_EXISTS");
      }

      // Create Hotel Workspace
      const hotel = await tx.hotel.create({
        data: {
          name: rawName,
          slug: rawSlug,
          currency,
          timezone,
          email,
          phone,
          address,
          status: "ACTIVE",
        },
      });

      // Assign Creator as HOTEL_OWNER
      const membership = await tx.hotelMembership.create({
        data: {
          userId,
          hotelId: hotel.id,
          role: HotelRole.HOTEL_OWNER,
          status: MembershipStatus.ACTIVE,
        },
      });

      // Bootstrap initial standard payment methods for convenience
      const standardPaymentMethods = [
        "Cash",
        "Credit / Debit Card",
        "Mobile Money / M-Pesa",
        "Bank Transfer",
      ];

      for (const name of standardPaymentMethods) {
        await tx.paymentMethod.create({
          data: {
            hotelId: hotel.id,
            name,
          },
        });
      }

      return { hotel, membership };
    });

    // 4. Set Active Hotel Cookie & Return Context
    const response = NextResponse.json(
      {
        hotel: {
          id: result.hotel.id,
          name: result.hotel.name,
          slug: result.hotel.slug,
          currency: result.hotel.currency,
          timezone: result.hotel.timezone,
        },
        role: result.membership.role,
        message: "Hotel workspace created successfully.",
      },
      { status: 201 }
    );

    response.cookies.set("active_hotel_id", result.hotel.id, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 24 * 60 * 60, // 30 days
    });

    return response;
  } catch (error: any) {
    if (error?.message === "SLUG_ALREADY_EXISTS") {
      return NextResponse.json(
        {
          error: "SLUG_ALREADY_EXISTS",
          message: `The workspace slug '${rawSlug}' is already taken. Please choose another slug.`,
        },
        { status: 409 }
      );
    }

    console.error("Failed to onboard hotel workspace:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "Failed to create hotel workspace. Please try again." },
      { status: 500 }
    );
  }
}
