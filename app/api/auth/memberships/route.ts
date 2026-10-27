import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { HotelStatus, MembershipStatus } from "@prisma/client";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const memberships = await prisma.hotelMembership.findMany({
    where: {
      userId: session.user.id,
      status: MembershipStatus.ACTIVE,
      hotel: {
        status: { in: [HotelStatus.ACTIVE, HotelStatus.TRIALING] },
      },
    },
    include: {
      hotel: {
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
        },
      },
    },
    orderBy: {
      hotel: {
        name: "asc",
      },
    },
  });

  return NextResponse.json({
    memberships: memberships.map((m) => ({
      id: m.id,
      hotelId: m.hotelId,
      hotelName: m.hotel.name,
      hotelSlug: m.hotel.slug,
      role: m.role,
      status: m.status,
    })),
  });
}
