import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Financial integrity of the pricing records.
 *
 * These tests drive the real routes and the real check-in service against an
 * in-memory Prisma double whose transactions actually roll back, so they can
 * prove the properties that matter to a hotel's books:
 *
 *   - a configured-price reservation is never sold without a frozen snapshot;
 *   - repricing appends versions and never rewrites earlier agreements;
 *   - a repricing that cannot be audited does not happen at all;
 *   - the folio bills the latest agreed version;
 *   - legacy hotels keep working exactly as before.
 */

const HotelRole = {
  HOTEL_OWNER: "HOTEL_OWNER",
  HOTEL_ADMIN: "HOTEL_ADMIN",
  MANAGER: "MANAGER",
  RECEPTIONIST: "RECEPTIONIST",
  HOUSEKEEPING: "HOUSEKEEPING",
} as const;

const state = vi.hoisted(() => {
  class MockNextResponse extends Response {
    static json(data: unknown, init?: ResponseInit): Response {
      return new MockNextResponse(JSON.stringify(data), {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      });
    }
  }
  return {
    MockNextResponse,
    tenant: null as null | { userId: string; hotelId: string; role: string; hotel: Record<string, unknown> },
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

type Db = {
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
  folios: Row[];
  folioItems: Row[];
  payments: Row[];
  paymentMethods: Row[];
};

const emptyDb = (): Db => ({
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
  folios: [],
  folioItems: [],
  payments: [],
  paymentMethods: [],
});

let db: Db = emptyDb();

/** Fault injection: make a specific write fail, the way a database outage would. */
const faults = {
  snapshotCreate: null as null | Error,
  auditCreate: null as null | Error,
  snapshotDelegateMissing: false,
  auditDelegateMissing: false,
  // Simulate a second writer racing us: the reprice reads a stale version and
  // has to be stopped by the uniqueness of (reservationId, version).
  staleVersionRead: false,
};

const matches = (row: Row, where: Row | undefined): boolean => {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      const composite = value as Row;
      return Object.entries(composite).every(([innerKey, innerValue]) => row[innerKey] === innerValue);
    }
    return row[key] === value;
  });
};

const list =
  (rows: () => Row[]) =>
  async (args?: { where?: Row; orderBy?: any; take?: number }) =>
    rows().filter((row) => matches(row, args?.where)).slice(0, args?.take ?? undefined);

const findUnique =
  (rows: () => Row[]) =>
  async (args: { where: Row }) =>
    rows().find((row) => matches(row, args.where)) ?? null;

function shapeReservation(reservation: Row | null, include?: Row) {
  if (!reservation) return null;
  const copy: Row = { ...reservation };
  if (include?.rooms) {
    copy.rooms = db.reservationRooms
      .filter((row) => row.reservationId === reservation.id)
      .map((row) => ({ ...row, room: db.rooms.find((room) => room.id === row.roomId) }));
  }
  if (include?.folios) {
    copy.folios = db.folios
      .filter((row) => row.reservationId === reservation.id)
      .map((folio) => ({
        ...folio,
        items: db.folioItems.filter((item) => item.folioId === folio.id),
        // Every payment counts, whatever its status: a pending deposit is money
        // in flight and a refunded one is money that already moved.
        payments: db.payments.filter((payment) => payment.folioId === folio.id),
      }));
  }
  if (include?.priceSnapshots) {
    // `staleVersionRead` makes the include see the oldest version, which is what
    // a read that slipped outside the lock would have returned.
    const versions = db.snapshots
      .filter((row) => row.reservationId === reservation.id)
      .sort((left, right) =>
        faults.staleVersionRead ? left.version - right.version : right.version - left.version
      );
    copy.priceSnapshots = include.priceSnapshots.take ? versions.slice(0, include.priceSnapshots.take) : versions;
  }
  return copy;
}

