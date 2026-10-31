import { describe, expect, it } from "vitest";
import { priceStay } from "@/lib/pricing/engine";
import { DEFAULT_PRICING_SETTINGS, type HotelPricingConfig } from "@/lib/pricing/types";

/**
 * Children are the one part of the engine whose price depends on data that may be
 * missing at request time: the age bands.
 *
 * Before this change, a hotel that switched child pricing on but had no band (or
 * had no band covering the child's age) charged *nothing* for that child — a
 * silent under-charge. The engine now refuses to price and says what to
 * configure, which is the only safe answer when the guest is standing at the desk.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function config(overrides: Partial<HotelPricingConfig> = {}): HotelPricingConfig {
  return {
    hotelId: "hotel-a",
    currency: "KES",
    settings: {
      ...DEFAULT_PRICING_SETTINGS,
      pricingModel: "ROOM_TYPE_OCCUPANCY",
      useOccupancyRates: true,
      useChildPricing: true,
    },
    roomTypes: [{ id: "rt-deluxe", name: "Deluxe Room", baseRate: 6000, capacity: 4 }],
    occupancies: [
      { id: "occ-family", name: "Family", minAdults: 2, maxAdults: 4, maxChildren: 3, sortOrder: 1, isActive: true },
    ],
    roomTypeOccupancies: [
      { roomTypeId: "rt-deluxe", occupancyTypeId: "occ-family", nightlyRate: 10000, isActive: true },
    ],
    mealPlans: [],
    adjustments: [],
    extraBeds: [],
    childRules: [],
    taxes: [],
    ...overrides,
  };
}

const childRule = (overrides: Record<string, unknown> = {}) => ({
  id: "child-0-5",
  name: "Infant / toddler",
  minAge: 0,
  maxAge: 5,
  chargeType: "FIXED_PER_NIGHT" as const,
  amount: 500,
  isActive: true,
  ...overrides,
});

const stay = (children: number, childAges?: number[]) => ({
  roomTypeId: "rt-deluxe",
  occupancyTypeId: "occ-family",
  checkIn: day("2026-11-10"),
  checkOut: day("2026-11-12"),
  adults: 2,
  children,
  childAges,
});

describe("child pricing fails closed", () => {
  it("refuses to price when child pricing is on but no age band is configured", () => {
    const result = priceStay(config(), stay(1, [4]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_CONFIG");
    expect(result.message).toContain("no child age band is configured");
  });

  it("refuses to price when every configured band is inactive", () => {
    const result = priceStay(config({ childRules: [childRule({ isActive: false })] }), stay(1, [4]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_CONFIG");
  });

  it("refuses to price a child whose age is outside every band instead of making them free", () => {
    const rules = [childRule(), childRule({ id: "child-6-12", name: "Child", minAge: 6, maxAge: 12, amount: 800 })];
    const result = priceStay(config({ childRules: rules }), stay(1, [15]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_CONFIG");
    expect(result.message).toContain("aged 15");
    expect(result.message).toContain("record the guest as an adult");
  });

  it("charges the matching band for each child", () => {
    const rules = [
      childRule({ amount: 0 }),
      childRule({ id: "child-6-12", name: "Child", minAge: 6, maxAge: 12, chargeType: "PERCENT_OF_ADULT", amount: 50 }),
    ];
    const result = priceStay(config({ childRules: rules }), stay(2, [3, 8]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 2 nights x (0 for the toddler + 50% of 10,000 for the 8-year-old)
    expect(result.totals.extras).toBe(2 * (0 + 5000));
    // The free toddler produces no charge line; the 8-year-old does.
    expect(result.lines.filter((line) => line.kind === "CHILD")).toHaveLength(1);
  });

  it("prices unnamed children with the youngest band (documented default, never free)", () => {
    const rules = [childRule(), childRule({ id: "child-6-12", minAge: 6, maxAge: 12, amount: 800 })];
    const result = priceStay(config({ childRules: rules }), stay(2));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Both children fall in the 0-5 band: 2 children x 500 x 2 nights
    expect(result.totals.extras).toBe(2000);
  });

  it("does not charge for children when the hotel switched child pricing off", () => {
    const settings = { ...config().settings, useChildPricing: false };
    const result = priceStay(config({ settings }), stay(1, [4]));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totals.extras).toBe(0);
    expect(result.lines.filter((line) => line.kind === "CHILD")).toHaveLength(0);
  });
});
