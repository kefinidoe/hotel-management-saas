import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Reservation creation with configured pricing, end to end through the route.
 *
 * These cases prove the properties the pricing engine exists for:
 *   - the price comes from the hotel's own configuration, never the request;
 *   - the agreed price is frozen in a snapshot;
 *   - another hotel's rooms, occupancies and rates are unreachable;
 *   - capacity, meal plans and discounts are enforced server-side.
 */

const HotelRole = {
  HOTEL_OWNER: "HOTEL_OWNER",
  HOTEL_ADMIN: "HOTEL_ADMIN",
  MANAGER: "MANAGER",
  RECEPTIONIST: "RECEPTIONIST",
} as const;

const state = vi.hoisted(() => {
  // The routes detect a refused authorization with `instanceof NextResponse`, so
  // the double has to hand back an instance of the very class they import.
  class MockNextResponse extends Response {
    static json(data: unknown, init?: ResponseInit): Response {
      return new MockNextResponse(JSON.stringify(data), {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      });
    }
  }
  return {
    tenant: null as null | { userId: string; hotelId: string; role: string; hotel: Record<string, unknown> },
    MockNextResponse,
  };
});

vi.doMock("@prisma/client", () => ({
  HotelRole,
  Prisma: {
    TransactionIsolationLevel: { Serializable: "Serializable" },
    PrismaClientKnownRequestError: class extends Error {
      code: string;
      constructor(message: string, code: string) {
        super(message);
        this.code = code;
      }
    },
  },
}));

vi.doMock("next/server", () => ({ NextResponse: state.MockNextResponse }));

vi.doMock("@/lib/authz", () => ({
  getTenantFromRoute: async () => state.tenant,
  requireRole: (role: string, allowed: readonly string[]) =>
    allowed.includes(role)
      ? null
      : state.MockNextResponse.json({ error: "You don't have permission to do that." }, { status: 403 }),
  requireModule: async () => null,
  ROLE_GROUPS: {
    MANAGEMENT: [HotelRole.HOTEL_OWNER, HotelRole.HOTEL_ADMIN, HotelRole.MANAGER],
    GUEST_STAYS: [HotelRole.HOTEL_OWNER, HotelRole.HOTEL_ADMIN, HotelRole.MANAGER, HotelRole.RECEPTIONIST],
    STAFF: Object.values(HotelRole),
  },
}));

type Row = Record<string, any>;

const db: {
  hotels: Row[];
  roomTypes: Row[];
  rooms: Row[];
  occupancies: Row[];
  roomTypeOccupancies: Row[];
  mealPlans: Row[];
  mealPlanRoomTypes: Row[];
  adjustments: Row[];
  extraBeds: Row[];
  childRules: Row[];
  taxes: Row[];
  settings: Row[];
  guests: Row[];
  reservations: Row[];
  reservationRooms: Row[];
  snapshots: Row[];
  changes: Row[];
  audits: Row[];
} = {
  hotels: [],
  roomTypes: [],
  rooms: [],
  occupancies: [],
  roomTypeOccupancies: [],
  mealPlans: [],
  mealPlanRoomTypes: [],
  adjustments: [],
  extraBeds: [],
  childRules: [],
  taxes: [],
  settings: [],
  guests: [],
  reservations: [],
  reservationRooms: [],
  snapshots: [],
  changes: [],
  audits: [],
};

const matches = (row: Row, where: Row | undefined): boolean => {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      // Composite key objects: { id_hotelId: { id, hotelId } }
      const composite = value as Row;
      return Object.entries(composite).every(([innerKey, innerValue]) => row[innerKey] === innerValue);
    }
    return row[key] === value;
  });
};

function list(rows: Row[]) {
  return async (args?: { where?: Row; take?: number }) =>
    rows.filter((row) => matches(row, args?.where)).slice(0, args?.take ?? undefined);
}

function findUnique(rows: Row[]) {
  return async (args: { where: Row }) => rows.find((row) => matches(row, args.where)) ?? null;
}