function client(): Row {
  const tx: Row = {
    hotel: { findUnique: findUnique(() => db.hotels), findMany: list(() => db.hotels) },
    roomType: { findUnique: findUnique(() => db.roomTypes), findMany: list(() => db.roomTypes) },
    room: {
      findUnique: findUnique(() => db.rooms),
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const room = db.rooms.find((row) => matches(row, where));
        Object.assign(room!, data);
        return room;
      },
    },
    occupancyType: { findMany: list(() => db.occupancies) },
    roomTypeOccupancy: { findMany: list(() => db.roomTypeOccupancies) },
    mealPlanConfig: { findMany: list(() => db.mealPlans) },
    mealPlanRoomType: { findMany: list(() => db.mealPlanRoomTypes) },
    rateAdjustment: { findMany: list(() => db.adjustments) },
    extraBedRule: { findMany: list(() => db.extraBeds) },
    childPricingRule: { findMany: list(() => db.childRules) },
    taxRule: { findMany: list(() => db.taxes) },
    hotelPricingSettings: {
      findUnique: findUnique(() => db.settings),
      findMany: list(() => db.settings),
    },
    guest: {
      findFirst: findUnique(() => db.guests),
      create: async ({ data }: { data: Row }) => {
        const guest = { id: `guest-${db.guests.length + 1}`, ...data };
        db.guests.push(guest);
        return guest;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const guest = db.guests.find((row) => matches(row, where));
        Object.assign(guest!, data);
        return guest;
      },
    },
    reservation: {
      findUnique: async (args: { where: Row; include?: Row }) =>
        shapeReservation(
          db.reservations.find((row) => matches(row, args.where)) ?? null,
          args.include
        ),
      findMany: list(() => db.reservations),
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
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const reservation = db.reservations.find((row) => matches(row, where));
        Object.assign(reservation!, data);
        return reservation;
      },
    },
    reservationRoom: {
      findMany: list(() => db.reservationRooms),
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = db.reservationRooms.find((entry) => matches(entry, where));
        Object.assign(row!, data);
        return row;
      },
    },
    reservationPriceSnapshot: faults.snapshotDelegateMissing
      ? undefined
      : {
          create: async ({ data }: { data: Row }) => {
            if (faults.snapshotCreate) throw faults.snapshotCreate;
            const version = Number(data.version ?? 1);
            const clash = db.snapshots.some(
              (row) => row.reservationId === data.reservationId && row.version === version
            );
            if (clash) throw new Error("duplicate price version");
            const snapshot = { id: `snap-${db.snapshots.length + 1}`, ...data, version };
            db.snapshots.push(snapshot);
            return snapshot;
          },
          findFirst: async ({ where }: { where: Row }) => {
            const versions = db.snapshots
              .filter((row) => matches(row, where))
              .sort((left, right) =>
                faults.staleVersionRead ? left.version - right.version : right.version - left.version
              );
            return versions[0] ?? null;
          },
        },
    reservationPriceChange: {
      create: async ({ data }: { data: Row }) => {
        const change = { id: `change-${db.changes.length + 1}`, ...data };
        db.changes.push(change);
        return change;
      },
      count: async ({ where }: { where?: Row } = {}) =>
        db.changes.filter((row) => matches(row, where)).length,
      findMany: list(() => db.changes),
    },
    auditLog: faults.auditDelegateMissing
      ? undefined
      : {
          create: async ({ data }: { data: Row }) => {
            if (faults.auditCreate) throw faults.auditCreate;
            db.audits.push(data);
            return data;
          },
        },
    folio: {
      create: async ({ data }: { data: Row }) => {
        const folio = { id: `folio-${db.folios.length + 1}`, ...data };
        db.folios.push(folio);
        return folio;
      },
    },
    folioItem: {
      create: async ({ data }: { data: Row }) => {
        db.folioItems.push(data);
        return data;
      },
    },
    payment: {
      create: async ({ data }: { data: Row }) => {
        db.payments.push(data);
        return data;
      },
    },
    paymentMethod: { findFirst: findUnique(() => db.paymentMethods) },
    $queryRaw: async () => [{ id: "locked" }],
  };
  tx.$transaction = async (fn: (t: Row) => Promise<unknown>) => {
    // Real rollback semantics: restore the whole state if the callback throws.
    const backup = structuredClone(db);
    try {
      return await fn(tx);
    } catch (error) {
      db = backup;
      throw error;
    }
  };
  return tx;
}

const dbHandle = { get current() { return db; } };

vi.doMock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_target, property) => client()[property as string],
    }
  ),
}));

let createReservation: (req: Request) => Promise<Response>;
let reprice: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let checkIn: (tenant: unknown, options: unknown) => Promise<any>;
let latestVersion: <T extends { version: number }>(rows: readonly T[] | null | undefined) => T | null;

