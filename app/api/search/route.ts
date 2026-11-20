import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";

const RESULT_LIMIT = 5;

export async function GET(req: Request) {
  const tenant = await getTenantFromRoute("read");
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.FRONT_DESK);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS", "read");
  if (blocked) return blocked;

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() ?? "";

  // Require at least 2 characters — avoids scanning the whole guest table
  // on every keystroke of a 1-letter query.
  if (q.length < 2) {
    return NextResponse.json({ guests: [], reservations: [], rooms: [] });
  }

  const hotelId = tenant.hotelId;
  const [guests, reservations, rooms] = await Promise.all([
    prisma.guest.findMany({
      where: {
        hotelId,
        isArchived: false,
        OR: [
          { fullName: { contains: q, mode: "insensitive" } },
          { phone: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
        ],
      },
      select: { id: true, fullName: true, phone: true, email: true },
      take: RESULT_LIMIT,
      orderBy: { fullName: "asc" },
    }),
    prisma.reservation.findMany({
      where: {
        hotelId,
        OR: [
          { code: { contains: q, mode: "insensitive" } },
          { guest: { fullName: { contains: q, mode: "insensitive" } } },
        ],
      },
      select: {
        id: true,
        code: true,
        status: true,
        checkInDate: true,
        guest: { select: { fullName: true } },
      },
      take: RESULT_LIMIT,
      orderBy: { createdAt: "desc" },
    }),
    prisma.room.findMany({
      where: {
        hotelId,
        isActive: true,
        number: { contains: q, mode: "insensitive" },
      },
      select: { id: true, number: true, status: true },
      take: RESULT_LIMIT,
      orderBy: { number: "asc" },
    }),
  ]);

  return NextResponse.json({ guests, reservations, rooms });
}