function prismaDouble() {
  const client: Row = {
    hotel: { findUnique: findUnique(db.hotels), findMany: list(db.hotels) },
    roomType: { findMany: list(db.roomTypes), findUnique: findUnique(db.roomTypes) },
    room: { findUnique: findUnique(db.rooms) },
    occupancyType: { findMany: list(db.occupancies) },
    roomTypeOccupancy: { findMany: list(db.roomTypeOccupancies) },
    mealPlanConfig: { findMany: list(db.mealPlans) },
    mealPlanRoomType: { findMany: list(db.mealPlanRoomTypes) },
    rateAdjustment: { findMany: list(db.adjustments) },
    extraBedRule: { findMany: list(db.extraBeds) },
    childPricingRule: { findMany: list(db.childRules) },
    taxRule: { findMany: list(db.taxes) },
    hotelPricingSettings: { findMany: list(db.settings) },
    guest: {
      findFirst: async ({ where }: { where: Row }) =>
        db.guests.find((guest) => matches(guest, where)) ?? null,
      create: async ({ data }: { data: Row }) => {
        const guest = { id: `guest-${db.guests.length + 1}`, ...data };
        db.guests.push(guest);
        return guest;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const guest = db.guests.find((entry) => matches(entry, where));
        Object.assign(guest!, data);
        return guest;
      },
    },
    reservation: {
      findMany: async ({ where }: { where?: Row } = {}) =>
        db.reservations
          .filter((reservation) => matches(reservation, where))
          .map((reservation) => ({ ...reservation })),
      findUnique: findUnique(db.reservations),
      create: async ({ data }: { data: Row }) => {
        const { rooms, ...rest } = data;
        const reservation: Row = { id: `res-${db.reservations.length + 1}`, ...rest };
        db.reservations.push(reservation);
        for (const room of rooms?.create ?? []) {
          db.reservationRooms.push({
            id: `rr-${db.reservationRooms.length + 1}`,
            reservationId: reservation.id,
            hotelId: reservation.hotelId,
            roomId: room.roomId,
            rate: room.rate,
          });
        }
        return reservation;
      },
    },
    reservationRoom: {
      findMany: async ({ where }: { where?: Row } = {}) =>
        db.reservationRooms.filter((row) => {
          if (where?.roomId && row.roomId !== where.roomId) return false;
          const reservation = db.reservations.find((entry) => entry.id === row.reservationId);
          if (!reservation) return false;
          if (where?.reservation?.hotelId && reservation.hotelId !== where.reservation.hotelId) return false;
          if (
            where?.reservation?.status?.notIn &&
            where.reservation.status.notIn.includes(reservation.status)
          ) {
            return false;
          }
          return true;
        }).map((row) => ({ ...row, reservation: db.reservations.find((entry) => entry.id === row.reservationId) })),
    },
    reservationPriceSnapshot: {
      create: async ({ data }: { data: Row }) => {
        const snapshot = { id: `snap-${db.snapshots.length + 1}`, ...data };
        db.snapshots.push(snapshot);
        return snapshot;
      },
    },
    reservationPriceChange: {
      create: async ({ data }: { data: Row }) => {
        db.changes.push({ id: `change-${db.changes.length + 1}`, ...data });
        return data;
      },
    },
    auditLog: {
      create: async ({ data }: { data: Row }) => {
        db.audits.push(data);
        return data;
      },
    },
    $queryRaw: async () => [{ locked: "1" }],
    $transaction: async (fn: (tx: Row) => Promise<unknown>) => fn(client),
  };
  return client;
}

vi.doMock("@/lib/prisma", () => ({ prisma: prismaDouble() }));

let createReservation: (req: Request) => Promise<Response>;

beforeAll(async () => {
  const route = await import("@/app/api/reservations/route");
  createReservation = route.POST as unknown as (req: Request) => Promise<Response>;
});

