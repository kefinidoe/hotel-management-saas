import { NextResponse } from "next/server";
import { getPlatformAdminFromRoute } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { HotelStatus, HotelRole } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function GET() {
  const admin = await getPlatformAdminFromRoute();
  if (admin instanceof NextResponse) return admin;

  try {
    const [
      totalHotels,
      activeHotels,
      trialingHotels,
      suspendedHotels,
      cancelledHotels,
      totalUsers,
      totalRooms,
      recentHotels,
      recentAuditLogs,
    ] = await Promise.all([
      prisma.hotel.count(),
      prisma.hotel.count({ where: { status: HotelStatus.ACTIVE } }),
      prisma.hotel.count({ where: { status: HotelStatus.TRIALING } }),
      prisma.hotel.count({ where: { status: HotelStatus.SUSPENDED } }),
      prisma.hotel.count({ where: { status: HotelStatus.CANCELLED } }),
      prisma.user.count(),
      prisma.room.count(),
      prisma.hotel.findMany({
        take: 8,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          currency: true,
          createdAt: true,
          memberships: {
            where: { role: HotelRole.HOTEL_OWNER },
            take: 1,
            select: {
              user: {
                select: { name: true, email: true },
              },
            },
          },
        },
      }),
      prisma.auditLog.findMany({
        take: 10,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          action: true,
          entity: true,
          entityId: true,
          metadata: true,
          createdAt: true,
          user: {
            select: { name: true, email: true },
          },
          hotel: {
            select: { name: true, slug: true },
          },
        },
      }),
    ]);

    return NextResponse.json({
      metrics: {
        totalHotels,
        activeHotels,
        trialingHotels,
        suspendedHotels,
        cancelledHotels,
        totalUsers,
        totalRooms,
      },
      recentHotels: recentHotels.map((h) => ({
        id: h.id,
        name: h.name,
        slug: h.slug,
        status: h.status,
        currency: h.currency,
        createdAt: h.createdAt.toISOString(),
        owner: h.memberships[0]?.user || null,
      })),
      recentAuditLogs: recentAuditLogs.map((log) => ({
        id: log.id,
        action: log.action,
        entity: log.entity,
        entityId: log.entityId,
        metadata: log.metadata,
        createdAt: log.createdAt.toISOString(),
        userName: log.user?.name || "System",
        userEmail: log.user?.email || null,
        hotelName: log.hotel?.name || "Platform",
        hotelSlug: log.hotel?.slug || null,
      })),
    });
  } catch (error) {
    console.error("Failed to fetch platform overview metrics:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "Failed to load platform overview" },
      { status: 500 }
    );
  }
}
