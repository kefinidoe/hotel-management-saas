/** Pure building block for the opt-in universal pricing model.
 * Existing hotel pricing remains authoritative until this model is integrated.
 */
import { parseMoney } from "@/lib/billing";

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
    return parseMoney(input.overrideTariffRate, "Tariff rate");
  }
  // Work in integer cents to avoid floating-point drift and reject overflow.
  const cents = (amount: number | string, label: string, allowZero = true) =>
    Math.round(parseMoney(amount, label, { allowZero }) * 100);
  const total = cents(input.baseRate, "Base rate", false) +
    (input.adults - 1) * cents(input.extraAdultFee, "Extra adult fee") +
    input.adults * cents(meal?.adultSurcharge ?? 0, "Adult meal surcharge") +
    input.children * cents(meal?.childSurcharge ?? 0, "Child meal surcharge");
  if (!Number.isSafeInteger(total)) throw new Error("Nightly rate is too large.");
  return parseMoney(total / 100, "Nightly rate");
}
