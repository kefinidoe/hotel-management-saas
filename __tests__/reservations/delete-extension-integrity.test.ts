import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Deletion and stay-extension integrity, at the route level.
 *
 * The real-PostgreSQL verification (scripts/verify-reservation-integrity.mjs)
 * proves the locking and concurrency behaviour. These tests run the same two
 * routes against an in-memory database whose transactions genuinely roll back,
 * so the rules are pinned in the fast suite as well: what may be deleted, what
 * must never be deleted, and what an extension has to record.
 */

export const HotelRole = {
  HOTEL_OWNER: "HOTEL_OWNER",
  HOTEL_ADMIN: "HOTEL_ADMIN",
  MANAGER: "MANAGER",
  RECEPTIONIST: "RECEPTIONIST",
  CASHIER: "CASHIER",
} as const;

const state: { tenant: any } = { tenant: null };

vi.doMock("next/server", () => {
  class MockNextResponse extends Response {
    static json(data: any, init?: ResponseInit) {
      return new Response(JSON.stringify(data), {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      });
    }
  }
  return { NextResponse: MockNextResponse };
});

vi.doMock("@prisma/client", () => ({
  RoomStatus: { AVAILABLE: "AVAILABLE", RESERVED: "RESERVED", OCCUPIED: "OCCUPIED", DIRTY: "DIRTY", CLEANING: "CLEANING", READY: "READY", MAINTENANCE: "MAINTENANCE", OUT_OF_ORDER: "OUT_OF_ORDER" },
  Prisma: {
    TransactionIsolationLevel: { Serializable: "Serializable", ReadCommitted: "ReadCommitted" },
    PrismaClientKnownRequestError: class extends Error {
      code: string;
      meta?: unknown;
      constructor(message: string, code: string) {
        super(message);
        this.code = code;
      }
    },
    InputJsonValue: undefined,
  },
}));

vi.doMock("@/lib/authz", () => ({
  getTenantFromRoute: async () => {
    if (!state.tenant) return Response.json({ error: "UNAUTHORIZED" }, { status: 401 });
    return state.tenant;
  },
  requireModule: async () => null,
  requireRole: (role: string, allowed: readonly string[]) =>
    allowed.includes(role)
      ? null
      : Response.json({ error: "You don't have permission to do that." }, { status: 403 }),
  ROLE_GROUPS: {
    MANAGEMENT: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER"],
    GUEST_STAYS: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER", "RECEPTIONIST"],
  },
}));

type Row = Record<string, any>;

type Db = {
  reservations: Row[];
  reservationRooms: Row[];
  rooms: Row[];
  folios: Row[];
  folioItems: Row[];
  payments: Row[];
  snapshots: Row[];
  changes: Row[];
  extensions: Row[];
  audits: Row[];
};

const emptyDb = (): Db => ({
  reservations: [],
  reservationRooms: [],
  rooms: [],
  folios: [],
  folioItems: [],
  payments: [],
  snapshots: [],
  changes: [],
  extensions: [],
  audits: [],
});

let db: Db = emptyDb();

const faults = { auditCreate: null as null | Error };

const matches = (row: Row, where: Row | undefined): boolean => {
  if (!where) return true;
  return Object.entries(where).every(([key, value]) => {
    if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
      return Object.entries(value as Row).every(([innerKey, innerValue]) => row[innerKey] === innerValue);
    }
    return row[key] === value;
  });
};

function shapeReservation(reservation: Row, include?: Row) {
  if (!reservation) return null;
  const copy: Row = { ...reservation };
  if (include?.rooms) {
    copy.rooms = db.reservationRooms
      .filter((row) => row.reservationId === reservation.id)
      .map((row) => ({
        ...row,
        room: db.rooms.find((room) => room.id === row.roomId),
      }));
  }
  if (include?.folios) {
    copy.folios = db.folios
      .filter((folio) => folio.reservationId === reservation.id)
      .filter((folio) => !include.folios?.where?.isClosed || folio.isClosed === false)
      .map((folio) => ({
        ...folio,
        items: db.folioItems.filter((item) => item.folioId === folio.id),
        payments: db.payments.filter((payment) => payment.folioId === folio.id),
      }));
  }
  if (include?.priceSnapshots) {
    copy.priceSnapshots = db.snapshots
      .filter((row) => row.reservationId === reservation.id)
      .sort((left, right) => right.version - left.version);
  }
  if (include?.priceChanges) {
    copy.priceChanges = db.changes.filter((row) => row.reservationId === reservation.id);
  }
  if (include?.stayExtensions) {
    copy.stayExtensions = db.extensions.filter((row) => row.reservationId === reservation.id);
  }
  return copy;
}

