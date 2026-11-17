import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

export const HotelRole = {
  HOTEL_OWNER: "HOTEL_OWNER",
  HOTEL_ADMIN: "HOTEL_ADMIN",
  HOTEL_MANAGER: "HOTEL_MANAGER",
  MANAGER: "MANAGER",
  RECEPTIONIST: "RECEPTIONIST",
  CASHIER: "CASHIER",
  HOUSEKEEPER: "HOUSEKEEPER",
  MAINTENANCE: "MAINTENANCE",
  WAITER: "WAITER",
  CHEF: "CHEF",
  ACCOUNTANT: "ACCOUNTANT",
  TECHNICIAN: "TECHNICIAN",
} as const;

export const HotelStatus = {
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
} as const;

export const MembershipStatus = {
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
} as const;

export const PaymentStatus = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
} as const;

let mockCurrentTenant: any = null;

vi.doMock("server-only", () => ({}));

class MockPrismaClientKnownRequestError extends Error {
  code: string;
  constructor(message: string, code = "") {
    super(message);
    this.name = "PrismaClientKnownRequestError";
    this.code = code;
  }
}

vi.doMock("@prisma/client", () => ({
  HotelRole,
  HotelStatus,
  MembershipStatus,
  PaymentStatus,
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
    PrismaClientKnownRequestError: MockPrismaClientKnownRequestError,
  },
}));

class CustomNextResponse extends Response {
  static json(data: any, init?: ResponseInit) {
    return new CustomNextResponse(JSON.stringify(data), {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
  }
}

vi.doMock("next/server", () => ({
  NextResponse: CustomNextResponse,
}));

vi.doMock("next-auth", () => ({
  getServerSession: () => null,
}));

vi.doMock("next/headers", () => ({
  cookies: async () => ({
    get: () => ({ value: "hotel-a" }),
  }),
}));

vi.doMock("@/lib/authz", () => ({
  getTenantFromRoute: async () => {
    if (!mockCurrentTenant) {
      return CustomNextResponse.json({ error: "UNAUTHORIZED", message: "Authentication required" }, { status: 401 });
    }
    return mockCurrentTenant;
  },
  requireModule: async () => null,
  requireRole: (role: any, allowed: readonly string[]) => {
    if (!role || !allowed.includes(role)) {
      return CustomNextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });
    }
    return null;
  },
  ROLE_GROUPS: {
    ACCOMMODATION_PAYMENTS: [
      HotelRole.HOTEL_OWNER,
      HotelRole.HOTEL_ADMIN,
      HotelRole.HOTEL_MANAGER,
      HotelRole.MANAGER,
      HotelRole.RECEPTIONIST,
      HotelRole.CASHIER,
    ],
    PAYMENT_OPERATIONS: [
      HotelRole.HOTEL_OWNER,
      HotelRole.HOTEL_ADMIN,
      HotelRole.HOTEL_MANAGER,
      HotelRole.MANAGER,
      HotelRole.RECEPTIONIST,
      HotelRole.WAITER,
      HotelRole.CASHIER,
    ],
    RESTAURANT_POS: [
      HotelRole.HOTEL_OWNER,
      HotelRole.HOTEL_ADMIN,
      HotelRole.HOTEL_MANAGER,
      HotelRole.MANAGER,
      HotelRole.WAITER,
      HotelRole.CASHIER,
    ],
  },
  getPlatformAdminFromRoute: async () => {
    return CustomNextResponse.json({ error: "FORBIDDEN", message: "Insufficient permissions" }, { status: 403 });
  },
}));

interface TestDB {
  hotels: Map<string, any>;
  guests: Map<string, any>;
  folios: Map<string, any>;
  folioItems: Map<string, any>;
  payments: Map<string, any>;
  paymentMethods: Map<string, any>;
  menuItems: Map<string, any>;
  inventoryItems: Map<string, any>;
  locks: string[];
  simulateP2002OnPaymentCreate?: boolean;
  simulateP2002WinnerOverrides?: Record<string, unknown>;
}

