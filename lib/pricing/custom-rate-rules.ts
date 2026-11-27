import Decimal from "decimal.js";
import { accommodationRequiredExact, parseMoneyDecimal, roundMoneyDecimal, stayNights } from "@/lib/billing";
import type { PriceBreakdown } from "@/lib/pricing/types";

/** Pure calculator for the separately opted-in custom rate rules. */
export function calculateCustomNightlyRate(input: {
  baseRate: number | string;
  adults: number;
  children: number;
  meal: { pricePerNight: number; perGuest: boolean; isActive: boolean };
  occupancy: { includedAdults: number; surchargeAmount: number; extraAdultRate: number; isActive: boolean };
}) {
  const { adults, children, meal, occupancy } = input;
  if (!Number.isSafeInteger(adults) || adults < 1 || adults > 100 ||
      !Number.isSafeInteger(children) || children < 0 || children > 100 ||
      !Number.isSafeInteger(occupancy.includedAdults) || occupancy.includedAdults < 1) {
    throw new Error("Invalid guest counts or included adults.");
  }
  if (!meal.isActive || !occupancy.isActive) throw new Error("The selected rate rule is inactive.");
  const base = parseMoneyDecimal(input.baseRate, "Base room rate");
  const surcharge = parseMoneyDecimal(occupancy.surchargeAmount, "Occupancy surcharge", { allowZero: true });
  const extraAdultRate = parseMoneyDecimal(occupancy.extraAdultRate, "Extra adult rate", { allowZero: true });
  const mealRate = parseMoneyDecimal(meal.pricePerNight, "Meal plan rate", { allowZero: true });
  const extraAdults = Math.max(0, adults - occupancy.includedAdults);
  const occupancyTotal = roundMoneyDecimal(surcharge.plus(extraAdultRate.mul(extraAdults)));
  const mealTotal = roundMoneyDecimal(mealRate.mul(meal.perGuest ? adults + children : 1));
  const nightlyRate = parseMoneyDecimal(
    roundMoneyDecimal(base.plus(occupancyTotal).plus(mealTotal)),
    "Nightly rate"
  );
  return {
    base: base.toNumber(),
    surcharge: surcharge.toNumber(),
    extraAdults,
    extraAdultRate: extraAdultRate.toNumber(),
    occupancyTotal: occupancyTotal.toNumber(),
    mealTotal: mealTotal.toNumber(),
    nightlyRate: nightlyRate.toNumber(),
  };
}

/** Produces the same immutable accounting breakdown for a quote and a booking. */
export function priceCustomStay(input: {
  currency: string;
  roomType: { id: string; name: string; baseRate: number | string; maxAdults: number; maxChildren: number };
  meal: { id: string; name: string; pricePerNight: number; perGuest: boolean; isActive: boolean };
  occupancy: { id: string; label: string; includedAdults: number; surchargeAmount: number; extraAdultRate: number; isActive: boolean };
  adults: number; children: number; checkIn: Date; checkOut: Date; discount?: number;
}): PriceBreakdown {
  if (input.adults > input.roomType.maxAdults || input.children > input.roomType.maxChildren) throw new Error("Guest counts exceed the room's capacity.");
  const nights = stayNights(input.checkIn, input.checkOut);
  if (nights > 3660) throw new Error("The stay is too long to price.");
  const amounts = calculateCustomNightlyRate({ baseRate: input.roomType.baseRate, adults: input.adults, children: input.children, meal: input.meal, occupancy: input.occupancy });
  const discountDecimal = parseMoneyDecimal(input.discount ?? 0, "Discount", { allowZero: true });
  const grandTotalDecimal = accommodationRequiredExact([amounts.nightlyRate], nights, discountDecimal);
  const baseDecimal = new Decimal(amounts.base);
  const occupancyDecimal = new Decimal(amounts.occupancyTotal);
  const mealDecimal = new Decimal(amounts.mealTotal);
  const roomNightDecimal = roundMoneyDecimal(baseDecimal.plus(occupancyDecimal));
  const roomDecimal = roundMoneyDecimal(roomNightDecimal.mul(nights));
  const mealsDecimal = roundMoneyDecimal(mealDecimal.mul(nights));
  const subtotalDecimal = roundMoneyDecimal(roomDecimal.plus(mealsDecimal));
  // All persisted snapshot amounts use Decimal(10,2); reject overflowing totals before quoting.
  for (const [label, value] of [["Room total", roomDecimal], ["Meals total", mealsDecimal], ["Stay total", subtotalDecimal], ["Grand total", grandTotalDecimal]] as const) {
    parseMoneyDecimal(value, label, { allowZero: true });
  }
  const roomNight = roomNightDecimal.toNumber();
  const room = roomDecimal.toNumber();
  const meals = mealsDecimal.toNumber();
  const subtotal = subtotalDecimal.toNumber();
  const discount = discountDecimal.toNumber();
  const grandTotal = grandTotalDecimal.toNumber();
  const averagePerNight = roundMoneyDecimal(grandTotalDecimal.div(nights)).toNumber();

  return {
    ok: true, currency: input.currency, pricingModel: "CUSTOM_RATE_RULES", nights,
    roomTypeId: input.roomType.id, roomTypeName: input.roomType.name,
    occupancyTypeId: input.occupancy.id, occupancyName: input.occupancy.label,
    mealPlanId: input.meal.id, mealPlanName: input.meal.name, mealPlanBasis: null,
    nightlyRate: roomNight, effectiveNightlyRate: amounts.nightlyRate,
    adults: input.adults, children: input.children, extraBeds: 0,
    perNight: Array.from({ length: nights }, (_, index) => ({ date: new Date(input.checkIn.getTime() + index * 86_400_000).toISOString().slice(0, 10), baseRate: amounts.base, rate: roomNight, adjustments: [input.occupancy.label] })),
    lines: [
      { kind: "ROOM", code: "ROOM", label: input.roomType.name, quantity: nights, unitPrice: amounts.base, amount: roundMoneyDecimal(baseDecimal.mul(nights)).toNumber() },
      { kind: "ADJUSTMENT", code: "OCCUPANCY", label: input.occupancy.label, quantity: nights, unitPrice: amounts.occupancyTotal, amount: roundMoneyDecimal(occupancyDecimal.mul(nights)).toNumber() },
      { kind: "MEAL_PLAN", code: "MEAL_PLAN", label: input.meal.name, quantity: nights, unitPrice: amounts.mealTotal, amount: meals },
      ...(discount > 0 ? [{ kind: "DISCOUNT" as const, code: "DISCOUNT", label: "Discount", quantity: 1, unitPrice: discount, amount: discountDecimal.neg().toNumber() }] : []),
    ],
    totals: { room, adjustments: 0, meals, extras: 0, subtotal, discount, tax: 0, grandTotal, averagePerNight }, taxInclusive: false,
  };
}
