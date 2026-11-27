import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  accommodationRequired,
  accommodationRequiredExact,
  folioTotalsExact,
  hasMaxDecimalPlaces,
  parseMoneyDecimal,
  roundMoney,
  roundMoneyDecimal,
} from "@/lib/billing";
import { computeAvailablePortions, formatQty, getStockStatus } from "@/lib/inventory";
import { manualSubscriptionPaymentSchema } from "@/lib/manual-subscription-payment";
import { BillingInterval, calculateBandPricing } from "@/lib/plans";
import { calculateUniversalNightlyRate } from "@/lib/pricing";
import { calculateCustomNightlyRate, priceCustomStay } from "@/lib/pricing/custom-rate-rules";
import { priceStay } from "@/lib/pricing/engine";
import { priceModularStay } from "@/lib/pricing/modular";
import { DEFAULT_PRICING_SETTINGS, type HotelPricingConfig } from "@/lib/pricing/types";

const utcDay = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function buildPricingConfig(overrides: Partial<HotelPricingConfig> = {}): HotelPricingConfig {
  return {
    hotelId: "hotel-a2",
    currency: "KES",
    settings: {
      ...DEFAULT_PRICING_SETTINGS,
      pricingModel: "ROOM_TYPE_OCCUPANCY",
      useOccupancyRates: true,
    },
    roomTypes: [{ id: "rt-1", name: "Deluxe", baseRate: 333.33, capacity: 4 }],
    occupancies: [
      {
        id: "occ-1",
        name: "Double",
        minAdults: 1,
        maxAdults: 4,
        maxChildren: 3,
        sortOrder: 1,
        isActive: true,
      },
    ],
    roomTypeOccupancies: [
      { roomTypeId: "rt-1", occupancyTypeId: "occ-1", nightlyRate: 333.33, isActive: true },
    ],
    mealPlans: [],
    adjustments: [],
    extraBeds: [],
    childRules: [],
    taxes: [],
    ...overrides,
  };
}

describe("Phase A2: exact Decimal rounding & money validation", () => {
  it("avoids binary float rounding traps at half-cent boundaries and normalizes negative zero", () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(2.675)).toBe(2.68);
    expect(roundMoney(1000.005)).toBe(1000.01);
    expect(roundMoney(-1.005)).toBe(-1);
    expect(Object.is(roundMoney(-0.001), 0)).toBe(true);
    expect(Object.is(roundMoney(-0), 0)).toBe(true);
    expect(roundMoneyDecimal(new Decimal("0.1").plus("0.2")).toString()).toBe("0.3");
  });

  it("validates decimal places without floating-point epsilon false positives", () => {
    expect(hasMaxDecimalPlaces(19.99, 2)).toBe(true);
    expect(hasMaxDecimalPlaces("100.25", 2)).toBe(true);
    expect(hasMaxDecimalPlaces(new Decimal("12.34"), 2)).toBe(true);
    expect(hasMaxDecimalPlaces(19.999, 2)).toBe(false);
    expect(hasMaxDecimalPlaces("100.251", 2)).toBe(false);
    expect(hasMaxDecimalPlaces(Number.NaN, 2)).toBe(false);
    expect(hasMaxDecimalPlaces(Number.POSITIVE_INFINITY, 2)).toBe(false);
    expect(hasMaxDecimalPlaces("", 2)).toBe(false);
  });

  it("parses and bounds monetary inputs strictly", () => {
    expect(parseMoneyDecimal("1234.56", "Amount").toString()).toBe("1234.56");
    expect(Object.is(parseMoneyDecimal("-0", "Discount", { allowZero: true }).toNumber(), 0)).toBe(true);
    expect(() => parseMoneyDecimal(0, "Payment")).toThrow(/greater than zero/i);
    expect(() => parseMoneyDecimal("12.345", "Payment")).toThrow(/two decimal places/i);
    expect(() => parseMoneyDecimal("100000000.00", "Payment")).toThrow(/too large/i);
  });

  it("computes multi-room accommodation totals cleanly without penny drift", () => {
    const exact = accommodationRequiredExact(["19.99", "29.99"], 3, "5.55");
    expect(exact.toString()).toBe("144.39");
    expect(accommodationRequired([19.99, 29.99], 3, 5.55)).toBe(144.39);
  });

  it("reconciles fractional folio totals across historical strings and decimals", () => {
    const exact = folioTotalsExact(["19.99", "0.10", "0.20"], ["0.10", "0.20"]);
    expect(exact.required.toString()).toBe("20.29");
    expect(exact.balance.toString()).toBe("19.99");
  });
});

