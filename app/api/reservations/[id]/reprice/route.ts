import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { roundMoney } from "@/lib/billing";
import { loadPricingConfig } from "@/lib/pricing/config";
import { priceStay } from "@/lib/pricing/engine";

/**
 * Explicit repricing of an existing reservation.
 *
 * Existing reservations never follow later configuration changes on their own:
 * the agreed price is frozen in `ReservationPriceSnapshot`. This endpoint is the
 * only way to replace it, and it records who did it, from what to what, and why.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;
  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  const hotelId = tenant.hotelId;
  const { id } = await params;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  const reservation = await prisma.reservation.findUnique({
    where: { id_hotelId: { id, hotelId } },
    include: {
      rooms: { include: { room: true } },
      priceSnapshot: true,
    },
  });
  if (!reservation) {
    return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
  }
  if (reservation.status !== "PENDING" && reservation.status !== "CONFIRMED") {
    return NextResponse.json(
      { error: "Only a pending or confirmed reservation can be repriced." },
      { status: 400 }
    );
  }
  if (reservation.rooms.length !== 1) {
    return NextResponse.json(
      { error: "Repricing is supported for single-room reservations." },
      { status: 400 }
    );
  }

  const room = reservation.rooms[0].room;
  const config = await loadPricingConfig(hotelId, tenant.hotel.currency);
  const previousTotal = reservation.priceSnapshot
    ? Number(reservation.priceSnapshot.grandTotal)
    : null;

  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const occupancyTypeId =
    text(body.occupancyTypeId) ||
    config.occupancies.find((option) => option.name === reservation.priceSnapshot?.occupancyName)?.id ||
    null;
  const mealPlanId =
    text(body.mealPlanId) ||
    config.mealPlans.find((plan) => plan.name === reservation.priceSnapshot?.mealPlanName)?.id ||
    null;

  const discount = Number(body.discount ?? reservation.discount ?? 0);
  const discountPercent =
    body.discountPercent === undefined || body.discountPercent === null || body.discountPercent === ""
      ? undefined
      : Number(body.discountPercent);

  const priced = priceStay(config, {
    roomTypeId: room.roomTypeId,
    occupancyTypeId,
    mealPlanId,
    checkIn: reservation.checkInDate,
    checkOut: reservation.checkOutDate,
    adults: body.adults === undefined ? reservation.adults : Number(body.adults),
    children: body.children === undefined ? reservation.children : Number(body.children),
    childAges: Array.isArray(body.childAges)
      ? (body.childAges as unknown[]).map((age) => Number(age)).filter((age) => Number.isFinite(age))
      : undefined,
    extraBeds: Number(body.extraBeds ?? 0),
    discount: Number.isFinite(discount) && discount > 0 ? discount : undefined,
    discountPercent,
  });

  if (!priced.ok) {
    return NextResponse.json({ error: priced.message, code: priced.code }, { status: 400 });
  }

  const nightlyRate = roundMoney((priced.totals.room + priced.totals.adjustments) / priced.nights);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : null;

  const updated = await prisma.$transaction(async (tx) => {
    await tx.reservationRoom.update({
      where: { id: reservation.rooms[0].id },
      data: { rate: nightlyRate },
    });
    await tx.reservation.update({
      where: { id_hotelId: { id, hotelId } },
      data: { discount: priced.totals.discount || null },
    });
    const snapshot = await tx.reservationPriceSnapshot.upsert({
      where: { reservationId: id },
      update: {
        pricingModel: priced.pricingModel,
        currency: priced.currency,
        occupancyName: priced.occupancyName,
        mealPlanName: priced.mealPlanName,
        mealPlanBasis: priced.mealPlanBasis,
        nightlyRate: priced.nightlyRate,
        nights: priced.nights,
        adults: priced.adults,
        children: priced.children,
        extraBeds: priced.extraBeds,
        roomTotal: priced.totals.room,
        mealsTotal: priced.totals.meals,
        extrasTotal: priced.totals.extras,
        adjustmentsTotal: priced.totals.adjustments,
        discountTotal: priced.totals.discount,
        taxTotal: priced.totals.tax,
        grandTotal: priced.totals.grandTotal,
        breakdown: priced as unknown as Prisma.InputJsonValue,
        createdById: tenant.userId,
      },
      create: {
        hotelId,
        reservationId: id,
        pricingModel: priced.pricingModel,
        currency: priced.currency,
        occupancyName: priced.occupancyName,
        mealPlanName: priced.mealPlanName,
        mealPlanBasis: priced.mealPlanBasis,
        nightlyRate: priced.nightlyRate,
        nights: priced.nights,
        adults: priced.adults,
        children: priced.children,
        extraBeds: priced.extraBeds,
        roomTotal: priced.totals.room,
        mealsTotal: priced.totals.meals,
        extrasTotal: priced.totals.extras,
        adjustmentsTotal: priced.totals.adjustments,
        discountTotal: priced.totals.discount,
        taxTotal: priced.totals.tax,
        grandTotal: priced.totals.grandTotal,
        breakdown: priced as unknown as Prisma.InputJsonValue,
        createdById: tenant.userId,
      },
    });
    await tx.reservationPriceChange.create({
      data: {
        hotelId,
        reservationId: id,
        previousTotal: previousTotal ?? priced.totals.grandTotal,
        newTotal: priced.totals.grandTotal,
        reason,
        breakdown: priced as unknown as Prisma.InputJsonValue,
        changedById: tenant.userId,
      },
    });
    return snapshot;
  });

  await recordAudit({
    hotelId,
    userId: tenant.userId,
    action: "RESERVATION_REPRICED",
    entity: "Reservation",
    entityId: id,
    metadata: { previousTotal, newTotal: priced.totals.grandTotal, reason },
  });

  return NextResponse.json({
    ok: true,
    reservationId: id,
    previousTotal,
    total: Number(updated.grandTotal),
    breakdown: priced,
  });
}
