import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { folioTotals } from "@/lib/billing";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.GUEST_STAYS);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  const guest = await prisma.guest.findUnique({
    where: { id_hotelId: { id, hotelId } },
    include: {
      reservations: {
        where: { hotelId },
        orderBy: { checkInDate: "desc" },
        include: { rooms: { include: { room: true } } },
      },
      folios: {
        where: { hotelId },
        orderBy: { createdAt: "desc" },
        include: {
          items: true,
          payments: { where: { status: "COMPLETED", hotelId } },
        },
      },
    },
  });

  if (!guest) return NextResponse.json({ error: "Guest not found." }, { status: 404 });

  return NextResponse.json({
    id: guest.id,
    fullName: guest.fullName,
    phone: guest.phone,
    email: guest.email,
    idNumber: guest.idNumber,
    nationality: guest.nationality,
    vehicleRegistration: guest.vehicleRegistration,
    notes: guest.notes,
    isArchived: guest.isArchived,
    reservations: guest.reservations.map((r) => ({
      id: r.id,
      code: r.code,
      status: r.status,
      checkInDate: r.checkInDate.toISOString(),
      checkOutDate: r.checkOutDate.toISOString(),
      rooms: r.rooms.map((rr) => ({ roomNumber: rr.room.number, rate: Number(rr.rate) })),
    })),
    folios: guest.folios.map((folio) => {
      const totals = folioTotals(
        folio.items.map((item) => Number(item.total)),
        folio.payments.map((payment) => Number(payment.amount))
      );
      return {
        id: folio.id,
        isClosed: folio.isClosed,
        total: totals.required,
        paid: totals.paid,
        balance: totals.balance,
      };
    }),
  });
}

// Archive or restore a guest. This NEVER deletes anything — it only flips a
// flag that hides the guest from the default list. Their reservations,
// folios, and payments are untouched either way, forever.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.GUEST_STAYS);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  const body = await req.json();
  if (typeof body.isArchived !== "boolean") {
    return NextResponse.json({ error: "isArchived (true or false) is required." }, { status: 400 });
  }

  // Guard: don't allow archiving a guest who is currently checked in within this hotel.
  if (body.isArchived) {
    const activeStay = await prisma.reservation.findFirst({
      where: { hotelId, guestId: id, status: "CHECKED_IN" },
    });
    if (activeStay) {
      return NextResponse.json(
        { error: "This guest is currently checked in and can't be archived." },
        { status: 400 }
      );
    }
  }

  const existingGuest = await prisma.guest.findUnique({
    where: { id_hotelId: { id, hotelId } },
  });
  if (!existingGuest) {
    return NextResponse.json({ error: "Guest not found." }, { status: 404 });
  }

  const guest = await prisma.guest.update({
    where: { id_hotelId: { id, hotelId } },
    data: { isArchived: body.isArchived },
  });

  return NextResponse.json({ id: guest.id, isArchived: guest.isArchived });
}