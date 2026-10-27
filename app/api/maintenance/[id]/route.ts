import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MAINTENANCE);
  if (forbidden) return forbidden;

  const { checkModuleEntitlement } = await import("@/lib/entitlements");
  const moduleCheck = await checkModuleEntitlement(tenant.hotelId, "MAINTENANCE");
  if (!moduleCheck.allowed) {
    return NextResponse.json(
      { error: moduleCheck.code || "MODULE_NOT_ENTITLED", message: moduleCheck.reason },
      { status: 403 }
    );
  }

  const existing = await prisma.maintenanceTicket.findFirst({
    where: { id, hotelId: tenant.hotelId },
  });
  if (!existing) {
    return NextResponse.json({ error: "Maintenance ticket not found." }, { status: 404 });
  }

  const body = await req.json();
  const ticket = await prisma.maintenanceTicket.update({
    where: { id },
    data: {
      status: body.status ?? undefined,
      assigneeId: body.assigneeId ?? undefined,
      priority: body.priority ?? undefined,
      description: body.description ?? undefined,
      cost: body.cost !== undefined ? body.cost : undefined,
    },
  });

  if (body.status === "COMPLETED" && ticket.roomId) {
    await prisma.room.update({
      where: { id_hotelId: { id: ticket.roomId, hotelId: tenant.hotelId } },
      data: { status: "AVAILABLE" },
    });
  }

  return NextResponse.json(ticket);
}
