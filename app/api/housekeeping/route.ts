import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";

export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.HOUSEKEEPING);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "HOUSEKEEPING");
  if (blocked) return blocked;

  const [tasks, memberships] = await Promise.all([
    prisma.housekeepingTask.findMany({
      where: { hotelId: tenant.hotelId, room: { isActive: true } },
      include: { room: { include: { roomType: true } } },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.hotelMembership.findMany({
      where: { hotelId: tenant.hotelId, status: "ACTIVE", user: { isActive: true } },
      select: { userId: true, user: { select: { name: true } } },
    }),
  ]);
  const staffNamesByUserId = new Map(memberships.map((membership) => [membership.userId, membership.user.name]));

  return NextResponse.json(
    tasks.map((t) => ({
      id: t.id,
      status: t.status,
      priority: t.priority,
      roomId: t.roomId,
      roomNumber: t.room.number,
      roomTypeName: t.room.roomType.name,
      assigneeId: t.assigneeId && staffNamesByUserId.has(t.assigneeId) ? t.assigneeId : null,
      assigneeName: t.assigneeId ? staffNamesByUserId.get(t.assigneeId) ?? null : null,
      updatedAt: t.updatedAt.toISOString(),
    }))
  );
}