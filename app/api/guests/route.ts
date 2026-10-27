import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";

export async function GET(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.GUEST_STAYS);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  const includeArchived = searchParams.get("includeArchived") === "true";

  const guests = await prisma.guest.findMany({
    where: {
      hotelId,
      isArchived: includeArchived ? undefined : false,
      ...(q
        ? {
            OR: [
              { fullName: { contains: q, mode: "insensitive" } },
              { phone: { contains: q, mode: "insensitive" } },
              { email: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      reservations: {
        where: { hotelId },
        orderBy: { checkInDate: "desc" },
        take: 1,
        include: { rooms: { include: { room: true } } },
      },
    },
  });

  return NextResponse.json(
    guests.map((g) => ({
      id: g.id,
      fullName: g.fullName,
      phone: g.phone,
      email: g.email,
      isArchived: g.isArchived,
      currentRoom: g.reservations[0]?.rooms[0]?.room.number ?? null,
      lastStatus: g.reservations[0]?.status ?? null,
      checkInDate: g.reservations[0]?.checkInDate.toISOString() ?? null,
      checkOutDate: g.reservations[0]?.checkOutDate.toISOString() ?? null,
    }))
  );
}