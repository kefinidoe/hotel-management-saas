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
 * leaves it suspended. Nothing about the invitee's global account — name, credentials,
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
function latestInvitationRows(rows: InvitationAuditRow[]): Map<string, InvitationAuditRow> {
  const latest = new Map<string, InvitationAuditRow>();
  for (const row of rows) {
    if (!row.entityId) continue;
    const current = latest.get(row.entityId);
    const at = new Date(row.createdAt).getTime();
    const currentAt = current ? new Date(current.createdAt).getTime() : -Infinity;
    // Equal timestamps are ambiguous: prefer a terminal state, so a decline or
    // revocation cannot be replayed when the database timestamp ties.
    if (!current || at > currentAt || (at === currentAt && row.action !== INVITATION_ACTIONS.CREATED)) latest.set(row.entityId, row);
  }
  return latest;
}

export function latestEventsByMembership(rows: InvitationAuditRow[]): Map<string, string> {
  return new Map([...latestInvitationRows(rows)].map(([id, row]) => [id, row.action]));
}

/** A membership is pending only while its newest invitation event is "created". */
export function isPendingInvitation(latestAction: string | undefined): boolean {
  return latestAction === INVITATION_ACTIONS.CREATED;
}

const INVITATION_AUDIT_ACTIONS = Object.values(INVITATION_ACTIONS);

async function latestRowsFor(membershipIds: string[], client: any = prisma): Promise<Map<string, InvitationAuditRow>> {
  if (membershipIds.length === 0) return new Map();
  const rows = await client.auditLog.findMany({
    where: {
      entity: "HOTEL_MEMBERSHIP",
      entityId: { in: membershipIds },
      action: { in: INVITATION_AUDIT_ACTIONS },
    },
    select: { entityId: true, action: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  return latestInvitationRows(rows as InvitationAuditRow[]);
}

/** Invitations addressed to this user, newest first. */
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function invitationNotExpired(createdAt: Date, now = Date.now()) {
  const created = new Date(createdAt).getTime();
  return Number.isFinite(created) && created <= now && now - created < INVITATION_TTL_MS;
}

export async function listPendingInvitations(userId: string) {
  const candidates = await prisma.hotelMembership.findMany({
    where: { userId, status: "SUSPENDED" },
    include: { hotel: { select: { id: true, name: true, slug: true, status: true } } },
    orderBy: { createdAt: "desc" },
  });
  if (candidates.length === 0) return [];

  const latest = await latestRowsFor(candidates.map((membership) => membership.id));
  return candidates
    .filter((membership) => isPendingInvitation(latest.get(membership.id)?.action) && invitationNotExpired(new Date(latest.get(membership.id)!.createdAt)))
    .filter((membership) => ["ACTIVE", "TRIALING"].includes(membership.hotel.status))
    .map((membership) => ({
      id: membership.id,
      hotelId: membership.hotelId,
      hotelName: membership.hotel.name,
      hotelSlug: membership.hotel.slug,
      role: membership.role,
      invitedAt: new Date(latest.get(membership.id)!.createdAt).toISOString(),
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
  let latest: Map<string, InvitationAuditRow>;
  try {
    latest = await latestRowsFor(membershipIds);
  } catch (error) {
    console.error("Could not read invitation history for the staff list:", error);
    return new Set();
  }
  return new Set(
    [...latest.entries()]
      .filter(([, row]) => isPendingInvitation(row.action))
      .map(([id]) => id)
  );
}

/** True when this membership is an unaccepted invitation for this user. */
export async function isPendingInvitationFor(membershipId: string, userId: string, client: any = prisma, checkExpiry = true) {
  const membership = await client.hotelMembership.findFirst({
    where: { id: membershipId, userId },
    select: { id: true, status: true, createdAt: true },
  });
  if (!membership || membership.status !== "SUSPENDED") return false;
  const latest = await latestRowsFor([membership.id], client);
  const event = latest.get(membership.id);
  return !!event && isPendingInvitation(event.action) && (!checkExpiry || invitationNotExpired(new Date(event.createdAt)));
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
    params.client,
    { strict: true }
  );
}

export async function recordInvitationResolved(params: {
  hotelId: string;
  membershipId: string;
  userId: string;
  action: typeof INVITATION_ACTIONS.ACCEPTED | typeof INVITATION_ACTIONS.DECLINED | typeof INVITATION_ACTIONS.REVOKED;
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
    params.client,
    { strict: true }
  );
}
