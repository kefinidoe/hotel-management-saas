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

  const tasks = await prisma.housekeepingTask.findMany({
    where: { hotelId: tenant.hotelId, room: { isActive: true } },
    include: { room: { include: { roomType: true } }, assignee: true },
    orderBy: { updatedAt: "desc" },
  });

  return NextResponse.json(
    tasks.map((t) => ({
      id: t.id,
      status: t.status,
      priority: t.priority,
      roomId: t.roomId,
      roomNumber: t.room.number,
      roomTypeName: t.room.roomType.name,
      assigneeId: t.assigneeId,
      assigneeName: t.assignee?.name ?? null,
      updatedAt: t.updatedAt.toISOString(),
    }))
  );
}