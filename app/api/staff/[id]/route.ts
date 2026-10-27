import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { HotelRole, MembershipStatus } from "@prisma/client";
import { passwordProblem } from "@/lib/password";

const PERMITTED_HOTEL_ROLES = Object.values(HotelRole);

export const dynamic = "force-dynamic";

// Find membership by ID or userId strictly within tenant.hotelId
async function findHotelMembership(hotelId: string, idOrUserId: string) {
  return await prisma.hotelMembership.findFirst({
    where: {
      hotelId,
      OR: [{ id: idOrUserId }, { userId: idOrUserId }],
    },
    include: {
      user: true,
    },
  });
}

// Edit a staff member's role, status, or department
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.STAFF_ADMIN);
  if (forbidden) return forbidden;

  const targetMembership = await findHotelMembership(tenant.hotelId, id);
  if (!targetMembership) {
    return NextResponse.json(
      { error: "Staff member not found in this hotel workspace." },
      { status: 404 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const isSelf = targetMembership.userId === tenant.userId;
  const requestedRole = body.role as HotelRole | undefined;
  const requestedActive = body.isActive as boolean | undefined;
  const requestedStatus = body.status as MembershipStatus | undefined;
  const requestedDepartment = body.department as string | undefined;

  // 1. Guard against self-lockout: cannot demote or deactivate yourself
  if (isSelf) {
    const demotingSelf = requestedRole !== undefined && requestedRole !== targetMembership.role;
    const deactivatingSelf = requestedActive === false || requestedStatus === MembershipStatus.SUSPENDED;

    if (demotingSelf || deactivatingSelf) {
      return NextResponse.json(
        { error: "You cannot change your own role, deactivate, or suspend your own account." },
        { status: 400 }
      );
    }
  }

  // 2. Validate role if supplied
  if (requestedRole !== undefined) {
    if (!PERMITTED_HOTEL_ROLES.includes(requestedRole)) {
      return NextResponse.json(
        { error: `Invalid role. Permitted hotel roles: ${PERMITTED_HOTEL_ROLES.join(", ")}` },
        { status: 400 }
      );
    }

    // Only a HOTEL_OWNER can promote someone to HOTEL_OWNER
    if (requestedRole === HotelRole.HOTEL_OWNER && tenant.role !== HotelRole.HOTEL_OWNER) {
      return NextResponse.json(
        { error: "Only hotel owners can grant the HOTEL_OWNER role." },
        { status: 403 }
      );
    }

    // Only a HOTEL_OWNER can modify an existing HOTEL_OWNER's role
    if (targetMembership.role === HotelRole.HOTEL_OWNER && tenant.role !== HotelRole.HOTEL_OWNER) {
      return NextResponse.json(
        { error: "Only hotel owners can modify another hotel owner's access." },
        { status: 403 }
      );
    }

    // Guard: Prevent demoting the last remaining active HOTEL_OWNER
    if (targetMembership.role === HotelRole.HOTEL_OWNER && requestedRole !== HotelRole.HOTEL_OWNER) {
      const remainingOwners = await prisma.hotelMembership.count({
        where: {
          hotelId: tenant.hotelId,
          role: HotelRole.HOTEL_OWNER,
          status: MembershipStatus.ACTIVE,
          id: { not: targetMembership.id },
        },
      });

      if (remainingOwners === 0) {
        return NextResponse.json(
          { error: "This is the last active hotel owner account. Promote another member to owner first." },
          { status: 400 }
        );
      }
    }
  }

  // 3. Guard: Prevent suspending or deactivating the last active owner/admin
  if (requestedActive === false || requestedStatus === MembershipStatus.SUSPENDED) {
    if (targetMembership.role === HotelRole.HOTEL_OWNER) {
      const remainingActiveOwners = await prisma.hotelMembership.count({
        where: {
          hotelId: tenant.hotelId,
          role: HotelRole.HOTEL_OWNER,
          status: MembershipStatus.ACTIVE,
          id: { not: targetMembership.id },
        },
      });

      if (remainingActiveOwners === 0) {
        return NextResponse.json(
          { error: "Cannot suspend or deactivate the only active hotel owner." },
          { status: 400 }
        );
      }
    }
  }

  // 4. Password Reset for staff member
  let passwordHash: string | undefined;
  if (body.newPassword !== undefined) {
    const problem = passwordProblem(body.newPassword);
    if (problem) {
      return NextResponse.json({ error: problem }, { status: 400 });
    }
    passwordHash = await bcrypt.hash(body.newPassword, 10);
  }

  // Execute update
  const effectiveStatus =
    requestedStatus !== undefined
      ? requestedStatus
      : requestedActive !== undefined
      ? requestedActive
        ? MembershipStatus.ACTIVE
        : MembershipStatus.SUSPENDED
      : undefined;

  // Quota enforcement: Reactivating an inactive/suspended staff member increases active staff count
  if (
    targetMembership.status !== MembershipStatus.ACTIVE &&
    effectiveStatus === MembershipStatus.ACTIVE
  ) {
    const { checkUsageLimit } = await import("@/lib/entitlements");
    const staffLimit = await checkUsageLimit(tenant.hotelId, "maxStaff", 1);
    if (!staffLimit.allowed) {
      return NextResponse.json(
        {
          error: staffLimit.code || "PLAN_LIMIT_EXCEEDED",
          message: staffLimit.reason,
        },
        { status: 403 }
      );
    }
  }

  const [updatedMembership] = await prisma.$transaction([
    prisma.hotelMembership.update({
      where: { id: targetMembership.id },
      data: {
        role: requestedRole ?? undefined,
        status: effectiveStatus,
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, department: true },
        },
      },
    }),
    ...(passwordHash !== undefined || requestedDepartment !== undefined
      ? [
          prisma.user.update({
            where: { id: targetMembership.userId },
            data: {
              passwordHash,
              department: requestedDepartment !== undefined ? requestedDepartment.trim() || null : undefined,
            },
          }),
        ]
      : []),
  ]);

  return NextResponse.json({
    id: updatedMembership.id,
    userId: updatedMembership.user.id,
    role: updatedMembership.role,
    status: updatedMembership.status,
    isActive: updatedMembership.status === MembershipStatus.ACTIVE,
    passwordReset: passwordHash !== undefined,
    message: "Staff member updated successfully.",
  });
}