function createFreshTestDB(): TestDB {
  const db: TestDB = {
    hotels: new Map(),
    guests: new Map(),
    folios: new Map(),
    folioItems: new Map(),
    payments: new Map(),
    paymentMethods: new Map(),
    menuItems: new Map(),
    inventoryItems: new Map(),
    locks: [],
  };

  // Seed Hotel A
  db.hotels.set("hotel-a", { id: "hotel-a", name: "Hotel Alpha" });
  db.guests.set("guest-a-1", { id: "guest-a-1", hotelId: "hotel-a", fullName: "Alice Alpha" });
  db.paymentMethods.set("pm-a-cash", {
    id: "pm-a-cash",
    hotelId: "hotel-a",
    name: "Cash",
    isActive: true,
  });
  db.paymentMethods.set("pm-a-mpesa", {
    id: "pm-a-mpesa",
    hotelId: "hotel-a",
    name: "M-Pesa",
    isActive: true,
  });
  db.folios.set("folio-a-open", {
    id: "folio-a-open",
    hotelId: "hotel-a",
    guestId: "guest-a-1",
    isClosed: false,
  });
  db.folioItems.set("fi-a-1", {
    id: "fi-a-1",
    folioId: "folio-a-open",
    type: "ROOM_CHARGE",
    description: "Room 101 - 2 nights",
    quantity: 2,
    unitPrice: 5000,
    total: 10000,
  });
  db.folios.set("folio-a-closed", {
    id: "folio-a-closed",
    hotelId: "hotel-a",
    guestId: "guest-a-1",
    isClosed: true,
  });

  // Seed Hotel B (foreign tenant)
  db.hotels.set("hotel-b", { id: "hotel-b", name: "Hotel Beta" });
  db.guests.set("guest-b-1", { id: "guest-b-1", hotelId: "hotel-b", fullName: "Bob Beta" });
  db.paymentMethods.set("pm-b-card", {
    id: "pm-b-card",
    hotelId: "hotel-b",
    name: "Credit Card Beta",
    isActive: true,
  });
  db.folios.set("folio-b-open", {
    id: "folio-b-open",
    hotelId: "hotel-b",
    guestId: "guest-b-1",
    isClosed: false,
  });
  db.folioItems.set("fi-b-1", {
    id: "fi-b-1",
    folioId: "folio-b-open",
    type: "ROOM_CHARGE",
    description: "Room 201 - 1 night",
    quantity: 1,
    unitPrice: 8000,
    total: 8000,
  });

  return db;
}

let db: TestDB;

