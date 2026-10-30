import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pricing configuration API: tenant isolation and permissions.
 *
 * The prisma double below behaves like a tenant-scoped database: every finder
 * filters on the `hotelId` it is given, so a query that forgot the hotel filter
 * would hand back another hotel's rows and fail these assertions.
 */

const state = vi.hoisted(() => {
  class MockNextResponse extends Response {
    // Like the real class, `json()` returns an instance of itself — the routes
    // rely on `instanceof NextResponse` to spot a rejected authorization.
    static json(data: unknown, init?: ResponseInit) {
      return new MockNextResponse(JSON.stringify(data), {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      });
    }
  }
  return {
  MockNextResponse,
  tenant: null as null | {
    userId: string;
    hotelId: string;
    role: string;
    hotel: { id: string; name: string; slug: string; currency: string; timezone: string; status: string };
  },
  occupancyTypes: [] as Record<string, unknown>[],
  mealPlans: [] as Record<string, unknown>[],
  roomTypeOccupancies: [] as Record<string, unknown>[],
  settings: [] as Record<string, unknown>[],
  };
});

const ROLE_GROUPS = {
  MANAGEMENT: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER"],
  GUEST_STAYS: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER", "RECEPTIONIST"],
};

vi.doMock("@/lib/authz", () => ({
  getTenantFromRoute: async () => state.tenant,
  requireRole: (role: string, allowed: readonly string[]) =>
    allowed.includes(role)
      ? null
      : state.MockNextResponse.json({ error: "You don't have permission to do that." }, { status: 403 }),
  requireModule: async () => null,
  ROLE_GROUPS,
}));

vi.doMock("next/server", () => ({ NextResponse: state.MockNextResponse }));

const hotelA = { id: "hotel-a", name: "Hotel A", slug: "a", currency: "KES", timezone: "Africa/Nairobi", status: "ACTIVE" };
const hotelB = { id: "hotel-b", name: "Hotel B", slug: "b", currency: "USD", timezone: "UTC", status: "ACTIVE" };

function scoped<T extends Record<string, unknown>>(rows: T[], hotelId?: string) {
  return hotelId ? rows.filter((row) => row.hotelId === hotelId) : rows;
}