beforeAll(async () => {
  const route = await import("@/app/api/reservations/route");
  createReservation = route.POST as unknown as (req: Request) => Promise<Response>;
  const repriceRoute = await import("@/app/api/reservations/[id]/reprice/route");
  reprice = repriceRoute.POST as unknown as typeof reprice;
  const stay = await import("@/lib/stay-service");
  checkIn = stay.executeCheckIn as unknown as typeof checkIn;
  const versions = await import("@/lib/pricing/versions");
  latestVersion = versions.currentPriceVersion;
});

function seed({ configured = true }: { configured?: boolean } = {}) {
  db = emptyDb();
  faults.snapshotCreate = null;
  faults.auditCreate = null;
  faults.snapshotDelegateMissing = false;

  db.hotels.push({ id: "hotel-a", name: "Hotel A", currency: "KES" }, { id: "hotel-b", name: "Hotel B", currency: "USD" });
  db.roomTypes.push({ id: "rt-deluxe", hotelId: "hotel-a", name: "Deluxe", baseRate: 6000, capacity: 4 });
  db.rooms.push({
    id: "room-101",
    hotelId: "hotel-a",
    number: "101",
    roomTypeId: "rt-deluxe",
    status: "AVAILABLE",
    isActive: true,
  });
  db.occupancies.push({
    id: "occ-double",
    hotelId: "hotel-a",
    name: "Double",
    minAdults: 2,
    maxAdults: 2,
    maxChildren: 1,
    sortOrder: 1,
    isActive: true,
  });
  db.roomTypeOccupancies.push({
    id: "rto-1",
    hotelId: "hotel-a",
    roomTypeId: "rt-deluxe",
    occupancyTypeId: "occ-double",
    nightlyRate: 8500,
    isActive: true,
  });
  db.mealPlans.push({
    id: "mp-half",
    hotelId: "hotel-a",
    name: "Half Board",
    pricingBasis: "PER_PERSON_PER_NIGHT",
    charge: 1500,
    effectiveFrom: null,
    effectiveTo: null,
    isActive: true,
  });
  db.settings.push({
    id: "settings-a",
    hotelId: "hotel-a",
    pricingModel: configured ? "ROOM_TYPE_OCCUPANCY" : "LEGACY_BASE_RATE",
    useOccupancyRates: configured,
    useMealPlans: configured,
    useSeasonalPricing: false,
    useWeekendPricing: false,
    useChildPricing: false,
    useExtraBeds: false,
    useTaxes: false,
    pricesIncludeTax: false,
  });
  db.paymentMethods.push({ id: "pm-cash", hotelId: "hotel-a", name: "Cash", isActive: true });

  state.tenant = {
    userId: "user-manager",
    hotelId: "hotel-a",
    role: HotelRole.MANAGER,
    hotel: { id: "hotel-a", name: "Hotel A", currency: "KES" },
  };
}

beforeEach(() => {
  seed();
});

const guestName = () => `Guest ${Math.random().toString(36).slice(2, 8)}`;

function createRequest(body: Record<string, unknown> = {}) {
  return new Request("http://localhost:3000/api/reservations", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      guestName: guestName(),
      checkInDate: "2026-12-01T00:00:00.000Z",
      checkOutDate: "2026-12-03T00:00:00.000Z",
      roomId: "room-101",
      occupancyTypeId: "occ-double",
      adults: 2,
      ...body,
    }),
  });
}

