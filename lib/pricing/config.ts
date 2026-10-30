import { prisma } from "@/lib/prisma";
import {
  DEFAULT_PRICING_SETTINGS,
  type HotelPricingConfig,
  type PricingSettings,
} from "./types";

/**
 * Load one hotel's pricing configuration for the engine.
 *
 * Two properties matter here:
 *   1. every query is filtered by `hotelId`, so the config object can only ever
 *      describe the caller's hotel;
 *   2. if the pricing tables are not present yet (an installation that has not
 *      run the migration, or a test double without those delegates) the hotel
 *      falls back to its existing `RoomType.baseRate` behaviour instead of
 *      failing. A hotel that has never opened the pricing page keeps selling
 *      rooms exactly as it did before this feature existed.
 */

type AnyDelegate = { findMany?: (args: unknown) => Promise<unknown[]> } | undefined;

let warnedAboutMissingTables = false;

function delegate(name: string): AnyDelegate {
  return (prisma as unknown as Record<string, AnyDelegate>)[name];
}

async function safeFindMany<T>(name: string, args: unknown): Promise<T[]> {
  const model = delegate(name);
  if (!model?.findMany) return [];
  try {
    return (await model.findMany(args)) as T[];
  } catch (error) {
    if (!warnedAboutMissingTables) {
      warnedAboutMissingTables = true;
      console.warn(
        `[pricing] pricing tables unavailable (${error instanceof Error ? error.message : error}); using room type base rates.`
      );
    }
    return [];
  }
}

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const day = (value: unknown): Date | null => (value instanceof Date ? value : null);

export async function loadPricingConfig(
  hotelId: string,
  currency: string
): Promise<HotelPricingConfig> {
  const [settingsRow, roomTypes, occupancies, roomTypeOccupancies, mealPlans, mealPlanRoomTypes, adjustments, extraBeds, childRules, taxes, hotels] =
    await Promise.all([
      safeFindMany<Record<string, unknown>>("hotelPricingSettings", { where: { hotelId }, take: 1 }),
      safeFindMany<Record<string, unknown>>("roomType", {
        where: { hotelId },
        select: { id: true, name: true, baseRate: true, capacity: true },
      }),
      safeFindMany<Record<string, unknown>>("occupancyType", {
        where: { hotelId },
        orderBy: { sortOrder: "asc" },
      }),
      safeFindMany<Record<string, unknown>>("roomTypeOccupancy", { where: { hotelId } }),
      safeFindMany<Record<string, unknown>>("mealPlanConfig", {
        where: { hotelId },
        orderBy: { sortOrder: "asc" },
      }),
      safeFindMany<Record<string, unknown>>("mealPlanRoomType", { where: { hotelId } }),
      safeFindMany<Record<string, unknown>>("rateAdjustment", { where: { hotelId } }),
      safeFindMany<Record<string, unknown>>("extraBedRule", { where: { hotelId } }),
      safeFindMany<Record<string, unknown>>("childPricingRule", { where: { hotelId } }),
      safeFindMany<Record<string, unknown>>("taxRule", { where: { hotelId }, orderBy: { sortOrder: "asc" } }),
      // Currency is authoritative on the Hotel row; the caller may pass a cached
      // value but we only trust this read when it is available.
      safeFindMany<Record<string, unknown>>("hotel", {
        where: { id: hotelId },
        select: { currency: true },
        take: 1,
      }),
    ]);

  const settingsRowValue = settingsRow[0];
  const settings: PricingSettings = settingsRowValue
    ? {
        pricingModel: settingsRowValue.pricingModel as PricingSettings["pricingModel"],
        useOccupancyRates: Boolean(settingsRowValue.useOccupancyRates),
        useMealPlans: Boolean(settingsRowValue.useMealPlans),
        useSeasonalPricing: Boolean(settingsRowValue.useSeasonalPricing),
        useWeekendPricing: Boolean(settingsRowValue.useWeekendPricing),
        useChildPricing: Boolean(settingsRowValue.useChildPricing),
        useExtraBeds: Boolean(settingsRowValue.useExtraBeds),
        useTaxes: Boolean(settingsRowValue.useTaxes),
        pricesIncludeTax: Boolean(settingsRowValue.pricesIncludeTax),
      }
    : { ...DEFAULT_PRICING_SETTINGS };

  return {
    hotelId,
    currency: (hotels[0]?.currency as string | undefined) ?? currency,
    settings,
    roomTypes: roomTypes.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      baseRate: num(row.baseRate),
      capacity: Number(row.capacity ?? 1),
    })),
    occupancies: occupancies.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      minAdults: Number(row.minAdults ?? 1),
      maxAdults: Number(row.maxAdults ?? 4),
      maxChildren: Number(row.maxChildren ?? 0),
      sortOrder: Number(row.sortOrder ?? 0),
      isActive: Boolean(row.isActive),
    })),
    roomTypeOccupancies: roomTypeOccupancies.map((row) => ({
      roomTypeId: String(row.roomTypeId),
      occupancyTypeId: String(row.occupancyTypeId),
      nightlyRate: num(row.nightlyRate),
      isActive: Boolean(row.isActive),
    })),
    mealPlans: mealPlans.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      pricingBasis: row.pricingBasis as HotelPricingConfig["mealPlans"][number]["pricingBasis"],
      charge: num(row.charge),
      effectiveFrom: day(row.effectiveFrom),
      effectiveTo: day(row.effectiveTo),
      isActive: Boolean(row.isActive),
      roomTypeIds: mealPlanRoomTypes
        .filter((link) => String(link.mealPlanId) === String(row.id))
        .map((link) => String(link.roomTypeId)),
    })),
    adjustments: adjustments.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      kind: row.kind as HotelPricingConfig["adjustments"][number]["kind"],
      adjustmentType: row.adjustmentType as HotelPricingConfig["adjustments"][number]["adjustmentType"],
      amount: num(row.amount),
      daysOfWeek: Array.isArray(row.daysOfWeek) ? (row.daysOfWeek as number[]) : [],
      startDate: day(row.startDate),
      endDate: day(row.endDate),
      roomTypeId: (row.roomTypeId as string | null) ?? null,
      priority: Number(row.priority ?? 0),
      isActive: Boolean(row.isActive),
    })),
    extraBeds: extraBeds.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      roomTypeId: (row.roomTypeId as string | null) ?? null,
      nightlyRate: num(row.nightlyRate),
      childRate: row.childRate === null || row.childRate === undefined ? null : num(row.childRate),
      maxPerRoom: Number(row.maxPerRoom ?? 1),
      isActive: Boolean(row.isActive),
    })),
    childRules: childRules.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      minAge: Number(row.minAge ?? 0),
      maxAge: Number(row.maxAge ?? 12),
      chargeType: row.chargeType as HotelPricingConfig["childRules"][number]["chargeType"],
      amount: num(row.amount),
      isActive: Boolean(row.isActive),
    })),
    taxes: taxes.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      basis: row.basis as HotelPricingConfig["taxes"][number]["basis"],
      amount: num(row.amount),
      appliesTo: row.appliesTo as HotelPricingConfig["taxes"][number]["appliesTo"],
      chargeBasis: row.chargeBasis as HotelPricingConfig["taxes"][number]["chargeBasis"],
      isInclusive: Boolean(row.isInclusive),
      sortOrder: Number(row.sortOrder ?? 0),
      isActive: Boolean(row.isActive),
    })),
  };
}