function client(): Row {
  const tx: Row = {
    $queryRaw: async () => [{ locked: "1" }],
    reservation: {
      findUnique: async ({ where, include }: { where: Row; include?: Row }) => {
        const reservation = db.reservations.find((row) => matches(row, where));
        return reservation ? shapeReservation(reservation, include) : null;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const reservation = db.reservations.find((row) => matches(row, where));
        if (!reservation) throw new Error("Reservation not found");
        Object.assign(reservation, data);
        return reservation;
      },
      delete: async ({ where }: { where: Row }) => {
        const index = db.reservations.findIndex((row) => matches(row, where));
        if (index === -1) throw new Error("Reservation not found");
        return db.reservations.splice(index, 1)[0];
      },
    },
    reservationRoom: {
      deleteMany: async ({ where }: { where: Row }) => {
        const before = db.reservationRooms.length;
        db.reservationRooms = db.reservationRooms.filter((row) => !matches(row, where));
        return { count: before - db.reservationRooms.length };
      },
      findFirst: async ({ where }: { where: Row }) => {
        const reservationIds = db.reservationRooms
          .filter((row) => (where.roomId?.in ?? []).includes(row.roomId))
          .map((row) => row.reservationId);
        const excluded = where.reservation?.id?.not;
        const candidate = db.reservations.find(
          (row) =>
            reservationIds.includes(row.id) &&
            row.hotelId === where.reservation?.hotelId &&
            row.id !== excluded &&
            row.status !== "CANCELLED" &&
            row.status !== "NO_SHOW"
        );
        if (!candidate) return null;
        const link = db.reservationRooms.find((row) => row.reservationId === candidate.id)!;
        return {
          ...link,
          room: db.rooms.find((room) => room.id === link.roomId),
          reservation: { code: candidate.code, checkInDate: candidate.checkInDate },
        };
      },
    },
    reservationPriceSnapshot: {
      findFirst: async ({ where }: { where: Row }) => {
        const rows = db.snapshots
          .filter((row) => matches(row, where))
          .sort((left, right) => right.version - left.version);
        return rows[0] ?? null;
      },
      deleteMany: async ({ where }: { where: Row }) => {
        const before = db.snapshots.length;
        db.snapshots = db.snapshots.filter((row) => !matches(row, where));
        return { count: before - db.snapshots.length };
      },
    },
    reservationExtension: {
      findFirst: async ({ where }: { where: Row }) => {
        const rows = db.extensions.filter((row) => matches(row, where));
        return rows[0] ?? null;
      },
      create: async ({ data }: { data: Row }) => {
        const clash = db.extensions.some(
          (row) =>
            row.reservationId === data.reservationId &&
            new Date(row.previousCheckOut).getTime() === new Date(data.previousCheckOut).getTime()
        );
        if (clash) throw new Error("duplicate extension");
        const extension = { id: `ext-${db.extensions.length + 1}`, ...data };
        db.extensions.push(extension);
        return extension;
      },
    },
    folioItem: {
      create: async ({ data }: { data: Row }) => {
        const item = { id: `fi-${db.folioItems.length + 1}`, ...data };
        db.folioItems.push(item);
        return item;
      },
    },
    auditLog: faults.auditCreate
      ? undefined
      : {
          create: async ({ data }: { data: Row }) => {
            if (faults.auditCreate) throw faults.auditCreate;
            db.audits.push(data);
            return data;
          },
        },
  };
  tx.$transaction = async (fn: (client: Row) => Promise<unknown>) => {
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

vi.doMock("@/lib/prisma", () => ({
  prisma: new Proxy({}, { get: (_target, property) => client()[property as string] }),
}));

const dbHandle = { get current() { return db; } };

let deleteReservation: (req: Request, ctx: any) => Promise<Response>;
let extendStay: (req: Request, ctx: any) => Promise<Response>;

beforeAll(async () => {
  const route = await import("@/app/api/reservations/[id]/route");
  deleteReservation = route.DELETE as unknown as typeof deleteReservation;
  const extendRoute = await import("@/app/api/reservations/[id]/extend/route");
  extendStay = extendRoute.POST as unknown as typeof extendStay;
});

const CHECK_IN = new Date("2026-12-01T12:00:00.000Z");
const CHECK_OUT = new Date("2026-12-03T12:00:00.000Z");
const RATE = 7000;

function seed() {
  db = emptyDb();
  faults.auditCreate = null;
  db.rooms.push({ id: "room-101", hotelId: "hotel-a", number: "101", roomTypeId: "rt-standard" });
  db.reservations.push({
    id: "res-1",
    hotelId: "hotel-a",
    code: "RES-2026-00001",
    guestId: "guest-1",
    status: "PENDING",
    checkInDate: CHECK_IN,
    checkOutDate: CHECK_OUT,
    adults: 1,
    children: 0,
  });
  db.reservationRooms.push({
    id: "rr-1",
    reservationId: "res-1",
    hotelId: "hotel-a",
    roomId: "room-101",
    rate: RATE,
  });
  // Version 1: the agreement every reservation created through the API carries.
  db.snapshots.push({
    id: "snap-1",
    hotelId: "hotel-a",
    reservationId: "res-1",
    version: 1,
    currency: "KES",
    grandTotal: RATE * 2,
    nights: 2,
    nightlyRate: RATE,
    createdById: "user-reception",
    roomTotal: RATE * 2,
    discountTotal: 0,
    mealsTotal: 0,
    extrasTotal: 0,
    adjustmentsTotal: 0,
    taxTotal: 0,
  });
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

const deleteCtx = { params: Promise.resolve({ id: "res-1" }) };
const deleteRequest = () => new Request("http://localhost:3000/api/reservations/res-1", { method: "DELETE" });

function extendRequest(checkOutDate: string, note = "guest staying longer") {
  return new Request("http://localhost:3000/api/reservations/res-1/extend", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checkOutDate, note }),
  });
}

