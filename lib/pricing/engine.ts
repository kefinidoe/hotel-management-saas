import Decimal from "decimal.js";
import { roundMoneyDecimal } from "@/lib/billing";
import type {
  HotelPricingConfig,
  NightPrice,
  PriceFailure,
  PriceLine,
  PriceRequest,
  PriceResult,
  RateAdjustmentConfig,
  TaxRuleConfig,
} from "./types";

/**
 * Server-side pricing engine.
 *
 * One pure function decides what a stay costs: room rate for the chosen
 * occupancy, seasonal/weekend adjustments per night, meal plan by its configured
 * basis, extra beds, child rules, discount and taxes. It reads only configuration
 * belonging to the hotel it is given, so a request can never reach another
 * hotel's prices, and it never accepts a total from the caller.
 */

const DAY_MS = 86_400_000;

function fail(code: PriceFailure["code"], message: string): PriceFailure {
  return { ok: false, code, message };
}

function nightsBetween(checkIn: Date, checkOut: Date): number | null {
  const start = checkIn.getTime();
  const end = checkOut.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const nights = (end - start) / DAY_MS;
  if (!Number.isInteger(nights) || nights < 1) return null;
  return nights;
}

function utcDay(date: Date): string {
  return new Date(date).toISOString().slice(0, 10);
}

function dayKey(date: Date): number {
  return new Date(date).getUTCDay();
}

function isWithinRange(date: Date, start: Date | null, end: Date | null): boolean {
  const day = utcDay(date);
  if (start && day < utcDay(start)) return false;
  if (end && day > utcDay(end)) return false;
  return true;
}

function adjustmentApplies(adjustment: RateAdjustmentConfig, date: Date, roomTypeId: string): boolean {
  if (!adjustment.isActive) return false;
  if (adjustment.roomTypeId && adjustment.roomTypeId !== roomTypeId) return false;
  if (adjustment.kind === "SEASONAL") {
    return isWithinRange(date, adjustment.startDate, adjustment.endDate);
  }
  return adjustment.daysOfWeek.includes(dayKey(date));
}

function applyAdjustment(rate: Decimal, adjustment: RateAdjustmentConfig): Decimal {
  switch (adjustment.adjustmentType) {
    case "PERCENT":
      return roundMoneyDecimal(rate.mul(new Decimal(1).plus(new Decimal(adjustment.amount).div(100))));
    case "FIXED_PER_NIGHT":
      return roundMoneyDecimal(rate.plus(adjustment.amount));
    case "SET_RATE":
      return roundMoneyDecimal(adjustment.amount);
    default:
      return rate;
  }
}

function parseDiscountPercent(raw: number | undefined): number | null {
  if (raw === undefined || raw === null) return null;
  if (!Number.isFinite(raw) || raw < 0 || raw > 100) return null;
  return raw;
}

/**
 * Price a stay from a hotel's own configuration.
 *
 * Returns a failure object (never throws) for anything the caller got wrong, so
 * the API can turn it into a 400 with a message a receptionist can act on.
 */
