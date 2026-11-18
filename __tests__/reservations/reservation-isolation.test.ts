import { describe, it, expect, vi, beforeEach } from "vitest";
import { pricingModelStubs } from "../fixtures/pricing-prisma-double";

export const HotelRole = {
  HOTEL_OWNER: "HOTEL_OWNER",
  HOTEL_ADMIN: "HOTEL_ADMIN",
  HOTEL_MANAGER: "HOTEL_MANAGER",
  HOTEL_RECEPTIONIST: "RECEPTIONIST",
  RECEPTIONIST: "RECEPTIONIST",
  CASHIER: "CASHIER",
  HOUSEKEEPER: "HOUSEKEEPER",
  MAINTENANCE: "MAINTENANCE",
  WAITER: "WAITER",
  CHEF: "CHEF",
} as const;

export const HotelStatus = {
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
} as const;

export const MembershipStatus = {
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
} as const;

export const ReservationStatus = {
  PENDING: "PENDING",
  CONFIRMED: "CONFIRMED",
  CHECKED_IN: "CHECKED_IN",
  CHECKED_OUT: "CHECKED_OUT",
  CANCELLED: "CANCELLED",
  NO_SHOW: "NO_SHOW",
} as const;

export const RoomStatus = {
  AVAILABLE: "AVAILABLE",
  OCCUPIED: "OCCUPIED",
  RESERVED: "RESERVED",
  DIRTY: "DIRTY",
  CLEANING: "CLEANING",
  MAINTENANCE: "MAINTENANCE",
  OUT_OF_ORDER: "OUT_OF_ORDER",
} as const;

// Module mocks for next-auth, next/headers, and prisma
let mockCurrentTenant: any = null;

vi.doMock("@prisma/client", () => ({
  HotelRole,
  HotelStatus,
  MembershipStatus,
  ReservationStatus,
  RoomStatus,
  SubscriptionStatus: {
    TRIALING: "TRIALING",
    ACTIVE: "ACTIVE",
    PAST_DUE: "PAST_DUE",
    SUSPENDED: "SUSPENDED",
    CANCELLED: "CANCELLED",
  },
  BillingInterval: {
    MONTHLY: "MONTHLY",
    YEARLY: "YEARLY",
  },
  Prisma: {
    TransactionIsolationLevel: {
      Serializable: "Serializable",
    },
    PrismaClientKnownRequestError: class extends Error {
      code: string;
      constructor(msg: string, code: string) {
        super(msg);
        this.code = code;
      }
    },
  },
}));

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

vi.doMock("next-auth", () => ({
  getServerSession: () => null,
}));

vi.doMock("next/headers", () => ({
  cookies: async () => ({
    get: () => ({ value: "hotel-a-id" }),
  }),
}));

vi.doMock("@/lib/authz", () => ({
  getTenantFromRoute: async () => {
    if (!mockCurrentTenant) {
      return Response.json({ error: "UNAUTHORIZED", message: "Authentication required" }, { status: 401 });
    }
    return mockCurrentTenant;
  },
  requireModule: async () => null,
  requireRole: (role: any, allowed: readonly (typeof HotelRole)[keyof typeof HotelRole][]) => {
    if (!role || !allowed.includes(role)) {
      return Response.json({ error: "You don't have permission to do that." }, { status: 403 });
    }
    return null;
  },
  ROLE_GROUPS: {
    MANAGEMENT: [HotelRole.HOTEL_OWNER, HotelRole.HOTEL_ADMIN, HotelRole.HOTEL_MANAGER],
    GUEST_STAYS: [HotelRole.HOTEL_OWNER, HotelRole.HOTEL_ADMIN, HotelRole.HOTEL_MANAGER, HotelRole.RECEPTIONIST],
    STAFF: [
      HotelRole.HOTEL_OWNER,
      HotelRole.HOTEL_ADMIN,
      HotelRole.HOTEL_MANAGER,
      HotelRole.RECEPTIONIST,
      HotelRole.CASHIER,
      HotelRole.HOUSEKEEPER,
      HotelRole.MAINTENANCE,
      HotelRole.WAITER,
      HotelRole.CHEF,
    ],
  },
  getPlatformAdminFromRoute: async () => {
    return Response.json({ error: "FORBIDDEN", message: "Insufficient permissions" }, { status: 403 });
  },
}));

// In-memory tenant-isolated database simulator for integration assertions
interface TestDB {
  hotels: Map<string, any>;
  guests: Map<string, any>;
  roomTypes: Map<string, any>;
  rooms: Map<string, any>;
  reservations: Map<string, any>;
  reservationRooms: Map<string, any>;
  folios: Map<string, any>;
  folioItems: Map<string, any>;
  payments: Map<string, any>;
  paymentMethods: Map<string, any>;
  housekeepingTasks: Map<string, any>;
  locks: string[];
}