function addFolio({ items = 0, payments = [] as string[] } = {}) {
  db.folios.push({ id: "folio-1", hotelId: "hotel-a", reservationId: "res-1", guestId: "guest-1", isClosed: false });
  for (let index = 0; index < items; index += 1) {
    db.folioItems.push({
      id: `fi-${db.folioItems.length + 1}`,
      folioId: "folio-1",
      type: "ROOM_CHARGE",
      description: "accommodation",
      quantity: 2,
      unitPrice: RATE,
      total: RATE * 2,
    });
  }
  for (const status of payments) {
    db.payments.push({
      id: `pay-${db.payments.length + 1}`,
      folioId: "folio-1",
      hotelId: "hotel-a",
      amount: 2000,
      status,
    });
  }
}

describe("reservation deletion", () => {
  it("deletes a genuinely unused draft and records who did it", async () => {
    const response = await deleteReservation(deleteRequest(), deleteCtx);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.message).toMatch(/deleted/i);
    expect(dbHandle.current.reservations).toHaveLength(0);
    expect(dbHandle.current.reservationRooms).toHaveLength(0);
    // The draft's own frozen quote goes with the draft it belonged to.
    expect(dbHandle.current.snapshots).toHaveLength(0);
    const audit = dbHandle.current.audits.find((row) => row.action === "RESERVATION_DELETED");
    expect(audit).toMatchObject({ hotelId: "hotel-a", userId: "user-manager", entityId: "res-1" });
    expect(audit?.metadata).toMatchObject({ code: "RES-2026-00001", priceSnapshotsRemoved: 1 });
  });

  it("refuses deletion when a folio charge exists, and changes nothing", async () => {
    addFolio({ items: 2 });
    const before = structuredClone(dbHandle.current);

    const response = await deleteReservation(deleteRequest(), deleteCtx);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("RESERVATION_HAS_FINANCIAL_RECORDS");
    expect(body.error).toMatch(/folio charge/i);
    expect(dbHandle.current).toEqual(before);
    expect(dbHandle.current.audits).toHaveLength(0);
  });

  it.each([
    ["PENDING", /pending/i],
    ["REFUNDED", /refunded/i],
    ["COMPLETED", /completed/i],
    ["FAILED", /failed/i],
  ])("refuses deletion when a %s payment exists", async (status, pattern) => {
    addFolio({ payments: [status] });
    const response = await deleteReservation(deleteRequest(), deleteCtx);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("RESERVATION_HAS_FINANCIAL_RECORDS");
    expect(body.error).toMatch(/payment/i);
    expect(body.error).toMatch(pattern);
    expect(dbHandle.current.reservations).toHaveLength(1);
    expect(dbHandle.current.payments).toHaveLength(1);
  });

  it("refuses deletion when pricing history exists", async () => {
    db.snapshots.push({ ...db.snapshots[0], id: "snap-2", version: 2, grandTotal: RATE * 2 - 500 });
    db.changes.push({ id: "change-1", reservationId: "res-1", hotelId: "hotel-a", previousVersion: 1, newVersion: 2 });

    const response = await deleteReservation(deleteRequest(), deleteCtx);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/repricing/i);
    expect(dbHandle.current.snapshots).toHaveLength(2);
    expect(dbHandle.current.changes).toHaveLength(1);
  });

  it("refuses deletion when a stay extension was recorded", async () => {
    addFolio({ items: 1 });
    db.extensions.push({
      id: "ext-1",
      reservationId: "res-1",
      hotelId: "hotel-a",
      previousCheckOut: CHECK_OUT,
      newCheckOut: new Date("2026-12-04T12:00:00.000Z"),
      additionalNights: 1,
    });

    const response = await deleteReservation(deleteRequest(), deleteCtx);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/extension/i);
    expect(dbHandle.current.extensions).toHaveLength(1);
  });

  it("refuses deletion of a checked-in stay", async () => {
    db.reservations[0].status = "CHECKED_IN";
    const response = await deleteReservation(deleteRequest(), deleteCtx);
    expect(response.status).toBe(409);
    expect(dbHandle.current.reservations).toHaveLength(1);
  });

  it("cannot delete another hotel's reservation", async () => {
    state.tenant = { ...state.tenant, hotelId: "hotel-b" };
    const response = await deleteReservation(deleteRequest(), deleteCtx);
    expect(response.status).toBe(404);
    expect(dbHandle.current.reservations).toHaveLength(1);
  });

  it("refuses deletion for a receptionist", async () => {
    state.tenant = { ...state.tenant, role: HotelRole.RECEPTIONIST };
    const response = await deleteReservation(deleteRequest(), deleteCtx);
    expect(response.status).toBe(403);
    expect(dbHandle.current.reservations).toHaveLength(1);
  });

  it("rolls the deletion back when the audit record cannot be written", async () => {
    faults.auditCreate = new Error("audit store unavailable");
    const response = await deleteReservation(deleteRequest(), deleteCtx);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.code).toBe("AUDIT_UNAVAILABLE");
    expect(dbHandle.current.reservations).toHaveLength(1);
    expect(dbHandle.current.reservationRooms).toHaveLength(1);
    expect(dbHandle.current.snapshots).toHaveLength(1);
  });
});

