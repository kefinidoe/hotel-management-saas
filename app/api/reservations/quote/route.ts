import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { hasRole } from "@/lib/permissions";
import { loadPricingConfig } from "@/lib/pricing/config";
import { priceStay } from "@/lib/pricing/engine";

/**
 * Live price quote for the reservation form.
 *
 * The form never computes a price itself: it sends the current selection here and
 * renders the breakdown the server returns. The same engine runs again on
 * `POST /api/reservations`, so what the receptionist sees is what gets stored.
 */
export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.GUEST_STAYS);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const roomId = text(body.roomId);
  if (!roomId) {
    return NextResponse.json({ error: "Choose a room to price the stay." }, { status: 400 });
  }

  const checkIn = new Date(String(body.checkInDate ?? ""));
  const checkOut = new Date(String(body.checkOutDate ?? ""));
  if (!Number.isFinite(checkIn.getTime()) || !Number.isFinite(checkOut.getTime())) {
    return NextResponse.json({ error: "Choose valid check-in and check-out dates." }, { status: 400 });
  }

  const discount = Number(body.discount ?? 0);
  const discountPercent =
    body.discountPercent === undefined || body.discountPercent === null || body.discountPercent === ""
      ? undefined
      : Number(body.discountPercent);
  const wantsDiscount = (Number.isFinite(discount) && discount > 0) || (discountPercent ?? 0) > 0;
  if (wantsDiscount && !hasRole(tenant.role, ROLE_GROUPS.MANAGEMENT)) {
    return NextResponse.json(
      { error: "Only an Admin or Manager can apply an accommodation discount." },
      { status: 403 }
    );
  }

  // The room is resolved through the tenant, so a room id from another hotel is
  // indistinguishable from one that does not exist.
  const room = await prisma.room.findUnique({
    where: { id_hotelId: { id: roomId, hotelId: tenant.hotelId } },
    select: { id: true, number: true, roomTypeId: true, isActive: true },
  });
  if (!room || !room.isActive) {
    return NextResponse.json({ error: "Room not found in this hotel." }, { status: 404 });
  }

  const config = await loadPricingConfig(tenant.hotelId, tenant.hotel.currency);

  // The options this room is actually sold as, with the hotel's own names.
  const occupancyOptions = config.occupancies
    .filter((option) => option.isActive)
    .map((option) => {
      const rate = config.roomTypeOccupancies.find(
        (row) => row.roomTypeId === room.roomTypeId && row.occupancyTypeId === option.id && row.isActive
      );
      return rate
        ? {
            id: option.id,
            name: option.name,
            minAdults: option.minAdults,
            maxAdults: option.maxAdults,
            maxChildren: option.maxChildren,
            nightlyRate: rate.nightlyRate,
          }
        : null;
    })
    .filter((option): option is NonNullable<typeof option> => option !== null);

  // The form opens before the receptionist has chosen an occupancy. Failing that
  // first quote would leave the picker empty, so pick the least expensive option
  // that fits the party (or the roomiest one, so an oversized party gets a
  // capacity message). The choice is only a default — the reservation itself
  // still has to name its occupancy.
  let occupancyTypeId = text(body.occupancyTypeId) || null;
  if (
    !occupancyTypeId &&
    config.settings.pricingModel === "ROOM_TYPE_OCCUPANCY" &&
    occupancyOptions.length > 0
  ) {
    const adults = Number(body.adults ?? 1) || 1;
    const children = Number(body.children ?? 0) || 0;
    const roomy = [...occupancyOptions].sort(
      (left, right) => right.maxAdults - left.maxAdults || right.maxChildren - left.maxChildren
    );
    const fits = roomy
      .filter(
        (option) =>
          adults >= option.minAdults && adults <= option.maxAdults && children <= option.maxChildren
      )
      .sort((left, right) => left.maxAdults - right.maxAdults || left.nightlyRate - right.nightlyRate);
    occupancyTypeId = (fits[0] ?? roomy[0]).id;
  }

  const priced = priceStay(config, {
    roomTypeId: room.roomTypeId,
    occupancyTypeId,
    mealPlanId: text(body.mealPlanId) || null,
    checkIn,
    checkOut,
    adults: Number(body.adults ?? 1),
    children: Number(body.children ?? 0),
    childAges: Array.isArray(body.childAges)
      ? (body.childAges as unknown[]).map((age) => Number(age)).filter((age) => Number.isFinite(age))
      : undefined,
    extraBeds: Number(body.extraBeds ?? 0),
    discount: Number.isFinite(discount) && discount > 0 ? discount : undefined,
    discountPercent,
  });

  if (!priced.ok) {
    return NextResponse.json(
      { error: priced.message, code: priced.code },
      { status: 400 }
    );
  }

  return NextResponse.json({
    ...priced,
    roomId: room.id,
    roomNumber: room.number,
    // The room type's configured options, so the picker only offers what this
    // room is actually sold as.
    availableOccupancies: occupancyOptions,
    availableMealPlans: config.mealPlans
      .filter(
        (plan) =>
          plan.isActive &&
          (plan.roomTypeIds.length === 0 || plan.roomTypeIds.includes(room.roomTypeId))
      )
      .map((plan) => ({ id: plan.id, name: plan.name, pricingBasis: plan.pricingBasis, charge: plan.charge })),
  });
}