function createFreshTestDB(): TestDB {
  const db: TestDB = {
    hotels: new Map(),
    guests: new Map(),
    roomTypes: new Map(),
    rooms: new Map(),
    reservations: new Map(),
    reservationRooms: new Map(),
    folios: new Map(),
    folioItems: new Map(),
    payments: new Map(),
    paymentMethods: new Map(),
    housekeepingTasks: new Map(),
    locks: [],
  };

  // Seed Hotel A
  db.hotels.set("hotel-a", { id: "hotel-a", name: "Hotel Alpha" });
  db.roomTypes.set("rt-a-standard", {
    id: "rt-a-standard",
    hotelId: "hotel-a",
    name: "Single — Standard",
    baseRate: 3500,
    mealPlan: "BED_ONLY",
  });
  db.rooms.set("room-a-101", {
    id: "room-a-101",
    hotelId: "hotel-a",
    number: "101",
    status: "AVAILABLE",
    isActive: true,
    roomTypeId: "rt-a-standard",
  });
  db.paymentMethods.set("pm-a-cash", {
    id: "pm-a-cash",
    hotelId: "hotel-a",
    name: "Cash",
    isActive: true,
  });

  // Seed Hotel B (foreign tenant)
  db.hotels.set("hotel-b", { id: "hotel-b", name: "Hotel Beta" });
  db.roomTypes.set("rt-b-deluxe", {
    id: "rt-b-deluxe",
    hotelId: "hotel-b",
    name: "Single — Deluxe",
    baseRate: 8000,
    mealPlan: "BED_ONLY",
  });
  db.rooms.set("room-b-201", {
    id: "room-b-201",
    hotelId: "hotel-b",
    number: "201",
    status: "AVAILABLE",
    isActive: true,
    roomTypeId: "rt-b-deluxe",
  });
  db.reservations.set("res-b-999", {
    id: "res-b-999",
    hotelId: "hotel-b",
    code: "RES-2026-00999",
    guestId: "guest-b-1",
    checkInDate: new Date("2026-11-01"),
    checkOutDate: new Date("2026-11-05"),
    status: "CONFIRMED",
    createdById: "user-b",
  });

  return db;
}

let db: TestDB;