function seed() {
  db.hotels.length = 0;
  db.roomTypes.length = 0;
  db.rooms.length = 0;
  db.occupancies.length = 0;
  db.roomTypeOccupancies.length = 0;
  db.mealPlans.length = 0;
  db.mealPlanRoomTypes.length = 0;
  db.adjustments.length = 0;
  db.extraBeds.length = 0;
  db.childRules.length = 0;
  db.taxes.length = 0;
  db.settings.length = 0;
  db.guests.length = 0;
  db.reservations.length = 0;
  db.reservationRooms.length = 0;
  db.snapshots.length = 0;
  db.changes.length = 0;
  db.audits.length = 0;

  db.hotels.push(
    { id: "hotel-a", name: "Hotel A", currency: "KES" },
    { id: "hotel-b", name: "Hotel B", currency: "USD" }
  );
  db.roomTypes.push(
    { id: "rt-a-deluxe", hotelId: "hotel-a", name: "Deluxe", baseRate: 6000, capacity: 4 },
    { id: "rt-a-twin", hotelId: "hotel-a", name: "Twin", baseRate: 7000, capacity: 2 },
    { id: "rt-b-deluxe", hotelId: "hotel-b", name: "B secret type", baseRate: 999, capacity: 2 }
  );
  db.rooms.push(
    { id: "room-a-101", hotelId: "hotel-a", number: "101", roomTypeId: "rt-a-deluxe", status: "AVAILABLE", isActive: true },
    { id: "room-a-102", hotelId: "hotel-a", number: "102", roomTypeId: "rt-a-twin", status: "AVAILABLE", isActive: true },
    { id: "room-b-201", hotelId: "hotel-b", number: "201", roomTypeId: "rt-b-deluxe", status: "AVAILABLE", isActive: true }
  );
  db.occupancies.push(
    { id: "occ-single", hotelId: "hotel-a", name: "Single", minAdults: 1, maxAdults: 1, maxChildren: 0, sortOrder: 1, isActive: true },
    { id: "occ-double", hotelId: "hotel-a", name: "Double", minAdults: 2, maxAdults: 2, maxChildren: 1, sortOrder: 2, isActive: true },
    { id: "occ-b-occ", hotelId: "hotel-b", name: "B occupancy", minAdults: 1, maxAdults: 2, maxChildren: 0, sortOrder: 1, isActive: true }
  );
  db.roomTypeOccupancies.push(
    { id: "rto-1", hotelId: "hotel-a", roomTypeId: "rt-a-deluxe", occupancyTypeId: "occ-single", nightlyRate: 6000, isActive: true },
    { id: "rto-2", hotelId: "hotel-a", roomTypeId: "rt-a-deluxe", occupancyTypeId: "occ-double", nightlyRate: 8500, isActive: true },
    { id: "rto-3", hotelId: "hotel-a", roomTypeId: "rt-a-twin", occupancyTypeId: "occ-single", nightlyRate: 7000, isActive: true }
  );
  db.mealPlans.push(
    { id: "mp-half", hotelId: "hotel-a", name: "Half Board", pricingBasis: "PER_PERSON_PER_NIGHT", charge: 1500, effectiveFrom: null, effectiveTo: null, isActive: true },
    { id: "mp-b", hotelId: "hotel-b", name: "B plan", pricingBasis: "PER_PERSON_PER_NIGHT", charge: 10, effectiveFrom: null, effectiveTo: null, isActive: true }
  );
  db.settings.push({
    id: "settings-a",
    hotelId: "hotel-a",
    pricingModel: "ROOM_TYPE_OCCUPANCY",
    useOccupancyRates: true,
    useMealPlans: true,
    useSeasonalPricing: false,
    useWeekendPricing: false,
    useChildPricing: false,
    useExtraBeds: false,
    useTaxes: false,
    pricesIncludeTax: false,
  });
}

beforeEach(() => {
  seed();
  state.tenant = {
    userId: "user-reception-a",
    hotelId: "hotel-a",
    role: HotelRole.RECEPTIONIST,
    hotel: { id: "hotel-a", name: "Hotel A", currency: "KES" },
  };
});

function post(body: Record<string, unknown>) {
  return createReservation(
    new Request("http://localhost:3000/api/reservations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        guestName: "Grace Njeri",
        checkInDate: "2026-12-01T00:00:00.000Z",
        checkOutDate: "2026-12-03T00:00:00.000Z",
        roomId: "room-a-101",
        ...body,
      }),
    })
  );
}

