import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { parseMoney } from "@/lib/billing";
import { assertPricingDelegates } from "./delegates";

/**
 * Pricing configuration: reading, validating and writing one hotel's settings.
 *
 * Every write is scoped by `hotelId` and every cross-reference (room type,
 * occupancy option) is re-checked against that hotel before it is stored, so a
 * crafted request cannot attach another hotel's record to this one.
 *
 * Each entry point first proves the Prisma Client can serve the pricing models
 * (`assertPricingDelegates`). Without that check a client generated from an older
 * schema fails here with `TypeError: Cannot read properties of undefined`, which
 * is the crash this module used to produce on the Pricing & Rates page. With it,
 * the caller gets `PricingUnavailableError("PRISMA_CLIENT_STALE")` and a 503 that
 * names the fix.
 */

function assertPricingClient(context: string): void {
  assertPricingDelegates(prisma as unknown, context);
}

export class PricingConfigError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const MEAL_PLAN_BASES = ["PER_PERSON_PER_NIGHT", "PER_ROOM_PER_NIGHT", "PER_PERSON_PER_STAY", "PER_ROOM_PER_STAY"] as const;
const ADJUSTMENT_KINDS = ["SEASONAL", "WEEKEND"] as const;
const ADJUSTMENT_TYPES = ["PERCENT", "FIXED_PER_NIGHT", "SET_RATE"] as const;
const CHILD_CHARGE_TYPES = ["FIXED_PER_NIGHT", "PERCENT_OF_ADULT"] as const;
const TAX_BASES = ["PERCENT", "FIXED"] as const;
const TAX_APPLIES_TO = ["ROOM", "MEALS", "ALL"] as const;
const TAX_CHARGE_BASES = ["PER_NIGHT", "PER_STAY", "PER_PERSON_PER_NIGHT"] as const;
const PRICING_MODELS = ["ROOM_TYPE_OCCUPANCY", "LEGACY_BASE_RATE"] as const;

export const PRICING_ENTITIES = [
  "occupancy-types",
  "meal-plans",
  "adjustments",
  "extra-beds",
  "child-rules",
  "tax-rules",
] as const;

export type PricingEntity = (typeof PRICING_ENTITIES)[number];

export function isPricingEntity(value: string): value is PricingEntity {
  return (PRICING_ENTITIES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// primitive validators
// ---------------------------------------------------------------------------
function str(value: unknown, label: string, { max = 120, required = true } = {}): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (required) throw new PricingConfigError(`${label} is required.`);
    return "";
  }
  if (text.length > max) throw new PricingConfigError(`${label} must be ${max} characters or fewer.`);
  return text;
}

function int(value: unknown, label: string, { min, max }: { min: number; max: number }): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new PricingConfigError(`${label} must be a whole number between ${min} and ${max}.`);
  }
  return parsed;
}

function bool(value: unknown, fallback = true): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function optionalMoney(value: unknown, label: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  return parseMoney(value, label, { allowZero: true });
}

function requiredMoney(value: unknown, label: string): number {
  return parseMoney(value, label, { allowZero: true });
}

function optionalDate(value: unknown, label: string): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new PricingConfigError(`${label} must be a valid date.`);
  return date;
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  const match = allowed.find((option) => option === value);
  if (!match) throw new PricingConfigError(`${label} must be one of: ${allowed.join(", ")}.`);
  return match;
}

// ---------------------------------------------------------------------------
// tenant-safe reference checks
// ---------------------------------------------------------------------------
async function assertRoomType(hotelId: string, roomTypeId: string | null, client: Prisma.TransactionClient): Promise<string | null> {
  if (!roomTypeId) return null;
  const found = await client.roomType.findUnique({
    where: { id_hotelId: { id: roomTypeId, hotelId } },
    select: { id: true },
  });
  if (!found) throw new PricingConfigError("That room type does not belong to this hotel.", 404);
  return found.id;
}

