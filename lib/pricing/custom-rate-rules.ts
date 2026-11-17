import { accommodationRequired, parseMoney, roundMoney, stayNights } from "@/lib/billing";

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
  const base = parseMoney(input.baseRate, "Base room rate");
  const surcharge = parseMoney(occupancy.surchargeAmount, "Occupancy surcharge", { allowZero: true });
  const extraAdultRate = parseMoney(occupancy.extraAdultRate, "Extra adult rate", { allowZero: true });
  const mealRate = parseMoney(meal.pricePerNight, "Meal plan rate", { allowZero: true });
  const extraAdults = Math.max(0, adults - occupancy.includedAdults);
  const occupancyTotal = roundMoney(surcharge + extraAdults * extraAdultRate);
  const mealTotal = roundMoney(mealRate * (meal.perGuest ? adults + children : 1));
  const nightlyRate = parseMoney(roundMoney(base + occupancyTotal + mealTotal), "Nightly rate");
  return { base, surcharge, extraAdults, extraAdultRate, occupancyTotal, mealTotal, nightlyRate };
}

import type { PriceBreakdown } from "@/lib/pricing/types";

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
  const discount = parseMoney(input.discount ?? 0, "Discount", { allowZero: true });
  const grandTotal = accommodationRequired([amounts.nightlyRate], nights, discount);
  const roomNight = roundMoney(amounts.base + amounts.occupancyTotal);
  const room = roundMoney(roomNight * nights);
  const meals = roundMoney(amounts.mealTotal * nights);
  const subtotal = roundMoney(room + meals);
  // All persisted snapshot amounts use Decimal(10,2); reject overflowing totals before quoting.
  for (const [label, value] of [["Room total", room], ["Meals total", meals], ["Stay total", subtotal], ["Grand total", grandTotal]] as const) parseMoney(value, label, { allowZero: true });
  return {
    ok: true, currency: input.currency, pricingModel: "CUSTOM_RATE_RULES", nights,
    roomTypeId: input.roomType.id, roomTypeName: input.roomType.name,
    occupancyTypeId: input.occupancy.id, occupancyName: input.occupancy.label,
    mealPlanId: input.meal.id, mealPlanName: input.meal.name, mealPlanBasis: null,
    nightlyRate: roomNight, effectiveNightlyRate: amounts.nightlyRate,
    adults: input.adults, children: input.children, extraBeds: 0,
    perNight: Array.from({ length: nights }, (_, index) => ({ date: new Date(input.checkIn.getTime() + index * 86_400_000).toISOString().slice(0, 10), baseRate: amounts.base, rate: roomNight, adjustments: [input.occupancy.label] })),
    lines: [
      { kind: "ROOM", code: "ROOM", label: input.roomType.name, quantity: nights, unitPrice: amounts.base, amount: roundMoney(amounts.base * nights) },
      { kind: "ADJUSTMENT", code: "OCCUPANCY", label: input.occupancy.label, quantity: nights, unitPrice: amounts.occupancyTotal, amount: roundMoney(amounts.occupancyTotal * nights) },
      { kind: "MEAL_PLAN", code: "MEAL_PLAN", label: input.meal.name, quantity: nights, unitPrice: amounts.mealTotal, amount: meals },
    ],
    totals: { room, adjustments: 0, meals, extras: 0, subtotal, discount, tax: 0, grandTotal, averagePerNight: roundMoney(grandTotal / nights) }, taxInclusive: false,
  };
}
