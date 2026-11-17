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
 * mutation to be atomic pass the transaction client as `client` and
 * `{ strict: true }`: the write then joins the same transaction and its failure
 * rolls the mutation back instead of leaving a change nobody can account for.
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

/**
 * Raised when an operation that *requires* an audit record could not write one.
 * Callers inside a transaction let this propagate so the whole change rolls back.
 */
export class AuditPersistenceError extends Error {
  constructor(readonly action: string, cause?: unknown) {
    super(`The audit record for ${action} could not be written.`);
    this.name = "AuditPersistenceError";
    this.cause = cause;
  }
}

export async function recordAudit(
  event: AuditEvent,
  client?: unknown,
  options: { strict?: boolean } = {}
): Promise<boolean> {
  const target = (client ?? prisma) as AuditCapableClient | undefined;
  const writer = target?.auditLog;
  // Test doubles and pre-AuditLog schemas have no audit model. Skipping is only
  // acceptable for operations where the audit row is a nice-to-have; financial
  // mutations pass `strict` so a missing writer rolls the change back.
  if (typeof writer?.create !== "function") {
    if (options.strict) throw new AuditPersistenceError(event.action);
    return false;
  }

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
    if (options.strict) throw new AuditPersistenceError(event.action, error);
    return false;
  }
}
