import { readMutationBody, validateMutation, housekeepingSchema } from "@/lib/staff-settings-validation";
import { NextResponse } from "next/server";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { findActiveHotelStaff } from "@/lib/hotel-staff";

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

  const validation = validateMutation(req, housekeepingSchema, await readMutationBody(req), { id });
  if (validation.response) return validation.response;
  const body = validation.data;

  const existing = await prisma.housekeepingTask.findFirst({
    where: { id, hotelId: tenant.hotelId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Housekeeping task not found." }, { status: 404 });
  }


  let assigneeId: string | null | undefined;
  if (body.assigneeId !== undefined) {
    if (body.assigneeId !== null && typeof body.assigneeId !== "string") {
      return NextResponse.json({ error: "Assignee must be a staff member in this hotel." }, { status: 400 });
    }
    assigneeId = typeof body.assigneeId === "string" ? body.assigneeId.trim() || null : null;
  }

  const task = await prisma.$transaction(async (tx) => {
    if (assigneeId && !(await findActiveHotelStaff(tenant.hotelId, assigneeId, tx))) return null;
    const updated = await tx.housekeepingTask.updateMany({
      where: { id, hotelId: tenant.hotelId },
      data: {
        status: body.status,
        assigneeId,
        priority: body.priority ?? undefined,
      },
    });
    if (updated.count !== 1) return null;
    return tx.housekeepingTask.findFirst({
      where: { id, hotelId: tenant.hotelId },
    });
  }, { isolationLevel: "Serializable" });
  if (!task) {
    return NextResponse.json({ error: "Choose an active staff member from this hotel." }, { status: 400 });
  }

  if (body.status && ROOM_STATUS_FOR[body.status]) {
    await prisma.room.update({
      where: { id_hotelId: { id: task.roomId, hotelId: tenant.hotelId } },
      data: { status: ROOM_STATUS_FOR[body.status] as any },
    });
  }

  return NextResponse.json(task);
}
