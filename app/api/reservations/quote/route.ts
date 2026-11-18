import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { hasRole } from "@/lib/permissions";
import { loadPricingConfig } from "@/lib/pricing/config";
import { priceStay } from "@/lib/pricing/engine";
import { pricingUnavailableResponse } from "@/lib/pricing/http";
import { z } from "zod";
import { priceCustomReservation, CustomPricingError } from "@/lib/pricing/custom-server";
import { priceModularStay } from "@/lib/pricing/modular";
import { UNIVERSAL_MEAL_PLANS, type UniversalMealPlan } from "@/lib/pricing";

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

  if (tenant.hotel.useCustomRateRules) {
    const query = z.strictObject({}).safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!query.success) return NextResponse.json({ error: "Invalid request.", issues: query.error.issues }, { status: 400 });
    const valid = z.object({ occupancyTypeId: z.string().trim().min(1).max(200), mealPlanId: z.string().trim().min(1).max(200), adults: z.number().int().min(1).max(100), children: z.number().int().min(0).max(100) }).safeParse(body);
    if (!valid.success) return NextResponse.json({ error: "Invalid pricing selection.", issues: valid.error.issues }, { status: 400 });
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

  if (tenant.hotel.useCustomRateRules === true) {
    if (discountPercent !== undefined || Number(body.extraBeds ?? 0) !== 0) return NextResponse.json({ error: "Percentage discounts and extra beds are not supported by dynamic pricing." }, { status: 400 });
    try {
      const result = await prisma.$transaction(async (tx) => {
        const lockKey = `hotel-${tenant.hotelId}-reservation-create`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        const hotel = await tx.hotel.findUnique({ where: { id: tenant.hotelId }, select: { useCustomRateRules: true, currency: true } });
        if (!hotel?.useCustomRateRules) throw new CustomPricingError("Pricing mode changed. Please retry.");
        const currentRoom = await tx.room.findUnique({ where: { id_hotelId: { id: room.id, hotelId: tenant.hotelId } }, select: { roomTypeId: true, isActive: true } });
        if (!currentRoom?.isActive) throw new CustomPricingError("Room is no longer available.");
        return priceCustomReservation(tx, { hotelId: tenant.hotelId, currency: hotel.currency, roomTypeId: currentRoom.roomTypeId, mealId: String(body.mealPlanId), occupancyId: String(body.occupancyTypeId), adults: Number(body.adults), children: Number(body.children), checkIn, checkOut, discount });
      });
      return NextResponse.json({ ...result, roomId: room.id, roomNumber: room.number, availableOccupancies: [], availableMealPlans: [] });
    } catch (error) {
      if (error instanceof CustomPricingError) return NextResponse.json({ error: error.message }, { status: 400 });
      console.error("Dynamic pricing quote failed", error);
      return NextResponse.json({ error: "Could not price this stay." }, { status: 500 });
    }
  }

  if (tenant.hotel.useModularPricing === true) {
    const mealPlan = typeof body.mealPlanCode === "string" ? body.mealPlanCode : "";
    if (!UNIVERSAL_MEAL_PLANS.includes(mealPlan as UniversalMealPlan)) {
      return NextResponse.json({ error: "Invalid meal plan." }, { status: 400 });
    }
    if (discountPercent !== undefined || Number(body.extraBeds ?? 0) !== 0) {
      return NextResponse.json({ error: "Percentage discounts and extra beds are not supported by modular pricing." }, { status: 400 });
    }
    try {
      const result = await prisma.$transaction(async (tx) => {
        const lockKey = `hotel-${tenant.hotelId}-reservation-create`;
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        const hotel = await tx.hotel.findUnique({ where: { id: tenant.hotelId }, select: { useModularPricing: true, useCustomRateRules: true, currency: true } });
        if (!hotel?.useModularPricing || hotel.useCustomRateRules) throw new Error("Pricing mode changed. Please retry.");
        const type = await tx.roomType.findUnique({ where: { id_hotelId: { id: room.roomTypeId, hotelId: tenant.hotelId } }, select: { id: true, name: true, baseRate: true, extraAdultFee: true, maxAdults: true, maxChildren: true } });
        if (!type) throw new Error("Room type not found.");
        const rows = await tx.hotelMealPricing.findMany({ where: { hotelId: tenant.hotelId } });
        return priceModularStay({
          currency: hotel.currency,
          roomType: { ...type, baseRate: String(type.baseRate), extraAdultFee: String(type.extraAdultFee) },
          mealPlan: mealPlan as UniversalMealPlan,
          mealRates: rows.map((row) => ({ ...row, adultSurcharge: String(row.adultSurcharge), childSurcharge: String(row.childSurcharge) })),
          checkIn, checkOut, adults: Number(body.adults ?? 1), children: Number(body.children ?? 0), discount,
        });
      });
      return NextResponse.json({ ...result, roomId: room.id, roomNumber: room.number, availableOccupancies: [], availableMealPlans: [] });
    } catch (error) {
      // Pricing validation failures are safe to expose; unexpected persistence
      // errors must not leak database diagnostics to the client.
      if (error instanceof Error && /^(Guest counts|Invalid |Meal plan is inactive|Meal plan pricing is not configured|Discount |The reservation|Check-in|The stay|Base rate|Extra adult fee|Adult meal surcharge|Child meal surcharge|Nightly rate|Pricing mode changed|Room type not found)/.test(error.message)) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
      console.error("Modular quote failed", error);
      return NextResponse.json({ error: "Could not price this stay." }, { status: 500 });
    }
  }

  // A quote that cannot read the hotel's configuration must not fall back to the
  // room type's base rate: the receptionist would read out a price that the
  // engine will refuse (or charge differently) at booking time.
  let config: Awaited<ReturnType<typeof loadPricingConfig>>;
  try {
    config = await loadPricingConfig(tenant.hotelId, tenant.hotel.currency);
  } catch (error) {
    const unavailable = pricingUnavailableResponse(error, "POST /api/reservations/quote");
    if (unavailable) return unavailable;
    throw error;
  }

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