vi.doMock("@/lib/prisma", () => {
  // Read the arrays at call time: the tests replace them between cases and a
  // captured reference would keep pointing at the first (empty) array.
  const findMany = (rows: () => Record<string, unknown>[]) => async (args?: { where?: { hotelId?: string } }) =>
    scoped(rows(), args?.where?.hotelId);

  return {
    prisma: {
      hotel: {
        findUnique: async ({ where }: { where: { id: string } }) =>
          [hotelA, hotelB].find((hotel) => hotel.id === where.id) ?? null,
      },
      hotelPricingSettings: {
        findMany: async (args?: { where?: { hotelId?: string } }) =>
          state.settings.filter((row) => row.hotelId === args?.where?.hotelId).slice(0, 1),
        findUnique: async ({ where }: { where: { hotelId: string } }) =>
          state.settings.find((row) => row.hotelId === where.hotelId) ?? null,
        upsert: async ({ where, create, update }: { where: { hotelId: string }; create: Record<string, unknown>; update: Record<string, unknown> }) => {
          const existing = state.settings.find((row) => row.hotelId === where.hotelId);
          if (existing) Object.assign(existing, update);
          else state.settings.push({ id: "settings-new", hotelId: where.hotelId, ...create });
          return state.settings.find((row) => row.hotelId === where.hotelId);
        },
      },
      roomType: {
        findUnique: async ({ where }: { where: { id_hotelId: { id: string; hotelId: string } } }) =>
          [
            { id: "rt-a-standard", hotelId: "hotel-a", name: "Standard", baseRate: 4500, capacity: 2 },
            { id: "rt-b-deluxe", hotelId: "hotel-b", name: "B secret type", baseRate: 999, capacity: 2 },
          ].find(
            (type) =>
              type.id === where.id_hotelId.id && type.hotelId === where.id_hotelId.hotelId
          ) ?? null,
        findMany: async (args?: { where?: { hotelId?: string } }) =>
          scoped(
            [
              { id: "rt-a-standard", hotelId: "hotel-a", name: "Standard", baseRate: 4500, capacity: 2, mealPlan: null },
              { id: "rt-b-deluxe", hotelId: "hotel-b", name: "B secret type", baseRate: 999, capacity: 2, mealPlan: null },
            ],
            args?.where?.hotelId
          ),
        update: async ({ where, data }: { where: { id_hotelId: { id: string } }; data: unknown }) => ({
          id: where.id_hotelId.id,
          ...(data as object),
        }),
      },
      occupancyType: {
        findMany: findMany(() => state.occupancyTypes),
        count: async (args?: { where?: { hotelId?: string } }) => scoped(state.occupancyTypes, args?.where?.hotelId).length,
        findUnique: async ({ where }: { where: { id_hotelId: { id: string; hotelId: string } } }) =>
          state.occupancyTypes.find(
            (row) => row.id === where.id_hotelId.id && row.hotelId === where.id_hotelId.hotelId
          ) ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `occ-${state.occupancyTypes.length + 1}`, ...data };
          state.occupancyTypes.push(row);
          return row;
        },
        update: async ({ where, data }: { where: { id_hotelId: { id: string } }; data: Record<string, unknown> }) => {
          const row = state.occupancyTypes.find((entry) => entry.id === where.id_hotelId.id);
          Object.assign(row!, data);
          return row;
        },
        delete: async ({ where }: { where: { id_hotelId: { id: string } } }) => {
          const index = state.occupancyTypes.findIndex((entry) => entry.id === where.id_hotelId.id);
          if (index >= 0) state.occupancyTypes.splice(index, 1);
          return { ok: true };
        },
      },
      roomTypeOccupancy: {
        findMany: findMany(() => state.roomTypeOccupancies),
        count: async (args?: { where?: { hotelId?: string } }) => scoped(state.roomTypeOccupancies, args?.where?.hotelId).length,
        findFirst: async (args?: { where?: { hotelId?: string; roomTypeId?: string } }) =>
          scoped(state.roomTypeOccupancies, args?.where?.hotelId).find(
            (row) => !args?.where?.roomTypeId || row.roomTypeId === args.where.roomTypeId
          ) ?? null,
        upsert: async ({ where, create }: { where: { roomTypeId_occupancyTypeId: { roomTypeId: string; occupancyTypeId: string } }; create: Record<string, unknown> }) => {
          const existing = state.roomTypeOccupancies.find(
            (row) =>
              row.roomTypeId === where.roomTypeId_occupancyTypeId.roomTypeId &&
              row.occupancyTypeId === where.roomTypeId_occupancyTypeId.occupancyTypeId
          );
          if (existing) return existing;
          const created = { id: `rto-${state.roomTypeOccupancies.length + 1}`, ...create };
          state.roomTypeOccupancies.push(created);
          return created;
        },
        deleteMany: async (args: { where: { hotelId: string; roomTypeId: string; occupancyTypeId: string } }) => {
          const before = state.roomTypeOccupancies.length;
          state.roomTypeOccupancies = state.roomTypeOccupancies.filter(
            (row) =>
              !(
                row.hotelId === args.where.hotelId &&
                row.roomTypeId === args.where.roomTypeId &&
                row.occupancyTypeId === args.where.occupancyTypeId
              )
          );
          return { count: before - state.roomTypeOccupancies.length };
        },
      },
      mealPlanConfig: {
        findMany: findMany(() => state.mealPlans),
        findUnique: async ({ where }: { where: { id_hotelId: { id: string; hotelId: string } } }) =>
          state.mealPlans.find(
            (row) => row.id === where.id_hotelId.id && row.hotelId === where.id_hotelId.hotelId
          ) ?? null,
        create: async ({ data }: { data: Record<string, unknown> }) => {
          const row = { id: `mp-${state.mealPlans.length + 1}`, ...data };
          state.mealPlans.push(row);
          return row;
        },
      },
      mealPlanRoomType: {
        findMany: async () => [],
        deleteMany: async () => ({ count: 0 }),
        createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }),
      },
      rateAdjustment: { findMany: async () => [], create: async () => ({ id: "adj-1" }) },
      extraBedRule: { findMany: async () => [] },
      childPricingRule: { findMany: async () => [] },
      taxRule: { findMany: async () => [] },
      room: {
        findUnique: async ({ where }: { where: { id_hotelId: { id: string; hotelId: string } } }) =>
          [
            { id: "room-a-101", hotelId: "hotel-a", number: "101", roomTypeId: "rt-a-standard", isActive: true },
            { id: "room-b-201", hotelId: "hotel-b", number: "201", roomTypeId: "rt-b-deluxe", isActive: true },
          ].find(
            (room) => room.id === where.id_hotelId.id && room.hotelId === where.id_hotelId.hotelId
          ) ?? null,
      },
      auditLog: { create: async () => ({ id: "audit-1" }) },
    },
  };
});

