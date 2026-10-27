
import { prisma } from "@/lib/prisma";
import MaintenanceClient from "@/components/maintenance/MaintenanceClient";
import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function MaintenancePage() {
  const tenant = await requirePageRole(ROLE_GROUPS.MAINTENANCE, "MAINTENANCE");

  const [tickets, rooms, memberships] = await Promise.all([
    prisma.maintenanceTicket.findMany({
      where: {
        hotelId: tenant.hotelId,
      },
      include: {
        room: true,
      },
      orderBy: { updatedAt: "desc" },
    }),

    prisma.room.findMany({
      where: {
        hotelId: tenant.hotelId,
        isActive: true,
      },
      orderBy: { number: "asc" },
    }),

    prisma.hotelMembership.findMany({
      where: {
        hotelId: tenant.hotelId,
        status: "ACTIVE",
        user: { isActive: true },
      },
      select: {
        userId: true,
        role: true,
        user: {
          select: { name: true },
        },
      },
      orderBy: {
        user: { name: "asc" },
      },
    }),
  ]);

  const staffNamesByUserId = new Map(memberships.map((membership) => [membership.userId, membership.user.name]));

  const initialTickets = tickets.map((t) => ({
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
  }));

  const staff = memberships.map((membership) => ({
    id: membership.userId,
    name: membership.user.name,
    role: membership.role,
  }));

  return (
    <MaintenanceClient
      initialTickets={initialTickets}
      rooms={rooms.map((r) => ({
        id: r.id,
        number: r.number,
      }))}
      staff={staff}
    />
  );
}
