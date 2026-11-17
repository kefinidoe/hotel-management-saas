import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findActiveHotelStaff } from "@/lib/hotel-staff";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MAINTENANCE);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "MAINTENANCE");
  if (blocked) return blocked;

  const existing = await prisma.maintenanceTicket.findFirst({
    where: { id, hotelId: tenant.hotelId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Maintenance ticket not found." }, { status: 404 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }

  let assigneeId: string | null | undefined;
  if (body.assigneeId !== undefined) {
    if (body.assigneeId !== null && typeof body.assigneeId !== "string") {
      return NextResponse.json({ error: "Assignee must be a staff member in this hotel." }, { status: 400 });
    }
    assigneeId = typeof body.assigneeId === "string" ? body.assigneeId.trim() || null : null;
  }

  const ticket = await prisma.$transaction(async (tx) => {
    if (assigneeId && !(await findActiveHotelStaff(tenant.hotelId, assigneeId, tx))) return null;
    const updated = await tx.maintenanceTicket.updateMany({
      where: { id, hotelId: tenant.hotelId },
      data: {
        status: body.status ?? undefined,
        assigneeId,
        priority: body.priority ?? undefined,
        description: body.description ?? undefined,
        cost: body.cost !== undefined ? body.cost : undefined,
      },
    });
    if (updated.count !== 1) return null;
    return tx.maintenanceTicket.findFirst({
      where: { id, hotelId: tenant.hotelId },
    });
  }, { isolationLevel: "Serializable" });
  if (!ticket) {
    return NextResponse.json({ error: "Choose an active staff member from this hotel." }, { status: 400 });
  }

  if (body.status === "COMPLETED" && ticket.roomId) {
    await prisma.room.update({
      where: { id_hotelId: { id: ticket.roomId, hotelId: tenant.hotelId } },
      data: { status: "AVAILABLE" },
    });
  }

  return NextResponse.json(ticket);
}