// Remove or suspend staff membership in the active hotel
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.STAFF_ADMIN);
  if (forbidden) return forbidden;

  const targetMembership = await findHotelMembership(tenant.hotelId, id);
  if (!targetMembership) {
    return NextResponse.json(
      { error: "Staff member not found in this hotel workspace." },
      { status: 404 }
    );
  }

  // Guard: Cannot remove your own membership
  if (targetMembership.userId === tenant.userId) {
    return NextResponse.json(
      { error: "You cannot remove your own staff membership." },
      { status: 400 }
    );
  }

  // Guard: Non-owner cannot remove an owner
  if (targetMembership.role === HotelRole.HOTEL_OWNER && tenant.role !== HotelRole.HOTEL_OWNER) {
    return NextResponse.json(
      { error: "Only hotel owners can remove another hotel owner." },
      { status: 403 }
    );
  }

  // Guard: Cannot remove last owner
  if (targetMembership.role === HotelRole.HOTEL_OWNER) {
    const remainingOwners = await prisma.hotelMembership.count({
      where: {
        hotelId: tenant.hotelId,
        role: HotelRole.HOTEL_OWNER,
        status: MembershipStatus.ACTIVE,
        id: { not: targetMembership.id },
      },
    });

    if (remainingOwners === 0) {
      return NextResponse.json(
        { error: "Cannot remove the only remaining hotel owner." },
        { status: 400 }
      );
    }
  }

  // Check historical records in this hotel
  const [
    reservationsCount,
    paymentsCount,
    housekeepingCount,
    maintenanceCount,
  ] = await Promise.all([
    prisma.reservation.count({
      where: { hotelId: tenant.hotelId, createdById: targetMembership.userId },
    }),
    prisma.payment.count({
      where: { hotelId: tenant.hotelId, cashierId: targetMembership.userId },
    }),
    prisma.housekeepingTask.count({
      where: { hotelId: tenant.hotelId, assigneeId: targetMembership.userId },
    }),
    prisma.maintenanceTicket.count({
      where: { hotelId: tenant.hotelId, assigneeId: targetMembership.userId },
    }),
  ]);

  const hasHistoryInHotel =
    reservationsCount + paymentsCount + housekeepingCount + maintenanceCount > 0;

  if (hasHistoryInHotel) {
    // Suspend membership to preserve referential integrity of financial/audit records
    await prisma.hotelMembership.update({
      where: { id: targetMembership.id },
      data: { status: MembershipStatus.SUSPENDED },
    });

    return NextResponse.json({
      ok: true,
      mode: "suspended",
      name: targetMembership.user.name,
      message: `${targetMembership.user.name} has existing activity on record in this hotel. Membership was suspended instead of deleted to protect historical logs.`,
    });
  }

  // Clean delete if no transaction history exists in this hotel
  await prisma.hotelMembership.delete({
    where: { id: targetMembership.id },
  });

  return NextResponse.json({
    ok: true,
    mode: "deleted",
    name: targetMembership.user.name,
    message: `${targetMembership.user.name} was removed from this hotel workspace.`,
  });
}