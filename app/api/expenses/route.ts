import { validateIdempotencyKey, validateFinancialMutation, expenseSchema, checkInventoryContext } from "@/lib/financial-mutation-validation";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { inventoryRequest } from "@/lib/inventory-idempotency";
import { parseMoney } from "@/lib/billing";
import { hasRole } from "@/lib/permissions";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";

export async function GET() {
  const tenant = await getTenantFromRoute("read");
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.ALL_STAFF);
  if (forbidden) return forbidden;
  const blocked = await requireModule(tenant.hotelId, "EXPENSES", "read");
  if (blocked) return blocked;

  const expenses = await prisma.expense.findMany({
    where: { hotelId: tenant.hotelId, ...(hasRole(tenant.role, ROLE_GROUPS.FINANCIAL_REPORTS) ? {} : { requestedById: tenant.userId }) },
    include: { requestedBy: { select: { name: true, memberships: { where: { hotelId: tenant.hotelId }, select: { id: true }, take: 1 } } } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  return NextResponse.json(
    expenses.map((e) => ({
      id: e.id,
      category: e.category,
      description: e.description,
      amount: Number(e.amount),
      paymentMethod: e.paymentMethod,
      supplier: e.supplier,
      reference: e.reference,
      status: e.status,
      requestedByName: e.requestedBy.memberships.length ? e.requestedBy.name : "Former staff",
      createdAt: e.createdAt,
    }))
  );
}

// Every expense starts as PENDING_APPROVAL, regardless of who submits it or
// what status they might try to pass in. Only an ADMIN/MANAGER approving it
// (see PATCH in [id]/route.ts) can move it to APPROVED or REJECTED -- an
// expense log nobody has to approve isn't really a control, it's a diary.
export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.ALL_STAFF);
  if (forbidden) return forbidden;
  const blocked = await requireModule(tenant.hotelId, "EXPENSES");
  if (blocked) return blocked;

  const contextMismatch = checkInventoryContext(req, tenant.hotelId, tenant.userId);
  if (contextMismatch) return contextMismatch;

  const validation = await validateFinancialMutation(req, expenseSchema, {});
  if (validation.response) return validation.response;
  const body = validation.data;
  const invalidKey = validateIdempotencyKey(req.headers.get("idempotency-key") || req.headers.get("x-idempotency-key"), "inventory");
  if (invalidKey) return invalidKey;

  const { category, description, amount, paymentMethod, supplier, reference } = body as {
    category: string;
    description: string;
    amount: number;
    paymentMethod: string;
    supplier?: string;
    reference?: string;
  };

  let validAmount: number;
  try { validAmount = parseMoney(amount, "Expense amount"); } catch { return NextResponse.json({ error: "Expense amount is invalid." }, { status: 400 }); }
  if (![category, description, paymentMethod].every((value) => typeof value === "string" && value.trim()) ||
      (supplier != null && typeof supplier !== "string") || (reference != null && typeof reference !== "string")) {
    return NextResponse.json(
      { error: "Category, description, amount, and payment method are required." },
      { status: 400 }
    );
  }

  return inventoryRequest(req, tenant.hotelId, tenant.userId, "EXPENSE_CREATE", body, async (tx) => {
  const expense = await tx.expense.create({
    data: {
      hotelId: tenant.hotelId,
      category,
      description,
      amount: validAmount,
      paymentMethod,
      supplier: supplier || null,
      reference: reference || null,
      status: "PENDING_APPROVAL",
      requestedById: tenant.userId,
    },
  });

  return { status: 201, body: expense };
  });
}