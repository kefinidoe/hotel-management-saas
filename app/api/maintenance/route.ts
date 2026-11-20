import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { notify } from "@/lib/notifications";

export async function GET() {
  const tenant = await getTenantFromRoute("read");
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MAINTENANCE);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "MAINTENANCE", "read");
  if (blocked) return blocked;

  const [tickets, memberships] = await Promise.all([
    prisma.maintenanceTicket.findMany({
      where: { hotelId: tenant.hotelId },
      include: { room: true },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.hotelMembership.findMany({
      where: { hotelId: tenant.hotelId, status: "ACTIVE", user: { isActive: true } },
      select: { userId: true, user: { select: { name: true } } },
    }),
  ]);
  const staffNamesByUserId = new Map(memberships.map((membership) => [membership.userId, membership.user.name]));

  return NextResponse.json(
    tickets.map((t) => ({
      id: t.id,
      title: t.title,
      description: t.description,
      priority: t.priority,
      status: t.status,
      cost: t.cost ? Number(t.cost) : null,
      roomId: t.roomId,
      roomNumber: t.room?.number ?? null,
      assigneeId: t.assigneeId && staffNamesByUserId.has(t.assigneeId) ? t.assigneeId : null,
      assigneeName: t.assigneeId ? staffNamesByUserId.get(t.assigneeId) ?? null : null,
      updatedAt: t.updatedAt.toISOString(),
    }))
  );
}

export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MAINTENANCE);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "MAINTENANCE");
  if (blocked) return blocked;

  const body = await req.json();
  if (!body.title) {
    return NextResponse.json({ error: "A ticket title is required." }, { status: 400 });
  }

  const roomId = typeof body.roomId === "string" && body.roomId ? body.roomId : null;
  if (roomId) {
    const activeRoom = await prisma.room.findFirst({
      where: { id: roomId, hotelId: tenant.hotelId, isActive: true },
      select: { id: true },
    });
    if (!activeRoom) {
      return NextResponse.json(
        { error: "That room is no longer part of the active hotel inventory." },
        { status: 400 }
      );
    }
  }

  const ticket = await prisma.maintenanceTicket.create({
    data: {
      hotelId: tenant.hotelId,
      title: body.title,
      description: body.description || null,
      priority: body.priority || "normal",
      roomId,
      status: "OPEN",
    },
  });

  if (roomId && body.takeOutOfService) {
    await prisma.room.update({
      where: { id_hotelId: { id: roomId, hotelId: tenant.hotelId } },
      data: { status: "MAINTENANCE" },
    });
  }

  // Whoever raised the ticket knows about it; the point of the notification is
  // that the people who fix and pay for things find out without being told.
  const room = roomId
    ? await prisma.room.findFirst({ where: { id: roomId, hotelId: tenant.hotelId }, select: { number: true } })
    : null;
  await notify({
    hotelId: tenant.hotelId,
    type: "MAINTENANCE",
    title: `Maintenance: ${ticket.title}`,
    message: `${room ? `Room ${room.number} - ` : ""}${ticket.priority} priority ticket opened${
      body.takeOutOfService ? "; the room has been taken out of service" : ""
    }.`,
  });

  return NextResponse.json(ticket, { status: 201 });
}
