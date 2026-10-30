/**
 * Occupancy and meal-plan rules, shared by the reservation screens and the
 * reservation API so the two cannot drift apart.
 *
 * A booking is priced by picking a room and then choosing who is staying
 * (occupancy) and what meals are included (meal plan). The matching tariff --
 * the RoomType row named "Single — Half Board", for example -- supplies the
 * nightly rate. Rooms themselves carry no tariff restriction.
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
 * The seeded tariff names all start with one of these words.
 */
export function tariffCategory(occupancy: Occupancy): string {
  return OCCUPANCY_LABELS[occupancy];
}

/**
 * Does this tariff belong to the chosen occupancy and meal plan?
 *
 * This is the rule the API enforces, so a tampered request cannot price a Twin
 * booking at the Single rate. It is deliberately name-based because the tariff
 * names are what the hotel maintains.
 */
export function tariffMatches(
  tariffName: string,
  tariffMealPlan: string | null,
  occupancy: Occupancy,
  mealPlan: MealPlanCode
): boolean {
  const category = tariffCategory(occupancy).toLowerCase();
  return tariffName.trim().toLowerCase().startsWith(category) && tariffMealPlan === mealPlan;
}

/** Find the tariff for a booking, or undefined when the hotel has not set one up. */
export function findTariff<T extends { name: string; mealPlan: string | null }>(
  tariffs: T[],
  occupancy: Occupancy,
  mealPlan: MealPlanCode
): T | undefined {
  return tariffs.find((tariff) => tariffMatches(tariff.name, tariff.mealPlan, occupancy, mealPlan));
}

/**
 * The rate a reservation is sold at.
 *
 * Hotels price stays in one of two ways, and both must work:
 *
 *   1. Per occupancy/meal-plan tariffs -- room types named "Single — Half Board"
 *      and so on. This is the richer model and is preferred when the hotel has
 *      set it up, because it lets one room be sold as a single, a double or on
 *      half board at different prices.
 *   2. A single rate on the room type itself, with no occupancy variants.
 *
 * The screen and the API previously required (1) only. A hotel that named its
 * room types anything else ("Standard", "Deluxe Garden", "Family Suite") could
 * therefore never price a booking: the approved rate showed "--", the submit
 * button stayed disabled, and a hand-crafted request was rejected with "the
 * selected tariff does not match the occupancy and meal plan". That is the
 * defect this resolver fixes, on both sides at once so they cannot drift.
 */
export type TariffPricing = {
  id: string;
  name: string;
  baseRate: number | string;
  mealPlan: string | null;
};

export type ApprovedRate<T extends TariffPricing> =
  | {
      ok: true;
      tariff: T;
      rate: number;
      /** Which rule produced the price, so the screen can explain it. */
      source: "OCCUPANCY_TARIFF" | "ROOM_TYPE";
    }
  | { ok: false; reason: "NO_TARIFF" | "INVALID_TARIFF_RATE" };

function usableRate(baseRate: number | string): number | null {
  const rate = typeof baseRate === "number" ? baseRate : Number(baseRate);
  // A zero, negative, NaN or infinite rate is not a price. Returning null here
  // is what stops a reservation being silently submitted at 0.
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

/**
 * Resolve the nightly rate for a stay.
 *
 * `roomTypeId` is the type of the room the guest is being put in, and it is the
 * price that wins: a hotel sets the rate on the room type it is selling, so the
 * rate must follow the room the receptionist picks. A tariff matched by
 * occupancy/meal-plan name is only used when the room's own type has no usable
 * rate (for example a hotel that leaves the type blank and prices by occupancy).
 */
export function resolveApprovedRate<T extends TariffPricing>(input: {
  tariffs: readonly T[];
  occupancy: Occupancy;
  mealPlan: MealPlanCode;
  roomTypeId?: string | null;
}): ApprovedRate<T> {
  const matched = findTariff([...input.tariffs], input.occupancy, input.mealPlan);
  const roomType = input.roomTypeId
    ? input.tariffs.find((tariff) => tariff.id === input.roomTypeId)
    : undefined;

  const candidates: Array<{ tariff: T; source: "OCCUPANCY_TARIFF" | "ROOM_TYPE" }> = [];
  if (roomType) candidates.push({ tariff: roomType, source: "ROOM_TYPE" });
  if (matched && matched.id !== roomType?.id) {
    candidates.push({ tariff: matched, source: "OCCUPANCY_TARIFF" });
  }

  for (const candidate of candidates) {
    const rate = usableRate(candidate.tariff.baseRate);
    if (rate !== null) {
      return { ok: true, tariff: candidate.tariff, rate, source: candidate.source };
    }
  }

  return candidates.length > 0
    ? { ok: false, reason: "INVALID_TARIFF_RATE" }
    : { ok: false, reason: "NO_TARIFF" };
}

/**
 * Is this tariff allowed to price this booking?
 *
 * Either it is the tariff for the chosen occupancy and meal plan, or it is the
 * room's own room type. Nothing else: a client cannot price a Twin room at
 * another type's cheaper rate.
 */
export function tariffPricesStay(
  tariff: { id: string; name: string; mealPlan: string | null },
  roomTypeId: string | null,
  occupancy: Occupancy,
  mealPlan: MealPlanCode
): boolean {
  if (tariffMatches(tariff.name, tariff.mealPlan, occupancy, mealPlan)) return true;
  return Boolean(roomTypeId) && tariff.id === roomTypeId;
}