describe("Phase A2: Decimal pricing engines (occupancy, modular, custom rules)", () => {
  it("prices seasonal percentage adjustments, child percentage rules, percentage discounts, and taxes in Decimal", () => {
    const result = priceStay(
      buildPricingConfig({
        settings: {
          ...DEFAULT_PRICING_SETTINGS,
          pricingModel: "ROOM_TYPE_OCCUPANCY",
          useOccupancyRates: true,
          useSeasonalPricing: true,
          useChildPricing: true,
          useTaxes: true,
        },
        adjustments: [
          {
            id: "adj-1",
            name: "Peak +12.5%",
            kind: "SEASONAL",
            adjustmentType: "PERCENT",
            amount: 12.5,
            daysOfWeek: [],
            startDate: utcDay("2026-12-01"),
            endDate: utcDay("2026-12-31"),
            roomTypeId: null,
            priority: 1,
            isActive: true,
          },
        ],
        childRules: [
          {
            id: "ch-1",
            name: "Child 50%",
            minAge: 0,
            maxAge: 12,
            chargeType: "PERCENT_OF_ADULT",
            amount: 50,
            isActive: true,
          },
        ],
        taxes: [
          {
            id: "tax-vat",
            name: "VAT 16%",
            basis: "PERCENT",
            amount: 16,
            appliesTo: "ALL",
            chargeBasis: "PER_STAY",
            isInclusive: false,
            sortOrder: 1,
            isActive: true,
          },
          {
            id: "tax-levy",
            name: "Levy 2% incl",
            basis: "PERCENT",
            amount: 2,
            appliesTo: "ROOM",
            chargeBasis: "PER_STAY",
            isInclusive: true,
            sortOrder: 2,
            isActive: true,
          },
        ],
      }),
      {
        roomTypeId: "rt-1",
        occupancyTypeId: "occ-1",
        checkIn: utcDay("2026-12-10"),
        checkOut: utcDay("2026-12-13"),
        adults: 2,
        children: 1,
        childAges: [8],
        discountPercent: 10,
      }
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Room: 333.33 * 3 = 999.99; Adjusted per night: 333.33 * 1.125 = 374.99625 -> 375.00 (+41.67/night -> +125.01)
    expect(result.totals.room).toBe(999.99);
    expect(result.totals.adjustments).toBe(125.01);
    // Child: 333.33 * 50% * 3 = 499.995 -> 500.00
    expect(result.totals.extras).toBe(500);
    expect(result.totals.subtotal).toBe(1625);
    // Discount: 1625 * 10% = 162.50 -> net 1462.50
    expect(result.totals.discount).toBe(162.5);
    // Exclusive VAT: 1462.50 * 16% = 234.00; Inclusive Levy on ROOM (1125): 1125 * 2% = 22.50
    expect(result.totals.tax).toBe(256.5);
    expect(result.totals.grandTotal).toBe(1696.5);
  });

  it("computes universal & modular pricing with fractional rates without float drift", () => {
    const rate = calculateUniversalNightlyRate({
      baseRate: "33.33",
      extraAdultFee: "10.10",
      mealPlan: "HALF_BOARD",
      adults: 2,
      children: 1,
      hotelMealRates: [
        { mealPlan: "HALF_BOARD", adultSurcharge: "5.55", childSurcharge: "2.25", isActive: true },
      ],
    });
    expect(rate).toBe(56.78);

    const modular = priceModularStay({
      currency: "USD",
      roomType: {
        id: "rt-mod",
        name: "Suite",
        baseRate: "33.33",
        extraAdultFee: "10.10",
        maxAdults: 3,
        maxChildren: 2,
      },
      mealPlan: "HALF_BOARD",
      mealRates: [
        { mealPlan: "HALF_BOARD", adultSurcharge: "5.55", childSurcharge: "2.25", isActive: true },
      ],
      adults: 2,
      children: 1,
      checkIn: utcDay("2026-11-10"),
      checkOut: utcDay("2026-11-13"),
      discount: 0.3,
    });

    expect(modular.effectiveNightlyRate).toBe(56.78);
    expect(modular.totals.subtotal).toBe(170.34);
    expect(modular.totals.grandTotal).toBe(170.04);
  });

  it("computes custom rate rules without binary float drift on fractional surcharges", () => {
    const nightly = calculateCustomNightlyRate({
      baseRate: "100.10",
      adults: 3,
      children: 1,
      meal: { pricePerNight: 0.1, perGuest: true, isActive: true },
      occupancy: { includedAdults: 2, surchargeAmount: 0.2, extraAdultRate: 15.55, isActive: true },
    });
    expect(nightly.occupancyTotal).toBe(15.75);
    expect(nightly.mealTotal).toBe(0.4);
    expect(nightly.nightlyRate).toBe(116.25);

    const stay = priceCustomStay({
      currency: "USD",
      roomType: { id: "rt-c", name: "Villa", baseRate: "100.10", maxAdults: 4, maxChildren: 2 },
      meal: { id: "m-1", name: "Breakfast", pricePerNight: 0.1, perGuest: true, isActive: true },
      occupancy: {
        id: "o-1",
        label: "Triple",
        includedAdults: 2,
        surchargeAmount: 0.2,
        extraAdultRate: 15.55,
        isActive: true,
      },
      adults: 3,
      children: 1,
      checkIn: utcDay("2026-11-10"),
      checkOut: utcDay("2026-11-13"),
      discount: 0.3,
    });
    expect(stay.totals.subtotal).toBe(348.75);
    expect(stay.totals.grandTotal).toBe(348.45);
  });
});

describe("Phase A2: inventory portions, subscription pricing & validation precision", () => {
  it("computes exact available portions without float division undercounting (0.3 / 0.1 === 3)", () => {
    const res = computeAvailablePortions(
      [{ inventoryItemId: "inv-1", name: "Saffron", unit: "g", quantityPerBatch: "0.1", currentStock: "0.3" }],
      1
    );
    expect(res).toEqual({ portions: 3, limitingItem: "Saffron" });

    expect(computeAvailablePortions(
      [{ inventoryItemId: "inv-1", name: "Flour", unit: "g", quantityPerBatch: "100", currentStock: "500" }],
      0
    )).toEqual({ portions: 0, limitingItem: null });

    expect(getStockStatus("0", "10")).toBe("OUT_OF_STOCK");
    expect(getStockStatus("5", "10")).toBe("CRITICAL");
    expect(getStockStatus("5.01", "10")).toBe("LOW_STOCK");
    expect(getStockStatus("10.01", "10")).toBe("IN_STOCK");
    expect(formatQty("2500", "g")).toBe("2.50 kg");
  });

  it("computes yearly band pricing with exact Decimal division and validates payment amounts", () => {
    const bandPricing = calculateBandPricing({
      roomCount: 5,
      billingInterval: BillingInterval.YEARLY,
      currency: "USD",
    });
    expect(bandPricing.calculatedPrice).toBe(280);
    expect(bandPricing.monthlyEquivalent).toBe(23.33);
    expect(bandPricing.savingsVsMonthly).toBe(56);

    expect(
      manualSubscriptionPaymentSchema.safeParse({
        action: "ACTIVATE_MANUAL_PAYMENT",
        referenceCode: "REF123",
        amountPaid: 100.123,
        durationDays: 30,
        reason: "Verified deposit",
      }).success
    ).toBe(false);
  });
});
