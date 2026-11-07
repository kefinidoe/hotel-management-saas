import { describe, expect, it, vi } from "vitest";

/**
 * What happens when the pricing configuration cannot be read.
 *
 * The engine may only price from a complete configuration. Before this contract
 * existed, `lib/pricing/config.ts` turned a missing Prisma delegate, a missing
 * table and any other query failure into an empty configuration, and the engine
 * happily priced the stay from `RoomType.baseRate` — a silently wrong charge.
 * These tests pin the fail-closed behaviour and the one fallback that is
 * intended: a hotel that never opened the Pricing page.
 */

// The module under test imports the shared client at module scope; every case
// below passes its own client, so the real one must never be constructed here.
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { loadPricingConfig } from "@/lib/pricing/config";
import { PricingUnavailableError } from "@/lib/pricing/errors";
import {
  PRICING_MODEL_DELEGATES,
  assertPricingDelegates,
  missingPricingDelegates,
} from "@/lib/pricing/delegates";

type Rows = Partial<Record<string, Record<string, unknown>[]>>;

const baseSettings = (overrides: Record<string, unknown> = {}) => ({
  id: "settings-a",
  hotelId: "hotel-a",
  pricingModel: "LEGACY_BASE_RATE",
  useOccupancyRates: false,
  useMealPlans: false,
  useSeasonalPricing: false,
  useWeekendPricing: false,
  useChildPricing: false,
  useExtraBeds: false,
  useTaxes: false,
  pricesIncludeTax: false,
  ...overrides,
});

/**
 * A client shaped like a real generated one: every pricing delegate answers with
 * the rows it is given, and the `where.hotelId` it receives is recorded so the
 * tests can prove tenant scoping.
 */
function client(
  rows: Rows = {},
  options: { hide?: string[]; fail?: Record<string, Error>; record?: { hotelIds: (string | undefined)[] } } = {}
) {
  const source: Record<string, unknown> = {};
  for (const model of PRICING_MODEL_DELEGATES) {
    if (options.hide?.includes(model)) continue;
    source[model] = {
      findMany: async (args?: { where?: { hotelId?: string; id?: string } }) => {
        options.record?.hotelIds.push(args?.where?.hotelId ?? args?.where?.id);
        const failure = options.fail?.[model];
        if (failure) throw failure;
        return rows[model] ?? [];
      },
    };
  }
  return source;
}

const wellFormedRows = (): Rows => ({
  hotel: [{ id: "hotel-a", currency: "KES" }],
  hotelPricingSettings: [baseSettings()],
  roomType: [{ id: "rt-standard", name: "Standard", baseRate: 4500, capacity: 2 }],
});

async function failure(promise: Promise<unknown>): Promise<PricingUnavailableError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PricingUnavailableError);
    return error as PricingUnavailableError;
  }
  throw new Error("expected the pricing read to fail, but it resolved");
}

describe("pricing configuration cannot fail silently", () => {
  it("refuses to load when the generated client cannot serve hotelPricingSettings", async () => {
    // The original crash: `prisma.hotelPricingSettings` was undefined.
    const error = await failure(loadPricingConfig("hotel-a", "KES", client(wellFormedRows(), { hide: ["hotelPricingSettings"] })));

    expect(error.code).toBe("PRISMA_CLIENT_STALE");
    expect(error.status).toBe(503);
    expect(error.detail).toContain("hotelPricingSettings");
    expect(error.detail).toContain("npx prisma generate");
    // The caller-facing message says what to do, and never leaks internals.
    expect(error.message).toContain("database client is out of date");
    expect(error.message).not.toContain("hotelPricingSettings");
  });

  it("refuses to load when every pricing delegate is missing", async () => {
    const error = await failure(loadPricingConfig("hotel-a", "KES", {}));
    expect(error.code).toBe("PRISMA_CLIENT_STALE");
    for (const model of PRICING_MODEL_DELEGATES) {
      expect(error.detail).toContain(model);
    }
  });

  it("turns a failed query into PRICING_CONFIG_UNREADABLE, never into an empty configuration", async () => {
    const error = await failure(
      loadPricingConfig(
        "hotel-a",
        "KES",
        client(wellFormedRows(), {
          fail: { taxRule: Object.assign(new Error("connection terminated unexpectedly"), { code: "P1001" }) },
        })
      )
    );
    expect(error.code).toBe("PRICING_CONFIG_UNREADABLE");
    expect(error.detail).toContain("taxRule");
    expect(error.message).toContain("no price can be quoted");
  });

  it("distinguishes a missing pricing table from a transient failure", async () => {
    const error = await failure(
      loadPricingConfig(
        "hotel-a",
        "KES",
        client(wellFormedRows(), {
          fail: { occupancyType: Object.assign(new Error('relation "OccupancyType" does not exist'), { code: "P2021" }) },
        })
      )
    );
    expect(error.code).toBe("PRICING_TABLES_MISSING");
  });

  it("scopes every pricing read to the hotel it was given", async () => {
    const record = { hotelIds: [] as (string | undefined)[] };
    await loadPricingConfig("hotel-b", "KES", client(wellFormedRows(), { record }));

    expect(record.hotelIds).toHaveLength(PRICING_MODEL_DELEGATES.length);
    expect(record.hotelIds.every((id) => id === "hotel-b")).toBe(true);
  });
});

