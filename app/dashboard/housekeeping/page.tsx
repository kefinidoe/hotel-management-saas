
import { prisma } from "@/lib/prisma";
import HousekeepingClient from "@/components/housekeeping/HousekeepingClient";
import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function HousekeepingPage() {
  const tenant = await requirePageRole(ROLE_GROUPS.HOUSEKEEPING, "HOUSEKEEPING");

  const [tasks, memberships] = await Promise.all([
    prisma.housekeepingTask.findMany({
      where: {
        hotelId: tenant.hotelId,
        room: { isActive: true },
      },
      include: {
        room: { include: { roomType: true } },
      },
      orderBy: { updatedAt: "desc" },
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
        user: { select: { name: true } },
      },
      orderBy: { user: { name: "asc" } },
    }),
  ]);

  const staffNamesByUserId = new Map(memberships.map((membership) => [membership.userId, membership.user.name]));

  const initialTasks = tasks.map((t) => ({
    id: t.id,
    status: t.status,
    priority: t.priority,
    roomId: t.roomId,
    roomNumber: t.room.number,
    roomTypeName: t.room.roomType.name,
    assigneeId: t.assigneeId && staffNamesByUserId.has(t.assigneeId) ? t.assigneeId : null,
    assigneeName: t.assigneeId ? staffNamesByUserId.get(t.assigneeId) ?? null : null,
  }));

  const staff = memberships.map((membership) => ({
    id: membership.userId,
    name: membership.user.name,
    role: membership.role,
  }));

  return (
    <HousekeepingClient
      initialTasks={initialTasks}
      staff={staff}
    />
  );
}