vi.doMock("@/lib/prisma", () => ({
  prisma: {
    // A real client always exposes the pricing models. Without them the pricing
    // reader now fails closed (503) instead of pricing from base rates silently,
    // so the double has to look like a real client: an empty configuration is a
    // hotel that never opened the Pricing page.
    ...pricingModelStubs(),
    $transaction: async (fn: any) => {
      const tx = {
        ...pricingModelStubs(),
        hotel: { findUnique: async ({ where }: any) => db.hotels.has(where.id) ? { useModularPricing: false } : null },
        $queryRaw: async (query: any, ...values: any[]) => {
          const parts = Array.isArray(query) ? query : [query];
          const rendered = parts.map((p: any, i: number) => `${p}${values[i] !== undefined ? values[i] : ""}`).join("");
          db.locks.push(rendered);
          return [{ locked: "1" }];
        },
        reservation: {
          findMany: async ({ where }: any) => {
            const list = Array.from(db.reservations.values()).filter((r) => {
              if (where?.hotelId && r.hotelId !== where.hotelId) return false;
              if (where?.code?.startsWith && !r.code.startsWith(where.code.startsWith)) return false;
              return true;
            });
            return list;
          },
          findUnique: async ({ where }: any) => {
            if (where?.id_hotelId) {
              const res = db.reservations.get(where.id_hotelId.id);
              if (res && res.hotelId === where.id_hotelId.hotelId) {
                // Populate relations
                const rooms = Array.from(db.reservationRooms.values())
                  .filter((rr) => rr.reservationId === res.id)
                  .map((rr) => ({ ...rr, room: db.rooms.get(rr.roomId) }));
                const folios = Array.from(db.folios.values())
                  .filter((f) => f.reservationId === res.id && f.hotelId === where.id_hotelId.hotelId)
                  .map((f) => ({
                    ...f,
                    items: Array.from(db.folioItems.values()).filter((fi) => fi.folioId === f.id),
                    payments: Array.from(db.payments.values()).filter((p) => p.folioId === f.id),
                  }));
                return { ...res, rooms, folios };
              }
              return null;
            }
            if (where?.id) {
              return db.reservations.get(where.id) ?? null;
            }
            return null;
          },
          create: async ({ data }: any) => {
            const id = `res-${Date.now()}-${Math.random().toString(36).substring(7)}`;
            const created = { id, ...data };
            db.reservations.set(id, created);
            if (data.rooms?.create) {
              for (const r of data.rooms.create) {
                const rrId = `rr-${Date.now()}`;
                db.reservationRooms.set(rrId, {
                  id: rrId,
                  reservationId: id,
                  roomId: r.roomId,
                  hotelId: created.hotelId,
                  rate: r.rate,
                });
              }
            }
            return created;
          },
          update: async ({ where, data }: any) => {
            const id = where?.id_hotelId ? where.id_hotelId.id : where.id;
            const res = db.reservations.get(id);
            if (!res) throw new Error("Reservation not found");
            const updated = { ...res, ...data };
            db.reservations.set(id, updated);
            return updated;
          },
        },
        room: {
          findUnique: async ({ where }: any) => {
            if (where?.id_hotelId) {
              const r = db.rooms.get(where.id_hotelId.id);
              if (r && r.hotelId === where.id_hotelId.hotelId) return r;
              return null;
            }
            return db.rooms.get(where.id) ?? null;
          },
          update: async ({ where, data }: any) => {
            const id = where?.id_hotelId ? where.id_hotelId.id : where.id;
            const r = db.rooms.get(id);
            if (!r) throw new Error("Room not found");
            const updated = { ...r, ...data };
            db.rooms.set(id, updated);
            return updated;
          },
        },
        roomType: {
          findUnique: async ({ where }: any) => {
            if (where?.id_hotelId) {
              const rt = db.roomTypes.get(where.id_hotelId.id);
              if (rt && rt.hotelId === where.id_hotelId.hotelId) return rt;
              return null;
            }
            return db.roomTypes.get(where.id) ?? null;
          },
        },
        guest: {
          findFirst: async ({ where }: any) => {
            for (const g of db.guests.values()) {
              if (where?.hotelId && g.hotelId !== where.hotelId) continue;
              if (where?.phone && g.phone === where.phone) return g;
            }
            return null;
          },
          create: async ({ data }: any) => {
            const id = `guest-${Date.now()}`;
            const g = { id, ...data };
            db.guests.set(id, g);
            return g;
          },
          update: async ({ where, data }: any) => {
            const id = where?.id_hotelId ? where.id_hotelId.id : where.id;
            const g = db.guests.get(id);
            const updated = { ...g, ...data };
            db.guests.set(id, updated);
            return updated;
          },
        },
        reservationRoom: {
          findMany: async ({ where }: any) => {
            return Array.from(db.reservationRooms.values()).filter((rr) => {
              if (where?.roomId && rr.roomId !== where.roomId) return false;
              const res = db.reservations.get(rr.reservationId);
              if (!res) return false;
              if (where?.reservation?.hotelId && res.hotelId !== where.reservation.hotelId) return false;
              if (where?.reservation?.status?.notIn && where.reservation.status.notIn.includes(res.status)) return false;
              if (where?.reservation?.status?.in && !where.reservation.status.in.includes(res.status)) return false;
              if (where?.reservation?.id?.not && res.id === where.reservation.id.not) return false;
              return true;
            }).map((rr) => ({ ...rr, reservation: db.reservations.get(rr.reservationId) }));
          },
          update: async ({ where, data }: any) => {
            const rr = db.reservationRooms.get(where.id);
            if (!rr) throw new Error("ReservationRoom not found");
            const updated = { ...rr, ...data };
            db.reservationRooms.set(where.id, updated);
            return updated;
          },
        },
        paymentMethod: {
          findFirst: async ({ where }: any) => {
            for (const pm of db.paymentMethods.values()) {
              if (where?.hotelId && pm.hotelId !== where.hotelId) continue;
              if (where?.id && pm.id === where.id) return pm;
            }
            return null;
          },
        },
        folio: {
          create: async ({ data }: any) => {
            const id = `folio-${Date.now()}`;
            const f = { id, ...data, isClosed: false };
            db.folios.set(id, f);
            return f;
          },
          update: async ({ where, data }: any) => {
            const id = where?.id_hotelId ? where.id_hotelId.id : where.id;
            const f = db.folios.get(id);
            const updated = { ...f, ...data };
            db.folios.set(id, updated);
            return updated;
          },
        },
        folioItem: {
          create: async ({ data }: any) => {
            const id = `fi-${Date.now()}`;
            const fi = { id, ...data };
            db.folioItems.set(id, fi);
            return fi;
          },
        },
        payment: {
          create: async ({ data }: any) => {
            const id = `pay-${Date.now()}`;
            const p = { id, ...data };
            db.payments.set(id, p);
            return p;
          },
        },
        housekeepingTask: {
          create: async ({ data }: any) => {
            const id = `hk-${Date.now()}`;
            const hk = { id, ...data };
            db.housekeepingTasks.set(id, hk);
            return hk;
          },
        },
      };
      return await fn(tx);
    },
    reservation: {
      findMany: async ({ where }: any) => {
        return Array.from(db.reservations.values()).filter((r) => {
          if (where?.hotelId && r.hotelId !== where.hotelId) return false;
          return true;
        }).map((r) => ({
          ...r,
          guest: db.guests.get(r.guestId) || { fullName: "Guest", phone: "" },
          rooms: Array.from(db.reservationRooms.values())
            .filter((rr) => rr.reservationId === r.id)
            .map((rr) => ({ ...rr, room: db.rooms.get(rr.roomId) })),
        }));
      },
      findUnique: async ({ where }: any) => {
        if (where?.id_hotelId) {
          const res = db.reservations.get(where.id_hotelId.id);
          if (res && res.hotelId === where.id_hotelId.hotelId) {
            return {
              ...res,
              guest: db.guests.get(res.guestId) || { fullName: "Guest" },
              rooms: Array.from(db.reservationRooms.values())
                .filter((rr) => rr.reservationId === res.id)
                .map((rr) => ({ ...rr, room: db.rooms.get(rr.roomId) })),
              folios: [],
            };
          }
          return null;
        }
        return null;
      },
    },
  },
}));