describe("the one intended fallback: a hotel with no pricing configuration", () => {
  it("loads LEGACY_BASE_RATE defaults when there is no settings row and no rules", async () => {
    const config = await loadPricingConfig(
      "hotel-a",
      "KES",
      client({ hotel: [{ id: "hotel-a", currency: "KES" }], roomType: [{ id: "rt-standard", name: "Standard", baseRate: 4500, capacity: 2 }] })
    );

    expect(config.settings.pricingModel).toBe("LEGACY_BASE_RATE");
    expect(config.settings.useOccupancyRates).toBe(false);
    expect(config.settings.useTaxes).toBe(false);
    expect(config.occupancies).toEqual([]);
    expect(config.taxes).toEqual([]);
  });

  it("keeps optional rule lists empty when the hotel switched the feature off", async () => {
    const config = await loadPricingConfig("hotel-a", "KES", client(wellFormedRows()));
    expect(config.adjustments).toEqual([]);
    expect(config.childRules).toEqual([]);
    expect(config.extraBeds).toEqual([]);
  });
});

describe("a switched-on rule is never ignored", () => {
  it("refuses a hotel that switched taxes on without a tax rule", async () => {
    const rows = wellFormedRows();
    rows.hotelPricingSettings = [baseSettings({ useTaxes: true })];

    const error = await failure(loadPricingConfig("hotel-a", "KES", client(rows)));
    expect(error.code).toBe("PRICING_CONFIG_INVALID");
    expect(error.message).toContain("no tax rule is configured");
  });

  it("refuses occupancy pricing with no occupancy options", async () => {
    const rows = wellFormedRows();
    rows.hotelPricingSettings = [baseSettings({ pricingModel: "ROOM_TYPE_OCCUPANCY", useOccupancyRates: true })];

    const error = await failure(loadPricingConfig("hotel-a", "KES", client(rows)));
    expect(error.code).toBe("PRICING_CONFIG_INVALID");
    expect(error.message).toContain("no occupancy option");
  });

  it("refuses occupancy pricing with no occupancy rates", async () => {
    const rows = wellFormedRows();
    rows.hotelPricingSettings = [baseSettings({ pricingModel: "ROOM_TYPE_OCCUPANCY", useOccupancyRates: true })];
    rows.occupancyType = [
      { id: "occ-double", name: "Double", minAdults: 1, maxAdults: 2, maxChildren: 1, sortOrder: 1, isActive: true },
    ];

    const error = await failure(loadPricingConfig("hotel-a", "KES", client(rows)));
    expect(error.code).toBe("PRICING_CONFIG_INVALID");
    expect(error.message).toContain("no occupancy rate");
  });

  it("accepts a fully configured hotel", async () => {
    const rows = wellFormedRows();
    rows.hotelPricingSettings = [
      baseSettings({ pricingModel: "ROOM_TYPE_OCCUPANCY", useOccupancyRates: true, useTaxes: true }),
    ];
    rows.occupancyType = [
      { id: "occ-double", name: "Double", minAdults: 1, maxAdults: 2, maxChildren: 1, sortOrder: 1, isActive: true },
    ];
    rows.roomTypeOccupancy = [
      { roomTypeId: "rt-standard", occupancyTypeId: "occ-double", nightlyRate: 5500, isActive: true },
    ];
    rows.taxRule = [
      { id: "tax-vat", name: "VAT", basis: "PERCENT", amount: 16, appliesTo: "ROOM", chargeBasis: "PER_NIGHT", isInclusive: false, sortOrder: 1, isActive: true },
    ];

    const config = await loadPricingConfig("hotel-a", "KES", client(rows));
    expect(config.settings.pricingModel).toBe("ROOM_TYPE_OCCUPANCY");
    expect(config.taxes).toHaveLength(1);
    expect(config.roomTypeOccupancies[0].nightlyRate).toBe(5500);
  });
});

describe("delegate guard", () => {
  it("names the delegates a client is missing", () => {
    expect(missingPricingDelegates(client(wellFormedRows(), { hide: ["taxRule", "extraBedRule"] }))).toEqual([
      "extraBedRule",
      "taxRule",
    ]);
  });

  it("accepts a complete client and rejects an incomplete one", () => {
    expect(() => assertPricingDelegates(client(), "test")).not.toThrow();

    // The delegate name is for the server log (`detail`); the thrown message is
    // the safe text an operator or UI may show.
    let thrown: unknown;
    try {
      assertPricingDelegates(client({}, { hide: ["childPricingRule"] }), "test");
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(PricingUnavailableError);
    expect((thrown as PricingUnavailableError).detail).toContain("childPricingRule");
    expect((thrown as PricingUnavailableError).message).not.toContain("childPricingRule");
  });

  it("treats a non-object client as entirely missing", () => {
    expect(missingPricingDelegates(undefined)).toHaveLength(PRICING_MODEL_DELEGATES.length);
  });
});
