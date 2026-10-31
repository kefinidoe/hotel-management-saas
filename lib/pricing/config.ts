import { prisma } from "@/lib/prisma";
import {
  DEFAULT_PRICING_SETTINGS,
  type HotelPricingConfig,
  type PricingSettings,
} from "./types";
import {
  PricingUnavailableError,
  describeError,
  invalidPricingConfig,
  isMissingTableError,
} from "./errors";
import {
  assertPricingDelegates,
  requirePricingDelegate,
  type PricingModelName,
} from "./delegates";

/**
 * Load one hotel's pricing configuration for the engine.
 *
 * Two properties matter here:
 *   1. every query is filtered by `hotelId`, so the config object can only ever
 *      describe the caller's hotel;
 *   2. the read either returns a *complete* configuration or throws
 *      `PricingUnavailableError`. It never degrades to an empty configuration,
 *      because an empty configuration would price rooms from `RoomType.baseRate`
 *      while silently ignoring occupancy rates, meal plans, adjustments, extra
 *      beds, child bands and taxes — i.e. it would charge the guest the wrong
 *      amount without anyone noticing.
 *
 * The one intended fallback is explicit and narrow: a hotel that has never
 * opened the Pricing page has no `HotelPricingSettings` row, and is priced by
 * its room type base rate (`LEGACY_BASE_RATE`). That is a product decision, it
 * is seeded that way, and it is covered by tests. It is different from "the
 * pricing tables could not be read", which is a failure and throws.
 */

type Reader = Record<string, unknown>;

function clientFor(client: unknown): Reader {
  return (client ?? (prisma as unknown as Reader)) as Reader;
}

/**
 * Read one model for this hotel.
 *
 * Missing delegate  → `PRISMA_CLIENT_STALE`  (generated client is out of date)
 * Missing table     → `PRICING_TABLES_MISSING` (migrations not applied)
 * Any other failure → `PRICING_CONFIG_UNREADABLE`
 *
 * In none of those cases is an empty list returned.
 */
async function readMany<T>(source: Reader, delegate: PricingModelName, args: unknown): Promise<T[]> {
  const model = requirePricingDelegate(source, delegate, "pricing configuration read");
  try {
    return (await model.findMany(args)) as T[];
  } catch (error) {
    if (isMissingTableError(error)) {
      throw new PricingUnavailableError(
        "PRICING_TABLES_MISSING",
        `Reading ${delegate} failed because the table is missing: ${describeError(error)}`,
        undefined,
        { cause: error }
      );
    }
    throw new PricingUnavailableError(
      "PRICING_CONFIG_UNREADABLE",
      `Reading ${delegate} failed: ${describeError(error)}`,
      undefined,
      { cause: error }
    );
  }
}

const num = (value: unknown): number => (value === null || value === undefined ? 0 : Number(value));
const day = (value: unknown): Date | null => (value instanceof Date ? value : null);

/**
 * Refuse a configuration that cannot produce a correct price.
 *
 * These are states in which the hotel has switched a pricing rule on but has
 * nothing for the engine to apply. Charging without the rule would under-bill the
 * guest (or the hotel), so the booking is stopped with an explanation instead.
 * A hotel that has switched the rule *off* is unaffected: that is a deliberate
 * product choice, not an error.
 */
export function assertPricingConfigUsable(config: HotelPricingConfig): void {
  const { settings } = config;

  if (settings.pricingModel === "ROOM_TYPE_OCCUPANCY" && settings.useOccupancyRates) {
    const activeOccupancies = config.occupancies.filter((option) => option.isActive);
    if (activeOccupancies.length === 0) {
      throw invalidPricingConfig(
        `hotel ${config.hotelId}: pricingModel=ROOM_TYPE_OCCUPANCY, useOccupancyRates=true, but no active OccupancyType row`,
        "Occupancy pricing is switched on for this hotel, but no occupancy option is configured. Add one on the Pricing page before selling rooms."
      );
    }
    const activeRates = config.roomTypeOccupancies.filter((row) => row.isActive);
    if (activeRates.length === 0) {
      throw invalidPricingConfig(
        `hotel ${config.hotelId}: pricingModel=ROOM_TYPE_OCCUPANCY, useOccupancyRates=true, but no active RoomTypeOccupancy row`,
        "Occupancy pricing is switched on for this hotel, but no occupancy rate is configured. Set the room rates on the Pricing page before selling rooms."
      );
    }
  }

  if (settings.useTaxes && config.taxes.filter((rule) => rule.isActive).length === 0) {
    throw invalidPricingConfig(
      `hotel ${config.hotelId}: useTaxes=true but no active TaxRule row`,
      "Taxes are switched on for this hotel, but no tax rule is configured. Add a tax rule or switch taxes off on the Pricing page — a booking cannot be priced without it."
    );
  }
}

export async function loadPricingConfig(
  hotelId: string,
  currency: string,
  client?: unknown
): Promise<HotelPricingConfig> {
  const source = clientFor(client);
  // Check the shape once, with a message that names the whole contract, before
  // any individual read can fail with a bare TypeError.
  assertPricingDelegates(source, "pricing configuration read");

  const [settingsRow, roomTypes, occupancies, roomTypeOccupancies, mealPlans, mealPlanRoomTypes, adjustments, extraBeds, childRules, taxes, hotels] =
    await Promise.all([
      readMany<Record<string, unknown>>(source, "hotelPricingSettings", { where: { hotelId }, take: 1 }),
      readMany<Record<string, unknown>>(source, "roomType", {
        where: { hotelId },
        select: { id: true, name: true, baseRate: true, capacity: true },
      }),
      readMany<Record<string, unknown>>(source, "occupancyType", {
        where: { hotelId },
        orderBy: { sortOrder: "asc" },
      }),
      readMany<Record<string, unknown>>(source, "roomTypeOccupancy", { where: { hotelId } }),
      readMany<Record<string, unknown>>(source, "mealPlanConfig", {
        where: { hotelId },
        orderBy: { sortOrder: "asc" },
      }),
      readMany<Record<string, unknown>>(source, "mealPlanRoomType", { where: { hotelId } }),
      readMany<Record<string, unknown>>(source, "rateAdjustment", { where: { hotelId } }),
      readMany<Record<string, unknown>>(source, "extraBedRule", { where: { hotelId } }),
      readMany<Record<string, unknown>>(source, "childPricingRule", { where: { hotelId } }),
      readMany<Record<string, unknown>>(source, "taxRule", { where: { hotelId }, orderBy: { sortOrder: "asc" } }),
      // Currency is authoritative on the Hotel row; the caller may pass a cached
      // value but we only trust this read when it is available.
      readMany<Record<string, unknown>>(source, "hotel", {
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
    : // No settings row: the hotel has never opened the Pricing page and is
      // sold at its room type base rate. Documented default, not a failure.
      { ...DEFAULT_PRICING_SETTINGS };

  const config: HotelPricingConfig = {
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

  assertPricingConfigUsable(config);
  return config;
}
