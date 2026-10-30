import { prisma } from "@/lib/prisma";

/**
 * Hotel-scoped audit trail.
 *
 * Privileged mutations (staff membership, hotel settings, subscription state)
 * are recorded in `AuditLog` so that an operator can answer "who changed this,
 * when, and from what?" without replaying application logs.
 *
 * Writing an audit row must never be the reason a legitimate operation fails,
 * but it also must never be silent: a failed write is logged to the server
 * console with the action name. Callers that need the audit row and the
 * mutation to be atomic pass the transaction client as `client`.
 */

export interface AuditEvent {
  hotelId: string | null;
  userId: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: Record<string, unknown> | null;
  ipAddress?: string | null;
}

type AuditCapableClient = {
  auditLog?: {
    create?: (args: { data: Record<string, unknown> }) => Promise<unknown>;
  };
};

export async function recordAudit(
  event: AuditEvent,
  client?: unknown
): Promise<boolean> {
  const target = (client ?? prisma) as AuditCapableClient | undefined;
  const writer = target?.auditLog;
  // Test doubles and pre-AuditLog schemas have no audit model. Skipping there is
  // intentional; a real Prisma client always exposes it.
  if (typeof writer?.create !== "function") return false;

  try {
    await writer.create({
      data: {
        hotelId: event.hotelId,
        userId: event.userId,
        action: event.action,
        entity: event.entity,
        entityId: event.entityId ?? null,
        metadata: (event.metadata ?? undefined) as never,
        ipAddress: event.ipAddress ?? null,
      },
    });
    return true;
  } catch (error) {
    console.error(`Failed to write audit log entry (${event.action}):`, error);
    return false;
  }
}
