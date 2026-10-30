import { describe, expect, it } from "vitest";
import {
  resolveApprovedRate,
  tariffPricesStay,
  type TariffPricing,
} from "@/lib/tariffs";

/**
 * The reservation form and the reservation API both price a stay through these
 * helpers. Before this existed they only understood tariffs named
 * "Single/Double/Twin …", so a hotel with ordinary names ("Standard", "Deluxe")
 * could never create a reservation at all: the approved rate showed "--", the
 * submit button stayed disabled and the API rejected the request.
 */

const occupancyTariffs: TariffPricing[] = [
  { id: "t-single-bo", name: "Single - Bed Only", baseRate: "4500", mealPlan: "BED_ONLY" },
  { id: "t-single-bb", name: "Single - Bed & Breakfast", baseRate: 5200, mealPlan: "BED_AND_BREAKFAST" },
  { id: "t-double-bb", name: "Double - Bed & Breakfast", baseRate: 7800, mealPlan: "BED_AND_BREAKFAST" },
];

// Room types a hotel named after itself rather than after an occupancy: the
// name match finds nothing, so the room's own rate is what the guest pays.
const plainTariffs: TariffPricing[] = [
  { id: "t-standard", name: "Standard", baseRate: 5000, mealPlan: null },
  { id: "t-deluxe", name: "Deluxe Garden", baseRate: 8500, mealPlan: "BED_ONLY" },
];

describe("resolveApprovedRate", () => {
  it("prices from the room's own type, not from a name-matched tariff", () => {
    const result = resolveApprovedRate({
      tariffs: occupancyTariffs,
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
      roomTypeId: "t-double-bb",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("ROOM_TYPE");
    expect(result.tariff.id).toBe("t-double-bb");
    expect(result.rate).toBe(7800);
  });

  it("uses the occupancy tariff only when the room type has no usable rate", () => {
    const result = resolveApprovedRate({
      tariffs: [
        ...occupancyTariffs,
        { id: "t-blank", name: "Unpriced", baseRate: 0, mealPlan: null },
      ],
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
      roomTypeId: "t-blank",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("OCCUPANCY_TARIFF");
    expect(result.tariff.id).toBe("t-single-bo");
    expect(result.rate).toBe(4500);
  });

  it("falls back to the room's own type when no occupancy tariff matches", () => {
    const result = resolveApprovedRate({
      tariffs: plainTariffs,
      occupancy: "DOUBLE",
      mealPlan: "HALF_BOARD",
      roomTypeId: "t-standard",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toBe("ROOM_TYPE");
    expect(result.tariff.id).toBe("t-standard");
    expect(result.rate).toBe(5000);
  });

  it("prices the room the guest is actually in, not the first room type", () => {
    const standard = resolveApprovedRate({
      tariffs: plainTariffs,
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
      roomTypeId: "t-standard",
    });
    const deluxe = resolveApprovedRate({
      tariffs: plainTariffs,
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
      roomTypeId: "t-deluxe",
    });
    expect(standard.ok && standard.rate).toBe(5000);
    expect(deluxe.ok && deluxe.rate).toBe(8500);
  });

  it("reports NO_TARIFF when the hotel has no rate at all", () => {
    const result = resolveApprovedRate({
      tariffs: [],
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
      roomTypeId: "t-standard",
    });
    expect(result).toEqual({ ok: false, reason: "NO_TARIFF" });
  });

  it.each([
    ["zero", 0],
    ["negative", -100],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
  ])("refuses a %s rate instead of submitting it", (_label, baseRate) => {
    const result = resolveApprovedRate({
      tariffs: [{ id: "t-bad", name: "Standard", baseRate, mealPlan: null }],
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
      roomTypeId: "t-bad",
    });
    expect(result).toEqual({ ok: false, reason: "INVALID_TARIFF_RATE" });
  });

  it("falls back to the occupancy tariff when the room type rate is invalid", () => {
    const result = resolveApprovedRate({
      tariffs: [
        { id: "t-room", name: "Standard", baseRate: 0, mealPlan: null },
        { id: "t-single-bo", name: "Single - Bed Only", baseRate: 4500, mealPlan: "BED_ONLY" },
      ],
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
      roomTypeId: "t-room",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tariff.id).toBe("t-single-bo");
    expect(result.rate).toBe(4500);
  });

  it("does not fall back to a different room type's rate", () => {
    const result = resolveApprovedRate({
      tariffs: plainTariffs,
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
      roomTypeId: "t-missing",
    });
    expect(result.ok).toBe(false);
  });
});

describe("tariffPricesStay", () => {
  it("accepts the matching occupancy tariff", () => {
    expect(
      tariffPricesStay({ id: "t-single-bo", name: "Single - Bed Only", mealPlan: "BED_ONLY" }, "t-double-bb", "SINGLE", "BED_ONLY")
    ).toBe(true);
  });

  it("accepts the room's own room type", () => {
    expect(
      tariffPricesStay({ id: "t-standard", name: "Standard", mealPlan: null }, "t-standard", "DOUBLE", "HALF_BOARD")
    ).toBe(true);
  });

  it("rejects any other room type, so prices cannot be swapped", () => {
    expect(
      tariffPricesStay({ id: "t-deluxe", name: "Deluxe Garden", mealPlan: null }, "t-standard", "DOUBLE", "HALF_BOARD")
    ).toBe(false);
  });

  it("rejects a tariff whose meal plan differs when it is not the room type", () => {
    expect(
      tariffPricesStay({ id: "t-single-bb", name: "Single - Bed & Breakfast", mealPlan: "BED_AND_BREAKFAST" }, "t-standard", "SINGLE", "BED_ONLY")
    ).toBe(false);
  });
});
