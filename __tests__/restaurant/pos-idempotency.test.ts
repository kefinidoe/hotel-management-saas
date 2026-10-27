import { describe, it, expect, vi, beforeEach } from "vitest";

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

export const PaymentStatus = {
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  REFUNDED: "REFUNDED",
} as const;

export const MembershipStatus = {
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
  INVITED: "INVITED",
} as const;

export const HotelStatus = {
  ACTIVE: "ACTIVE",
  TRIALING: "TRIALING",
  SUSPENDED: "SUSPENDED",
  CANCELLED: "CANCELLED",
} as const;

export const PlatformRole = {
  PLATFORM_SUPER_ADMIN: "PLATFORM_SUPER_ADMIN",
  PLATFORM_SUPPORT: "PLATFORM_SUPPORT",
  PLATFORM_BILLING: "PLATFORM_BILLING",
} as const;

let mockCurrentTenant: any = null;

vi.doMock("server-only", () => ({}));

class MockPrismaClientKnownRequestError extends Error {
  code: string;
  meta?: any;
  constructor(message: string, code = "", meta?: any) {
    super(message);
    this.name = "PrismaClientKnownRequestError";
    this.code = code;
    this.meta = meta;
  }
}

vi.doMock("@prisma/client", () => ({
  HotelRole,
  PaymentStatus,
  MembershipStatus,
  HotelStatus,
  PlatformRole,
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

vi.doMock("@/lib/authz", () => ({
  getTenantFromRoute: async () => {
    if (!mockCurrentTenant) {
      return CustomNextResponse.json({ error: "UNAUTHORIZED", message: "Authentication required" }, { status: 401 });
    }
    return mockCurrentTenant;
  },
  requireRole: (role: any, allowed: readonly string[]) => {
    if (!role || !allowed.includes(role)) {
      return CustomNextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });
    }
    return null;
  },
  ROLE_GROUPS: {
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
  recipes: Map<string, any>;
  inventoryItems: Map<string, any>;
  stockMovements: any[];
  locks: string[];
  simulateP2002OnPaymentCreate?: boolean;
  simulateP2002Target?: any;
  failRecipeStockDeduction?: boolean;
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
    recipes: new Map(),
    inventoryItems: new Map(),
    stockMovements: [],
    locks: [],
  };

  // Seed Hotel A
  db.hotels.set("hotel-a", { id: "hotel-a", name: "Hotel Alpha" });
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
  db.menuItems.set("item-a-burger", {
    id: "item-a-burger",
    hotelId: "hotel-a",
    name: "Alpha Burger",
    price: 850,
    isActive: true,
  });
  db.menuItems.set("item-a-soda", {
    id: "item-a-soda",
    hotelId: "hotel-a",
    name: "Soda",
    price: 150,
    isActive: true,
  });
  db.inventoryItems.set("inv-a-patty", {
    id: "inv-a-patty",
    hotelId: "hotel-a",
    name: "Beef Patty",
    currentStock: 100,
    unit: "pcs",
  });
  db.recipes.set("recipe-burger", {
    id: "recipe-burger",
    menuItemId: "item-a-burger",
    portions: 1,
    menuItem: { id: "item-a-burger", hotelId: "hotel-a" },
    ingredients: [
      {
        inventoryItemId: "inv-a-patty",
        quantity: 1,
        inventoryItem: { id: "inv-a-patty", hotelId: "hotel-a", name: "Beef Patty" },
      },
    ],
  });

  // Seed Hotel B
  db.hotels.set("hotel-b", { id: "hotel-b", name: "Hotel Bravo" });
  db.paymentMethods.set("pm-b-card", {
    id: "pm-b-card",
    hotelId: "hotel-b",
    name: "Credit Card",
    isActive: true,
  });
  db.menuItems.set("item-b-steak", {
    id: "item-b-steak",
    hotelId: "hotel-b",
    name: "Bravo Steak",
    price: 1800,
    isActive: true,
  });

  return db;
}

let db: TestDB;

function buildPaymentResult(p: any) {
  const folio = db.folios.get(p.folioId) || { guestId: p.guestId };
  const guest = db.guests.get(folio.guestId) || { fullName: "Walk-in Guest" };
  const method = db.paymentMethods.get(p.paymentMethodId) || { name: "Unknown" };
  return {
    ...p,
    folio: { ...folio, guest },
    paymentMethod: method,
  };
}

vi.doMock("@/lib/prisma", () => ({
  prisma: {
    payment: {
      findUnique: async ({ where }: any) => {
        if (where?.hotelId_idempotencyKey) {
          const { hotelId, idempotencyKey } = where.hotelId_idempotencyKey;
          for (const p of db.payments.values()) {
            if (p.hotelId === hotelId && p.idempotencyKey === idempotencyKey) {
              return buildPaymentResult(p);
            }
          }
          return null;
        }
        const p = db.payments.get(where.id);
        return p ? buildPaymentResult(p) : null;
      },
    },
    $transaction: async (fn: any) => {
      // Create backup state for atomic rollback simulation
      const snapshot = {
        folios: new Map(db.folios),
        folioItems: new Map(db.folioItems),
        payments: new Map(db.payments),
        inventoryItems: new Map(Array.from(db.inventoryItems.entries()).map(([k, v]) => [k, { ...v }])),
        stockMovements: [...db.stockMovements],
      };

      const tx = {
        $queryRaw: async (query: any, ...values: any[]) => {
          const parts = Array.isArray(query) ? query : [query];
          const rendered = parts.map((p: any, i: number) => `${p}${values[i] !== undefined ? values[i] : ""}`).join("");
          db.locks.push(rendered);
          return [{ locked: "1" }];
        },
        payment: {
          findUnique: async ({ where }: any) => {
            if (where?.hotelId_idempotencyKey) {
              const { hotelId, idempotencyKey } = where.hotelId_idempotencyKey;
              for (const p of db.payments.values()) {
                if (p.hotelId === hotelId && p.idempotencyKey === idempotencyKey) {
                  return buildPaymentResult(p);
                }
              }
              return null;
            }
            const p = db.payments.get(where.id);
            return p ? buildPaymentResult(p) : null;
          },
          create: async ({ data }: any) => {
            if (db.simulateP2002OnPaymentCreate) {
              const target = db.simulateP2002Target !== undefined
                ? db.simulateP2002Target
                : ["hotelId", "idempotencyKey"];
              throw new MockPrismaClientKnownRequestError(
                "Unique constraint failed",
                "P2002",
                target ? { target } : undefined
              );
            }
            if (data.idempotencyKey) {
              for (const p of db.payments.values()) {
                if (p.hotelId === data.hotelId && p.idempotencyKey === data.idempotencyKey) {
                  throw new MockPrismaClientKnownRequestError(
                    "Unique constraint failed",
                    "P2002",
                    { target: ["hotelId", "idempotencyKey"] }
                  );
                }
              }
            }
            const id = `pay-${Date.now()}-${Math.random().toString(36).substring(7)}`;
            const created = { id, createdAt: new Date(), ...data };
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
        },
        menuItem: {
          findMany: async ({ where }: any) => {
            const results: any[] = [];
            const ids = where?.id?.in || [];
            const hotelId = where?.hotelId;
            const isActive = where?.isActive;
            for (const item of db.menuItems.values()) {
              if (ids.includes(item.id)) {
                if (hotelId && item.hotelId !== hotelId) continue;
                if (isActive !== undefined && item.isActive !== isActive) continue;
                results.push(item);
              }
            }
            return results;
          },
        },
        recipe: {
          findMany: async ({ where }: any) => {
            const results: any[] = [];
            const itemIds = where?.menuItemId?.in || [];
            const hotelId = where?.menuItem?.hotelId;
            for (const r of db.recipes.values()) {
              if (itemIds.includes(r.menuItemId)) {
                if (hotelId && r.menuItem?.hotelId !== hotelId) continue;
                results.push(r);
              }
            }
            return results;
          },
        },
        inventoryItem: {
          findMany: async ({ where }: any) => {
            const results: any[] = [];
            const ids = where?.id?.in || [];
            const hotelId = where?.hotelId;
            for (const inv of db.inventoryItems.values()) {
              if (ids.includes(inv.id)) {
                if (hotelId && inv.hotelId !== hotelId) continue;
                results.push(inv);
              }
            }
            return results;
          },
          update: async ({ where, data }: any) => {
            const id = where?.id_hotelId ? where.id_hotelId.id : where.id;
            const hotelId = where?.id_hotelId ? where.id_hotelId.hotelId : undefined;
            const item = db.inventoryItems.get(id);
            if (!item || (hotelId && item.hotelId !== hotelId)) {
              throw new Error("Inventory item not found");
            }
            const updated = { ...item, ...data };
            db.inventoryItems.set(id, updated);
            return updated;
          },
        },
        stockMovement: {
          create: async ({ data }: any) => {
            db.stockMovements.push(data);
            return data;
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
            const id = `guest-${Date.now()}-${Math.random().toString(36).substring(7)}`;
            const created = { id, ...data };
            db.guests.set(id, created);
            return created;
          },
        },
        folio: {
          create: async ({ data }: any) => {
            const id = `folio-${Date.now()}-${Math.random().toString(36).substring(7)}`;
            const created = { id, ...data };
            db.folios.set(id, created);
            return created;
          },
        },
        folioItem: {
          create: async ({ data }: any) => {
            const id = `fi-${Date.now()}-${Math.random().toString(36).substring(7)}`;
            const created = { id, ...data };
            db.folioItems.set(id, created);
            return created;
          },
        },
      };

      try {
        return await fn(tx);
      } catch (err) {
        // Rollback state on transaction failure
        db.folios = snapshot.folios;
        db.folioItems = snapshot.folioItems;
        db.payments = snapshot.payments;
        db.inventoryItems = snapshot.inventoryItems;
        db.stockMovements = snapshot.stockMovements;
        throw err;
      }
    },
  },
}));

let payNowRoute: any = null;
let paymentStatusRoute: any = null;

describe("Phase 4B: Restaurant POS Pay-Now Idempotency & Concurrency Hardening", () => {
  beforeEach(async () => {
    db = createFreshTestDB();
    mockCurrentTenant = {
      hotelId: "hotel-a",
      userId: "user-cashier-a",
      role: HotelRole.CASHIER,
      name: "Cashier Alice",
    };
    if (!payNowRoute) {
      payNowRoute = (await import("@/app/api/restaurant/pay-now/route")).POST;
    }
    if (!paymentStatusRoute) {
      paymentStatusRoute = (await import("@/app/api/restaurant/payments/status/route")).GET;
    }
  });

  it("1. Normal POS payment succeeds and deducts inventory atomically", async () => {
    const req = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "pos-key-1001",
      },
      body: JSON.stringify({
        paymentMethodId: "pm-a-cash",
        tableNumber: "5",
        items: [{ menuItemId: "item-a-burger", quantity: 2 }],
      }),
    });

    const res = await payNowRoute(req);
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.total).toBe(1700); // 850 * 2
    expect(data.method).toBe("Cash");
    expect(data.folioId).toBeDefined();
    expect(data.paymentId).toBeDefined();

    // Verify database state: exactly 1 folio, 1 payment, 1 folioItem, 1 stock movement
    expect(db.folios.size).toBe(1);
    expect(db.payments.size).toBe(1);
    expect(db.folioItems.size).toBe(1);
    expect(db.stockMovements.length).toBe(1);
    expect(db.stockMovements[0].quantity).toBe(-2);
    expect(db.inventoryItems.get("inv-a-patty").currentStock).toBe(98); // 100 - 2
  });

  it("2. Repeating same successful request and key returns original result (isIdempotentReplay)", async () => {
    const payload = {
      paymentMethodId: "pm-a-cash",
      tableNumber: "5",
      items: [{ menuItemId: "item-a-burger", quantity: 2 }],
    };

    // First submission
    const req1 = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "pos-key-replay-1",
      },
      body: JSON.stringify(payload),
    });
    const res1 = await payNowRoute(req1);
    expect(res1.status).toBe(201);
    const data1 = await res1.json();
    expect(data1.isIdempotentReplay).toBeUndefined();

    const foliosAfterFirst = db.folios.size;
    const paymentsAfterFirst = db.payments.size;
    const stockAfterFirst = db.inventoryItems.get("inv-a-patty").currentStock;
    const movementsAfterFirst = db.stockMovements.length;

    // Second submission (replay)
    const req2 = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "pos-key-replay-1",
      },
      body: JSON.stringify(payload),
    });
    const res2 = await payNowRoute(req2);
    expect(res2.status).toBe(201);
    const data2 = await res2.json();

    // Must be marked as idempotent replay and match original identifiers
    expect(data2.isIdempotentReplay).toBe(true);
    expect(data2.paymentId).toBe(data1.paymentId);
    expect(data2.folioId).toBe(data1.folioId);
    expect(data2.total).toBe(data1.total);

    // Verifies requirement: Exactly one folio, payment, and stock deduction
    expect(db.folios.size).toBe(foliosAfterFirst);
    expect(db.payments.size).toBe(paymentsAfterFirst);
    expect(db.inventoryItems.get("inv-a-patty").currentStock).toBe(stockAfterFirst);
    expect(db.stockMovements.length).toBe(movementsAfterFirst);
  });

  it("3. Reusing the key with a different cart or quantity returns 409 Conflict", async () => {
    // Initial submission: 1 burger
    const req1 = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "pos-conflict-cart",
      },
      body: JSON.stringify({
        paymentMethodId: "pm-a-cash",
        items: [{ menuItemId: "item-a-burger", quantity: 1 }],
      }),
    });
    const res1 = await payNowRoute(req1);
    expect(res1.status).toBe(201);

    // Same key with different quantity (2 burgers)
    const reqDiffQty = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "pos-conflict-cart",
      },
      body: JSON.stringify({
        paymentMethodId: "pm-a-cash",
        items: [{ menuItemId: "item-a-burger", quantity: 2 }],
      }),
    });
    const resDiffQty = await payNowRoute(reqDiffQty);
    expect(resDiffQty.status).toBe(409);
    const dataDiffQty = await resDiffQty.json();
    expect(dataDiffQty.error).toContain("Idempotency key was previously used with different order details");

    // Same key with different item (soda instead of burger)
    const reqDiffItem = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "pos-conflict-cart",
      },
      body: JSON.stringify({
        paymentMethodId: "pm-a-cash",
        items: [{ menuItemId: "item-a-soda", quantity: 1 }],
      }),
    });
    const resDiffItem = await payNowRoute(reqDiffItem);
    expect(resDiffItem.status).toBe(409);
  });

  it("4. Reusing the key with a different payment method returns 409 Conflict", async () => {
    const req1 = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "pos-conflict-method",
      },
      body: JSON.stringify({
        paymentMethodId: "pm-a-cash",
        items: [{ menuItemId: "item-a-soda", quantity: 1 }],
      }),
    });
    const res1 = await payNowRoute(req1);
    expect(res1.status).toBe(201);

    // Same key with M-Pesa instead of Cash
    const reqDiffMethod = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "pos-conflict-method",
      },
      body: JSON.stringify({
        paymentMethodId: "pm-a-mpesa",
        items: [{ menuItemId: "item-a-soda", quantity: 1 }],
      }),
    });
    const resDiffMethod = await payNowRoute(reqDiffMethod);
    expect(resDiffMethod.status).toBe(409);
    const data = await resDiffMethod.json();
    expect(data.error).toContain("Idempotency key was previously used with different order details");
  });

  it("5. Rejects missing, blank, or out-of-bounds idempotency keys with 400", async () => {
    // Missing key
    const reqMissing = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        paymentMethodId: "pm-a-cash",
        items: [{ menuItemId: "item-a-soda", quantity: 1 }],
      }),
    });
    const resMissing = await payNowRoute(reqMissing);
    expect(resMissing.status).toBe(400);
    const dataMissing = await resMissing.json();
    expect(dataMissing.error).toContain("An idempotency key is required");

    // Too short (< 4 chars)
    const reqShort = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "ab",
      },
      body: JSON.stringify({
        paymentMethodId: "pm-a-cash",
        items: [{ menuItemId: "item-a-soda", quantity: 1 }],
      }),
    });
    const resShort = await payNowRoute(reqShort);
    expect(resShort.status).toBe(400);

    // Too long (> 128 chars)
    const reqLong = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "k".repeat(129),
      },
      body: JSON.stringify({
        paymentMethodId: "pm-a-cash",
        items: [{ menuItemId: "item-a-soda", quantity: 1 }],
      }),
    });
    const resLong = await payNowRoute(reqLong);
    expect(resLong.status).toBe(400);
  });

  it("6. Recovers winning payment outside failed transaction when concurrent race triggers P2002", async () => {
    const payload = {
      paymentMethodId: "pm-a-cash",
      items: [{ menuItemId: "item-a-burger", quantity: 1 }],
    };

    // First, seed the winning payment in DB as if a concurrent request committed first
    const reqWinner = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "concurrent-race-pos",
      },
      body: JSON.stringify(payload),
    });
    const resWinner = await payNowRoute(reqWinner);
    expect(resWinner.status).toBe(201);
    const dataWinner = await resWinner.json();

    // Now simulate concurrent racer that attempts payment.create and collides on unique constraint (P2002)
    db.simulateP2002OnPaymentCreate = true;
    try {
      const reqRacer = new Request("http://localhost:3000/api/restaurant/pay-now", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": "concurrent-race-pos",
        },
        body: JSON.stringify(payload),
      });

      const resRacer = await payNowRoute(reqRacer);
      // Requirement 9: inspects winning result OUTSIDE failed transaction, matches fingerprint, returns original result!
      expect(resRacer.status).toBe(201);
      const dataRacer = await resRacer.json();
      expect(dataRacer.isIdempotentReplay).toBe(true);
      expect(dataRacer.paymentId).toBe(dataWinner.paymentId);
      expect(dataRacer.folioId).toBe(dataWinner.folioId);
    } finally {
      db.simulateP2002OnPaymentCreate = false;
    }
  });

  it("7. Concurrent race with different payload returns 409 Conflict", async () => {
    // Initial winning request with 1 soda
    const reqWinner = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "concurrent-diff-payload",
      },
      body: JSON.stringify({
        paymentMethodId: "pm-a-cash",
        items: [{ menuItemId: "item-a-soda", quantity: 1 }],
      }),
    });
    const resWinner = await payNowRoute(reqWinner);
    expect(resWinner.status).toBe(201);

    // Concurrent loser request with different payload (burger instead of soda)
    db.simulateP2002OnPaymentCreate = true;
    try {
      const reqRacerDiff = new Request("http://localhost:3000/api/restaurant/pay-now", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": "concurrent-diff-payload",
        },
        body: JSON.stringify({
          paymentMethodId: "pm-a-cash",
          items: [{ menuItemId: "item-a-burger", quantity: 1 }],
        }),
      });

      const resRacerDiff = await payNowRoute(reqRacerDiff);
      expect(resRacerDiff.status).toBe(409);
      const data = await resRacerDiff.json();
      expect(data.error).toContain("Idempotency key was previously used with different order details");
    } finally {
      db.simulateP2002OnPaymentCreate = false;
    }
  });

  it("8. Failed transaction leaves no partial payment or stock deduction", async () => {
    const initialFolioCount = db.folios.size;
    const initialPaymentCount = db.payments.size;
    const initialStock = db.inventoryItems.get("inv-a-patty").currentStock;
    const initialMovements = db.stockMovements.length;

    // Send order with invalid payment method
    const req = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "fail-rollback-test",
      },
      body: JSON.stringify({
        paymentMethodId: "pm-non-existent",
        items: [{ menuItemId: "item-a-burger", quantity: 2 }],
      }),
    });

    const res = await payNowRoute(req);
    expect(res.status).toBe(400);

    // Atomicity check: everything rolled back
    expect(db.folios.size).toBe(initialFolioCount);
    expect(db.payments.size).toBe(initialPaymentCount);
    expect(db.inventoryItems.get("inv-a-patty").currentStock).toBe(initialStock);
    expect(db.stockMovements.length).toBe(initialMovements);
  });

  it("9. Cross-hotel keys and menu items cannot cross tenant boundaries", async () => {
    // Hotel B has payment with key "shared-pos-key"
    db.payments.set("pay-b-1", {
      id: "pay-b-1",
      hotelId: "hotel-b",
      folioId: "folio-b-1",
      guestId: "guest-b-1",
      paymentMethodId: "pm-b-card",
      amount: 1800,
      idempotencyKey: "shared-pos-key",
      requestFingerprint: "fingerprint-b",
      status: "COMPLETED",
      cashierId: "user-b",
    });

    // Hotel A submits order using that same idempotency key "shared-pos-key"
    const reqA = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "shared-pos-key",
      },
      body: JSON.stringify({
        paymentMethodId: "pm-a-cash",
        items: [{ menuItemId: "item-a-burger", quantity: 1 }],
      }),
    });

    const resA = await payNowRoute(reqA);
    expect(resA.status).toBe(201);
    const dataA = await resA.json();
    expect(dataA.id).not.toBe("pay-b-1");

    const savedA = Array.from(db.payments.values()).find((p) => p.id === dataA.paymentId);
    expect(savedA).toBeDefined();
    expect(savedA.hotelId).toBe("hotel-a");
    expect(savedA.idempotencyKey).toBe("shared-pos-key");

    // Hotel A cannot order Hotel B's menu item
    const reqForeignItem = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "foreign-item-attempt",
      },
      body: JSON.stringify({
        paymentMethodId: "pm-a-cash",
        items: [{ menuItemId: "item-b-steak", quantity: 1 }],
      }),
    });
    const resForeignItem = await payNowRoute(reqForeignItem);
    expect(resForeignItem.status).toBe(400);
    const errData = await resForeignItem.json();
    expect(errData.error).toContain("One or more menu items are unavailable");
  });

  it("10. P2002 with constraint name string Payment_hotelId_idempotencyKey_key recovers winning payment", async () => {
    const payload = {
      paymentMethodId: "pm-a-cash",
      items: [{ menuItemId: "item-a-burger", quantity: 1 }],
    };

    const reqWinner = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "constraint-str-key",
      },
      body: JSON.stringify(payload),
    });
    const resWinner = await payNowRoute(reqWinner);
    expect(resWinner.status).toBe(201);
    const dataWinner = await resWinner.json();

    // Simulate P2002 with constraint identifier string
    db.simulateP2002OnPaymentCreate = true;
    db.simulateP2002Target = "Payment_hotelId_idempotencyKey_key";
    try {
      const reqRacer = new Request("http://localhost:3000/api/restaurant/pay-now", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": "constraint-str-key",
        },
        body: JSON.stringify(payload),
      });

      const resRacer = await payNowRoute(reqRacer);
      expect(resRacer.status).toBe(201);
      const dataRacer = await resRacer.json();
      expect(dataRacer.isIdempotentReplay).toBe(true);
      expect(dataRacer.paymentId).toBe(dataWinner.paymentId);
    } finally {
      db.simulateP2002OnPaymentCreate = false;
      db.simulateP2002Target = undefined;
    }
  });

  it("11. P2002 with unrelated unique constraint does not enter idempotency recovery", async () => {
    const payload = {
      paymentMethodId: "pm-a-cash",
      items: [{ menuItemId: "item-a-burger", quantity: 1 }],
    };

    db.simulateP2002OnPaymentCreate = true;
    db.simulateP2002Target = ["email"]; // Unrelated constraint e.g. Guest email
    try {
      const req = new Request("http://localhost:3000/api/restaurant/pay-now", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": "unrelated-p2002-key",
        },
        body: JSON.stringify(payload),
      });

      const res = await payNowRoute(req);
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain("unique record constraint violation");
      expect(data.error).not.toContain("concurrently");
    } finally {
      db.simulateP2002OnPaymentCreate = false;
      db.simulateP2002Target = undefined;
    }
  });

  it("12. P2002 with missing or ambiguous metadata uses conservative fallback without false success", async () => {
    const payload = {
      paymentMethodId: "pm-a-cash",
      items: [{ menuItemId: "item-a-burger", quantity: 1 }],
    };

    db.simulateP2002OnPaymentCreate = true;
    db.simulateP2002Target = null; // Missing metadata
    try {
      const req = new Request("http://localhost:3000/api/restaurant/pay-now", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": "missing-meta-p2002",
        },
        body: JSON.stringify(payload),
      });

      const res = await payNowRoute(req);
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain("unique record constraint violation");
    } finally {
      db.simulateP2002OnPaymentCreate = false;
      db.simulateP2002Target = undefined;
    }
  });

  it("13. P2002 with idempotency target but missing winning payment returns 409 without fabricating success", async () => {
    const payload = {
      paymentMethodId: "pm-a-cash",
      items: [{ menuItemId: "item-a-burger", quantity: 1 }],
    };

    // P2002 thrown, but NO matching payment was actually committed in db
    db.simulateP2002OnPaymentCreate = true;
    db.simulateP2002Target = ["hotelId", "idempotencyKey"];
    try {
      const req = new Request("http://localhost:3000/api/restaurant/pay-now", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Idempotency-Key": "no-winner-p2002",
        },
        body: JSON.stringify(payload),
      });

      const res = await payNowRoute(req);
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain("submitted concurrently");
    } finally {
      db.simulateP2002OnPaymentCreate = false;
      db.simulateP2002Target = undefined;
    }
  });

  it("14. Server status inquiry endpoint returns payment status for matching key and fingerprint", async () => {
    // Commit a real payment first
    const payReq = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "status-check-key-1",
      },
      body: JSON.stringify({
        paymentMethodId: "pm-a-cash",
        items: [{ menuItemId: "item-a-burger", quantity: 1 }],
      }),
    });
    const payRes = await payNowRoute(payReq);
    expect(payRes.status).toBe(201);

    // Query status
    const statusReq = new Request("http://localhost:3000/api/restaurant/payments/status?key=status-check-key-1");
    const statusRes = await paymentStatusRoute(statusReq);
    expect(statusRes.status).toBe(200);
    const data = await statusRes.json();
    expect(data.found).toBe(true);
    expect(data.status).toBe("COMPLETED");
    expect(data.total).toBe(850);
    expect(data.method).toBe("Cash");
  });

  it("15. Server status inquiry endpoint detects payload mismatch when fingerprint differs", async () => {
    const payReq = new Request("http://localhost:3000/api/restaurant/pay-now", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Idempotency-Key": "status-check-key-2",
      },
      body: JSON.stringify({
        paymentMethodId: "pm-a-cash",
        items: [{ menuItemId: "item-a-burger", quantity: 1 }],
      }),
    });
    const payRes = await payNowRoute(payReq);
    expect(payRes.status).toBe(201);

    // Query status with a foreign/mismatched fingerprint
    const statusReq = new Request(
      "http://localhost:3000/api/restaurant/payments/status?key=status-check-key-2&fingerprint=mismatched-fp-123"
    );
    const statusRes = await paymentStatusRoute(statusReq);
    expect(statusRes.status).toBe(200);
    const data = await statusRes.json();
    expect(data.found).toBe(true);
    expect(data.matchesFingerprint).toBe(false);
  });

  it("16. Server status inquiry endpoint returns found: false when key does not exist", async () => {
    const statusReq = new Request("http://localhost:3000/api/restaurant/payments/status?key=non-existent-key-999");
    const statusRes = await paymentStatusRoute(statusReq);
    expect(statusRes.status).toBe(200);
    const data = await statusRes.json();
    expect(data.found).toBe(false);
    expect(data.status).toBe("NOT_FOUND");
  });

  it("17. Server status inquiry enforces tenant isolation (Hotel A cannot query Hotel B's key)", async () => {
    // Record payment in Hotel B
    db.payments.set("pay-b-status", {
      id: "pay-b-status",
      hotelId: "hotel-b",
      folioId: "folio-b-1",
      paymentMethodId: "pm-b-cash",
      amount: 1500,
      idempotencyKey: "cross-tenant-status-key",
      requestFingerprint: "fp-b",
      status: "COMPLETED",
      cashierId: "user-b",
      createdAt: new Date(),
    });

    // Hotel A queries for that key
    const statusReq = new Request(
      "http://localhost:3000/api/restaurant/payments/status?key=cross-tenant-status-key"
    );
    const statusRes = await paymentStatusRoute(statusReq);
    expect(statusRes.status).toBe(200);
    const data = await statusRes.json();
    // Must return found: false because key belongs to Hotel B
    expect(data.found).toBe(false);
  });

  it("18. Server status inquiry rejects invalid or missing idempotency key with 400", async () => {
    const emptyReq = new Request("http://localhost:3000/api/restaurant/payments/status");
    const emptyRes = await paymentStatusRoute(emptyReq);
    expect(emptyRes.status).toBe(400);

    const shortReq = new Request("http://localhost:3000/api/restaurant/payments/status?key=ab");
    const shortRes = await paymentStatusRoute(shortReq);
    expect(shortRes.status).toBe(400);
  });
});
