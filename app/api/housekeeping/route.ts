import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";

export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.HOUSEKEEPING);
  if (forbidden) return forbidden;

  const { checkModuleEntitlement } = await import("@/lib/entitlements");
  const moduleCheck = await checkModuleEntitlement(tenant.hotelId, "HOUSEKEEPING");
  if (!moduleCheck.allowed) {
    return NextResponse.json(
      { error: moduleCheck.code || "MODULE_NOT_ENTITLED", message: moduleCheck.reason },
      { status: 403 }
    );
  }

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