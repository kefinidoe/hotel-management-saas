import { NextResponse } from "next/server";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

const ROOM_STATUS_FOR: Record<string, string> = {
  NEEDS_CLEANING: "DIRTY",
  IN_PROGRESS: "CLEANING",
  READY_FOR_INSPECTION: "CLEANING",
  READY: "AVAILABLE",
};

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.HOUSEKEEPING);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "HOUSEKEEPING");
  if (blocked) return blocked;

  const existing = await prisma.housekeepingTask.findFirst({
    where: { id, hotelId: tenant.hotelId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Housekeeping task not found." }, { status: 404 });
  }

  const body = await req.json();
  const task = await prisma.housekeepingTask.update({
    where: { id },
    data: {
      status: body.status,
      assigneeId: body.assigneeId ?? undefined,
      priority: body.priority ?? undefined,
    },
  });

  if (body.status && ROOM_STATUS_FOR[body.status]) {
    await prisma.room.update({
      where: { id_hotelId: { id: task.roomId, hotelId: tenant.hotelId } },
      data: { status: ROOM_STATUS_FOR[body.status] as any },
    });
  }

  return NextResponse.json(task);
}
