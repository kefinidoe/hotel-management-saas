import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";

/**
 * The hotel's own audit trail.
 *
 * `AuditLog` rows have been written since the membership and settings APIs were
 * built, and payment/checkout now write them too, but nothing could read them
 * back without a database console. This is the read side: newest first, scoped
 * to the active hotel, with the actor's name resolved from their current
 * membership in that hotel (a former employee's row still resolves through the
 * relation, which is why it is read from the log's own `userId`).
 *
 * Restricted to owner/admin: the trail names who changed what, which is a
 * management view rather than an operational one.
 */

export async function GET(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.STAFF_ADMIN);
  if (forbidden) return forbidden;

  const { searchParams } = new URL(req.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? 100) || 100, 200);
  const action = searchParams.get("action")?.trim();
  const entity = searchParams.get("entity")?.trim();

  const logs = await prisma.auditLog.findMany({
    where: {
      hotelId: tenant.hotelId,
      ...(action ? { action } : {}),
      ...(entity ? { entity } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: {
      user: { select: { name: true, email: true } },
    },
  });

  const actions = await prisma.auditLog.findMany({
    where: { hotelId: tenant.hotelId },
    distinct: ["action"],
    select: { action: true },
    orderBy: { action: "asc" },
  });

  return NextResponse.json({
    actions: actions.map((row) => row.action),
    logs: logs.map((log) => ({
      id: log.id,
      action: log.action,
      entity: log.entity,
      entityId: log.entityId,
      actorName: log.user?.name ?? "System",
      actorEmail: log.user?.email ?? null,
      metadata: log.metadata,
      ipAddress: log.ipAddress,
      createdAt: log.createdAt,
    })),
  });
}
