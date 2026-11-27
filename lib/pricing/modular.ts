/** Server-side modular price construction for opt-in hotels. */
import Decimal from "decimal.js";
import { accommodationRequiredExact, parseMoneyDecimal, roundMoneyDecimal, stayNights } from "@/lib/billing";
import { calculateUniversalNightlyRate, UNIVERSAL_MEAL_PLAN_LABELS, type HotelMealRate, type UniversalMealPlan } from "@/lib/pricing";
import type { PriceBreakdown } from "@/lib/pricing/types";

export type ModularPriceBreakdown = Omit<PriceBreakdown, "pricingModel"> & { pricingModel: "MODULAR_PRICING" };

export function priceModularStay(input: {
  currency: string;
  roomType: { id: string; name: string; baseRate: number | string; extraAdultFee: number | string; maxAdults: number; maxChildren: number };
  mealPlan: UniversalMealPlan;
  mealRates: readonly HotelMealRate[];
  adults: number;
  children: number;
  checkIn: Date;
  checkOut: Date;
  discount?: number;
}): ModularPriceBreakdown {
  if (!Number.isSafeInteger(input.adults) || input.adults < 1 ||
      !Number.isSafeInteger(input.children) || input.children < 0 ||
      !Number.isInteger(input.roomType.maxAdults) || !Number.isInteger(input.roomType.maxChildren) ||
      input.adults > input.roomType.maxAdults || input.children > input.roomType.maxChildren) {
    throw new Error("Guest counts exceed the room's capacity.");
  }
  // A missing paid-meal configuration is not evidence of a free meal.
  if (input.mealPlan !== "ROOM_ONLY" && !input.mealRates.some((rate) => rate.mealPlan === input.mealPlan)) {
    throw new Error("Meal plan pricing is not configured.");
  }
  const nights = stayNights(input.checkIn, input.checkOut);
  if (nights > 3660) throw new Error("The stay is too long to price.");
  const nightlyRateDecimal = new Decimal(
    calculateUniversalNightlyRate({
      baseRate: input.roomType.baseRate, extraAdultFee: input.roomType.extraAdultFee,
      mealPlan: input.mealPlan, adults: input.adults, children: input.children, hotelMealRates: input.mealRates,
    })
  );
  const discountDecimal = parseMoneyDecimal(input.discount ?? 0, "Discount", { allowZero: true });
  const grandTotalDecimal = accommodationRequiredExact([nightlyRateDecimal], nights, discountDecimal);
  const subtotalDecimal = roundMoneyDecimal(nightlyRateDecimal.mul(nights));
  const baseRateDecimal = parseMoneyDecimal(input.roomType.baseRate, "Base rate");
  const extraAdultDecimal = parseMoneyDecimal(input.roomType.extraAdultFee, "Extra adult fee", { allowZero: true });
  const roomNightlyRateDecimal = roundMoneyDecimal(baseRateDecimal.plus(extraAdultDecimal.mul(input.adults - 1)));
  const mealNightlyRateDecimal = roundMoneyDecimal(nightlyRateDecimal.minus(roomNightlyRateDecimal));
  const roomTotalDecimal = roundMoneyDecimal(roomNightlyRateDecimal.mul(nights));
  const mealsTotalDecimal = roundMoneyDecimal(mealNightlyRateDecimal.mul(nights));

  const nightlyRate = nightlyRateDecimal.toNumber();
  const discount = discountDecimal.toNumber();
  const grandTotal = grandTotalDecimal.toNumber();
  const subtotal = subtotalDecimal.toNumber();
  const roomNightlyRate = roomNightlyRateDecimal.toNumber();
  const mealNightlyRate = mealNightlyRateDecimal.toNumber();
  const roomTotal = roomTotalDecimal.toNumber();
  const mealsTotal = mealsTotalDecimal.toNumber();
  const averagePerNight = roundMoneyDecimal(grandTotalDecimal.div(nights)).toNumber();

  return {
    ok: true, currency: input.currency, pricingModel: "MODULAR_PRICING", nights,
    roomTypeId: input.roomType.id, roomTypeName: input.roomType.name,
    occupancyTypeId: null, occupancyName: null, mealPlanId: null,
    mealPlanName: UNIVERSAL_MEAL_PLAN_LABELS[input.mealPlan], mealPlanBasis: null,
    nightlyRate: roomNightlyRate, effectiveNightlyRate: nightlyRate, adults: input.adults, children: input.children, extraBeds: 0,
    perNight: Array.from({ length: nights }, (_, index) => ({
      date: new Date(input.checkIn.getTime() + index * 86_400_000).toISOString().slice(0, 10),
      baseRate: roomNightlyRate, rate: roomNightlyRate, adjustments: [],
    })),
    lines: [
      { kind: "ROOM", code: "ROOM", label: input.roomType.name, quantity: nights, unitPrice: roomNightlyRate, amount: roomTotal },
      ...(mealsTotal ? [{ kind: "MEAL_PLAN" as const, code: "MEAL_PLAN", label: UNIVERSAL_MEAL_PLAN_LABELS[input.mealPlan], quantity: nights, unitPrice: mealNightlyRate, amount: mealsTotal }] : []),
      ...(discount > 0 ? [{ kind: "DISCOUNT" as const, code: "DISCOUNT", label: "Discount", quantity: 1, unitPrice: discount, amount: discountDecimal.neg().toNumber() }] : []),
    ],
    totals: { room: roomTotal, adjustments: 0, meals: mealsTotal, extras: 0, subtotal, discount, tax: 0, grandTotal, averagePerNight },
    taxInclusive: false,
  };
}
