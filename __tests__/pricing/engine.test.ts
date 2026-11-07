import { describe, expect, it } from "vitest";
import { priceStay } from "@/lib/pricing/engine";
import {
  DEFAULT_PRICING_SETTINGS,
  type HotelPricingConfig,
  type PricingSettings,
} from "@/lib/pricing/types";

/**
 * The pricing engine is the single place a stay is priced. These tests pin the
 * arithmetic for every configurable feature so a hotel's configuration — not a
 * hardcoded assumption — decides what a guest pays.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function config(overrides: Partial<HotelPricingConfig> = {}): HotelPricingConfig {
  const settings: PricingSettings = {
    ...DEFAULT_PRICING_SETTINGS,
    pricingModel: "ROOM_TYPE_OCCUPANCY",
    useOccupancyRates: true,
  };
  return {
    hotelId: "hotel-a",
    currency: "KES",
    settings,
    roomTypes: [
      { id: "rt-deluxe", name: "Deluxe Room", baseRate: 6000, capacity: 4 },
      { id: "rt-standard", name: "Standard Room", baseRate: 4500, capacity: 2 },
    ],
    occupancies: [
      { id: "occ-single", name: "Single", minAdults: 1, maxAdults: 1, maxChildren: 0, sortOrder: 1, isActive: true },
      { id: "occ-double", name: "Double", minAdults: 2, maxAdults: 2, maxChildren: 1, sortOrder: 2, isActive: true },
      { id: "occ-twin", name: "Twin", minAdults: 2, maxAdults: 2, maxChildren: 2, sortOrder: 3, isActive: true },
      { id: "occ-family", name: "Family", minAdults: 2, maxAdults: 4, maxChildren: 3, sortOrder: 4, isActive: true },
    ],
    roomTypeOccupancies: [
      { roomTypeId: "rt-deluxe", occupancyTypeId: "occ-single", nightlyRate: 6000, isActive: true },
      { roomTypeId: "rt-deluxe", occupancyTypeId: "occ-double", nightlyRate: 8500, isActive: true },
      { roomTypeId: "rt-deluxe", occupancyTypeId: "occ-twin", nightlyRate: 9000, isActive: true },
      { roomTypeId: "rt-deluxe", occupancyTypeId: "occ-family", nightlyRate: 11000, isActive: true },
      { roomTypeId: "rt-standard", occupancyTypeId: "occ-single", nightlyRate: 4500, isActive: true },
      { roomTypeId: "rt-standard", occupancyTypeId: "occ-double", nightlyRate: 5500, isActive: true },
    ],
    mealPlans: [],
    adjustments: [],
    extraBeds: [],
    childRules: [],
    taxes: [],
    ...overrides,
  };
}

const stay = (nights: number, adults = 2, children = 0) => ({
  roomTypeId: "rt-deluxe",
  occupancyTypeId: "occ-double",
  checkIn: day("2026-11-10"),
  checkOut: day(`2026-11-${10 + nights}`),
  adults,
  children,
});

describe("occupancy pricing", () => {
  it("prices single, double, twin and a custom occupancy from configuration", () => {
    const cases = [
      ["occ-single", 1, 6000],
      ["occ-double", 2, 8500],
      ["occ-twin", 2, 9000],
      ["occ-family", 3, 11000],
    ] as const;

    for (const [occupancyTypeId, adults, expected] of cases) {
      const result = priceStay(config(), { ...stay(2, adults), occupancyTypeId });
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.nightlyRate).toBe(expected);
      expect(result.totals.room).toBe(expected * 2);
    }
  });

  it("uses a different rate for a different room type", () => {
    const result = priceStay(config(), { ...stay(1, 1), roomTypeId: "rt-standard", occupancyTypeId: "occ-single" });
    expect(result.ok && result.nightlyRate).toBe(4500);
  });

  it("rejects an occupancy the room type is not sold as", () => {
    const result = priceStay(config(), { ...stay(1), roomTypeId: "rt-standard", occupancyTypeId: "occ-twin" });
    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_OCCUPANCY" });
  });

  it("rejects an occupancy from another hotel's configuration", () => {
    const result = priceStay(config(), { ...stay(1), occupancyTypeId: "occ-foreign" });
    expect(result).toMatchObject({ ok: false, code: "UNSUPPORTED_OCCUPANCY" });
  });

  it("rejects an unknown room type", () => {
    const result = priceStay(config(), { ...stay(1), roomTypeId: "rt-other-hotel" });
    expect(result).toMatchObject({ ok: false, code: "ROOM_TYPE_NOT_FOUND" });
  });

  it("requires an occupancy when the hotel prices by occupancy", () => {
    const result = priceStay(config(), { ...stay(1), occupancyTypeId: null });
    expect(result).toMatchObject({ ok: false, code: "OCCUPANCY_REQUIRED" });
  });

  it("refuses a zero or missing configured rate instead of pricing at nothing", () => {
    const result = priceStay(
      config({
        roomTypeOccupancies: [
          { roomTypeId: "rt-deluxe", occupancyTypeId: "occ-double", nightlyRate: 0, isActive: true },
        ],
      }),
      stay(1)
    );
    expect(result).toMatchObject({ ok: false, code: "RATE_NOT_CONFIGURED" });
  });

  it("validates the guest count against the occupancy limits", () => {
    const tooManyAdults = priceStay(config(), { ...stay(1, 3), occupancyTypeId: "occ-double" });
    expect(tooManyAdults).toMatchObject({ ok: false, code: "CAPACITY_EXCEEDED" });

    const tooFewAdults = priceStay(config(), { ...stay(1, 1), occupancyTypeId: "occ-double" });
    expect(tooFewAdults).toMatchObject({ ok: false, code: "CAPACITY_EXCEEDED" });
  });

  it("validates total guests against room capacity", () => {
    const result = priceStay(
      config({
        occupancies: [
          { id: "occ-double", name: "Double", minAdults: 1, maxAdults: 4, maxChildren: 4, sortOrder: 1, isActive: true },
        ],
      }),
      { ...stay(1, 3, 2), roomTypeId: "rt-standard", occupancyTypeId: "occ-double" }
    );
    expect(result).toMatchObject({ ok: false, code: "CAPACITY_EXCEEDED" });
  });
});

describe("legacy base-rate pricing", () => {
  it("prices from the room type base rate when the hotel has not configured occupancy rates", () => {
    const result = priceStay(
      config({ settings: { ...DEFAULT_PRICING_SETTINGS } }),
      { ...stay(2), occupancyTypeId: null }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pricingModel).toBe("LEGACY_BASE_RATE");
    expect(result.nightlyRate).toBe(6000);
    expect(result.totals.grandTotal).toBe(12000);
  });

  it("refuses a zero base rate", () => {
    const result = priceStay(
      config({
        settings: { ...DEFAULT_PRICING_SETTINGS },
        roomTypes: [{ id: "rt-deluxe", name: "Deluxe Room", baseRate: 0, capacity: 2 }],
      }),
      { ...stay(1), occupancyTypeId: null }
    );
    expect(result).toMatchObject({ ok: false, code: "RATE_NOT_CONFIGURED" });
  });
});

describe("meal plans", () => {
  const mealConfig = (basis: string, charge: number, useMealPlans = true) =>
    config({
      settings: { ...config().settings, useMealPlans },
      mealPlans: [
        {
          id: "mp-half",
          name: "Half Board",
          pricingBasis: basis as never,
          charge,
          effectiveFrom: null,
          effectiveTo: null,
          isActive: true,
          roomTypeIds: [],
        },
      ],
    });

  it("charges per person per night", () => {
    const result = priceStay(mealConfig("PER_PERSON_PER_NIGHT", 1500), { ...stay(2, 2), mealPlanId: "mp-half" });
    expect(result.ok && result.totals.meals).toBe(6000); // 1500 x 2 people x 2 nights
    expect(result.ok && result.totals.grandTotal).toBe(23000); // 8500 x 2 + 6000
  });

  it("charges per room per night", () => {
    const result = priceStay(mealConfig("PER_ROOM_PER_NIGHT", 2000), { ...stay(3, 2), mealPlanId: "mp-half" });
    expect(result.ok && result.totals.meals).toBe(6000);
  });

  it("charges per person per stay", () => {
    const result = priceStay(mealConfig("PER_PERSON_PER_STAY", 1000), { ...stay(2, 2), mealPlanId: "mp-half" });
    expect(result.ok && result.totals.meals).toBe(2000);
  });

  it("charges per room per stay", () => {
    const result = priceStay(mealConfig("PER_ROOM_PER_STAY", 3000), { ...stay(4, 2), mealPlanId: "mp-half" });
    expect(result.ok && result.totals.meals).toBe(3000);
  });

  it("counts children as persons on a per-person basis", () => {
    const result = priceStay(mealConfig("PER_PERSON_PER_NIGHT", 800), { ...stay(1, 2, 1), mealPlanId: "mp-half" });
    expect(result.ok && result.totals.meals).toBe(2400); // 800 x 3 people x 1 night
  });

  it("ignores a meal plan when the hotel has not enabled meal plan pricing", () => {
    const result = priceStay(mealConfig("PER_PERSON_PER_NIGHT", 1500, false), { ...stay(2, 2), mealPlanId: "mp-half" });
    expect(result).toMatchObject({ ok: false, code: "MEAL_PLAN_NOT_AVAILABLE" });
  });

  it("refuses a meal plan restricted to other room types", () => {
    const base = mealConfig("PER_PERSON_PER_NIGHT", 1500);
    const result = priceStay(
      { ...base, mealPlans: base.mealPlans.map((plan) => ({ ...plan, roomTypeIds: ["rt-standard"] })) },
      { ...stay(1, 2, 0), mealPlanId: "mp-half" }
    );
    expect(result).toMatchObject({ ok: false, code: "MEAL_PLAN_NOT_AVAILABLE" });
  });

  it("refuses a meal plan outside its effective dates", () => {
    const base = mealConfig("PER_PERSON_PER_NIGHT", 1500);
    const result = priceStay(
      {
        ...base,
        mealPlans: base.mealPlans.map((plan) => ({
          ...plan,
          effectiveFrom: day("2027-01-01"),
          effectiveTo: day("2027-02-01"),
        })),
      },
      { ...stay(1, 2, 0), mealPlanId: "mp-half" }
    );
    expect(result).toMatchObject({ ok: false, code: "MEAL_PLAN_NOT_AVAILABLE" });
  });
});

describe("seasonal and weekend adjustments", () => {
  const peak = {
    id: "adj-peak",
    name: "Peak season",
    kind: "SEASONAL" as const,
    adjustmentType: "PERCENT" as const,
    amount: 25,
    daysOfWeek: [],
    startDate: day("2026-12-20"),
    endDate: day("2027-01-05"),
    roomTypeId: null,
    priority: 10,
    isActive: true,
  };

  it("applies a seasonal percentage only to the nights inside the range", () => {
    const result = priceStay(
      config({ settings: { ...config().settings, useSeasonalPricing: true }, adjustments: [peak] }),
      { ...stay(4, 2), checkIn: day("2026-12-18"), checkOut: day("2026-12-22") }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 2 nights at 8,500 then 2 nights at 8,500 x 1.25
    expect(result.totals.room).toBe(34000);
    expect(result.totals.adjustments).toBe(4250);
    expect(result.perNight.map((night) => night.rate)).toEqual([8500, 8500, 10625, 10625]);
  });

  it("ignores seasonal rules when the hotel has not enabled them", () => {
    const result = priceStay(config({ adjustments: [peak] }), {
      ...stay(2, 2),
      checkIn: day("2026-12-24"),
      checkOut: day("2026-12-26"),
    });
    expect(result.ok && result.totals.adjustments).toBe(0);
  });

  it("applies weekend pricing on the hotel's own weekend days", () => {
    const weekend = {
      id: "adj-weekend",
      name: "Weekend",
      kind: "WEEKEND" as const,
      adjustmentType: "FIXED_PER_NIGHT" as const,
      amount: 750,
      daysOfWeek: [5, 6], // Friday, Saturday
      startDate: null,
      endDate: null,
      roomTypeId: null,
      priority: 0,
      isActive: true,
    };
    // 2026-11-13 is a Friday, 2026-11-14 a Saturday, 2026-11-15 a Sunday.
    const result = priceStay(
      config({ settings: { ...config().settings, useWeekendPricing: true }, adjustments: [weekend] }),
      { ...stay(3, 2), checkIn: day("2026-11-13"), checkOut: day("2026-11-16") }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totals.adjustments).toBe(1500);
    expect(result.perNight.map((night) => night.rate)).toEqual([9250, 9250, 8500]);
  });

  it("supports a set nightly rate for an event", () => {
    const event = {
      id: "adj-event",
      name: "Concert",
      kind: "SEASONAL" as const,
      adjustmentType: "SET_RATE" as const,
      amount: 15000,
      daysOfWeek: [],
      startDate: day("2026-11-11"),
      endDate: day("2026-11-11"),
      roomTypeId: null,
      priority: 0,
      isActive: true,
    };
    const result = priceStay(
      config({ settings: { ...config().settings, useSeasonalPricing: true }, adjustments: [event] }),
      { ...stay(2, 2), checkIn: day("2026-11-11"), checkOut: day("2026-11-13") }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.perNight.map((night) => night.rate)).toEqual([15000, 8500]);
  });
});

describe("extras: extra beds and children", () => {
  const extraConfig = config({
    settings: { ...config().settings, useExtraBeds: true, useChildPricing: true },
    extraBeds: [
      { id: "eb-1", name: "Extra bed", roomTypeId: null, nightlyRate: 1200, childRate: null, maxPerRoom: 2, isActive: true },
    ],
    childRules: [
      { id: "ch-1", name: "Child 0-5", minAge: 0, maxAge: 5, chargeType: "FIXED_PER_NIGHT", amount: 500, isActive: true },
      { id: "ch-2", name: "Child 6-12", minAge: 6, maxAge: 12, chargeType: "PERCENT_OF_ADULT", amount: 50, isActive: true },
    ],
  });

  it("charges extra beds per bed per night", () => {
    const result = priceStay(extraConfig, { ...stay(2, 2, 0), extraBeds: 1 });
    expect(result.ok && result.totals.extras).toBe(2400);
  });

  it("refuses more extra beds than the rule allows", () => {
    // Room capacity is high enough for 3 beds here, so the limit that refuses the
    // request is the extra-bed rule itself rather than the room capacity.
    const roomy = {
      ...extraConfig,
      roomTypes: [{ id: "rt-deluxe", name: "Deluxe Room", baseRate: 6000, capacity: 8 }],
    };
    const result = priceStay(roomy, { ...stay(1, 2, 0), extraBeds: 3 });
    expect(result).toMatchObject({ ok: false, code: "EXTRA_BEDS_UNAVAILABLE" });
  });

  it("charges a child in the matching age band", () => {
    const result = priceStay(extraConfig, { ...stay(1, 2, 1), childAges: [4] });
    expect(result.ok && result.totals.extras).toBe(500);
  });

  it("charges a percentage of the adult rate for an older child", () => {
    const result = priceStay(extraConfig, { ...stay(2, 2, 1), childAges: [8] });
    // 50% of 8,500 x 2 nights
    expect(result.ok && result.totals.extras).toBe(8500);
  });

  it("does not charge children when the hotel has not enabled child pricing", () => {
    const result = priceStay(
      config({ settings: { ...config().settings, useChildPricing: false } }),
      { ...stay(1, 2, 1), childAges: [4] }
    );
    expect(result.ok && result.totals.extras).toBe(0);
  });
});

describe("discounts and taxes", () => {
  it("applies a fixed discount", () => {
    const result = priceStay(config(), { ...stay(2, 2), discount: 1000 });
    expect(result.ok && result.totals.discount).toBe(1000);
    expect(result.ok && result.totals.grandTotal).toBe(16000);
  });

  it("applies a percentage discount", () => {
    const result = priceStay(config(), { ...stay(2, 2), discountPercent: 10 });
    expect(result.ok && result.totals.discount).toBe(1700);
    expect(result.ok && result.totals.grandTotal).toBe(15300);
  });

  it("refuses a discount larger than the stay", () => {
    const result = priceStay(config(), { ...stay(1, 2), discount: 999999 });
    expect(result).toMatchObject({ ok: false, code: "INVALID_DISCOUNT" });
  });

  it("adds a percentage tax to the total", () => {
    const result = priceStay(
      config({
        settings: { ...config().settings, useTaxes: true },
        taxes: [
          { id: "tax-vat", name: "VAT", basis: "PERCENT", amount: 16, appliesTo: "ALL", chargeBasis: "PER_STAY", isInclusive: false, sortOrder: 0, isActive: true },
        ],
      }),
      stay(2, 2)
    );
    expect(result.ok && result.totals.tax).toBe(2720); // 16% of 17,000
    expect(result.ok && result.totals.grandTotal).toBe(19720);
  });

  it("charges a fixed per-night service charge", () => {
    const result = priceStay(
      config({
        settings: { ...config().settings, useTaxes: true },
        taxes: [
          { id: "tax-svc", name: "Service", basis: "FIXED", amount: 200, appliesTo: "ROOM", chargeBasis: "PER_NIGHT", isInclusive: false, sortOrder: 0, isActive: true },
        ],
      }),
      stay(3, 2)
    );
    expect(result.ok && result.totals.tax).toBe(600);
  });

  it("charges taxes on meals only when configured that way", () => {
    const base = config({
      settings: { ...config().settings, useTaxes: true, useMealPlans: true },
      mealPlans: [
        { id: "mp-half", name: "Half Board", pricingBasis: "PER_PERSON_PER_NIGHT", charge: 1500, effectiveFrom: null, effectiveTo: null, isActive: true, roomTypeIds: [] },
      ],
      taxes: [
        { id: "tax-meals", name: "Meal levy", basis: "PERCENT", amount: 10, appliesTo: "MEALS", chargeBasis: "PER_STAY", isInclusive: false, sortOrder: 0, isActive: true },
      ],
    });
    const result = priceStay(base, { ...stay(2, 2), mealPlanId: "mp-half" });
    expect(result.ok && result.totals.meals).toBe(6000);
    expect(result.ok && result.totals.tax).toBe(600);
  });

  it("does not add inclusive tax on top of the total", () => {
    const result = priceStay(
      config({
        settings: { ...config().settings, useTaxes: true, pricesIncludeTax: true },
        taxes: [
          { id: "tax-inc", name: "VAT (included)", basis: "PERCENT", amount: 16, appliesTo: "ALL", chargeBasis: "PER_STAY", isInclusive: true, sortOrder: 0, isActive: true },
        ],
      }),
      stay(2, 2)
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.totals.grandTotal).toBe(17000);
    expect(result.totals.tax).toBe(2720);
  });
});

describe("dates, precision and currency", () => {
  it("rejects a checkout that is not after check-in", () => {
    const result = priceStay(config(), {
      ...stay(1, 2),
      checkOut: day("2026-11-10"),
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_DATES" });
  });

  it("rejects a partial night", () => {
    const result = priceStay(config(), {
      ...stay(1, 2),
      checkIn: new Date("2026-11-10T12:00:00.000Z"),
      checkOut: new Date("2026-11-11T09:00:00.000Z"),
    });
    expect(result).toMatchObject({ ok: false, code: "INVALID_DATES" });
  });

  it("counts nights across a month boundary", () => {
    const result = priceStay(config(), {
      ...stay(1, 2),
      checkIn: day("2026-11-29"),
      checkOut: day("2026-12-02"),
    });
    expect(result.ok && result.nights).toBe(3);
    expect(result.ok && result.totals.room).toBe(25500);
  });

  it("keeps money to two decimals", () => {
    const result = priceStay(
      config({
        roomTypeOccupancies: [
          { roomTypeId: "rt-deluxe", occupancyTypeId: "occ-double", nightlyRate: 1000.005, isActive: true },
        ],
      }),
      stay(1, 2)
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Number.isInteger(result.totals.grandTotal * 100)).toBe(true);
  });

  it("reports the hotel's own currency", () => {
    expect(priceStay(config(), stay(1, 2)).ok && (priceStay(config(), stay(1, 2)) as { currency: string }).currency).toBe("KES");
    expect(
      (priceStay(config({ currency: "USD" }), stay(1, 2)) as { currency: string }).currency
    ).toBe("USD");
    expect(
      (priceStay(config({ currency: "EUR" }), stay(1, 2)) as { currency: string }).currency
    ).toBe("EUR");
  });

  it("rejects a non-integer adult count", () => {
    const result = priceStay(config(), { ...stay(1, 2), adults: 1.5 });
    expect(result).toMatchObject({ ok: false, code: "INVALID_GUESTS" });
  });
});
