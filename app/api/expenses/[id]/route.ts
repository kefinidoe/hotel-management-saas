import { validateFinancialMutation, expenseReviewSchema } from "@/lib/financial-mutation-validation";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";

// Approve or reject a pending expense within the active hotel only.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "EXPENSES");
  if (blocked) return blocked;

  const validation = await validateFinancialMutation(req, expenseReviewSchema, { id });
  if (validation.response) return validation.response;
  const body = validation.data;

  const status = (body as { status?: unknown } | null)?.status;
  if (status !== "APPROVED" && status !== "REJECTED") {
    return NextResponse.json({ error: "status must be APPROVED or REJECTED." }, { status: 400 });
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const result = await tx.expense.updateMany({
      where: { id, hotelId: tenant.hotelId, status: "PENDING_APPROVAL" },
      data: { status },
    });
    if (result.count === 0) {
      const expense = await tx.expense.findFirst({ where: { id, hotelId: tenant.hotelId }, select: { id: true, status: true } });
      return expense ? { status: 400, body: { error: "This expense has already been reviewed." } } : { status: 404, body: { error: "Expense not found." } };
    }
    const expense = await tx.expense.findFirst({ where: { id, hotelId: tenant.hotelId } });
    if (!expense) throw new Error("Updated expense could not be read.");
    await recordAudit({ hotelId: tenant.hotelId, userId: tenant.userId, action: "EXPENSE_REVIEWED", entity: "EXPENSE", entityId: id, metadata: { status } }, tx, { strict: true });
    return { status: 200, body: expense };
  });
  return NextResponse.json(outcome.body, { status: outcome.status });
}