vi.doMock("@/lib/prisma", () => ({
  prisma: {
    $transaction: async (fn: any) => {
      const tx = {
        $queryRaw: async (query: any, ...values: any[]) => {
          const parts = Array.isArray(query) ? query : [query];
          const rendered = parts.map((p: any, i: number) => `${p}${values[i] !== undefined ? values[i] : ""}`).join("");
          db.locks.push(rendered);
          return [{ locked: "1" }];
        },
        folio: {
          findUnique: async ({ where, include }: any) => {
            const id = where?.id_hotelId ? where.id_hotelId.id : where.id;
            const hotelId = where?.id_hotelId ? where.id_hotelId.hotelId : undefined;
            const f = db.folios.get(id);
            if (!f) return null;
            if (hotelId && f.hotelId !== hotelId) return null;

            const guest = db.guests.get(f.guestId) || { fullName: "Guest" };
            const items = Array.from(db.folioItems.values()).filter((fi) => fi.folioId === f.id);
            const payments = Array.from(db.payments.values())
              .filter((p) => p.folioId === f.id && (!hotelId || p.hotelId === hotelId))
              .map((p) => ({ ...p, paymentMethod: db.paymentMethods.get(p.paymentMethodId) }));
            return { ...f, guest, items, payments };
          },
          create: async ({ data }: any) => {
            const id = `folio-${Date.now()}-${Math.random().toString(36).substring(7)}`;
            const created = { id, ...data };
            db.folios.set(id, created);
            return created;
          },
          update: async ({ where, data }: any) => {
            const id = where?.id_hotelId ? where.id_hotelId.id : where.id;
            const hotelId = where?.id_hotelId ? where.id_hotelId.hotelId : undefined;
            const f = db.folios.get(id);
            if (!f || (hotelId && f.hotelId !== hotelId)) throw new Error("Folio not found");
            const updated = { ...f, ...data };
            db.folios.set(id, updated);
            return updated;
          },
        },
        folioItem: {
          create: async ({ data }: any) => {
            const id = `fi-${Date.now()}`;
            const created = { id, ...data };
            db.folioItems.set(id, created);
            return created;
          },
        },
        payment: {
          findUnique: async ({ where }: any) => {
            if (where?.hotelId_idempotencyKey) {
              const { hotelId, idempotencyKey } = where.hotelId_idempotencyKey;
              for (const p of db.payments.values()) {
                if (p.hotelId === hotelId && p.idempotencyKey === idempotencyKey) return p;
              }
              return null;
            }
            if (where?.id_hotelId) {
              const p = db.payments.get(where.id_hotelId.id);
              if (p && p.hotelId === where.id_hotelId.hotelId) return p;
              return null;
            }
            return db.payments.get(where.id) ?? null;
          },
          create: async ({ data }: any) => {
            if (db.simulateP2002OnPaymentCreate) {
              const id = "pay-concurrent-winner";
              db.payments.set(id, { id, ...data, ...(db.simulateP2002WinnerOverrides ?? {}) });
              throw new MockPrismaClientKnownRequestError("Unique constraint failed", "P2002");
            }
            if (data.idempotencyKey) {
              for (const p of db.payments.values()) {
                if (p.hotelId === data.hotelId && p.idempotencyKey === data.idempotencyKey) {
                  throw new MockPrismaClientKnownRequestError("Unique constraint failed", "P2002");
                }
              }
            }
            const id = `pay-${Date.now()}-${Math.random().toString(36).substring(7)}`;
            const created = { id, ...data };
            db.payments.set(id, created);
            return created;
          },
        },
        paymentMethod: {
          findUnique: async ({ where }: any) => {
            if (where?.id_hotelId) {
              const pm = db.paymentMethods.get(where.id_hotelId.id);
              if (pm && pm.hotelId === where.id_hotelId.hotelId) return pm;
              return null;
            }
            return db.paymentMethods.get(where.id) ?? null;
          },
          findFirst: async ({ where }: any) => {
            for (const pm of db.paymentMethods.values()) {
              if (where?.hotelId && pm.hotelId !== where.hotelId) continue;
              if (where?.id && pm.id !== where.id) continue;
              if (where?.isActive !== undefined && pm.isActive !== where.isActive) continue;
              return pm;
            }
            return null;
          },
        },
        guest: {
          findFirst: async ({ where }: any) => {
            for (const g of db.guests.values()) {
              if (where?.hotelId && g.hotelId !== where.hotelId) continue;
              if (where?.phone && g.phone === where.phone) return g;
              if (where?.fullName && g.fullName === where.fullName) return g;
            }
            return null;
          },
          create: async ({ data }: any) => {
            const id = `guest-${Date.now()}`;
            const created = { id, ...data };
            db.guests.set(id, created);
            return created;
          },
        },
        menuItem: {
          findMany: async ({ where }: any) => {
            return Array.from(db.menuItems.values()).filter((mi) => {
              if (where?.id?.in && !where.id.in.includes(mi.id)) return false;
              if (where?.hotelId && mi.hotelId !== where.hotelId) return false;
              if (where?.isActive !== undefined && mi.isActive !== where.isActive) return false;
              return true;
            });
          },
        },
      };
      return await fn(tx);
    },
    folio: {
      findUnique: async ({ where }: any) => {
        const id = where?.id_hotelId ? where.id_hotelId.id : where.id;
        const hotelId = where?.id_hotelId ? where.id_hotelId.hotelId : undefined;
        const f = db.folios.get(id);
        if (!f || (hotelId && f.hotelId !== hotelId)) return null;

        const guest = db.guests.get(f.guestId) || { fullName: "Guest" };
        const items = Array.from(db.folioItems.values()).filter((fi) => fi.folioId === f.id);
        const payments = Array.from(db.payments.values())
          .filter((p) => p.folioId === f.id && (!hotelId || p.hotelId === hotelId))
          .map((p) => ({ ...p, paymentMethod: db.paymentMethods.get(p.paymentMethodId) }));
        return { ...f, guest, items, payments };
      },
    },
    payment: {
      findUnique: async ({ where }: any) => {
        if (where?.hotelId_idempotencyKey) {
          const { hotelId, idempotencyKey } = where.hotelId_idempotencyKey;
          for (const payment of db.payments.values()) {
            if (payment.hotelId === hotelId && payment.idempotencyKey === idempotencyKey) return payment;
          }
          return null;
        }
        return null;
      },
    },
    paymentMethod: {
      findMany: async ({ where }: any) => {
        return Array.from(db.paymentMethods.values()).filter((pm) => {
          if (where?.hotelId && pm.hotelId !== where.hotelId) return false;
          if (where?.isActive !== undefined && pm.isActive !== where.isActive) return false;
          return true;
        });
      },
    },
  },
}));