function repriceRequest(id: string, body: Record<string, unknown> = {}) {
  return new Request(`http://localhost:3000/api/reservations/${id}/reprice`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const repriceCtx = (id: string) => ({ params: Promise.resolve({ id }) });

async function createStay(body: Record<string, unknown> = {}) {
  const response = await createReservation(createRequest(body));
  const payload = await response.json();
  return { response, payload };
}

const totalOf = (snapshot: Row) => Number(snapshot.grandTotal);

describe("fail-closed snapshot creation", () => {
  it("refuses the reservation and rolls everything back when the snapshot cannot be written", async () => {
    faults.snapshotCreate = new Error("disk full");
    const response = await createReservation(createRequest());
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toMatch(/price could not be recorded/i);
    expect(dbHandle.current.reservations).toHaveLength(0);
    expect(dbHandle.current.reservationRooms).toHaveLength(0);
    expect(dbHandle.current.guests).toHaveLength(0);
  });

  it("does not treat a missing snapshot delegate as optional for configured pricing", async () => {
    faults.snapshotDelegateMissing = true;
    const response = await createReservation(createRequest());

    expect(response.status).toBe(500);
    expect(dbHandle.current.reservations).toHaveLength(0);
  });

  it("still creates a legacy reservation when snapshot storage is missing", async () => {
    seed({ configured: false });
    faults.snapshotDelegateMissing = true;
    const response = await createReservation(
      createRequest({ occupancyTypeId: undefined, tariffId: "rt-deluxe", occupancy: "DOUBLE", mealPlan: "BED_ONLY" })
    );
    const payload = await response.json();

    expect(response.status).toBe(201);
    expect(payload.total).toBe(12000);
    expect(dbHandle.current.reservations).toHaveLength(1);
    expect(dbHandle.current.snapshots).toHaveLength(0);
  });

  it("keeps the pre-pricing legacy path: no configured breakdown, no snapshot, same totals", async () => {
    seed({ configured: false });
    faults.snapshotCreate = new Error("snapshot write must not be attempted for a legacy quote");
    const response = await createReservation(
      createRequest({ occupancyTypeId: undefined, tariffId: "rt-deluxe", occupancy: "DOUBLE", mealPlan: "BED_ONLY" })
    );

    expect(response.status).toBe(201);
    expect(dbHandle.current.reservations).toHaveLength(1);
    expect(dbHandle.current.snapshots).toHaveLength(0);
  });
});

describe("repricing eligibility and locked re-read", () => {
  function addFolio(reservationId: string, options: { charges?: number; payments?: string[] } = {}) {
    const folio = {
      id: `folio-${dbHandle.current.folios.length + 1}`,
      hotelId: "hotel-a",
      guestId: "guest-1",
      reservationId,
      isClosed: false,
    };
    dbHandle.current.folios.push(folio);
    for (let index = 0; index < (options.charges ?? 0); index += 1) {
      dbHandle.current.folioItems.push({
        id: `item-${dbHandle.current.folioItems.length + 1}`,
        folioId: folio.id,
        type: "ROOM_CHARGE",
        total: 4000,
      });
    }
    for (const status of options.payments ?? []) {
      dbHandle.current.payments.push({
        id: `pay-${dbHandle.current.payments.length + 1}`,
        folioId: folio.id,
        hotelId: "hotel-a",
        amount: 4000,
        status,
      });
    }
    return folio;
  }

  it("refuses to reprice once a payment has been recorded", async () => {
    const { payload } = await createStay();
    addFolio(payload.id, { charges: 2, payments: ["COMPLETED"] });

    const response = await reprice(repriceRequest(payload.id, { reason: "late discount" }), repriceCtx(payload.id));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("RESERVATION_HAS_FINANCIAL_ACTIVITY");
    expect(body.error).toMatch(/payment/i);
    // Nothing was appended and the original agreement is untouched.
    expect(dbHandle.current.snapshots).toHaveLength(1);
    expect(dbHandle.current.changes).toHaveLength(0);
    expect(dbHandle.current.audits.filter((row) => row.action === "RESERVATION_REPRICED")).toHaveLength(0);
  });

  it("refuses to reprice while a deposit is still pending", async () => {
    const { payload } = await createStay();
    addFolio(payload.id, { payments: ["PENDING"] });

    const response = await reprice(repriceRequest(payload.id), repriceCtx(payload.id));
    expect(response.status).toBe(409);
    expect(dbHandle.current.snapshots).toHaveLength(1);
  });

  it("refuses to reprice once a folio charge exists, even without a payment", async () => {
    const { payload } = await createStay();
    addFolio(payload.id, { charges: 1 });

    const response = await reprice(repriceRequest(payload.id), repriceCtx(payload.id));
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("RESERVATION_HAS_FINANCIAL_ACTIVITY");
    expect(body.error).toMatch(/folio charge/i);
    expect(dbHandle.current.snapshots).toHaveLength(1);
  });

  it("still reprices an unpaid reservation that has an empty folio", async () => {
    const { payload } = await createStay();
    addFolio(payload.id, {});

    const response = await reprice(repriceRequest(payload.id, { reason: "no money yet" }), repriceCtx(payload.id));
    expect(response.status).toBe(200);
    expect(dbHandle.current.snapshots).toHaveLength(2);
  });

  it("re-validates the status under the lock", async () => {
    const { payload } = await createStay();
    // A concurrent check-in commits before this request obtains the lock.
    dbHandle.current.reservations[0].status = "CHECKED_IN";

    const response = await reprice(repriceRequest(payload.id), repriceCtx(payload.id));
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/pending or confirmed/i);
    expect(dbHandle.current.snapshots).toHaveLength(1);
    expect(dbHandle.current.changes).toHaveLength(0);
  });

  it("prices the reservation as it is at lock time, not as it was when booked", async () => {
    const { payload } = await createStay();
    // A reschedule committed before this request: the stay is now four nights.
    const reservation = dbHandle.current.reservations[0];
    reservation.checkInDate = new Date("2026-12-01T00:00:00.000Z");
    reservation.checkOutDate = new Date("2026-12-05T00:00:00.000Z");

    const response = await reprice(repriceRequest(payload.id, { reason: "longer stay" }), repriceCtx(payload.id));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.breakdown.nights).toBe(4);
    const snapshot = dbHandle.current.snapshots[1];
    expect(snapshot.nights).toBe(4);
    expect(totalOf(snapshot)).toBe(body.total);
    // Four nights, not the two that were agreed when the booking was made.
    expect(totalOf(snapshot)).toBeGreaterThan(totalOf(dbHandle.current.snapshots[0]));
  });
});