export function priceStay(config: HotelPricingConfig, request: PriceRequest): PriceResult {
  const { settings } = config;

  const roomType = config.roomTypes.find((type) => type.id === request.roomTypeId);
  if (!roomType) {
    return fail("ROOM_TYPE_NOT_FOUND", "That room type was not found in this hotel.");
  }

  const nights = nightsBetween(request.checkIn, request.checkOut);
  if (nights === null) {
    return fail("INVALID_DATES", "Check-in and check-out must be whole dates, at least one night apart.");
  }

  const adults = Number.isInteger(request.adults) ? request.adults : Number.NaN;
  const children = Number.isInteger(request.children ?? 0) ? (request.children ?? 0) : Number.NaN;
  if (!Number.isFinite(adults) || adults < 1 || !Number.isFinite(children) || children < 0) {
    return fail("INVALID_GUESTS", "Adults must be at least 1 and children cannot be negative.");
  }

  const usesOccupancyRates = settings.useOccupancyRates && settings.pricingModel === "ROOM_TYPE_OCCUPANCY";
  let occupancy = null as (typeof config.occupancies)[number] | null;
  let nightlyRate = 0;

  if (usesOccupancyRates) {
    if (!request.occupancyTypeId) {
      return fail("OCCUPANCY_REQUIRED", "Choose an occupancy for this room.");
    }
    occupancy = config.occupancies.find((option) => option.id === request.occupancyTypeId) ?? null;
    if (!occupancy || !occupancy.isActive) {
      return fail("UNSUPPORTED_OCCUPANCY", "That occupancy option is not available in this hotel.");
    }
    const rate = config.roomTypeOccupancies.find(
      (row) =>
        row.roomTypeId === roomType.id &&
        row.occupancyTypeId === occupancy!.id &&
        row.isActive
    );
    if (!rate) {
      return fail(
        "UNSUPPORTED_OCCUPANCY",
        `${roomType.name} is not sold as ${occupancy.name}. Choose another occupancy.`
      );
    }
    nightlyRate = rate.nightlyRate;
    if (!Number.isFinite(nightlyRate) || nightlyRate <= 0) {
      return fail(
        "RATE_NOT_CONFIGURED",
        `${roomType.name} (${occupancy.name}) has no nightly rate configured. Set one on the Pricing page.`
      );
    }
    if (adults < occupancy.minAdults || adults > occupancy.maxAdults) {
      return fail(
        "CAPACITY_EXCEEDED",
        `${occupancy.name} allows ${occupancy.minAdults}-${occupancy.maxAdults} adults.`
      );
    }
    if (occupancy.maxChildren > 0 && children > occupancy.maxChildren) {
      return fail("CAPACITY_EXCEEDED", `${occupancy.name} allows at most ${occupancy.maxChildren} children.`);
    }
  } else {
    nightlyRate = Number(roomType.baseRate);
    if (!Number.isFinite(nightlyRate) || nightlyRate <= 0) {
      return fail(
        "RATE_NOT_CONFIGURED",
        `${roomType.name} has no nightly rate configured. Set one on the Rooms page.`
      );
    }
  }

  const extraBeds = Number.isInteger(request.extraBeds ?? 0) ? (request.extraBeds ?? 0) : 0;
  if (extraBeds < 0) {
    return fail("INVALID_GUESTS", "Extra beds cannot be negative.");
  }
  const guests = adults + children;
  if (guests + extraBeds > roomType.capacity) {
    return fail(
      "CAPACITY_EXCEEDED",
      `${roomType.name} sleeps ${roomType.capacity}. Reduce the guests or the extra beds.`
    );
  }

  // --- per-night room pricing with seasonal / weekend adjustments ----------
  const baseNightlyRate = new Decimal(nightlyRate);
  const perNight: NightPrice[] = [];
  const adjustmentLines = new Map<string, { quantity: number; amount: Decimal }>();
  let roomTotal = new Decimal(0);
  let adjustmentsTotal = new Decimal(0);

  const activeAdjustments = config.adjustments
    .filter((adjustment) => adjustment.isActive)
    .filter((adjustment) =>
      adjustment.kind === "SEASONAL" ? settings.useSeasonalPricing : settings.useWeekendPricing
    )
    .sort((left, right) => right.priority - left.priority);

  for (let index = 0; index < nights; index += 1) {
    const date = new Date(request.checkIn.getTime() + index * DAY_MS);
    let rate = baseNightlyRate;
    const applied: string[] = [];
    for (const adjustment of activeAdjustments) {
      if (!adjustmentApplies(adjustment, date, roomType.id)) continue;
      const next = applyAdjustment(rate, adjustment);
      const delta = roundMoneyDecimal(next.minus(rate));
      if (!delta.isZero()) {
        const existing = adjustmentLines.get(adjustment.id) ?? { quantity: 0, amount: new Decimal(0) };
        adjustmentLines.set(adjustment.id, {
          quantity: existing.quantity + 1,
          amount: roundMoneyDecimal(existing.amount.plus(delta)),
        });
      }
      rate = next;
      applied.push(adjustment.name);
    }
    roomTotal = roundMoneyDecimal(roomTotal.plus(baseNightlyRate));
    adjustmentsTotal = roundMoneyDecimal(adjustmentsTotal.plus(rate.minus(baseNightlyRate)));
    perNight.push({
      date: utcDay(date),
      baseRate: nightlyRate,
      rate: roundMoneyDecimal(rate).toNumber(),
      adjustments: applied,
    });
  }

  const lines: PriceLine[] = [
    {
      kind: "ROOM",
      code: "ROOM",
      label: `${roomType.name}${occupancy ? ` — ${occupancy.name}` : ""} × ${nights} night${nights === 1 ? "" : "s"}`,
      quantity: nights,
      unitPrice: nightlyRate,
      amount: roomTotal.toNumber(),
    },
  ];

  for (const [id, entry] of adjustmentLines) {
    const adjustment = activeAdjustments.find((candidate) => candidate.id === id);
    if (!adjustment) continue;
    lines.push({
      kind: "ADJUSTMENT",
      code: `ADJUSTMENT:${adjustment.id}`,
      label: `${adjustment.name} (${entry.quantity} night${entry.quantity === 1 ? "" : "s"})`,
      quantity: entry.quantity,
      unitPrice: roundMoneyDecimal(entry.amount.div(entry.quantity)).toNumber(),
      amount: entry.amount.toNumber(),
    });
  }

  // --- meal plan ----------------------------------------------------------
  let mealsTotal = new Decimal(0);
  let mealPlanName: string | null = null;
  let mealPlanBasis = null as (typeof config.mealPlans)[number]["pricingBasis"] | null;

  if (request.mealPlanId) {
    const mealPlan = config.mealPlans.find((plan) => plan.id === request.mealPlanId);
    if (!mealPlan) {
      return fail("MEAL_PLAN_NOT_AVAILABLE", "That meal plan is not available in this hotel.");
    }
    if (!settings.useMealPlans || !mealPlan.isActive) {
      return fail("MEAL_PLAN_NOT_AVAILABLE", `${mealPlan.name} is not currently offered.`);
    }
    if (
      mealPlan.roomTypeIds.length > 0 &&
      !mealPlan.roomTypeIds.includes(roomType.id)
    ) {
      return fail(
        "MEAL_PLAN_NOT_AVAILABLE",
        `${mealPlan.name} is not offered for ${roomType.name}.`
      );
    }
    const checkInDay = utcDay(request.checkIn);
    if (mealPlan.effectiveFrom && checkInDay < utcDay(mealPlan.effectiveFrom)) {
      return fail("MEAL_PLAN_NOT_AVAILABLE", `${mealPlan.name} is not available for those dates.`);
    }
    if (mealPlan.effectiveTo && checkInDay > utcDay(mealPlan.effectiveTo)) {
      return fail("MEAL_PLAN_NOT_AVAILABLE", `${mealPlan.name} is not available for those dates.`);
    }

    const persons = adults + children;
    const mealCharge = new Decimal(mealPlan.charge);
    switch (mealPlan.pricingBasis) {
      case "PER_PERSON_PER_NIGHT":
        mealsTotal = roundMoneyDecimal(mealCharge.mul(persons).mul(nights));
        break;
      case "PER_ROOM_PER_NIGHT":
        mealsTotal = roundMoneyDecimal(mealCharge.mul(nights));
        break;
      case "PER_PERSON_PER_STAY":
        mealsTotal = roundMoneyDecimal(mealCharge.mul(persons));
        break;
      case "PER_ROOM_PER_STAY":
        mealsTotal = roundMoneyDecimal(mealCharge);
        break;
    }
    mealPlanName = mealPlan.name;
    mealPlanBasis = mealPlan.pricingBasis;

    if (!mealsTotal.isZero()) {
      const quantity =
        mealPlan.pricingBasis === "PER_PERSON_PER_NIGHT"
          ? persons * nights
          : mealPlan.pricingBasis === "PER_ROOM_PER_NIGHT"
            ? nights
            : mealPlan.pricingBasis === "PER_PERSON_PER_STAY"
              ? persons
              : 1;
      lines.push({
        kind: "MEAL_PLAN",
        code: "MEAL_PLAN",
        label: `${mealPlan.name}`,
        quantity,
        unitPrice: mealPlan.charge,
        amount: mealsTotal.toNumber(),
      });
    }
  }

  // --- extras: extra beds and children ------------------------------------
  let extrasTotal = new Decimal(0);

  if (extraBeds > 0) {
    if (!settings.useExtraBeds) {
      return fail("EXTRA_BEDS_UNAVAILABLE", "This hotel does not offer extra beds.");
    }
    const rule =
      config.extraBeds.find((candidate) => candidate.isActive && candidate.roomTypeId === roomType.id) ??
      config.extraBeds.find((candidate) => candidate.isActive && candidate.roomTypeId === null);
    if (!rule) {
      return fail("EXTRA_BEDS_UNAVAILABLE", "No extra bed is configured for this room.");
    }
    if (extraBeds > rule.maxPerRoom) {
      return fail(
        "EXTRA_BEDS_UNAVAILABLE",
        `${rule.name} allows at most ${rule.maxPerRoom} extra bed(s) per room.`
      );
    }
    const amount = roundMoneyDecimal(new Decimal(rule.nightlyRate).mul(extraBeds).mul(nights));
    extrasTotal = roundMoneyDecimal(extrasTotal.plus(amount));
    lines.push({
      kind: "EXTRA_BED",
      code: "EXTRA_BED",
      label: `${rule.name} × ${extraBeds} × ${nights} night${nights === 1 ? "" : "s"}`,
      quantity: extraBeds * nights,
      unitPrice: rule.nightlyRate,
      amount: amount.toNumber(),
    });
  }

  if (children > 0 && settings.useChildPricing) {
    const activeRules = config.childRules
      .filter((rule) => rule.isActive)
      .sort((left, right) => left.maxAge - right.maxAge);

    // Child pricing is switched on with no band to apply. Charging nothing would
    // silently give the children away, so the price is refused instead.
    if (activeRules.length === 0) {
      return fail(
        "INVALID_CONFIG",
        "Child pricing is switched on for this hotel but no child age band is configured. " +
          "Add one on the Pricing page, or record the children as adults."
      );
    }

    // The booking form does not ask for ages, so unnamed children are priced with
    // the youngest band's minimum age. That is documented behaviour (see
    // docs/pricing-engine.md) and covered by tests; it never skips the rule.
    const ages =
      request.childAges?.length === children
        ? request.childAges
        : Array.from({ length: children }, () => activeRules[0].minAge);

    for (const age of ages) {
      const rule = activeRules.find((candidate) => age >= candidate.minAge && age <= candidate.maxAge);
      // A child outside every configured band used to be free. That is an
      // under-charge, not a valid price: say what to configure instead.
      if (!rule) {
        return fail(
          "INVALID_CONFIG",
          `No child price is configured for a child aged ${age}. Add an age band covering that age on the Pricing page, or record the guest as an adult.`
        );
      }
      const amount =
        rule.chargeType === "PERCENT_OF_ADULT"
          ? roundMoneyDecimal(baseNightlyRate.mul(new Decimal(rule.amount).div(100)).mul(nights))
          : roundMoneyDecimal(new Decimal(rule.amount).mul(nights));
      if (amount.isZero()) continue;
      extrasTotal = roundMoneyDecimal(extrasTotal.plus(amount));
      lines.push({
        kind: "CHILD",
        code: `CHILD:${rule.id}`,
        label: `${rule.name} (age ${age}) × ${nights} night${nights === 1 ? "" : "s"}`,
        quantity: nights,
        unitPrice:
          rule.chargeType === "PERCENT_OF_ADULT"
            ? roundMoneyDecimal(amount.div(nights)).toNumber()
            : rule.amount,
        amount: amount.toNumber(),
      });
    }
  }

  // --- discount -----------------------------------------------------------
  const subtotalBeforeDiscount = roundMoneyDecimal(
    roomTotal.plus(adjustmentsTotal).plus(mealsTotal).plus(extrasTotal)
  );
  let discountTotal = new Decimal(0);
  if (request.discount !== undefined && request.discount !== null && request.discount !== 0) {
    if (!Number.isFinite(request.discount) || request.discount < 0) {
      return fail("INVALID_DISCOUNT", "The discount must be a positive amount.");
    }
    discountTotal = roundMoneyDecimal(request.discount);
  } else {
    const percent = parseDiscountPercent(request.discountPercent);
    if (request.discountPercent !== undefined && request.discountPercent !== null && percent === null) {
      return fail("INVALID_DISCOUNT", "A percentage discount must be between 0 and 100.");
    }
    if (percent) {
      discountTotal = roundMoneyDecimal(subtotalBeforeDiscount.mul(new Decimal(percent).div(100)));
    }
  }
  if (discountTotal.gt(subtotalBeforeDiscount)) {
    return fail("INVALID_DISCOUNT", "The discount cannot exceed the reservation charges.");
  }
  if (discountTotal.gt(0)) {
    lines.push({
      kind: "DISCOUNT",
      code: "DISCOUNT",
      label: "Discount",
      quantity: 1,
      unitPrice: discountTotal.toNumber(),
      amount: discountTotal.neg().toNumber(),
    });
  }

  const netBeforeTax = roundMoneyDecimal(subtotalBeforeDiscount.minus(discountTotal));

  // --- taxes and service charges -----------------------------------------
  // `taxReported` is what the guest can see on the bill (inclusive or not);
  // `taxAdded` is what the price does not yet contain.
  let taxReported = new Decimal(0);
  let taxAdded = new Decimal(0);
  if (settings.useTaxes) {
    const taxes = config.taxes
      .filter((rule) => rule.isActive)
      .sort((left, right) => left.sortOrder - right.sortOrder);
    const roomTaxBase = roundMoneyDecimal(roomTotal.plus(adjustmentsTotal));
    for (const rule of taxes) {
      const amount = taxAmount(rule, {
        room: roomTaxBase,
        meals: mealsTotal,
        net: netBeforeTax,
        nights,
        persons: adults + children,
      });
      if (amount.isZero()) continue;
      taxReported = roundMoneyDecimal(taxReported.plus(amount));
      if (!rule.isInclusive) taxAdded = roundMoneyDecimal(taxAdded.plus(amount));
      const amountNumber = amount.toNumber();
      lines.push({
        kind: "TAX",
        code: `TAX:${rule.id}`,
        label: `${rule.name}${rule.isInclusive ? " (included)" : ""}`,
        quantity: 1,
        unitPrice: amountNumber,
        amount: amountNumber,
      });
    }
  }

  const grandTotal = roundMoneyDecimal(netBeforeTax.plus(taxAdded));

  // An inclusive-price hotel reports the tax portion without adding it again;
  // the line is present for transparency and the total already contains it.
  const effectiveNightlyRate = roundMoneyDecimal(
    perNight.reduce((sum, night) => sum.plus(night.rate), new Decimal(0)).div(nights)
  ).toNumber();

  return {
    ok: true,
    currency: config.currency,
    pricingModel: settings.pricingModel,
    nights,
    roomTypeId: roomType.id,
    roomTypeName: roomType.name,
    occupancyTypeId: occupancy?.id ?? null,
    occupancyName: occupancy?.name ?? null,
    mealPlanId: request.mealPlanId ?? null,
    mealPlanName,
    mealPlanBasis,
    nightlyRate: roundMoneyDecimal(baseNightlyRate).toNumber(),
    effectiveNightlyRate,
    adults,
    children,
    extraBeds,
    perNight,
    lines,
    totals: {
      room: roomTotal.toNumber(),
      adjustments: adjustmentsTotal.toNumber(),
      meals: mealsTotal.toNumber(),
      extras: extrasTotal.toNumber(),
      subtotal: subtotalBeforeDiscount.toNumber(),
      discount: discountTotal.toNumber(),
      tax: taxReported.toNumber(),
      grandTotal: grandTotal.toNumber(),
      averagePerNight: roundMoneyDecimal(grandTotal.div(nights)).toNumber(),
    },
    taxInclusive: settings.pricesIncludeTax,
  };
}

function taxAmount(
  rule: TaxRuleConfig,
  base: { room: Decimal; meals: Decimal; net: Decimal; nights: number; persons: number }
): Decimal {
  const taxableBase =
    rule.appliesTo === "ROOM" ? base.room : rule.appliesTo === "MEALS" ? base.meals : base.net;

  if (rule.basis === "PERCENT") {
    return roundMoneyDecimal(taxableBase.mul(new Decimal(rule.amount).div(100)));
  }

  const multiplier =
    rule.chargeBasis === "PER_NIGHT"
      ? base.nights
      : rule.chargeBasis === "PER_PERSON_PER_NIGHT"
        ? base.persons * base.nights
        : 1;

  // A fixed charge applies to the scope it names: a per-stay service charge is
  // charged once, not once per room or per tax line.
  return roundMoneyDecimal(new Decimal(rule.amount).mul(multiplier));
}
