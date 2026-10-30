import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { isDatabaseConfigured } from "@/lib/db-safety-guard";

export async function GET() {
  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      { error: "DATABASE_UNAVAILABLE", message: "Hotel memberships are unavailable while the database is not configured." },
      { status: 503 }
    );
  }

  // Avoid evaluating the database-backed auth and Prisma modules in offline preview.
  const { authOptions } = await import("@/lib/auth");
  const { prisma } = await import("@/lib/prisma");
  const { listPendingInvitations } = await import("@/lib/invitations");
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const memberships = await prisma.hotelMembership.findMany({
    where: {
      userId: session.user.id,
      status: "ACTIVE",
      hotel: {
        status: { in: ["ACTIVE", "TRIALING"] },
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

  // Invitations are listed separately: they are memberships the signed-in user
  // has been offered but has not accepted, so they must never be switchable.
  const pendingInvitations = await listPendingInvitations(session.user.id);

  return NextResponse.json({
    memberships: memberships.map((m) => ({
      id: m.id,
      hotelId: m.hotelId,
      hotelName: m.hotel.name,
      hotelSlug: m.hotel.slug,
      role: m.role,
      status: m.status,
    })),
    pendingInvitations,
  });
}