describe("append-only pricing history", () => {
  it("keeps the original agreement and appends a version per reprice", async () => {
    const { response, payload } = await createStay({ mealPlanId: "mp-half" });
    expect(response.status).toBe(201);

    const original = { ...dbHandle.current.snapshots[0] };
    expect(original).toMatchObject({ version: 1, currency: "KES", occupancyName: "Double", mealPlanName: "Half Board" });
    const originalTotal = totalOf(original);
    expect(originalTotal).toBe(payload.total);

    // The hotel raises the rate twice; each repricing is explicit.
    dbHandle.current.roomTypeOccupancies[0].nightlyRate = 9500;
    const first = await reprice(repriceRequest(payload.id, { reason: "rate review" }), repriceCtx(payload.id));
    expect(first.status).toBe(200);
    const firstBody = await first.json();
    expect(firstBody).toMatchObject({ previousTotal: originalTotal, version: 2 });

    dbHandle.current.roomTypeOccupancies[0].nightlyRate = 10500;
    const second = await reprice(repriceRequest(payload.id, { reason: "season change" }), repriceCtx(payload.id));
    expect(second.status).toBe(200);
    const secondBody = await second.json();
    expect(secondBody).toMatchObject({ previousTotal: firstBody.total, version: 3 });

    // The original row is byte-for-byte what it was.
    expect(dbHandle.current.snapshots[0]).toEqual(original);

    const versions = dbHandle.current.snapshots
      .filter((row) => row.reservationId === payload.id)
      .sort((left, right) => left.version - right.version);
    expect(versions.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(versions.map(totalOf)).toEqual([originalTotal, firstBody.total, secondBody.total]);
    // Every version keeps its own currency, occupancy, meal plan and actor.
    for (const version of versions) {
      expect(version.currency).toBe("KES");
      expect(version.occupancyName).toBe("Double");
      expect(version.mealPlanName).toBe("Half Board");
      expect(version.createdById).toBe("user-manager");
    }

    const changes = dbHandle.current.changes;
    expect(changes).toHaveLength(2);
    expect(changes[0]).toMatchObject({ previousVersion: 1, newVersion: 2, previousTotal: originalTotal });
    expect(changes[1]).toMatchObject({ previousVersion: 2, newVersion: 3 });
    expect(dbHandle.current.audits.filter((row) => row.action === "RESERVATION_REPRICED")).toHaveLength(2);

    // The current price is unambiguously the highest version.
    const current = latestVersion(versions as { version: number; grandTotal: unknown }[]);
    expect(current?.version).toBe(3);
    expect(current?.grandTotal).toBe(secondBody.total);
  });

  it("refuses to write a version number that already exists", async () => {
    const { payload } = await createStay();
    await reprice(repriceRequest(payload.id), repriceCtx(payload.id));
    expect(dbHandle.current.snapshots).toHaveLength(2);

    // A racing writer read version 1 as current; the unique (reservationId,
    // version) index must stop the duplicate and roll the repricing back.
    faults.staleVersionRead = true;
    const conflict = await reprice(repriceRequest(payload.id, { reason: "race" }), repriceCtx(payload.id));
    faults.staleVersionRead = false;

    expect(conflict.status).toBeGreaterThanOrEqual(400);
    expect(dbHandle.current.snapshots).toHaveLength(2);
    expect(dbHandle.current.changes).toHaveLength(1);
  });
});

describe("atomic audit recording", () => {
  it("does not reprice when the audit record cannot be written", async () => {
    const { payload } = await createStay({ mealPlanId: "mp-half" });
    const before = {
      snapshots: dbHandle.current.snapshots.length,
      rate: dbHandle.current.reservationRooms[0].rate,
      discount: dbHandle.current.reservations[0].discount,
    };
    dbHandle.current.roomTypeOccupancies[0].nightlyRate = 9999;
    faults.auditCreate = new Error("audit table unavailable");

    const response = await reprice(repriceRequest(payload.id, { reason: "should not stick" }), repriceCtx(payload.id));
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.code).toBe("AUDIT_UNAVAILABLE");
    expect(body.error).toMatch(/nothing was changed/i);
    expect(dbHandle.current.snapshots).toHaveLength(before.snapshots);
    expect(dbHandle.current.changes).toHaveLength(0);
    expect(dbHandle.current.reservationRooms[0].rate).toBe(before.rate);
    expect(dbHandle.current.reservations[0].discount).toBe(before.discount);
  });

  it("fails closed when the audit model itself is missing", async () => {
    const { payload } = await createStay();
    faults.auditDelegateMissing = true;

    const response = await reprice(repriceRequest(payload.id), repriceCtx(payload.id));
    const body = await response.json();
    faults.auditDelegateMissing = false;

    expect(response.status).toBe(500);
    expect(body.code).toBe("AUDIT_UNAVAILABLE");
    expect(dbHandle.current.snapshots).toHaveLength(1);
    expect(dbHandle.current.changes).toHaveLength(0);
  });
});

