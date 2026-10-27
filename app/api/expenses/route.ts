import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";

export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.ALL_STAFF);
  if (forbidden) return forbidden;
  const blocked = await requireModule(tenant.hotelId, "EXPENSES");
  if (blocked) return blocked;

  const expenses = await prisma.expense.findMany({
    where: { hotelId: tenant.hotelId },
    include: { requestedBy: true },
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
      requestedByName: e.requestedBy.name,
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

  const body = await req.json();
  const { category, description, amount, paymentMethod, supplier, reference } = body as {
    category: string;
    description: string;
    amount: number;
    paymentMethod: string;
    supplier?: string;
    reference?: string;
  };

  if (!category || !description || !amount || amount <= 0 || !paymentMethod) {
    return NextResponse.json(
      { error: "Category, description, amount, and payment method are required." },
      { status: 400 }
    );
  }

  const expense = await prisma.expense.create({
    data: {
      hotelId: tenant.hotelId,
      category,
      description,
      amount,
      paymentMethod,
      supplier: supplier || null,
      reference: reference || null,
      status: "PENDING_APPROVAL",
      requestedById: tenant.userId,
    },
  });

  return NextResponse.json(expense, { status: 201 });
}