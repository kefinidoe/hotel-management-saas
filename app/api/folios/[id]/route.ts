import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { folioTotals } from "@/lib/billing";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute("read");
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.ACCOMMODATION_PAYMENTS);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "FOLIOS", "read");
  if (blocked) return blocked;

  const hotelId = tenant.hotelId;

  const folio = await prisma.folio.findUnique({
    where: { id_hotelId: { id, hotelId } },
    include: {
      guest: true,
      items: { orderBy: { createdAt: "asc" } },
      payments: {
        where: { hotelId, status: "COMPLETED" },
        include: { paymentMethod: true },
        orderBy: { createdAt: "asc" },
      },
    },
  });
  if (!folio) return NextResponse.json({ error: "Folio not found." }, { status: 404 });

  const totals = folioTotals(
    folio.items.map((item) => Number(item.total)),
    folio.payments.map((payment) => Number(payment.amount))
  );

  return NextResponse.json({
    id: folio.id,
    guestName: folio.guest.fullName,
    isClosed: folio.isClosed,
    items: folio.items.map((item) => ({
      id: item.id,
      description: item.description,
      quantity: item.quantity,
      unitPrice: Number(item.unitPrice),
      total: Number(item.total),
    })),
    payments: folio.payments.map((payment) => ({
      id: payment.id,
      amount: Number(payment.amount),
      method: payment.paymentMethod.name,
      reference: payment.reference,
      createdAt: payment.createdAt.toISOString(),
    })),
    required: totals.required,
    total: totals.required,
    paid: totals.paid,
    balance: totals.balance,
  });
}
