import { prisma } from "@/lib/prisma";
import StaffClient from "@/components/staff/StaffClient";
import { pendingInvitationIds } from "@/lib/invitations";
import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function StaffPage() {
  const context = await requirePageRole(ROLE_GROUPS.STAFF_VIEW, "RESERVATIONS");

  const memberships = await prisma.hotelMembership.findMany({
    where: { hotelId: context.hotelId },
    include: {
      user: {
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          isActive: true,
          lastLoginAt: true,
          createdAt: true,
        },
      },
    },
    orderBy: { user: { name: "asc" } },
  });

  const pending = await pendingInvitationIds(memberships.map((m) => m.id));

  const initialStaff = memberships.map((m) => ({
    id: m.id,
    userId: m.user.id,
    name: m.user.name,
    email: m.user.email,
    phone: m.user.phone,
    role: m.role,
    department: m.department,
    status: m.status,
    isActive: m.user.isActive && m.status === "ACTIVE",
    invitationPending: pending.has(m.id),
    lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
    createdAt: m.createdAt.toISOString(),
  }));

  return (
    <StaffClient
      initialStaff={initialStaff}
      currentUserId={context.userId}
      currentUserRole={context.role}
    />
  );
}