describe("tenant isolation on repricing", () => {
  it("cannot reprice another hotel's reservation", async () => {
    const { payload } = await createStay();
    const before = structuredClone(dbHandle.current.snapshots);

    state.tenant = {
      userId: "user-b",
      hotelId: "hotel-b",
      role: HotelRole.MANAGER,
      hotel: { id: "hotel-b", name: "Hotel B", currency: "USD" },
    };
    const response = await reprice(repriceRequest(payload.id), repriceCtx(payload.id));

    expect(response.status).toBe(404);
    expect(dbHandle.current.snapshots).toEqual(before);
    expect(dbHandle.current.changes).toHaveLength(0);
  });

  it("refuses repricing from a receptionist", async () => {
    const { payload } = await createStay();
    state.tenant = { ...state.tenant!, role: HotelRole.RECEPTIONIST };
    const response = await reprice(repriceRequest(payload.id), repriceCtx(payload.id));
    expect(response.status).toBe(403);
    expect(dbHandle.current.snapshots).toHaveLength(1);
  });
});

describe("folio charges follow the latest version", () => {
  it("bills the repriced total and the repriced breakdown", async () => {
    const { payload } = await createStay({ mealPlanId: "mp-half" });
    // 8,500 x 2 nights + 1,500 x 2 people x 2 nights
    expect(payload.total).toBe(23000);

    dbHandle.current.roomTypeOccupancies[0].nightlyRate = 12000;
    const repriced = await reprice(repriceRequest(payload.id, { reason: "peak season" }), repriceCtx(payload.id));
    const repriceBody = await repriced.json();
    expect(repriceBody.total).toBe(12000 * 2 + 1500 * 2 * 2);

    const result = await checkIn(
      { userId: "user-manager", hotelId: "hotel-a", hotelName: "Hotel A", role: HotelRole.RECEPTIONIST, currency: "KES" },
      { reservationId: payload.id }
    );

    expect(result.required).toBe(repriceBody.total);
    expect(dbHandle.current.snapshots).toHaveLength(2);
    // Version 1 still records what was originally agreed.
    expect(totalOf(dbHandle.current.snapshots[0])).toBe(23000);

    const roomCharge = dbHandle.current.folioItems.find((item) => item.type === "ROOM_CHARGE");
    expect(roomCharge?.unitPrice).toBe(12000);
    expect(roomCharge?.total).toBe(24000);
    const meal = dbHandle.current.folioItems.find((item) => /Half Board/.test(String(item.description)));
    expect(meal?.total).toBe(6000);
    const itemsTotal = dbHandle.current.folioItems.reduce((sum, item) => sum + Number(item.total), 0);
    expect(itemsTotal).toBe(repriceBody.total);
    expect(dbHandle.current.reservations[0].status).toBe("CHECKED_IN");
  });
});
