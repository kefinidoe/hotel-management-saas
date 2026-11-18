import { describe, expect, it } from "vitest";
import { calculateCustomNightlyRate } from "@/lib/pricing/custom-rate-rules";

const input = { baseRate: 1000, adults: 3, children: 2,
  meal: { pricePerNight: 100, perGuest: true, isActive: true },
  occupancy: { includedAdults: 2, surchargeAmount: 200, extraAdultRate: 150, isActive: true } };

describe("custom rate calculation", () => {
  it("charges all guests for meals and extra adults above the allowance", () => {
    expect(calculateCustomNightlyRate(input)).toMatchObject({ base: 1000, occupancyTotal: 350, mealTotal: 500, nightlyRate: 1850 });
  });
  it("charges a flat meal rate once when not per guest", () => {
    expect(calculateCustomNightlyRate({ ...input, meal: { ...input.meal, perGuest: false } }).nightlyRate).toBe(1450);
  });
  it("fails closed on inactive or invalid rules", () => {
    expect(() => calculateCustomNightlyRate({ ...input, occupancy: { ...input.occupancy, isActive: false } })).toThrow(/inactive/);
    expect(() => calculateCustomNightlyRate({ ...input, meal: { ...input.meal, pricePerNight: Infinity } })).toThrow();
    expect(() => calculateCustomNightlyRate({ ...input, children: -1 })).toThrow();
  });
});
