import { NextResponse } from "next/server";
import { getPlatformAdminFromRoute } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { HotelStatus, HotelRole, Prisma } from "@prisma/client";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const admin = await getPlatformAdminFromRoute();
  if (admin instanceof NextResponse) return admin;

  try {
    const { searchParams } = new URL(req.url);
    const search = searchParams.get("search")?.trim() || "";
    const statusParam = searchParams.get("status")?.trim() || "";
    const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get("limit") || "20", 10) || 20));
    const skip = (page - 1) * limit;

    const where: Prisma.HotelWhereInput = {};

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { slug: { contains: search, mode: "insensitive" } },
      ];
    }

    if (statusParam && Object.values(HotelStatus).includes(statusParam as HotelStatus)) {
      where.status = statusParam as HotelStatus;
    }

    const [total, hotels] = await Promise.all([
      prisma.hotel.count({ where }),
      prisma.hotel.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          slug: true,
          status: true,
          currency: true,
          timezone: true,
          settings: true,
          createdAt: true,
          updatedAt: true,
          _count: {
            select: {
              rooms: true,
              memberships: true,
              reservations: true,
            },
          },
          memberships: {
            where: { role: HotelRole.HOTEL_OWNER },
            take: 1,
            select: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  phone: true,
                },
              },
            },
          },
        },
      }),
    ]);

    const formattedHotels = hotels.map((h) => {
      const settingsObj = (h.settings as Record<string, any>) || {};
      return {
        id: h.id,
        name: h.name,
        slug: h.slug,
        status: h.status,
        currency: h.currency,
        timezone: h.timezone,
        contactEmail: settingsObj.contactEmail || h.memberships[0]?.user?.email || null,
        contactPhone: settingsObj.contactPhone || h.memberships[0]?.user?.phone || null,
        address: settingsObj.address || null,
        roomCount: h._count.rooms,
        memberCount: h._count.memberships,
        reservationCount: h._count.reservations,
        owner: h.memberships[0]?.user || null,
        createdAt: h.createdAt.toISOString(),
        updatedAt: h.updatedAt.toISOString(),
      };
    });

    return NextResponse.json({
      hotels: formattedHotels,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    });
  } catch (error) {
    console.error("Failed to fetch platform hotel directory:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "Failed to retrieve hotel directory." },
      { status: 500 }
    );
  }
}
