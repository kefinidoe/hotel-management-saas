import { readMutationBody, validateMutation, staffUpdateSchema, emptySchema } from "@/lib/staff-settings-validation";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { INVITATION_ACTIONS, isPendingInvitationFor, recordInvitationCreated, recordInvitationResolved } from "@/lib/invitations";
import { HotelRole, MembershipStatus } from "@prisma/client";

export const dynamic = "force-dynamic";

// Find membership by ID or userId strictly within tenant.hotelId
async function findHotelMembership(hotelId: string, idOrUserId: string) {
  return await prisma.hotelMembership.findFirst({
    where: {
      hotelId,
      OR: [{ id: idOrUserId }, { userId: idOrUserId }],
    },
    include: {
      user: { select: { id: true, name: true, email: true } },
    },
  });
}

// Edit hotel-scoped membership attributes. Global account credentials and profile are not editable here.
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.STAFF_ADMIN);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  const targetMembership = await findHotelMembership(tenant.hotelId, id);
  if (!targetMembership) {
    return NextResponse.json(
      { error: "Staff member not found in this hotel workspace." },
      { status: 404 }
    );
  }

  const input = await readMutationBody(req);
  const body: any = input && typeof input === "object" && !Array.isArray(input) ? input : {};

  // A hotel administrator cannot change a global user's password. Password
  // changes remain account-holder controlled through /api/profile/password.
  if (Object.prototype.hasOwnProperty.call(body, "newPassword")) {
    return NextResponse.json(
      { error: "Staff passwords cannot be changed by a hotel administrator. The account holder must change their own password." },
      { status: 403 }
    );
  }

  // Suspended memberships without an invitation event are ambiguous legacy
  // records. Never infer consent: issue a fresh invitation in place instead.
  if (body.reinvite === true) {
    if (targetMembership.status !== MembershipStatus.SUSPENDED || targetMembership.userId === tenant.userId) return NextResponse.json({ error: "Only suspended staff can be invited." }, { status: 400 });
    if (targetMembership.role === HotelRole.HOTEL_OWNER && tenant.role !== HotelRole.HOTEL_OWNER) return NextResponse.json({ error: "Only hotel owners can invite another owner." }, { status: 403 });
    const validation = validateMutation(req, staffUpdateSchema, input, { id });
    if (validation.response) return validation.response;
    const invited = await prisma.$transaction(async (tx) => {
      const updated = await tx.hotelMembership.updateMany({
        where: { id: targetMembership.id, hotelId: tenant.hotelId, userId: targetMembership.userId, status: MembershipStatus.SUSPENDED, user: { isActive: true } },
        data: { status: MembershipStatus.SUSPENDED },
      });
      if (updated.count !== 1) return false;
      const current = await tx.hotelMembership.findUniqueOrThrow({ where: { id: targetMembership.id } });
      await recordInvitationCreated({ hotelId: tenant.hotelId, membershipId: current.id, invitedUserId: current.userId, role: current.role, invitedByUserId: tenant.userId, client: tx });
      return true;
    }, { isolationLevel: "Serializable" });
    if (!invited) return NextResponse.json({ error: "Membership is no longer eligible for invitation." }, { status: 409 });
    return NextResponse.json({ invitationPending: true, status: "SUSPENDED", message: "Invitation sent; the account holder must accept." });
  }

  const isSelf = targetMembership.userId === tenant.userId;
  const requestedRole = body.role as HotelRole | undefined;
  const requestedActive = body.isActive as boolean | undefined;
  const requestedStatus = body.status as MembershipStatus | undefined;
  let requestedDepartment: string | null | undefined;
  if (body.department !== undefined) {
    requestedDepartment = typeof body.department === "string" ? body.department.trim() || null : null;
  }

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

  const validation = validateMutation(req, staffUpdateSchema, input, { id });
  if (validation.response) return validation.response;

  // Execute membership-only update
  const effectiveStatus =
    requestedStatus !== undefined
      ? requestedStatus
      : requestedActive !== undefined
      ? requestedActive
        ? MembershipStatus.ACTIVE
        : MembershipStatus.SUSPENDED
      : undefined;

  const updateStaff = async (tx: any) => {
    if (effectiveStatus === MembershipStatus.ACTIVE) {
      const current = await tx.hotelMembership.findFirst({ where: { id: targetMembership.id, hotelId: tenant.hotelId } });
      if (!current || current.status !== MembershipStatus.ACTIVE) throw new Error("PENDING_INVITATION");
    }
    return tx.hotelMembership.update({
      where: { id: targetMembership.id },
      data: {
        role: requestedRole ?? undefined,
        status: effectiveStatus,
        department: requestedDepartment,
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
  };

  let updatedMembership: any;
  if (targetMembership.status !== MembershipStatus.ACTIVE && effectiveStatus === MembershipStatus.ACTIVE) {
    try {
      const { withUsageLimitLock } = await import("@/lib/entitlements");
      const quotaResult = await withUsageLimitLock(tenant.hotelId, "maxStaff", 1, updateStaff);
      if (!quotaResult.allowed) {
        return NextResponse.json(
          { error: quotaResult.limit.code || "PLAN_LIMIT_EXCEEDED", message: quotaResult.limit.reason },
          { status: quotaResult.limit.code === "SUBSCRIPTION_STATUS_UNAVAILABLE" || quotaResult.limit.code === "USAGE_LIMIT_UNAVAILABLE" ? 503 : 403 }
        );
      }
      updatedMembership = quotaResult.value;
    } catch (error: any) {
      if (error?.message === "PENDING_INVITATION") return NextResponse.json({ error: "Suspended memberships require an invitation accepted by the account holder." }, { status: 403 });
      if (error?.code === "SUBSCRIPTION_STATUS_UNAVAILABLE" || error?.code === "USAGE_LIMIT_UNAVAILABLE") {
        return NextResponse.json({ error: error.code, message: error.message }, { status: 503 });
      }
      throw error;
    }
  } else {
    try {
      updatedMembership = await prisma.$transaction((tx) => updateStaff(tx), { isolationLevel: "Serializable" });
    } catch (error: any) {
      if (error?.message === "PENDING_INVITATION") return NextResponse.json({ error: "Suspended memberships require an invitation accepted by the account holder." }, { status: 403 });
      throw error;
    }
  }

  await recordAudit({
    hotelId: tenant.hotelId,
    userId: tenant.userId,
    action: "STAFF_MEMBERSHIP_UPDATED",
    entity: "HOTEL_MEMBERSHIP",
    entityId: updatedMembership.id,
    metadata: {
      targetUserId: updatedMembership.user.id,
      previousRole: targetMembership.role,
      role: updatedMembership.role,
      previousStatus: targetMembership.status,
      status: updatedMembership.status,
      department: updatedMembership.department,
    },
  });

  return NextResponse.json({
    id: updatedMembership.id,
    userId: updatedMembership.user.id,
    role: updatedMembership.role,
    status: updatedMembership.status,
    department: updatedMembership.department,
    isActive: updatedMembership.status === MembershipStatus.ACTIVE,
    message: "Staff membership updated successfully.",
  });
}

// Remove or suspend staff membership in the active hotel
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.STAFF_ADMIN);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

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

  const validation = validateMutation(req, emptySchema, await readMutationBody(req, true), { id });
  if (validation.response) return validation.response;

  // Revoke an unaccepted invitation atomically. A pending membership itself
  // may represent a legacy membership with history, so retain it suspended.
  if (targetMembership.status === MembershipStatus.SUSPENDED &&
      await isPendingInvitationFor(targetMembership.id, targetMembership.userId, prisma, false)) {
    const revoked = await prisma.$transaction(async (tx) => {
      if (!(await isPendingInvitationFor(targetMembership.id, targetMembership.userId, tx, false))) return false;
      const updated = await tx.hotelMembership.updateMany({
        where: { id: targetMembership.id, hotelId: tenant.hotelId, userId: targetMembership.userId, status: MembershipStatus.SUSPENDED },
        data: { status: MembershipStatus.SUSPENDED },
      });
      if (updated.count !== 1) return false;
      await recordInvitationResolved({ hotelId: tenant.hotelId, membershipId: targetMembership.id,
        userId: tenant.userId, action: INVITATION_ACTIONS.REVOKED, client: tx });
      return true;
    }, { isolationLevel: "Serializable" });
    if (!revoked) return NextResponse.json({ error: "Invitation is no longer pending." }, { status: 409 });
    return NextResponse.json({ ok: true, mode: "suspended", name: targetMembership.user.name, message: "Invitation revoked." });
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

    await recordAudit({
      hotelId: tenant.hotelId,
      userId: tenant.userId,
      action: "STAFF_MEMBERSHIP_SUSPENDED",
      entity: "HOTEL_MEMBERSHIP",
      entityId: targetMembership.id,
      metadata: {
        targetUserId: targetMembership.userId,
        role: targetMembership.role,
        reason: "Existing activity in this hotel",
      },
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

  await recordAudit({
    hotelId: tenant.hotelId,
    userId: tenant.userId,
    action: "STAFF_MEMBERSHIP_REMOVED",
    entity: "HOTEL_MEMBERSHIP",
    entityId: targetMembership.id,
    metadata: {
      targetUserId: targetMembership.userId,
      role: targetMembership.role,
    },
  });

  return NextResponse.json({
    ok: true,
    mode: "deleted",
    name: targetMembership.user.name,
    message: `${targetMembership.user.name} was removed from this hotel workspace.`,
  });
}