describe("reservation pricing from hotel configuration", () => {
  it("prices the stay from the configured occupancy rate and freezes a snapshot", async () => {
    const response = await post({ occupancyTypeId: "occ-double", adults: 2, mealPlanId: "mp-half" });
    const body = await response.json();

    expect(response.status).toBe(201);
    // 8,500 x 2 nights room + 1,500 x 2 people x 2 nights meals
    expect(body.total).toBe(23000);
    expect(body.currency).toBe("KES");
    expect(db.snapshots).toHaveLength(1);
    expect(db.snapshots[0]).toMatchObject({
      hotelId: "hotel-a",
      reservationId: body.id,
      nightlyRate: 8500,
      nights: 2,
      roomTotal: 17000,
      mealsTotal: 6000,
      grandTotal: 23000,
      currency: "KES",
      occupancyName: "Double",
      mealPlanName: "Half Board",
    });
    // ReservationRoom keeps the nightly room rate that check-in bills from.
    expect(Number(db.reservationRooms[0].rate)).toBe(8500);
  });

  it("ignores totals supplied by the client", async () => {
    const response = await post({
      occupancyTypeId: "occ-double",
      adults: 2,
      total: 1,
      grandTotal: 1,
      rate: 1,
      nightlyRate: 1,
      discount: 0,
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.total).toBe(17000);
    expect(db.snapshots[0].grandTotal).toBe(17000);
  });

  it("refuses an occupancy the room type is not sold as", async () => {
    // Room 102 is a Twin, priced for Single only.
    const response = await post({ roomId: "room-a-102", occupancyTypeId: "occ-double", adults: 2 });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("not sold as Double"),
    });
    expect(db.reservations).toHaveLength(0);
  });

  it("refuses another hotel's occupancy option", async () => {
    const response = await post({ occupancyTypeId: "occ-b-occ", adults: 1 });
    expect(response.status).toBe(400);
    expect(db.reservations).toHaveLength(0);
  });

  it("refuses another hotel's room", async () => {
    const response = await post({ roomId: "room-b-201", occupancyTypeId: "occ-double", adults: 2 });
    expect(response.status).toBe(404);
    expect(db.reservations).toHaveLength(0);
  });

  it("refuses more guests than the occupancy allows", async () => {
    const response = await post({ occupancyTypeId: "occ-double", adults: 3 });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("allows 2-2 adults"),
    });
  });

  it("charges a meal plan only when one is selected", async () => {
    const response = await post({ occupancyTypeId: "occ-double", adults: 2 });
    const body = await response.json();
    expect(body.total).toBe(17000);
    expect(db.snapshots[0].mealsTotal).toBe(0);
  });

  it("keeps the hotel's currency on the snapshot, not the guest's", async () => {
    await post({ occupancyTypeId: "occ-double", adults: 2 });
    expect(db.snapshots[0].currency).toBe("KES");
  });
});

describe("discount permissions and server-side totals", () => {
  it("refuses a discount from a receptionist", async () => {
    const response = await post({ occupancyTypeId: "occ-double", adults: 2, discount: 500 });
    expect(response.status).toBe(403);
    expect(db.reservations).toHaveLength(0);
  });

  it("applies a manager's discount to the frozen total", async () => {
    state.tenant = { ...state.tenant!, role: HotelRole.MANAGER };
    const response = await post({ occupancyTypeId: "occ-double", adults: 2, discount: 1000 });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.total).toBe(16000);
    expect(db.snapshots[0]).toMatchObject({ discountTotal: 1000, grandTotal: 16000 });
    expect(Number(db.reservations[0].discount)).toBe(1000);
  });

  it("refuses a discount larger than the stay", async () => {
    state.tenant = { ...state.tenant!, role: HotelRole.MANAGER };
    const response = await post({ occupancyTypeId: "occ-double", adults: 2, discount: 999999 });
    expect(response.status).toBe(400);
    expect(db.reservations).toHaveLength(0);
  });
});

describe("configuration changes do not rewrite existing reservations", () => {
  it("keeps the agreed total after the hotel raises its rates", async () => {
    const created = await post({ occupancyTypeId: "occ-double", adults: 2 });
    const body = await created.json();

    // The hotel doubles the Double rate afterwards.
    const rate = db.roomTypeOccupancies.find((row) => row.id === "rto-2");
    rate!.nightlyRate = 17000;

    // The frozen snapshot is untouched: this is what the guest was quoted.
    expect(db.snapshots[0].grandTotal).toBe(body.total);
    expect(db.snapshots[0].nightlyRate).toBe(8500);

    // A new reservation picks up the new price.
    const second = await post({
      occupancyTypeId: "occ-double",
      adults: 2,
      guestName: "Second Guest",
      checkInDate: "2026-12-10T00:00:00.000Z",
      checkOutDate: "2026-12-12T00:00:00.000Z",
    });
    expect(await second.json()).toMatchObject({ total: 34000 });
  });
});
