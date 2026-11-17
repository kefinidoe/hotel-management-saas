import { describe, expect, it } from "vitest";
import { priceModularStay } from "@/lib/pricing/modular";
const input = {
  currency: "KES", roomType: { id: "r", name: "Suite", baseRate: 1000, extraAdultFee: 150, maxAdults: 2, maxChildren: 1 },
  mealPlan: "BED_BREAKFAST" as const,
  mealRates: [{ mealPlan: "BED_BREAKFAST" as const, adultSurcharge: 100, childSurcharge: 50, isActive: true }],
  adults: 2, children: 1, checkIn: new Date("2026-12-01"), checkOut: new Date("2026-12-03"), discount: 100,
};
describe("modular price breakdown foundation", () => {
  it("keeps room and meal charges separately billable with a fixed discount", () => {
    const p = priceModularStay(input);
    expect(p.pricingModel).toBe("MODULAR_PRICING");
    expect(p.nightlyRate).toBe(1150);
    expect(p.effectiveNightlyRate).toBe(1400);
    expect(p.totals).toMatchObject({ room: 2300, meals: 500, subtotal: 2800, discount: 100, grandTotal: 2700 });
    expect(p.lines).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "MEAL_PLAN", amount: 500 }), expect.objectContaining({ kind: "DISCOUNT", amount: -100 })]));
  });
  it("rejects inactive plans, over-capacity bookings and excessive discounts", () => {
    expect(() => priceModularStay({ ...input, mealRates: [{ ...input.mealRates[0], isActive: false }] })).toThrow(/inactive/);
    expect(() => priceModularStay({ ...input, adults: 3 })).toThrow(/capacity/);
    expect(() => priceModularStay({ ...input, discount: 3000 })).toThrow(/discount/i);
  });
});