async function assertOccupancy(hotelId: string, occupancyTypeId: string, client: Prisma.TransactionClient): Promise<string> {
  const found = await client.occupancyType.findUnique({
    where: { id_hotelId: { id: occupancyTypeId, hotelId } },
    select: { id: true },
  });
  if (!found) throw new PricingConfigError("That occupancy option does not belong to this hotel.", 404);
  return found.id;
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------
export async function listPricingBundle(hotelId: string) {
  assertPricingClient("pricing configuration read");

  const [
    hotel,
    settings,
    roomTypes,
    occupancies,
    roomTypeOccupancies,
    mealPlans,
    mealPlanRoomTypes,
    adjustments,
    extraBeds,
    childRules,
    taxes,
  ] = await Promise.all([
    prisma.hotel.findUnique({ where: { id: hotelId }, select: { currency: true, name: true } }),
    prisma.hotelPricingSettings.findUnique({ where: { hotelId } }),
    prisma.roomType.findMany({
      where: { hotelId },
      select: { id: true, name: true, baseRate: true, capacity: true, mealPlan: true },
      orderBy: { name: "asc" },
    }),
    prisma.occupancyType.findMany({ where: { hotelId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.roomTypeOccupancy.findMany({ where: { hotelId } }),
    prisma.mealPlanConfig.findMany({ where: { hotelId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.mealPlanRoomType.findMany({ where: { hotelId } }),
    prisma.rateAdjustment.findMany({ where: { hotelId }, orderBy: [{ kind: "asc" }, { priority: "desc" }] }),
    prisma.extraBedRule.findMany({ where: { hotelId } }),
    prisma.childPricingRule.findMany({ where: { hotelId }, orderBy: { minAge: "asc" } }),
    prisma.taxRule.findMany({ where: { hotelId }, orderBy: [{ sortOrder: "asc" }] }),
  ]);

  const toNumber = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));

  return {
    currency: hotel?.currency ?? "USD",
    hotelName: hotel?.name ?? "",
    settings:
      settings ??
      {
        pricingModel: "LEGACY_BASE_RATE" as const,
        useOccupancyRates: false,
        useMealPlans: false,
        useSeasonalPricing: false,
        useWeekendPricing: false,
        useChildPricing: false,
        useExtraBeds: false,
        useTaxes: false,
        pricesIncludeTax: false,
      },
    roomTypes: roomTypes.map((type) => ({
      id: type.id,
      name: type.name,
      baseRate: toNumber(type.baseRate),
      capacity: type.capacity,
      mealPlan: type.mealPlan,
      rates: roomTypeOccupancies
        .filter((row) => row.roomTypeId === type.id)
        .map((row) => ({
          id: row.id,
          occupancyTypeId: row.occupancyTypeId,
          nightlyRate: toNumber(row.nightlyRate),
          isActive: row.isActive,
        })),
    })),
    occupancies: occupancies.map((option) => ({
      ...option,
      createdAt: option.createdAt.toISOString(),
      updatedAt: option.updatedAt.toISOString(),
    })),
    mealPlans: mealPlans.map((plan) => ({
      ...plan,
      charge: toNumber(plan.charge),
      effectiveFrom: plan.effectiveFrom?.toISOString() ?? null,
      effectiveTo: plan.effectiveTo?.toISOString() ?? null,
      createdAt: plan.createdAt.toISOString(),
      updatedAt: plan.updatedAt.toISOString(),
      roomTypeIds: mealPlanRoomTypes
        .filter((link) => link.mealPlanId === plan.id)
        .map((link) => link.roomTypeId),
    })),
    adjustments: adjustments.map((row) => ({
      ...row,
      amount: toNumber(row.amount),
      startDate: row.startDate?.toISOString() ?? null,
      endDate: row.endDate?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    extraBeds: extraBeds.map((row) => ({
      ...row,
      nightlyRate: toNumber(row.nightlyRate),
      childRate: row.childRate === null ? null : toNumber(row.childRate),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    childRules: childRules.map((row) => ({
      ...row,
      amount: toNumber(row.amount),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
    taxes: taxes.map((row) => ({
      ...row,
      amount: toNumber(row.amount),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
export async function updatePricingSettings(hotelId: string, body: Record<string, unknown>, client: Prisma.TransactionClient = prisma) {
  assertPricingClient("pricing settings update");

  const data: Record<string, unknown> = {};
  if (body.pricingModel !== undefined) {
    data.pricingModel = enumValue(body.pricingModel, PRICING_MODELS, "Pricing model");
  }
  for (const flag of [
    "useOccupancyRates",
    "useMealPlans",
    "useSeasonalPricing",
    "useWeekendPricing",
    "useChildPricing",
    "useExtraBeds",
    "useTaxes",
    "pricesIncludeTax",
  ] as const) {
    if (body[flag] !== undefined) data[flag] = Boolean(body[flag]);
  }

  // A switch that is on with nothing for the engine to apply cannot be sold
  // safely: the booking either stops with an error the receptionist cannot fix,
  // or the rule is skipped and the guest is under-charged. Refuse the save here,
  // where a manager sees the message, instead of at the front desk.
  //
  // The check is on the *effective* state after this request, so a hotel that is
  // already inconsistent has to be repaired before any other change is saved.
  const existing = await client.hotelPricingSettings.findUnique({ where: { hotelId } });
  const effective = {
    pricingModel: (data.pricingModel as string | undefined) ?? existing?.pricingModel ?? "LEGACY_BASE_RATE",
    useOccupancyRates: data.useOccupancyRates !== undefined ? Boolean(data.useOccupancyRates) : Boolean(existing?.useOccupancyRates),
    useMealPlans: data.useMealPlans !== undefined ? Boolean(data.useMealPlans) : Boolean(existing?.useMealPlans),
    useChildPricing: data.useChildPricing !== undefined ? Boolean(data.useChildPricing) : Boolean(existing?.useChildPricing),
    useExtraBeds: data.useExtraBeds !== undefined ? Boolean(data.useExtraBeds) : Boolean(existing?.useExtraBeds),
    useTaxes: data.useTaxes !== undefined ? Boolean(data.useTaxes) : Boolean(existing?.useTaxes),
  };

  if (effective.pricingModel === "ROOM_TYPE_OCCUPANCY" && effective.useOccupancyRates) {
    const occupancies = await client.occupancyType.count({ where: { hotelId, isActive: true } });
    const rates = await client.roomTypeOccupancy.count({ where: { hotelId, isActive: true } });
    if (occupancies === 0 && rates === 0) {
      throw new PricingConfigError(
        "Add at least one occupancy option and an occupancy rate before switching occupancy pricing on.",
        400
      );
    }
    if (occupancies === 0) {
      throw new PricingConfigError(
        "Add at least one occupancy option before switching occupancy pricing on.",
        400
      );
    }
    if (rates === 0) {
      throw new PricingConfigError(
        "Add at least one occupancy rate before switching occupancy pricing on.",
        400
      );
    }
  }

  if (effective.useTaxes) {
    const taxes = await client.taxRule.count({ where: { hotelId, isActive: true } });
    if (taxes === 0) {
      throw new PricingConfigError(
        "Add at least one tax rule before switching taxes on — otherwise a booking cannot be priced.",
        400
      );
    }
  }

  if (effective.useChildPricing) {
    const rules = await client.childPricingRule.count({ where: { hotelId, isActive: true } });
    if (rules === 0) {
      throw new PricingConfigError(
        "Add at least one child age band before switching child pricing on.",
        400
      );
    }
  }

  if (effective.useMealPlans) {
    const plans = await client.mealPlanConfig.count({ where: { hotelId, isActive: true } });
    if (plans === 0) {
      throw new PricingConfigError(
        "Add at least one meal plan before switching meal-plan pricing on.",
        400
      );
    }
  }

  if (effective.useExtraBeds) {
    const rules = await client.extraBedRule.count({ where: { hotelId, isActive: true } });
    if (rules === 0) {
      throw new PricingConfigError(
        "Add at least one extra-bed rule before switching extra beds on.",
        400
      );
    }
  }

  const settings = await client.hotelPricingSettings.upsert({
    where: { hotelId },
    update: data,
    create: { hotelId, ...data },
  });
  return settings;
}

// ---------------------------------------------------------------------------
// room type × occupancy rates
// ---------------------------------------------------------------------------
export async function setRoomTypeRates(
  hotelId: string,
  body: Record<string, unknown>,
  client: Prisma.TransactionClient
) {
  assertPricingClient("room rate update");

  const roomTypeId = await assertRoomType(hotelId, String(body.roomTypeId ?? ""), client);
  if (!roomTypeId) throw new PricingConfigError("Choose a room type to set rates for.");

  const rows = Array.isArray(body.rates) ? (body.rates as Record<string, unknown>[]) : [];
  if (rows.length === 0) throw new PricingConfigError("Provide at least one occupancy rate.");

  const results: unknown[] = [];
  for (const row of rows) {
    const occupancyTypeId = await assertOccupancy(hotelId, String(row.occupancyTypeId ?? ""), client);
    if (row.nightlyRate === null || row.nightlyRate === "" || row.nightlyRate === undefined) {
      // No rate for this occupancy: remove the pairing rather than storing zero.
      await client.roomTypeOccupancy.deleteMany({ where: { hotelId, roomTypeId, occupancyTypeId } });
      continue;
    }
    const nightlyRate = requiredMoney(row.nightlyRate, "Nightly rate");
    if (nightlyRate <= 0) {
      throw new PricingConfigError("Nightly rates must be greater than zero.");
    }
    const saved = await client.roomTypeOccupancy.upsert({
      where: { roomTypeId_occupancyTypeId: { roomTypeId, occupancyTypeId } },
      update: { nightlyRate, isActive: bool(row.isActive, true), hotelId },
      create: {
        hotelId,
        roomTypeId,
        occupancyTypeId,
        nightlyRate,
        isActive: bool(row.isActive, true),
      },
    });
    results.push(saved);
  }

  // Keep the hotel's headline price in step with its single-occupancy rate so the
  // Rooms page and reports stay meaningful for legacy readers.
  const baseRow = await client.roomTypeOccupancy.findFirst({
    where: { hotelId, roomTypeId, isActive: true },
    orderBy: { occupancyType: { sortOrder: "asc" } },
  });
  if (baseRow) {
    await client.roomType.update({
      where: { id_hotelId: { id: roomTypeId, hotelId } },
      data: { baseRate: baseRow.nightlyRate },
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// generic entity writes
// ---------------------------------------------------------------------------
export async function createEntity(
  entity: PricingEntity,
  hotelId: string,
  body: Record<string, unknown>,
  client: Prisma.TransactionClient
) {
  assertPricingClient(`pricing ${entity} create`);

  switch (entity) {
    case "occupancy-types":
      return client.occupancyType.create({
        data: {
          hotelId,
          name: str(body.name, "Name", { max: 60 }),
          description: str(body.description, "Description", { required: false }),
          minAdults: int(body.minAdults ?? 1, "Minimum adults", { min: 0, max: 20 }),
          maxAdults: int(body.maxAdults ?? 2, "Maximum adults", { min: 1, max: 20 }),
          maxChildren: int(body.maxChildren ?? 0, "Maximum children", { min: 0, max: 20 }),
          sortOrder: int(body.sortOrder ?? 0, "Order", { min: 0, max: 999 }),
          isActive: bool(body.isActive),
        },
      });

    case "meal-plans": {
      // Validate the room-type links *before* writing, so a request that names
      // another hotel's room type cannot leave a half-created meal plan behind.
      await assertRoomTypes(hotelId, body.roomTypeIds, client);
      const plan = await client.mealPlanConfig.create({
        data: {
          hotelId,
          name: str(body.name, "Name", { max: 80 }),
          description: str(body.description, "Description", { required: false }),
          includedItems: Array.isArray(body.includedItems)
            ? (body.includedItems as unknown[]).map((item) => String(item)).filter(Boolean).slice(0, 20)
            : [],
          pricingBasis: enumValue(body.pricingBasis, MEAL_PLAN_BASES, "Pricing basis"),
          charge: requiredMoney(body.charge ?? 0, "Charge"),
          effectiveFrom: optionalDate(body.effectiveFrom, "Valid from"),
          effectiveTo: optionalDate(body.effectiveTo, "Valid to"),
          sortOrder: int(body.sortOrder ?? 0, "Order", { min: 0, max: 999 }),
          isActive: bool(body.isActive),
        },
      });
      await syncMealPlanRoomTypes(hotelId, plan.id, body.roomTypeIds, client);
      return plan;
    }

    case "adjustments":
      return client.rateAdjustment.create({
        data: {
          hotelId,
          roomTypeId: await assertRoomType(hotelId, body.roomTypeId ? String(body.roomTypeId) : null, client),
          name: str(body.name, "Name", { max: 80 }),
          kind: enumValue(body.kind, ADJUSTMENT_KINDS, "Kind"),
          adjustmentType: enumValue(body.adjustmentType, ADJUSTMENT_TYPES, "Adjustment type"),
          amount: adjustmentAmount(body),
          daysOfWeek: daysOfWeek(body.daysOfWeek),
          startDate: optionalDate(body.startDate, "Start date"),
          endDate: optionalDate(body.endDate, "End date"),
          priority: int(body.priority ?? 0, "Priority", { min: 0, max: 100 }),
          isActive: bool(body.isActive),
        },
      });

    case "extra-beds":
      return client.extraBedRule.create({
        data: {
          hotelId,
          roomTypeId: await assertRoomType(hotelId, body.roomTypeId ? String(body.roomTypeId) : null, client),
          name: str(body.name, "Name", { max: 80 }),
          nightlyRate: optionalMoney(body.nightlyRate, "Nightly rate") ?? 0,
          childRate: optionalMoney(body.childRate, "Child rate"),
          maxPerRoom: int(body.maxPerRoom ?? 1, "Maximum per room", { min: 1, max: 10 }),
          isActive: bool(body.isActive),
        },
      });

    case "child-rules": {
      const minAge = int(body.minAge ?? 0, "Minimum age", { min: 0, max: 17 });
      const maxAge = int(body.maxAge ?? 12, "Maximum age", { min: 0, max: 17 });
      if (maxAge < minAge) throw new PricingConfigError("Maximum age must be at least the minimum age.");
      return client.childPricingRule.create({
        data: {
          hotelId,
          name: str(body.name, "Name", { max: 80 }),
          minAge,
          maxAge,
          chargeType: enumValue(body.chargeType, CHILD_CHARGE_TYPES, "Charge type"),
          amount: requiredMoney(body.amount ?? 0, "Amount"),
          isActive: bool(body.isActive),
        },
      });
    }

    case "tax-rules":
      return client.taxRule.create({
        data: {
          hotelId,
          name: str(body.name, "Name", { max: 80 }),
          basis: enumValue(body.basis ?? "PERCENT", TAX_BASES, "Basis"),
          amount: taxAmount(body),
          appliesTo: enumValue(body.appliesTo ?? "ALL", TAX_APPLIES_TO, "Applies to"),
          chargeBasis: enumValue(body.chargeBasis ?? "PER_STAY", TAX_CHARGE_BASES, "Charge basis"),
          isInclusive: bool(body.isInclusive, false),
          sortOrder: int(body.sortOrder ?? 0, "Order", { min: 0, max: 999 }),
          isActive: bool(body.isActive),
        },
      });
  }
}

export async function updateEntity(
  entity: PricingEntity,
  hotelId: string,
  id: string,
  body: Record<string, unknown>,
  client: Prisma.TransactionClient
) {
  assertPricingClient(`pricing ${entity} update`);

  switch (entity) {
    case "occupancy-types": {
      const existing = await client.occupancyType.findUnique({
        where: { id_hotelId: { id, hotelId } },
        select: { id: true },
      });
      if (!existing) throw new PricingConfigError("Occupancy option not found in this hotel.", 404);
      return client.occupancyType.update({
        where: { id_hotelId: { id, hotelId } },
        data: {
          ...(body.name !== undefined ? { name: str(body.name, "Name", { max: 60 }) } : {}),
          ...(body.description !== undefined
            ? { description: str(body.description, "Description", { required: false }) }
            : {}),
          ...(body.minAdults !== undefined
            ? { minAdults: int(body.minAdults, "Minimum adults", { min: 0, max: 20 }) }
            : {}),
          ...(body.maxAdults !== undefined
            ? { maxAdults: int(body.maxAdults, "Maximum adults", { min: 1, max: 20 }) }
            : {}),
          ...(body.maxChildren !== undefined
            ? { maxChildren: int(body.maxChildren, "Maximum children", { min: 0, max: 20 }) }
            : {}),
          ...(body.sortOrder !== undefined
            ? { sortOrder: int(body.sortOrder, "Order", { min: 0, max: 999 }) }
            : {}),
          ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
        },
      });
    }

    case "meal-plans": {
      const existing = await client.mealPlanConfig.findUnique({
        where: { id_hotelId: { id, hotelId } },
        select: { id: true },
      });
      if (!existing) throw new PricingConfigError("Meal plan not found in this hotel.", 404);
      const plan = await client.mealPlanConfig.update({
        where: { id_hotelId: { id, hotelId } },
        data: {
          ...(body.name !== undefined ? { name: str(body.name, "Name", { max: 80 }) } : {}),
          ...(body.description !== undefined
            ? { description: str(body.description, "Description", { required: false }) }
            : {}),
          ...(body.includedItems !== undefined
            ? {
                includedItems: Array.isArray(body.includedItems)
                  ? (body.includedItems as unknown[]).map((item) => String(item)).filter(Boolean).slice(0, 20)
                  : [],
              }
            : {}),
          ...(body.pricingBasis !== undefined
            ? { pricingBasis: enumValue(body.pricingBasis, MEAL_PLAN_BASES, "Pricing basis") }
            : {}),
          ...(body.charge !== undefined ? { charge: requiredMoney(body.charge, "Charge") } : {}),
          ...(body.effectiveFrom !== undefined
            ? { effectiveFrom: optionalDate(body.effectiveFrom, "Valid from") }
            : {}),
          ...(body.effectiveTo !== undefined
            ? { effectiveTo: optionalDate(body.effectiveTo, "Valid to") }
            : {}),
          ...(body.sortOrder !== undefined
            ? { sortOrder: int(body.sortOrder, "Order", { min: 0, max: 999 }) }
            : {}),
          ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
        },
      });
      if (body.roomTypeIds !== undefined) await syncMealPlanRoomTypes(hotelId, id, body.roomTypeIds, client);
      return plan;
    }

    case "adjustments": {
      const existing = await client.rateAdjustment.findUnique({
        where: { id_hotelId: { id, hotelId } },
        select: { id: true },
      });
      if (!existing) throw new PricingConfigError("Rate adjustment not found in this hotel.", 404);
      return client.rateAdjustment.update({
        where: { id_hotelId: { id, hotelId } },
        data: {
          ...(body.name !== undefined ? { name: str(body.name, "Name", { max: 80 }) } : {}),
          ...(body.kind !== undefined
            ? { kind: enumValue(body.kind, ADJUSTMENT_KINDS, "Kind") }
            : {}),
          ...(body.adjustmentType !== undefined || body.amount !== undefined
            ? {
                adjustmentType: enumValue(
                  body.adjustmentType ?? "PERCENT",
                  ADJUSTMENT_TYPES,
                  "Adjustment type"
                ),
                amount: adjustmentAmount(body),
              }
            : {}),
          ...(body.daysOfWeek !== undefined ? { daysOfWeek: daysOfWeek(body.daysOfWeek) } : {}),
          ...(body.startDate !== undefined ? { startDate: optionalDate(body.startDate, "Start date") } : {}),
          ...(body.endDate !== undefined ? { endDate: optionalDate(body.endDate, "End date") } : {}),
          ...(body.roomTypeId !== undefined
            ? { roomTypeId: await assertRoomType(hotelId, body.roomTypeId ? String(body.roomTypeId) : null, client) }
            : {}),
          ...(body.priority !== undefined
            ? { priority: int(body.priority, "Priority", { min: 0, max: 100 }) }
            : {}),
          ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
        },
      });
    }

    case "extra-beds": {
      const existing = await client.extraBedRule.findUnique({
        where: { id_hotelId: { id, hotelId } },
        select: { id: true },
      });
      if (!existing) throw new PricingConfigError("Extra bed rule not found in this hotel.", 404);
      return client.extraBedRule.update({
        where: { id_hotelId: { id, hotelId } },
        data: {
          ...(body.name !== undefined ? { name: str(body.name, "Name", { max: 80 }) } : {}),
          ...(body.nightlyRate !== undefined
            ? { nightlyRate: requiredMoney(body.nightlyRate, "Nightly rate") }
            : {}),
          ...(body.childRate !== undefined ? { childRate: optionalMoney(body.childRate, "Child rate") } : {}),
          ...(body.maxPerRoom !== undefined
            ? { maxPerRoom: int(body.maxPerRoom, "Maximum per room", { min: 1, max: 10 }) }
            : {}),
          ...(body.roomTypeId !== undefined
            ? { roomTypeId: await assertRoomType(hotelId, body.roomTypeId ? String(body.roomTypeId) : null, client) }
            : {}),
          ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
        },
      });
    }

    case "child-rules": {
      const existing = await client.childPricingRule.findUnique({
        where: { id_hotelId: { id, hotelId } },
        select: { id: true },
      });
      if (!existing) throw new PricingConfigError("Child pricing rule not found in this hotel.", 404);
      const minAge = body.minAge !== undefined ? int(body.minAge, "Minimum age", { min: 0, max: 17 }) : undefined;
      const maxAge = body.maxAge !== undefined ? int(body.maxAge, "Maximum age", { min: 0, max: 17 }) : undefined;
      if (minAge !== undefined && maxAge !== undefined && maxAge < minAge) {
        throw new PricingConfigError("Maximum age must be at least the minimum age.");
      }
      return client.childPricingRule.update({
        where: { id_hotelId: { id, hotelId } },
        data: {
          ...(body.name !== undefined ? { name: str(body.name, "Name", { max: 80 }) } : {}),
          ...(minAge !== undefined ? { minAge } : {}),
          ...(maxAge !== undefined ? { maxAge } : {}),
          ...(body.chargeType !== undefined
            ? { chargeType: enumValue(body.chargeType, CHILD_CHARGE_TYPES, "Charge type") }
            : {}),
          ...(body.amount !== undefined ? { amount: requiredMoney(body.amount, "Amount") } : {}),
          ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
        },
      });
    }

    case "tax-rules": {
      const existing = await client.taxRule.findUnique({
        where: { id_hotelId: { id, hotelId } },
        select: { id: true },
      });
      if (!existing) throw new PricingConfigError("Tax rule not found in this hotel.", 404);
      return client.taxRule.update({
        where: { id_hotelId: { id, hotelId } },
        data: {
          ...(body.name !== undefined ? { name: str(body.name, "Name", { max: 80 }) } : {}),
          ...(body.basis !== undefined ? { basis: enumValue(body.basis, TAX_BASES, "Basis") } : {}),
          ...(body.amount !== undefined ? { amount: taxAmount(body) } : {}),
          ...(body.appliesTo !== undefined
            ? { appliesTo: enumValue(body.appliesTo, TAX_APPLIES_TO, "Applies to") }
            : {}),
          ...(body.chargeBasis !== undefined
            ? { chargeBasis: enumValue(body.chargeBasis, TAX_CHARGE_BASES, "Charge basis") }
            : {}),
          ...(body.isInclusive !== undefined ? { isInclusive: Boolean(body.isInclusive) } : {}),
          ...(body.sortOrder !== undefined
            ? { sortOrder: int(body.sortOrder, "Order", { min: 0, max: 999 }) }
            : {}),
          ...(body.isActive !== undefined ? { isActive: Boolean(body.isActive) } : {}),
        },
      });
    }
  }
}

export async function deleteEntity(entity: PricingEntity, hotelId: string, id: string, client: Prisma.TransactionClient) {
  assertPricingClient(`pricing ${entity} delete`);

  switch (entity) {
    case "occupancy-types": {
      const used = await client.roomTypeOccupancy.count({ where: { hotelId, occupancyTypeId: id } });
      if (used > 0) {
        throw new PricingConfigError(
          "This occupancy option is used by room rates. Deactivate it instead of deleting it.",
          409
        );
      }
      return client.occupancyType.delete({ where: { id_hotelId: { id, hotelId } } });
    }
    case "meal-plans":
      return client.mealPlanConfig.delete({ where: { id_hotelId: { id, hotelId } } });
    case "adjustments":
      return client.rateAdjustment.delete({ where: { id_hotelId: { id, hotelId } } });
    case "extra-beds":
      return client.extraBedRule.delete({ where: { id_hotelId: { id, hotelId } } });
    case "child-rules":
      return client.childPricingRule.delete({ where: { id_hotelId: { id, hotelId } } });
    case "tax-rules":
      return client.taxRule.delete({ where: { id_hotelId: { id, hotelId } } });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function daysOfWeek(value: unknown): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new PricingConfigError("Weekend days must be a list of weekdays.");
  return value.map((day) => int(day, "Weekend day", { min: 0, max: 6 }));
}

function adjustmentAmount(body: Record<string, unknown>): number {
  const amount = Number(body.amount ?? 0);
  if (!Number.isFinite(amount)) throw new PricingConfigError("Amount must be a number.");
  if (body.adjustmentType === "PERCENT") {
    if (amount < -100 || amount > 500) {
      throw new PricingConfigError("A percentage adjustment must be between -100 and 500.");
    }
    return Math.round(amount * 100) / 100;
  }
  return parseMoney(amount, "Amount", { allowZero: true });
}

function taxAmount(body: Record<string, unknown>): number {
  const amount = Number(body.amount ?? 0);
  if (!Number.isFinite(amount) || amount < 0) throw new PricingConfigError("Amount must be zero or more.");
  if (body.basis === "PERCENT" && amount > 100) {
    throw new PricingConfigError("A percentage tax cannot exceed 100.");
  }
  return Math.round(amount * 100) / 100;
}

async function assertRoomTypes(hotelId: string, roomTypeIds: unknown, client: Prisma.TransactionClient): Promise<string[]> {
  if (!Array.isArray(roomTypeIds)) return [];
  const wanted: string[] = [];
  for (const raw of roomTypeIds) {
    const id = await assertRoomType(hotelId, String(raw), client);
    if (id) wanted.push(id);
  }
  return wanted;
}

async function syncMealPlanRoomTypes(hotelId: string, mealPlanId: string, roomTypeIds: unknown, client: Prisma.TransactionClient) {
  const wanted = await assertRoomTypes(hotelId, roomTypeIds, client);
  await client.mealPlanRoomType.deleteMany({ where: { hotelId, mealPlanId } });
  if (wanted.length > 0) {
    await client.mealPlanRoomType.createMany({
      data: wanted.map((roomTypeId) => ({ hotelId, mealPlanId, roomTypeId })),
    });
  }
}
