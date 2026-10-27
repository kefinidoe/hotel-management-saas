import { prisma } from "@/lib/prisma";
import ExpensesClient from "@/components/expenses/ExpensesClient";
import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function ExpensesPage() {
  // Expense listing is available to hotel staff, but always in a validated
  // tenant context before any Prisma query is made.
  const tenant = await requirePageRole(ROLE_GROUPS.ALL_STAFF, "EXPENSES");

  const expenses = await prisma.expense.findMany({
    where: { hotelId: tenant.hotelId },
    include: {
      requestedBy: {
        select: {
          name: true,
          memberships: {
            where: { hotelId: tenant.hotelId },
            select: { id: true },
            take: 1,
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const initialExpenses = expenses.map((e) => ({
    id: e.id,
    category: e.category,
    description: e.description,
    amount: Number(e.amount),
    paymentMethod: e.paymentMethod,
    supplier: e.supplier,
    reference: e.reference,
    status: e.status,
    // User is global identity data. Do not disclose its name unless it has a
    // membership in the active hotel.
    requestedByName: e.requestedBy.memberships.length > 0 ? e.requestedBy.name : "Former staff",
    createdAt: e.createdAt.toISOString(),
  }));

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const approvedThisMonth = initialExpenses
    .filter((e) => e.status === "APPROVED" && new Date(e.createdAt) >= startOfMonth)
    .reduce((s, e) => s + e.amount, 0);
  const pendingCount = initialExpenses.filter((e) => e.status === "PENDING_APPROVAL").length;

  return (
    <ExpensesClient
      initialExpenses={initialExpenses}
      approvedThisMonth={approvedThisMonth}
      pendingCount={pendingCount}
      currentUserRole={tenant.role}
    />
  );
}