let getFolioById: any;
let createPayment: any;
let getPaymentMethods: any;

describe("Phase 4: Multi-Tenant Folio, Payment & Billing Security Hardening", () => {
  beforeAll(async () => {
    const folioRoute = await import("@/app/api/folios/[id]/route");
    getFolioById = folioRoute.GET;

    const paymentRoute = await import("@/app/api/payments/route");
    createPayment = paymentRoute.POST;

    const pmRoute = await import("@/app/api/payment-methods/route");
    getPaymentMethods = pmRoute.GET;
  });

  beforeEach(() => {
    db = createFreshTestDB();
    mockCurrentTenant = {
      userId: "user-cashier-a",
      hotelId: "hotel-a",
      role: HotelRole.CASHIER,
      hotel: { id: "hotel-a", name: "Hotel Alpha", status: HotelStatus.ACTIVE },
      membership: { id: "mem-a", role: HotelRole.CASHIER, status: MembershipStatus.ACTIVE },
      isPlatformAdmin: false,
    };
  });

  describe("Batch 1: Multi-Tenant Folio Isolation", () => {
    it("Hotel A cannot view Hotel B's folio via GET /api/folios/[id] (IDOR prevention)", async () => {
      const res = await getFolioById(
        new Request("http://localhost:3000/api/folios/folio-b-open"),
        { params: Promise.resolve({ id: "folio-b-open" }) }
      );
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Folio not found.");
    });

    it("Hotel A can view its own folio with accurate server-calculated balance and line items", async () => {
      const res = await getFolioById(
        new Request("http://localhost:3000/api/folios/folio-a-open"),
        { params: Promise.resolve({ id: "folio-a-open" }) }
      );
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.id).toBe("folio-a-open");
      expect(data.guestName).toBe("Alice Alpha");
      expect(data.required).toBe(10000);
      expect(data.paid).toBe(0);
      expect(data.balance).toBe(10000);
      expect(data.isClosed).toBe(false);
      expect(data.items.length).toBe(1);
    });

    it("Rejects unauthenticated requests to read folios", async () => {
      mockCurrentTenant = null;
      const res = await getFolioById(
        new Request("http://localhost:3000/api/folios/folio-a-open"),
        { params: Promise.resolve({ id: "folio-a-open" }) }
      );
      expect(res.status).toBe(401);
    });

    it("Rejects unauthorized staff roles (e.g. HOUSEKEEPER) from reading billing folios", async () => {
      mockCurrentTenant.role = HotelRole.HOUSEKEEPER;
      const res = await getFolioById(
        new Request("http://localhost:3000/api/folios/folio-a-open"),
        { params: Promise.resolve({ id: "folio-a-open" }) }
      );
      expect(res.status).toBe(403);
    });
  });

  describe("Batch 2: Payments and Billing Security", () => {
    it("rejects a stale tenant header without querying or creating a payment", async () => {
      const req = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Expected-Hotel-Id": "hotel-b",
        },
        body: JSON.stringify({
          folioId: "folio-a-open",
          paymentMethodId: "pm-a-cash",
          amount: 1000,
        }),
      });

      const response = await createPayment(req);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "TENANT_CONTEXT_MISMATCH",
        outcome: "UNKNOWN",
      });
      expect(db.payments.size).toBe(0);
      expect(db.locks).toEqual([]);
    });

    it("Hotel A cannot record a payment against Hotel B's folio", async () => {
      const req = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "valid-key-test" },
        body: JSON.stringify({
          folioId: "folio-b-open",
          paymentMethodId: "pm-a-cash",
          amount: 5000,
        }),
      });

      const res = await createPayment(req);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("Folio not found.");
      expect(db.payments.size).toBe(0);
    });

    it("Rejects payment referencing a payment method belonging to another hotel", async () => {
      const req = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "valid-key-test" },
        body: JSON.stringify({
          folioId: "folio-a-open",
          paymentMethodId: "pm-b-card", // belongs to hotel-b
          amount: 5000,
        }),
      });

      const res = await createPayment(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("That payment method is unavailable in this hotel.");
      expect(db.payments.size).toBe(0);
    });

    it("Ignores client-forged cashierId, status, and hotelId in request payload", async () => {
      const req = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "valid-key-test" },
        body: JSON.stringify({
          folioId: "folio-a-open",
          paymentMethodId: "pm-a-cash",
          amount: 4000,
          cashierId: "hacker-user-id",
          hotelId: "hotel-b",
          status: "REFUNDED",
        }),
      });

      const res = await createPayment(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.paid).toBe(4000);
      expect(data.balance).toBe(6000);

      // Verify the persisted payment in db has authoritative hotelId and cashierId
      const savedPayment = db.payments.get(data.id);
      expect(savedPayment).toBeDefined();
      expect(savedPayment.hotelId).toBe("hotel-a");
      expect(savedPayment.cashierId).toBe("user-cashier-a");
      expect(savedPayment.status).toBe("COMPLETED");
    });

    it("Rejects negative, zero, or malformed payment amounts", async () => {
      for (const badAmount of [-500, 0, "invalid", 10.999]) {
        const req = new Request("http://localhost:3000/api/payments", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": "valid-key-test" },
          body: JSON.stringify({
            folioId: "folio-a-open",
            paymentMethodId: "pm-a-cash",
            amount: badAmount,
          }),
        });

        const res = await createPayment(req);
        expect(res.status).toBe(400);
      }
      expect(db.payments.size).toBe(0);
    });

    it("Blocks payments exceeding the folio's outstanding balance", async () => {
      const req = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "valid-key-test" },
        body: JSON.stringify({
          folioId: "folio-a-open",
          paymentMethodId: "pm-a-cash",
          amount: 15000, // balance is only 10000
        }),
      });

      const res = await createPayment(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("cannot exceed the outstanding balance");
      expect(db.payments.size).toBe(0);
    });

    it("Blocks payment recording on a closed folio", async () => {
      const req = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "valid-key-test" },
        body: JSON.stringify({
          folioId: "folio-a-closed",
          paymentMethodId: "pm-a-cash",
          amount: 1000,
        }),
      });

      const res = await createPayment(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Payments cannot be added to a closed folio.");
      expect(db.payments.size).toBe(0);
    });

    it("Acquires coordinated advisory lock during payment transaction", async () => {
      db.locks = [];
      const req = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "valid-key-test" },
        body: JSON.stringify({
          folioId: "folio-a-open",
          paymentMethodId: "pm-a-cash",
          amount: 2500,
        }),
      });

      const res = await createPayment(req);
      expect(res.status).toBe(201);
      expect(db.locks.length).toBeGreaterThan(0);
      expect(db.locks[0]).toContain("hotel-hotel-a-reservation-create");
    });

    it("GET /api/payment-methods scopes list strictly to active tenant hotel", async () => {
      const res = await getPaymentMethods(new Request("http://localhost:3000/api/payment-methods"));
      expect(res.status).toBe(200);
      const methods = await res.json();
      expect(Array.isArray(methods)).toBe(true);
      expect(methods.length).toBe(2);
      expect(methods.some((m: any) => m.id === "pm-a-cash")).toBe(true);
      expect(methods.some((m: any) => m.id === "pm-a-mpesa")).toBe(true);
      // Hotel B's card must NOT be present
      expect(methods.some((m: any) => m.id === "pm-b-card")).toBe(false);
    });

    it("rejects a payment without an idempotency key", async () => {
      const req = new Request("http://localhost:3000/api/payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ folioId: "folio-a-open", paymentMethodId: "pm-a-cash", amount: 1000 }) });
      expect((await createPayment(req)).status).toBe(400);
      expect(db.payments.size).toBe(0);
    });

    it("Rejects invalid idempotency keys outside length bounds (4-128 chars)", async () => {
      // Too short
      const reqShort = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Idempotency-Key": "abc" },
        body: JSON.stringify({
          folioId: "folio-a-open",
          paymentMethodId: "pm-a-cash",
          amount: 1000,
        }),
      });
      const resShort = await createPayment(reqShort);
      expect(resShort.status).toBe(400);
      const dataShort = await resShort.json();
      expect(dataShort.error).toContain("An idempotency key between 4 and 128 characters is required");

      // Too long
      const reqLong = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          folioId: "folio-a-open",
          paymentMethodId: "pm-a-cash",
          amount: 1000,
          idempotencyKey: "k".repeat(129),
        }),
      });
      const resLong = await createPayment(reqLong);
      expect(resLong.status).toBe(400);
      const dataLong = await resLong.json();
      expect(dataLong.error).toContain("An idempotency key between 4 and 128 characters is required");
    });

    it("Accepts and records a payment with valid idempotency key via header", async () => {
      const req = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": "idem-key-alpha-100",
        },
        body: JSON.stringify({
          folioId: "folio-a-open",
          paymentMethodId: "pm-a-cash",
          amount: 2000,
        }),
      });

      const res = await createPayment(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBeDefined();
      expect(data.paid).toBe(2000);
      expect(data.balance).toBe(8000);

      const saved = Array.from(db.payments.values()).find((p) => p.id === data.id);
      expect(saved).toBeDefined();
      expect(saved.idempotencyKey).toBe("idem-key-alpha-100");
      expect(saved.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    });

    it("Replaying payment with same idempotency key and identical payload returns original payment record", async () => {
      const initialPaymentCount = db.payments.size;
      const payload = {
        folioId: "folio-a-open",
        paymentMethodId: "pm-a-cash",
        amount: 1500,
      };

      // First submission
      const req1 = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": "idem-replay-test",
        },
        body: JSON.stringify(payload),
      });
      const res1 = await createPayment(req1);
      expect(res1.status).toBe(201);
      const data1 = await res1.json();
      expect(data1.isIdempotentReplay).toBeUndefined();
      expect(db.payments.size).toBe(initialPaymentCount + 1);

      // Duplicate submission with same key and payload
      const req2 = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": "idem-replay-test",
        },
        body: JSON.stringify(payload),
      });
      const res2 = await createPayment(req2);
      expect(res2.status).toBe(201);
      const data2 = await res2.json();
      expect(data2.isIdempotentReplay).toBe(true);
      expect(data2.id).toBe(data1.id);
      // No duplicate payment created in database
      expect(db.payments.size).toBe(initialPaymentCount + 1);
    });

    it("Compares references when replaying legacy payments without a fingerprint", async () => {
      db.payments.set("pay-legacy-idem", {
        id: "pay-legacy-idem",
        hotelId: "hotel-a",
        folioId: "folio-a-open",
        paymentMethodId: "pm-a-cash",
        amount: 500,
        reference: "LEGACY-REF",
        idempotencyKey: "legacy-idem-key",
        requestFingerprint: null,
        status: "COMPLETED",
      });

      const makeRequest = (reference: string) => new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "legacy-idem-key" },
        body: JSON.stringify({
          folioId: "folio-a-open",
          paymentMethodId: "pm-a-cash",
          amount: 500,
          reference,
        }),
      });

      const same = await createPayment(makeRequest("LEGACY-REF"));
      expect(same.status).toBe(201);
      expect((await same.json()).id).toBe("pay-legacy-idem");

      const changedReference = await createPayment(makeRequest("DIFFERENT-REF"));
      expect(changedReference.status).toBe(409);
      expect((await changedReference.json()).error).toContain("different payment details");
      expect(db.payments.size).toBe(1);
    });

    it("Rejecting replay with same idempotency key but conflicting payload returns 409 Conflict", async () => {
      const initialPayload = {
        folioId: "folio-a-open",
        paymentMethodId: "pm-a-cash",
        amount: 1000,
      };

      // Initial payment
      const req1 = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": "idem-conflict-test",
        },
        body: JSON.stringify(initialPayload),
      });
      const res1 = await createPayment(req1);
      expect(res1.status).toBe(201);

      // Replay with different amount
      const reqDiffAmount = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": "idem-conflict-test",
        },
        body: JSON.stringify({ ...initialPayload, amount: 2000 }),
      });
      const resDiffAmount = await createPayment(reqDiffAmount);
      expect(resDiffAmount.status).toBe(409);
      const dataDiffAmount = await resDiffAmount.json();
      expect(dataDiffAmount.error).toContain("Idempotency key was previously used with different payment details");

      // Replay with different payment method
      const reqDiffMethod = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": "idem-conflict-test",
        },
        body: JSON.stringify({ ...initialPayload, paymentMethodId: "pm-a-mpesa" }),
      });
      const resDiffMethod = await createPayment(reqDiffMethod);
      expect(resDiffMethod.status).toBe(409);
      const dataDiffMethod = await resDiffMethod.json();
      expect(dataDiffMethod.error).toContain("Idempotency key was previously used with different payment details");

      // Reference and folio are also part of the idempotency payload.
      const reqDiffReference = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "idem-conflict-test" },
        body: JSON.stringify({ ...initialPayload, reference: "MPESA-NEW" }),
      });
      expect((await createPayment(reqDiffReference)).status).toBe(409);

      const reqDiffFolio = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "idem-conflict-test" },
        body: JSON.stringify({ ...initialPayload, folioId: "folio-a-closed" }),
      });
      expect((await createPayment(reqDiffFolio)).status).toBe(409);
      expect(db.payments.size).toBe(1);
    });

    // Mocked P2002 winner injection exercises the conflict handler, not real database concurrency.
    it("Mocked P2002 race replays the winner for a matching payload", async () => {
      db.simulateP2002OnPaymentCreate = true;
      try {
        const req = new Request("http://localhost:3000/api/payments", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Idempotency-Key": "concurrent-idem-key",
          },
          body: JSON.stringify({
            folioId: "folio-a-open",
            paymentMethodId: "pm-a-cash",
            amount: 1000,
          }),
        });

        const res = await createPayment(req);
        expect(res.status).toBe(201);
        const data = await res.json();
        expect(data.isIdempotentReplay).toBe(true);
        expect(data.id).toBe("pay-concurrent-winner");
        expect(db.payments.size).toBe(1);
      } finally {
        db.simulateP2002OnPaymentCreate = false;
      }
    });

    it("Mocked P2002 race rejects a mismatched concurrent payload", async () => {
      db.simulateP2002OnPaymentCreate = true;
      db.simulateP2002WinnerOverrides = { reference: "OTHER-REF", requestFingerprint: null };
      const req = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": "concurrent-conflict-key" },
        body: JSON.stringify({
          folioId: "folio-a-open",
          paymentMethodId: "pm-a-cash",
          amount: 1000,
          reference: "REQUEST-REF",
        }),
      });

      try {
        const res = await createPayment(req);
        expect(res.status).toBe(409);
        expect((await res.json()).error).toContain("different payment details");
        expect(db.payments.size).toBe(1);
      } finally {
        db.simulateP2002OnPaymentCreate = false;
        db.simulateP2002WinnerOverrides = undefined;
      }
    });

    it("Scopes idempotency keys per-tenant (cross-tenant key reuse is allowed)", async () => {
      // Hotel B already has a payment with key "hotel-shared-key-1"
      db.payments.set("pay-b-shared", {
        id: "pay-b-shared",
        hotelId: "hotel-b",
        folioId: "folio-b-open",
        paymentMethodId: "pm-b-card",
        amount: 5000,
        idempotencyKey: "hotel-shared-key-1",
        status: "COMPLETED",
        cashierId: "user-cashier-b",
      });

      // Hotel A sends request with that same key
      const req = new Request("http://localhost:3000/api/payments", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": "hotel-shared-key-1",
        },
        body: JSON.stringify({
          folioId: "folio-a-open",
          paymentMethodId: "pm-a-cash",
          amount: 2500,
        }),
      });

      const res = await createPayment(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.id).toBeDefined();
      expect(data.id).not.toBe("pay-b-shared");

      const saved = Array.from(db.payments.values()).find((p) => p.id === data.id);
      expect(saved).toBeDefined();
      expect(saved.hotelId).toBe("hotel-a");
      expect(saved.idempotencyKey).toBe("hotel-shared-key-1");
    });
  });
});