let pricingRoute: typeof import("@/app/api/pricing/route");
let entityRoute: typeof import("@/app/api/pricing/[entity]/route");
let roomRatesRoute: typeof import("@/app/api/pricing/room-rates/route");
let quoteRoute: typeof import("@/app/api/reservations/quote/route");

beforeEach(async () => {
  vi.resetModules();
  state.occupancyTypes = [];
  state.mealPlans = [];
  state.roomTypeOccupancies = [];
  state.settings = [];
  state.tenant = {
    userId: "user-owner-a",
    hotelId: "hotel-a",
    role: "HOTEL_OWNER",
    hotel: hotelA,
  };
  pricingRoute = await import("@/app/api/pricing/route");
  entityRoute = await import("@/app/api/pricing/[entity]/route");
  roomRatesRoute = await import("@/app/api/pricing/room-rates/route");
  quoteRoute = await import("@/app/api/reservations/quote/route");
});

function jsonRequest(body: unknown, url = "http://localhost:3000/api/pricing") {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("pricing configuration reads", () => {
  it("returns only the signed-in hotel's configuration", async () => {
    state.occupancyTypes = [
      { id: "occ-a", hotelId: "hotel-a", name: "A double", minAdults: 1, maxAdults: 2, maxChildren: 0, sortOrder: 1, isActive: true, createdAt: new Date(), updatedAt: new Date() },
      { id: "occ-b", hotelId: "hotel-b", name: "B secret occupancy", minAdults: 1, maxAdults: 2, maxChildren: 0, sortOrder: 1, isActive: true, createdAt: new Date(), updatedAt: new Date() },
    ];

    const response = await pricingRoute.GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.currency).toBe("KES");
    expect(body.occupancies.map((row: { name: string }) => row.name)).toEqual(["A double"]);
    expect(JSON.stringify(body)).not.toContain("B secret");
  });

  it("refuses a receptionist", async () => {
    state.tenant = { ...state.tenant!, role: "RECEPTIONIST" };
    const response = await pricingRoute.GET();
    expect(response.status).toBe(403);
  });
});

