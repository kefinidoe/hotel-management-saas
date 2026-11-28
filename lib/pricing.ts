/** Pure building block for the opt-in universal pricing model.
 * Existing hotel pricing remains authoritative until this model is integrated.
 */
import Decimal from "decimal.js";
import { parseMoneyDecimal, roundMoneyDecimal } from "@/lib/billing";

export const UNIVERSAL_MEAL_PLANS = [
  "ROOM_ONLY", "BED_BREAKFAST", "HALF_BOARD", "FULL_BOARD", "ALL_INCLUSIVE",
] as const;
export type UniversalMealPlan = (typeof UNIVERSAL_MEAL_PLANS)[number];
export const UNIVERSAL_MEAL_PLAN_LABELS: Record<UniversalMealPlan, string> = {
  ROOM_ONLY: "Room Only",
  BED_BREAKFAST: "Bed & Breakfast",
  HALF_BOARD: "Half Board",
  FULL_BOARD: "Full Board",
  ALL_INCLUSIVE: "All-Inclusive",
};

export type HotelMealRate = {
  mealPlan: UniversalMealPlan;
  adultSurcharge: number | string;
  childSurcharge: number | string;
  isActive: boolean;
};

/** Returns a nightly estimate; only a server-loaded configuration can approve it. */
export function calculateUniversalNightlyRate(input: {
  baseRate: number | string;
  mealPlan: UniversalMealPlan;
  adults: number;
  children: number;
  extraAdultFee: number | string;
  hotelMealRates: readonly HotelMealRate[];
  overrideTariffRate?: number | string | null;
}): number {
  if (!UNIVERSAL_MEAL_PLANS.includes(input.mealPlan)) throw new Error("Invalid meal plan.");
  if (!Number.isSafeInteger(input.adults) || input.adults < 1 ||
      !Number.isSafeInteger(input.children) || input.children < 0) {
    throw new Error("Invalid guest counts.");
  }
  const matches = input.hotelMealRates.filter((row) => row.mealPlan === input.mealPlan);
  if (matches.length > 1) throw new Error("Duplicate meal pricing.");
  const meal = matches[0];
  if (meal && !meal.isActive) throw new Error("Meal plan is inactive.");
  if (input.overrideTariffRate != null) {
    return parseMoneyDecimal(input.overrideTariffRate, "Tariff rate").toNumber();
  }
  const baseRate = parseMoneyDecimal(input.baseRate, "Base rate");
  const extraAdultFee = parseMoneyDecimal(input.extraAdultFee, "Extra adult fee", { allowZero: true });
  const adultSurcharge = parseMoneyDecimal(meal?.adultSurcharge ?? 0, "Adult meal surcharge", { allowZero: true });
  const childSurcharge = parseMoneyDecimal(meal?.childSurcharge ?? 0, "Child meal surcharge", { allowZero: true });

  const total = baseRate
    .plus(extraAdultFee.mul(input.adults - 1))
    .plus(adultSurcharge.mul(input.adults))
    .plus(childSurcharge.mul(input.children));

  return parseMoneyDecimal(roundMoneyDecimal(total), "Nightly rate").toNumber();
}
