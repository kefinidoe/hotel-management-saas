import { describe, expect, it } from "vitest";
import { calculateUniversalNightlyRate, UNIVERSAL_MEAL_PLANS } from "@/lib/pricing";

const stay = {
  baseRate: 1000, mealPlan: "BED_BREAKFAST" as const, adults: 2, children: 1,
  extraAdultFee: 150,
  hotelMealRates: [{ mealPlan: "BED_BREAKFAST" as const, adultSurcharge: 100, childSurcharge: 50, isActive: true }],
};

describe("universal nightly pricing foundation", () => {
  it("exports all five meal plans", () => expect(UNIVERSAL_MEAL_PLANS).toHaveLength(5));
  it("adds per-person meals and extra-adult fees", () => expect(calculateUniversalNightlyRate(stay)).toBe(1400));
  it("uses a configured override without adding charges", () => expect(calculateUniversalNightlyRate({ ...stay, overrideTariffRate: 3000 })).toBe(3000));
  it("defaults missing meal rates to zero", () => expect(calculateUniversalNightlyRate({ ...stay, hotelMealRates: [] })).toBe(1150));
  it("calculates fractional currency amounts precisely", () => expect(calculateUniversalNightlyRate({ ...stay, baseRate: 0.1, extraAdultFee: 0.2, hotelMealRates: [] })).toBe(0.3));
  it("rejects an inactive meal plan", () => expect(() => calculateUniversalNightlyRate({ ...stay, hotelMealRates: [{ ...stay.hotelMealRates[0], isActive: false }] })).toThrow(/inactive/));
  it("rejects negative, non-finite, fractional and excessive guest counts", () => {
    for (const adults of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER]) {
      expect(() => calculateUniversalNightlyRate({ ...stay, adults })).toThrow();
    }
  });
  it("rejects invalid prices and duplicate configurations", () => {
    expect(() => calculateUniversalNightlyRate({ ...stay, baseRate: -1 })).toThrow();
    expect(() => calculateUniversalNightlyRate({ ...stay, extraAdultFee: Infinity })).toThrow();
    expect(() => calculateUniversalNightlyRate({ ...stay, hotelMealRates: [...stay.hotelMealRates, ...stay.hotelMealRates] })).toThrow();
  });
});