describe("stay extensions", () => {
  beforeEach(() => {
    db.reservations[0].status = "CHECKED_IN";
    addFolio({ items: 1, payments: ["COMPLETED"] });
    db.payments[0].amount = 5000;
  });

  it("posts the extra nights, records the agreement and audits it", async () => {
    const originalSnapshot = structuredClone(dbHandle.current.snapshots[0]);

    const response = await extendStay(extendRequest("2026-12-05T12:00:00.000Z"), deleteCtx);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ additionalNights: 2, nightlyRate: RATE, additionalCharge: RATE * 2 });
    expect(body.currency).toBe("KES");
    expect(body.priceVersion).toBe(1);

    const charge = dbHandle.current.folioItems.at(-1)!;
    expect(charge).toMatchObject({
      folioId: "folio-1",
      type: "ROOM_CHARGE",
      quantity: 2,
      unitPrice: RATE,
      total: RATE * 2,
    });

    const extension = dbHandle.current.extensions[0];
    expect(extension).toMatchObject({
      hotelId: "hotel-a",
      reservationId: "res-1",
      additionalNights: 2,
      nightlyRate: RATE,
      additionalCharge: RATE * 2,
      currency: "KES",
      folioId: "folio-1",
      priceVersion: 1,
      approvedById: "user-manager",
    });
    expect(new Date(extension.previousCheckOut).toISOString()).toBe(CHECK_OUT.toISOString());
    expect(new Date(extension.newCheckOut).toISOString()).toBe("2026-12-05T12:00:00.000Z");
    expect(extension.rooms).toEqual([
      { roomId: "room-101", number: "101", roomTypeId: "rt-standard", nightlyRate: RATE, nights: 2, amount: RATE * 2 },
    ]);

    // The booking's frozen agreement is byte-for-byte what it was.
    expect(dbHandle.current.snapshots).toHaveLength(1);
    expect(dbHandle.current.snapshots[0]).toEqual(originalSnapshot);
    expect(dbHandle.current.changes).toHaveLength(0);
    expect(new Date(dbHandle.current.reservations[0].checkOutDate).toISOString()).toBe(
      "2026-12-05T12:00:00.000Z"
    );
    expect(dbHandle.current.audits.filter((row) => row.action === "RESERVATION_EXTENDED")).toHaveLength(1);
    expect(dbHandle.current.audits.find((row) => row.action === "RESERVATION_EXTENDED")?.metadata).toMatchObject({
      extensionId: extension.id,
      additionalNights: 2,
      additionalCharge: RATE * 2,
    });
  });

  it("does not post a second charge for the same extension", async () => {
    await extendStay(extendRequest("2026-12-05T12:00:00.000Z"), deleteCtx);
    const itemsAfterFirst = dbHandle.current.folioItems.length;

    const response = await extendStay(extendRequest("2026-12-05T12:00:00.000Z"), deleteCtx);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.code).toBe("EXTENSION_ALREADY_APPLIED");
    expect(dbHandle.current.folioItems).toHaveLength(itemsAfterFirst);
    expect(dbHandle.current.extensions).toHaveLength(1);
  });

  it("rolls the charge, the history and the dates back when the audit fails", async () => {
    faults.auditCreate = new Error("audit store unavailable");
    const before = structuredClone(dbHandle.current);

    const response = await extendStay(extendRequest("2026-12-05T12:00:00.000Z"), deleteCtx);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.code).toBe("AUDIT_UNAVAILABLE");
    expect(dbHandle.current).toEqual(before);
    expect(dbHandle.current.extensions).toHaveLength(0);
  });

  it("refuses to extend a stay that is not checked in", async () => {
    db.reservations[0].status = "PENDING";
    const response = await extendStay(extendRequest("2026-12-05T12:00:00.000Z"), deleteCtx);
    expect(response.status).toBe(400);
    expect(dbHandle.current.extensions).toHaveLength(0);
  });

  it("refuses an extension blocked by another booking", async () => {
    db.reservations.push({
      id: "res-2",
      hotelId: "hotel-a",
      code: "RES-2026-00002",
      guestId: "guest-2",
      status: "CONFIRMED",
      checkInDate: new Date("2026-12-03T12:00:00.000Z"),
      checkOutDate: new Date("2026-12-06T12:00:00.000Z"),
    });
    db.reservationRooms.push({
      id: "rr-2",
      reservationId: "res-2",
      hotelId: "hotel-a",
      roomId: "room-101",
      rate: RATE,
    });

    const response = await extendStay(extendRequest("2026-12-05T12:00:00.000Z"), deleteCtx);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/booked from/i);
    expect(dbHandle.current.folioItems).toHaveLength(1);
    expect(dbHandle.current.extensions).toHaveLength(0);
  });

  it("cannot extend another hotel's stay", async () => {
    state.tenant = { ...state.tenant, hotelId: "hotel-b" };
    const response = await extendStay(extendRequest("2026-12-05T12:00:00.000Z"), deleteCtx);
    expect(response.status).toBe(404);
    expect(dbHandle.current.extensions).toHaveLength(0);
    expect(dbHandle.current.folioItems).toHaveLength(1);
  });
});
