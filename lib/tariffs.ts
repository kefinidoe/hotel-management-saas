/**
 * Occupancy and meal-plan rules, shared by the reservation screens and the
 * reservation API so the two cannot drift apart.
 *
 * A booking is priced by picking a room and then choosing who is staying
 * (occupancy) and what meals are included (meal plan). Tariffs match based
 * on meal plan and capacity flexibility, supporting arbitrary hotel room naming conventions.
 */

export const OCCUPANCIES = ["SINGLE", "DOUBLE", "TWIN"] as const;
export type Occupancy = (typeof OCCUPANCIES)[number];

export const MEAL_PLANS = ["BED_ONLY", "BED_AND_BREAKFAST", "HALF_BOARD"] as const;
export type MealPlanCode = (typeof MEAL_PLANS)[number];

export const OCCUPANCY_LABELS: Record<Occupancy, string> = {
  SINGLE: "Single",
  DOUBLE: "Double",
  TWIN: "Twin",
};

export const MEAL_PLAN_LABELS: Record<MealPlanCode, string> = {
  BED_ONLY: "Bed Only",
  BED_AND_BREAKFAST: "Bed & Breakfast",
  HALF_BOARD: "Half Board",
};

export function isOccupancy(value: unknown): value is Occupancy {
  return OCCUPANCIES.includes(value as Occupancy);
}

export function isMealPlan(value: unknown): value is MealPlanCode {
  return MEAL_PLANS.includes(value as MealPlanCode);
}

/**
 * The tariff category a booking falls into: "Single", "Double" or "Twin".
 */
export function tariffCategory(occupancy: Occupancy): string {
  return OCCUPANCY_LABELS[occupancy];
}

/**
 * Does this tariff belong to the chosen occupancy and meal plan?
 * 
 * Updated to be flexible: matches strictly by meal plan, and optionally 
 * checks capacity if present on the tariff object to ensure single/double adequacy, 
 * without forcing strict name prefixes.
 */
export function tariffMatches<T extends { name: string; mealPlan: string | null; capacity?: number }>(
  tariff: T,
  occupancy: Occupancy,
  mealPlan: MealPlanCode
): boolean {
  const normalizedTariffMealPlan = (tariff.mealPlan || "").trim().toUpperCase();
  const normalizedTargetMealPlan = mealPlan.trim().toUpperCase();

  // Match strictly on meal plan alignment
  const matchesMealPlan = normalizedTariffMealPlan === normalizedTargetMealPlan;

  // Optional capacity validation if the tariff object specifies capacity
  const requiredCapacity = occupancy === "SINGLE" ? 1 : 2;
  const matchesCapacity = typeof tariff.capacity === "number" && tariff.capacity > 0
    ? tariff.capacity >= requiredCapacity
    : true;

  return matchesMealPlan && matchesCapacity;
}

/** Find the tariff for a booking, or undefined when the hotel has not set one up. */
export function findTariff<T extends { name: string; mealPlan: string | null; capacity?: number }>(
  tariffs: T[],
  occupancy: Occupancy,
  mealPlan: MealPlanCode
): T | undefined {
  // First attempt: try matching both meal plan and capacity if available
  let match = tariffs.find((tariff) => tariffMatches(tariff, occupancy, mealPlan));
  
  // Fallback: if no exact capacity-constrained match is found, match purely by meal plan 
  // to ensure maximum flexibility for custom multi-purpose room types.
  if (!match) {
    match = tariffs.find(
      (tariff) => (tariff.mealPlan || "").trim().toUpperCase() === mealPlan.trim().toUpperCase()
    );
  }

  return match;
}