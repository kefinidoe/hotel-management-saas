import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const status = (body as { status?: unknown } | null)?.status;
  if (status !== "APPROVED" && status !== "REJECTED") {
    return NextResponse.json({ error: "status must be APPROVED or REJECTED." }, { status: 400 });
  }

  const result = await prisma.expense.updateMany({
    where: { id, hotelId: tenant.hotelId, status: "PENDING_APPROVAL" },
    data: { status },
  });

  if (result.count === 0) {
    // This scoped lookup intentionally makes another hotel's expense indistinguishable
    // from a nonexistent ID.
    const expense = await prisma.expense.findFirst({
      where: { id, hotelId: tenant.hotelId },
      select: { id: true, status: true },
    });
    if (!expense) return NextResponse.json({ error: "Expense not found." }, { status: 404 });
    return NextResponse.json({ error: "This expense has already been reviewed." }, { status: 400 });
  }

  const expense = await prisma.expense.findFirst({ where: { id, hotelId: tenant.hotelId } });
  if (!expense) return NextResponse.json({ error: "Expense not found." }, { status: 404 });
  return NextResponse.json(expense);
}