describe("pricing configuration writes", () => {
  it("refuses a receptionist", async () => {
    state.tenant = { ...state.tenant!, role: "RECEPTIONIST" };
    const response = await entityRoute.POST(jsonRequest({ name: "Triple" }), {
      params: Promise.resolve({ entity: "occupancy-types" }),
    });
    expect(response.status).toBe(403);
    expect(state.occupancyTypes).toHaveLength(0);
  });

  it("creates an occupancy option scoped to the hotel", async () => {
    const response = await entityRoute.POST(
      jsonRequest({ name: "Family", minAdults: 2, maxAdults: 4, maxChildren: 2 }),
      { params: Promise.resolve({ entity: "occupancy-types" }) }
    );
    expect(response.status).toBe(201);
    expect(state.occupancyTypes).toHaveLength(1);
    expect(state.occupancyTypes[0]).toMatchObject({ hotelId: "hotel-a", name: "Family" });
  });

  it("rejects an unknown entity", async () => {
    const response = await entityRoute.POST(jsonRequest({ name: "x" }), {
      params: Promise.resolve({ entity: "hotel-currency" }),
    });
    expect(response.status).toBe(404);
  });

  it("refuses to attach a meal plan to another hotel's room type", async () => {
    const response = await entityRoute.POST(
      jsonRequest({
        name: "Breakfast",
        pricingBasis: "PER_PERSON_PER_NIGHT",
        charge: 800,
        roomTypeIds: ["rt-b-deluxe"],
      }),
      { params: Promise.resolve({ entity: "meal-plans" }) }
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("does not belong") });
    expect(state.mealPlans).toHaveLength(0);
  });

  it("refuses a rate for another hotel's room type", async () => {
    const response = await roomRatesRoute.POST(
      jsonRequest({ roomTypeId: "rt-b-deluxe", rates: [{ occupancyTypeId: "occ-a", nightlyRate: 100 }] })
    );
    expect(response.status).toBe(404);
    expect(state.roomTypeOccupancies).toHaveLength(0);
  });

  it("refuses a rate for another hotel's occupancy option", async () => {
    state.occupancyTypes = [
      { id: "occ-b", hotelId: "hotel-b", name: "B", minAdults: 1, maxAdults: 2, maxChildren: 0, sortOrder: 1, isActive: true },
    ];
    const response = await roomRatesRoute.POST(
      jsonRequest({ roomTypeId: "rt-a-standard", rates: [{ occupancyTypeId: "occ-b", nightlyRate: 100 }] })
    );
    expect(response.status).toBe(404);
    expect(state.roomTypeOccupancies).toHaveLength(0);
  });

  it("refuses to switch occupancy pricing on without a single rate", async () => {
    const response = await pricingRoute.PATCH(
      new Request("http://localhost:3000/api/pricing", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ useOccupancyRates: true, pricingModel: "ROOM_TYPE_OCCUPANCY" }),
      })
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("occupancy rate") });
  });
});

describe("reservation quote endpoint", () => {
  it("refuses another hotel's room", async () => {
    const response = await quoteRoute.POST(
      jsonRequest(
        { roomId: "room-b-201", checkInDate: "2026-12-01", checkOutDate: "2026-12-03", adults: 2 },
        "http://localhost:3000/api/reservations/quote"
      )
    );
    expect(response.status).toBe(404);
  });

  it("does not let a receptionist apply a discount", async () => {
    state.tenant = { ...state.tenant!, role: "RECEPTIONIST" };
    const response = await quoteRoute.POST(
      jsonRequest(
        { roomId: "room-a-101", checkInDate: "2026-12-01", checkOutDate: "2026-12-03", adults: 1, discount: 500 },
        "http://localhost:3000/api/reservations/quote"
      )
    );
    expect(response.status).toBe(403);
  });

  it("prices a stay from the hotel's own configuration", async () => {
    state.settings = [
      {
        id: "settings-a",
        hotelId: "hotel-a",
        pricingModel: "ROOM_TYPE_OCCUPANCY",
        useOccupancyRates: true,
        useMealPlans: false,
        useSeasonalPricing: false,
        useWeekendPricing: false,
        useChildPricing: false,
        useExtraBeds: false,
        useTaxes: false,
        pricesIncludeTax: false,
      },
    ];
    state.occupancyTypes = [
      { id: "occ-double", hotelId: "hotel-a", name: "Double", minAdults: 1, maxAdults: 2, maxChildren: 1, sortOrder: 1, isActive: true },
    ];
    state.roomTypeOccupancies = [
      { id: "rto-1", hotelId: "hotel-a", roomTypeId: "rt-a-standard", occupancyTypeId: "occ-double", nightlyRate: 5500, isActive: true },
    ];

    const response = await quoteRoute.POST(
      jsonRequest(
        {
          roomId: "room-a-101",
          occupancyTypeId: "occ-double",
          checkInDate: "2026-12-01",
          checkOutDate: "2026-12-03",
          adults: 2,
        },
        "http://localhost:3000/api/reservations/quote"
      )
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.nightlyRate).toBe(5500);
    expect(body.totals.grandTotal).toBe(11000);
    expect(body.availableOccupancies).toHaveLength(1);
  });
});
