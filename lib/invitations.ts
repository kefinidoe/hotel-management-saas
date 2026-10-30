import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import type { HotelRole } from "@prisma/client";

/**
 * Membership invitations.
 *
 * Adding an *existing* account to a hotel is not the same thing as hiring
 * somebody: the account belongs to a person who may work elsewhere, and their
 * consent is what turns "a hotel recorded your email" into "you have access".
 *
 * Until that consent exists the membership is stored as SUSPENDED — the state
 * the rest of the application already treats as "no access" — and an
 * `STAFF_INVITATION_CREATED` audit row records who invited whom. The invitee
 * accepts or declines through /api/auth/invitations/:id, which flips the
 * membership to ACTIVE (with the plan's staff limit enforced at that moment) or
 * removes it. Nothing about the invitee's global account — name, credentials,
 * other memberships — is touched at any point.
 *
 * Suspension-for-removal is a different action (`STAFF_MEMBERSHIP_SUSPENDED`),
 * so a membership whose latest invitation event is a creation is unambiguously
 * pending rather than revoked.
 */

export const INVITATION_ACTIONS = {
  CREATED: "STAFF_INVITATION_CREATED",
  ACCEPTED: "STAFF_INVITATION_ACCEPTED",
  DECLINED: "STAFF_INVITATION_DECLINED",
  REVOKED: "STAFF_INVITATION_REVOKED",
} as const;

export interface InvitationAuditRow {
  entityId: string | null;
  action: string;
  createdAt: Date | string;
}

/**
 * Reduce audit rows to the latest invitation-relevant event per membership.
 * Pure, so the ordering rules can be tested without a database.
 */
export function latestEventsByMembership(rows: InvitationAuditRow[]): Map<string, string> {
  const latest = new Map<string, { action: string; at: number }>();
  for (const row of rows) {
    if (!row.entityId) continue;
    const at = new Date(row.createdAt).getTime();
    const current = latest.get(row.entityId);
    if (!current || at >= current.at) {
      latest.set(row.entityId, { action: row.action, at });
    }
  }
  return new Map([...latest.entries()].map(([id, value]) => [id, value.action]));
}

/** A membership is pending only while its newest invitation event is "created". */
export function isPendingInvitation(latestAction: string | undefined): boolean {
  return latestAction === INVITATION_ACTIONS.CREATED;
}

const INVITATION_AUDIT_ACTIONS = Object.values(INVITATION_ACTIONS);

async function latestActionsFor(membershipIds: string[]): Promise<Map<string, string>> {
  if (membershipIds.length === 0) return new Map();
  const rows = await prisma.auditLog.findMany({
    where: {
      entity: "HOTEL_MEMBERSHIP",
      entityId: { in: membershipIds },
      action: { in: INVITATION_AUDIT_ACTIONS },
    },
    select: { entityId: true, action: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return latestEventsByMembership(rows as InvitationAuditRow[]);
}

/** Invitations addressed to this user, newest first. */
export async function listPendingInvitations(userId: string) {
  const candidates = await prisma.hotelMembership.findMany({
    where: { userId, status: "SUSPENDED" },
    include: { hotel: { select: { id: true, name: true, slug: true, status: true } } },
    orderBy: { createdAt: "desc" },
  });
  if (candidates.length === 0) return [];

  const latest = await latestActionsFor(candidates.map((membership) => membership.id));
  return candidates
    .filter((membership) => isPendingInvitation(latest.get(membership.id)))
    .filter((membership) => ["ACTIVE", "TRIALING"].includes(membership.hotel.status))
    .map((membership) => ({
      id: membership.id,
      hotelId: membership.hotelId,
      hotelName: membership.hotel.name,
      hotelSlug: membership.hotel.slug,
      role: membership.role,
      invitedAt: membership.createdAt.toISOString(),
    }));
}

/**
 * The subset of the given memberships that are still unaccepted invitations.
 *
 * Display-only: a failure here must not break the staff list, because the
 * authoritative check is `isPendingInvitationFor`, which fails closed inside the
 * accept endpoint. Callers therefore get an empty set rather than an error.
 */
export async function pendingInvitationIds(membershipIds: string[]): Promise<Set<string>> {
  let latest: Map<string, string>;
  try {
    latest = await latestActionsFor(membershipIds);
  } catch (error) {
    console.error("Could not read invitation history for the staff list:", error);
    return new Set();
  }
  return new Set(
    [...latest.entries()]
      .filter(([, action]) => isPendingInvitation(action))
      .map(([id]) => id)
  );
}

/** True when this membership is an unaccepted invitation for this user. */
export async function isPendingInvitationFor(membershipId: string, userId: string) {
  const membership = await prisma.hotelMembership.findFirst({
    where: { id: membershipId, userId },
    select: { id: true, status: true },
  });
  if (!membership || membership.status !== "SUSPENDED") return false;
  const latest = await latestActionsFor([membership.id]);
  return isPendingInvitation(latest.get(membership.id));
}

export async function recordInvitationCreated(params: {
  hotelId: string;
  membershipId: string;
  invitedUserId: string;
  role: HotelRole;
  invitedByUserId: string;
  client?: unknown;
}) {
  return recordAudit(
    {
      hotelId: params.hotelId,
      userId: params.invitedByUserId,
      action: INVITATION_ACTIONS.CREATED,
      entity: "HOTEL_MEMBERSHIP",
      entityId: params.membershipId,
      metadata: {
        invitedUserId: params.invitedUserId,
        role: params.role,
        note: "Existing account added to a hotel; access starts only when the invitee accepts.",
      },
    },
    params.client
  );
}

export async function recordInvitationResolved(params: {
  hotelId: string;
  membershipId: string;
  userId: string;
  action: typeof INVITATION_ACTIONS.ACCEPTED | typeof INVITATION_ACTIONS.DECLINED;
  client?: unknown;
}) {
  return recordAudit(
    {
      hotelId: params.hotelId,
      userId: params.userId,
      action: params.action,
      entity: "HOTEL_MEMBERSHIP",
      entityId: params.membershipId,
      metadata: {},
    },
    params.client
  );
}