// Dynamic imports so bun mock.module registers before module evaluation
let getReservations: any;
let createReservation: any;
let getReservationById: any;
let updateReservation: any;
let deleteReservation: any;
let executeCheckIn: any;
let executeCheckOut: any;
let canTransitionReservation: any;
let isReservationStatus: any;

import { beforeAll } from "vitest";

describe("Phase 4: Multi-Tenant Reservation & Stay Security Hardening", () => {
  beforeAll(async () => {
    const resRoute = await import("@/app/api/reservations/route");
    getReservations = resRoute.GET;
    createReservation = resRoute.POST;

    const resIdRoute = await import("@/app/api/reservations/[id]/route");
    getReservationById = resIdRoute.GET;
    updateReservation = resIdRoute.PUT;
    deleteReservation = resIdRoute.DELETE;

    const stayService = await import("@/lib/stay-service");
    executeCheckIn = stayService.executeCheckIn;
    executeCheckOut = stayService.executeCheckOut;

    const statusLib = await import("@/lib/reservation-status");
    canTransitionReservation = statusLib.canTransitionReservation;
    isReservationStatus = statusLib.isReservationStatus;
  });

  beforeEach(() => {
    db = createFreshTestDB();
    mockCurrentTenant = {
      userId: "user-reception-a",
      hotelId: "hotel-a",
      role: HotelRole.RECEPTIONIST,
      hotel: { id: "hotel-a", name: "Hotel Alpha", slug: "alpha", status: HotelStatus.ACTIVE },
      membership: { id: "mem-a", role: HotelRole.RECEPTIONIST, status: MembershipStatus.ACTIVE },
      isPlatformAdmin: false,
    };
  });

  describe("Tenant Isolation: Cross-Hotel Access Restrictions", () => {
    it("Hotel A cannot read Hotel B's reservations via GET /api/reservations", async () => {
      const req = new Request("http://localhost:3000/api/reservations");
      const res = await getReservations(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
      // Hotel B's seeded reservation 'res-b-999' must NOT appear in Hotel A's listing
      const foreignFound = data.find((r: any) => r.id === "res-b-999" || r.code === "RES-2026-00999");
      expect(foreignFound).toBeUndefined();
    });

    it("Hotel A cannot read Hotel B's reservation by ID via GET /api/reservations/[id]", async () => {
      const res = await getReservationById(new Request("http://localhost:3000/api/reservations/res-b-999"), {
        params: Promise.resolve({ id: "res-b-999" }),
      });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Reservation not found.");
    });

    it("Hotel A cannot update Hotel B's reservation status or schedule", async () => {
      const req = new Request("http://localhost:3000/api/reservations/res-b-999", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CANCELLED" }),
      });
      const res = await updateReservation(req, {
        params: Promise.resolve({ id: "res-b-999" }),
      });
      expect(res.status).toBe(404);
      expect(db.reservations.get("res-b-999")?.status).toBe("CONFIRMED");
    });

    it("Hotel A cannot delete Hotel B's reservation", async () => {
      mockCurrentTenant.role = HotelRole.HOTEL_ADMIN;
      const res = await deleteReservation(new Request("http://localhost:3000/api/reservations/res-b-999", { method: "DELETE" }), {
        params: Promise.resolve({ id: "res-b-999" }),
      });
      expect(res.status).toBe(404);
      expect(db.reservations.has("res-b-999")).toBe(true);
    });
  });

  describe("Cross-Tenant Reference Validation (Foreign Room & Tariff Rejection)", () => {
    it("rejects reservation creation if room belongs to another hotel", async () => {
      const req = new Request("http://localhost:3000/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestName: "Alice Smith",
          checkInDate: "2026-12-01",
          checkOutDate: "2026-12-03",
          roomId: "room-b-201", // Foreign room belonging to Hotel B!
          tariffId: "rt-a-standard",
          occupancy: "SINGLE",
          mealPlan: "BED_ONLY",
        }),
      });

      const res = await createReservation(req);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain("Room not found in this hotel");
    });

    it("rejects reservation creation if tariff belongs to another hotel", async () => {
      const req = new Request("http://localhost:3000/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestName: "Alice Smith",
          checkInDate: "2026-12-01",
          checkOutDate: "2026-12-03",
          roomId: "room-a-101",
          tariffId: "rt-b-deluxe", // Foreign tariff belonging to Hotel B!
          occupancy: "SINGLE",
          mealPlan: "BED_ONLY",
        }),
      });

      const res = await createReservation(req);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain("tariff is unavailable in this hotel");
    });

    it("ignores client-supplied hotelId in request payload", async () => {
      const req = new Request("http://localhost:3000/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hotelId: "hotel-b", // Malicious attempt to inject Hotel B
          guestName: "Bob Jones",
          checkInDate: "2026-12-10",
          checkOutDate: "2026-12-12",
          roomId: "room-a-101",
          tariffId: "rt-a-standard",
          occupancy: "SINGLE",
          mealPlan: "BED_ONLY",
        }),
      });

      const res = await createReservation(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      const saved = db.reservations.get(data.id);
      expect(saved).toBeDefined();
      expect(saved.hotelId).toBe("hotel-a"); // Strictly bound to tenant.hotelId
      expect(saved.rooms.create[0]).not.toHaveProperty("hotelId");
      const createdRoom = Array.from(db.reservationRooms.values()).find((room) => room.reservationId === data.id);
      expect(createdRoom).toMatchObject({ reservationId: data.id, roomId: "room-a-101", hotelId: "hotel-a" });
    });
  });

  describe("Role-Based Access Control on Reservations", () => {
    it("rejects non-management roles applying accommodation discounts", async () => {
      mockCurrentTenant.role = HotelRole.RECEPTIONIST; // Receptionist cannot give discounts
      const req = new Request("http://localhost:3000/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestName: "Charlie",
          checkInDate: "2026-12-15",
          checkOutDate: "2026-12-17",
          roomId: "room-a-101",
          tariffId: "rt-a-standard",
          occupancy: "SINGLE",
          mealPlan: "BED_ONLY",
          discount: 500, // Unauthorized discount attempt
        }),
      });

      const res = await createReservation(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain("Only an Admin or Manager can apply an accommodation discount");
    });

    it("rejects unauthorized roles from deleting reservations", async () => {
      mockCurrentTenant.role = HotelRole.RECEPTIONIST; // Only MANAGEMENT can delete
      const res = await deleteReservation(new Request("http://localhost:3000/api/reservations/res-1", { method: "DELETE" }), {
        params: Promise.resolve({ id: "res-1" }),
      });
      expect(res.status).toBe(403);
    });
  });

  describe("Reservation State Transitions & Validation", () => {
    it("enforces valid status transition graph", () => {
      // PENDING can transition to CONFIRMED, CANCELLED, NO_SHOW
      expect(canTransitionReservation("PENDING", "CONFIRMED")).toBe(true);
      expect(canTransitionReservation("PENDING", "CANCELLED")).toBe(true);
      expect(canTransitionReservation("PENDING", "NO_SHOW")).toBe(true);
      // PENDING cannot transition directly to CHECKED_OUT
      expect(canTransitionReservation("PENDING", "CHECKED_OUT")).toBe(false);

      // CHECKED_IN cannot transition via PUT (must use check-out workflow)
      expect(canTransitionReservation("CHECKED_IN", "CANCELLED")).toBe(false);
      expect(canTransitionReservation("CHECKED_IN", "PENDING")).toBe(false);
    });

    it("rejects invalid status values", () => {
      expect(isReservationStatus("INVALID_STATUS")).toBe(false);
      expect(isReservationStatus("CONFIRMED")).toBe(true);
    });
  });

  describe("Check-In Security & Boundary Enforcements", () => {
    it("rejects check-in for a foreign hotel reservation", async () => {
      // Current tenant is Hotel A; attempt check-in for Hotel B's reservation
      await expect(
        executeCheckIn(mockCurrentTenant, {
          reservationId: "res-b-999",
        })
      ).rejects.toThrow("Reservation not found.");
    });

    it("rejects room reassignment during check-in to a room in another hotel", async () => {
      // Create valid reservation in Hotel A
      const resA = {
        id: "res-a-test",
        hotelId: "hotel-a",
        guestId: "guest-a-1",
        checkInDate: new Date("2026-11-10"),
        checkOutDate: new Date("2026-11-12"),
        status: "CONFIRMED",
      };
      db.reservations.set(resA.id, resA);
      db.reservationRooms.set("rr-1", { id: "rr-1", reservationId: resA.id, roomId: "room-a-101", rate: 3500 });

      // Attempt check-in reassigning to Hotel B's room 'room-b-201'
      await expect(
        executeCheckIn(mockCurrentTenant, {
          reservationId: resA.id,
          newRoomId: "room-b-201",
        })
      ).rejects.toThrow("The room you selected was not found in this hotel.");
    });

    it("rejects a dirty reserved room even if its own ID is supplied as a replacement", async () => {
      db.rooms.set("room-a-101", { ...db.rooms.get("room-a-101"), status: "DIRTY" });
      db.reservations.set("incoming", { id: "incoming", hotelId: "hotel-a", guestId: "guest-a-1", status: "CONFIRMED", checkInDate: new Date("2026-11-17"), checkOutDate: new Date("2026-11-18") });
      db.reservationRooms.set("incoming-room", { id: "incoming-room", reservationId: "incoming", roomId: "room-a-101", rate: 3500 });
      await expect(executeCheckIn(mockCurrentTenant, { reservationId: "incoming", newRoomId: "room-a-101" })).rejects.toThrow(/needs cleaning/i);
      expect(db.reservations.get("incoming").status).toBe("CONFIRMED");
    });

    it("permits reassigning check-in to a cleaned room with an overlapping checked-out stay", async () => {
      db.reservations.set("prior", { id: "prior", hotelId: "hotel-a", code: "PRIOR", status: "CHECKED_OUT", checkInDate: new Date("2026-11-17"), checkOutDate: new Date("2026-11-18") });
      db.reservationRooms.set("prior-room", { id: "prior-room", reservationId: "prior", roomId: "room-a-101", rate: 3500 });
      db.rooms.set("room-a-102", { ...db.rooms.get("room-a-101"), id: "room-a-102", number: "102" });
      db.reservations.set("incoming", { id: "incoming", hotelId: "hotel-a", guestId: "guest-a-1", status: "CONFIRMED", checkInDate: new Date("2026-11-17"), checkOutDate: new Date("2026-11-18") });
      db.reservationRooms.set("incoming-room", { id: "incoming-room", reservationId: "incoming", roomId: "room-a-102", rate: 3500 });
      await executeCheckIn(mockCurrentTenant, { reservationId: "incoming", newRoomId: "room-a-101" });
      expect(db.reservationRooms.get("incoming-room").roomId).toBe("room-a-101");
      expect(db.reservations.get("incoming").status).toBe("CHECKED_IN");
    });

    it("successfully checks in same-hotel reservation and creates hotel-scoped folio", async () => {
      const resA = {
        id: "res-a-valid",
        hotelId: "hotel-a",
        guestId: "guest-a-1",
        checkInDate: new Date("2026-11-10"),
        checkOutDate: new Date("2026-11-12"),
        status: "CONFIRMED",
      };
      db.reservations.set(resA.id, resA);
      db.reservationRooms.set("rr-2", { id: "rr-2", reservationId: resA.id, roomId: "room-a-101", rate: 3500 });

      const result = await executeCheckIn(mockCurrentTenant, {
        reservationId: resA.id,
        amountPaid: 7000,
        paymentMethodId: "pm-a-cash",
      });

      expect(result).toHaveProperty("folioId");
      expect(result.required).toBe(7000);
      expect(result.balance).toBe(0);

      // Verify hotelId scoping in created folio and payment
      const folio = db.folios.get(result.folioId);
      expect(folio).toBeDefined();
      expect(folio.hotelId).toBe("hotel-a");

      // Verify room status updated to OCCUPIED
      expect(db.rooms.get("room-a-101")?.status).toBe("OCCUPIED");
      // Verify reservation status updated to CHECKED_IN
      expect(db.reservations.get(resA.id)?.status).toBe("CHECKED_IN");
    });
  });

  describe("Check-Out Security & Outstanding Balance Protection", () => {
    it("rejects check-out of a foreign hotel reservation", async () => {
      await expect(
        executeCheckOut(mockCurrentTenant, {
          reservationId: "res-b-999",
        })
      ).rejects.toThrow("Reservation not found.");
    });

    it("allows a new walk-in for the same date after early checkout and room readiness", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-11-17T15:00:00Z"));
      try {
        const prior = { id: "early-stay", code: "EARLY", hotelId: "hotel-a", guestId: "guest-a-1", checkInDate: new Date("2026-11-17T00:00:00Z"), checkOutDate: new Date("2026-11-18T00:00:00Z"), status: "CHECKED_IN" };
        db.reservations.set(prior.id, prior);
        db.rooms.get("room-a-101").status = "OCCUPIED";
        db.reservationRooms.set("rr-early", { id: "rr-early", reservationId: prior.id, roomId: "room-a-101", rate: 3500 });
        db.folios.set("folio-early", { id: "folio-early", hotelId: "hotel-a", reservationId: prior.id, isClosed: false });
        db.folioItems.set("item-early", { id: "item-early", folioId: "folio-early", total: 3500 });
        db.payments.set("payment-early", { id: "payment-early", folioId: "folio-early", hotelId: "hotel-a", amount: 3500, status: "COMPLETED" });
        await executeCheckOut(mockCurrentTenant, { reservationId: prior.id });
        expect(db.reservations.get(prior.id).status).toBe("CHECKED_OUT");
        expect(db.rooms.get("room-a-101").status).toBe("DIRTY");
        // Model housekeeping finishing; this fix must not bypass the cleaning guard.
        db.rooms.get("room-a-101").status = "AVAILABLE";
        const response = await createReservation(new Request("http://localhost:3000/api/reservations", {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
            guestName: "New guest", checkInDate: "2026-11-17T00:00:00Z", checkOutDate: "2026-11-18T00:00:00Z",
            roomId: "room-a-101", tariffId: "rt-a-standard", occupancy: "SINGLE", mealPlan: "BED_ONLY", source: "WALK_IN",
          }),
        }));
        expect(response.status).toBe(201);
        const newStay = await response.json();
        await executeCheckIn(mockCurrentTenant, { reservationId: newStay.id });
        expect(db.reservations.get(newStay.id).status).toBe("CHECKED_IN");
        expect(db.reservations.get(prior.id).status).toBe("CHECKED_OUT");
      } finally { vi.useRealTimers(); }
    });

    it("blocks checkout when balance is outstanding without manager override", async () => {
      const resA = {
        id: "res-a-unpaid",
        hotelId: "hotel-a",
        guestId: "guest-a-1",
        checkInDate: new Date("2026-11-10"),
        checkOutDate: new Date("2026-11-12"),
        status: "CHECKED_IN",
      };
      db.reservations.set(resA.id, resA);
      db.reservationRooms.set("rr-3", { id: "rr-3", reservationId: resA.id, roomId: "room-a-101", rate: 3500 });
      const folioA = { id: "folio-unpaid", hotelId: "hotel-a", reservationId: resA.id, isClosed: false };
      db.folios.set(folioA.id, folioA);
      db.folioItems.set("fi-1", { id: "fi-1", folioId: folioA.id, total: 7000 });
      // Zero payments recorded

      mockCurrentTenant.role = HotelRole.RECEPTIONIST;
      await expect(
        executeCheckOut(mockCurrentTenant, {
          reservationId: resA.id,
          allowOutstandingBalance: false,
        })
      ).rejects.toThrow("is still due before checkout");
    });

    it("allows checkout and creates hotel-scoped housekeeping task upon successful checkout", async () => {
      const resA = {
        id: "res-a-paid",
        hotelId: "hotel-a",
        guestId: "guest-a-1",
        checkInDate: new Date("2026-11-10"),
        checkOutDate: new Date("2026-11-12"),
        status: "CHECKED_IN",
      };
      db.reservations.set(resA.id, resA);
      db.reservationRooms.set("rr-4", { id: "rr-4", reservationId: resA.id, roomId: "room-a-101", rate: 3500 });
      const folioA = { id: "folio-paid", hotelId: "hotel-a", reservationId: resA.id, isClosed: false };
      db.folios.set(folioA.id, folioA);
      db.folioItems.set("fi-2", { id: "fi-2", folioId: folioA.id, total: 7000 });
      db.payments.set("pay-1", { id: "pay-1", folioId: folioA.id, amount: 7000, hotelId: "hotel-a", status: "COMPLETED" });

      const result = await executeCheckOut(mockCurrentTenant, {
        reservationId: resA.id,
      });

      expect(result.balance).toBe(0);
      expect(db.reservations.get(resA.id)?.status).toBe("CHECKED_OUT");
      expect(db.rooms.get("room-a-101")?.status).toBe("DIRTY");

      // Verify housekeeping task created with tenant hotelId
      const tasks = Array.from(db.housekeepingTasks.values()).filter((t) => t.roomId === "room-a-101");
      expect(tasks.length).toBeGreaterThan(0);
      expect(tasks[0].hotelId).toBe("hotel-a");
      expect(tasks[0].status).toBe("NEEDS_CLEANING");
    });
  });

  describe("Approved rate resolution (non-occupancy room-type names)", () => {
    // The owner test hotel names its types "Standard"/"Deluxe", so no tariff is
    // called "Single …"/"Double …". That used to make creation impossible.
    beforeEach(() => {
      db.roomTypes.set("rt-a-plain", {
        id: "rt-a-plain",
        hotelId: "hotel-a",
        name: "Standard",
        baseRate: 4500,
        mealPlan: null,
      });
      db.rooms.set("room-a-102", {
        id: "room-a-102",
        hotelId: "hotel-a",
        number: "102",
        status: "AVAILABLE",
        isActive: true,
        roomTypeId: "rt-a-plain",
      });
      db.roomTypes.set("rt-a-deluxe", {
        id: "rt-a-deluxe",
        hotelId: "hotel-a",
        name: "Deluxe Garden",
        baseRate: 8500,
        mealPlan: null,
      });
      db.roomTypes.set("rt-a-free", {
        id: "rt-a-free",
        hotelId: "hotel-a",
        name: "Unpriced",
        baseRate: 0,
        mealPlan: null,
      });
      db.rooms.set("room-a-103", {
        id: "room-a-103",
        hotelId: "hotel-a",
        number: "103",
        status: "AVAILABLE",
        isActive: true,
        roomTypeId: "rt-a-free",
      });
    });

    function createFor(payload: Record<string, unknown>) {
      return createReservation(
        new Request("http://localhost:3000/api/reservations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        })
      );
    }

    it("creates the reservation at the room's own rate and persists it", async () => {
      const res = await createFor({
        guestName: "Grace Njeri",
        guestPhone: "+254700000001",
        checkInDate: "2026-12-01",
        checkOutDate: "2026-12-03",
        roomId: "room-a-102",
        tariffId: "rt-a-plain",
        occupancy: "DOUBLE",
        mealPlan: "BED_ONLY",
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      const saved = db.reservations.get(data.id);
      expect(saved.hotelId).toBe("hotel-a");
      // Stored rate is the room type's configured rate, not 0/undefined.
      const link = saved.rooms.create[0];
      expect(Number(link.rate)).toBe(4500);
      const persisted = Array.from(db.reservationRooms.values()).find(
        (room) => room.reservationId === data.id
      );
      expect(persisted).toMatchObject({ roomId: "room-a-102", hotelId: "hotel-a" });
    });

    it("refuses to sell a room whose rate was never configured", async () => {
      const res = await createFor({
        guestName: "Zero Rate",
        checkInDate: "2026-12-01",
        checkOutDate: "2026-12-03",
        roomId: "room-a-103",
        tariffId: "rt-a-free",
        occupancy: "SINGLE",
        mealPlan: "BED_ONLY",
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("no nightly rate configured");
      // Nothing was written.
      expect(
        Array.from(db.reservations.values()).filter((r) => r.hotelId === "hotel-a").length
      ).toBe(0);
    });

    it("refuses a same-hotel tariff that belongs to a different room type", async () => {
      const res = await createFor({
        guestName: "Cheap Rate",
        checkInDate: "2026-12-01",
        checkOutDate: "2026-12-03",
        roomId: "room-a-102",
        tariffId: "rt-a-deluxe",
        occupancy: "SINGLE",
        mealPlan: "BED_ONLY",
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("does not match the occupancy and meal plan");
    });
  });

  describe("Compatible Concurrency Controls", () => {
    it("uses matching per-hotel advisory lock keys across reservation and stay operations", async () => {
      // Clear recorded locks
      db.locks = [];

      // Trigger reservation creation
      const req = new Request("http://localhost:3000/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestName: "Lock Test",
          checkInDate: "2026-12-20",
          checkOutDate: "2026-12-22",
          roomId: "room-a-101",
          tariffId: "rt-a-standard",
          occupancy: "SINGLE",
          mealPlan: "BED_ONLY",
        }),
      });
      await createReservation(req);

      // Verify lock key format
      expect(db.locks.length).toBeGreaterThan(0);
      const lockCall = db.locks[db.locks.length - 1];
      expect(lockCall).toContain("hotel-hotel-a-reservation-create");
    });
  });
});
