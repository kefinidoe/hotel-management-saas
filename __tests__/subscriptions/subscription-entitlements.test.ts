import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";

vi.mock("@prisma/client", () => ({
  HotelRole: {
    HOTEL_OWNER: "HOTEL_OWNER",
    HOTEL_ADMIN: "HOTEL_ADMIN",
    MANAGER: "MANAGER",
    RECEPTIONIST: "RECEPTIONIST",
    ACCOUNTANT: "ACCOUNTANT",
    HOUSEKEEPER: "HOUSEKEEPER",
    WAITER: "WAITER",
    CASHIER: "CASHIER",
    TECHNICIAN: "TECHNICIAN",
  },
  HotelStatus: { ACTIVE: "ACTIVE", TRIALING: "TRIALING", SUSPENDED: "SUSPENDED", CANCELLED: "CANCELLED" },
  MembershipStatus: { ACTIVE: "ACTIVE", SUSPENDED: "SUSPENDED", INVITED: "INVITED" },
  PlatformRole: {
    PLATFORM_SUPER_ADMIN: "PLATFORM_SUPER_ADMIN",
    PLATFORM_SUPPORT: "PLATFORM_SUPPORT",
    PLATFORM_BILLING: "PLATFORM_BILLING",
  },
  Prisma: {
    TransactionIsolationLevel: { Serializable: "Serializable" },
    PrismaClientKnownRequestError: class PrismaClientKnownRequestError extends Error {
      code: string;
      constructor(message: string, code: string) {
        super(message);
        this.code = code;
      }
    },
  },
}));
import {
  SUBSCRIPTION_PLANS,
  getPlan,
  getAllPlans,
  isPlanAvailableForNewSub,
  DEFAULT_PLAN_ID,
  SubscriptionStatus,
  BillingInterval,
} from "@/lib/plans";
let evaluateSubscriptionStatus: typeof import("@/lib/entitlements").evaluateSubscriptionStatus;
let checkModuleEntitlement: typeof import("@/lib/entitlements").checkModuleEntitlement;
let checkUsageLimit: typeof import("@/lib/entitlements").checkUsageLimit;
let withUsageLimitLock: typeof import("@/lib/entitlements").withUsageLimitLock;
let getOrBootstrapSubscription: typeof import("@/lib/entitlements").getOrBootstrapSubscription;
let getHotelUsageAndSubscription: typeof import("@/lib/entitlements").getHotelUsageAndSubscription;
import {
  HotelRole,
  HotelStatus,
  MembershipStatus,
  PlatformRole,
} from "@prisma/client";

// In-memory test state
interface DBState {
  users: Map<string, any>;
  hotels: Map<string, any>;
  memberships: Map<string, any>;
  subscriptions: Map<string, any>;
  rooms: Map<string, any>;
  auditLogs: any[];
}

let db: DBState;

function resetDB(): DBState {
  const users = new Map<string, any>();
  const hotels = new Map<string, any>();
  const memberships = new Map<string, any>();
  const subscriptions = new Map<string, any>();
  const rooms = new Map<string, any>();

  // Platform Admins
  users.set("super-admin-user", {
    id: "super-admin-user",
    name: "Platform Super Admin",
    email: "superadmin@saas.com",
    platformRole: PlatformRole.PLATFORM_SUPER_ADMIN,
    isActive: true,
  });

  users.set("billing-admin-user", {
    id: "billing-admin-user",
    name: "Billing Admin",
    email: "billing@saas.com",
    platformRole: PlatformRole.PLATFORM_BILLING,
    isActive: true,
  });

  // Hotel A: Starter Plan, Active Trial
  hotels.set("hotel-a", {
    id: "hotel-a",
    name: "Safari Boutique Hotel",
    slug: "safari-boutique",
    currency: "KES",
    timezone: "Africa/Nairobi",
    status: HotelStatus.ACTIVE,
    createdAt: new Date(),
  });

  users.set("user-a-owner", {
    id: "user-a-owner",
    name: "Alice Owner",
    email: "alice@safari.com",
    platformRole: null,
    isActive: true,
  });

  memberships.set("mem-a-owner", {
    id: "mem-a-owner",
    userId: "user-a-owner",
    hotelId: "hotel-a",
    role: HotelRole.HOTEL_OWNER,
    status: MembershipStatus.ACTIVE,
    createdAt: new Date(),
  });

  // 14 days trial ends in the future
  subscriptions.set("hotel-a", {
    id: "sub-a",
    hotelId: "hotel-a",
    planId: "STARTER",
    status: SubscriptionStatus.TRIALING,
    trialStartsAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
    trialEndsAt: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000),
    currentPeriodStartsAt: new Date(),
    currentPeriodEndsAt: new Date(Date.now() + 12 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: false,
    billingInterval: BillingInterval.MONTHLY,
    amount: 4500,
    currency: "KES",
  });

  // Hotel B: Growth Plan, Active Paid Subscription
  hotels.set("hotel-b", {
    id: "hotel-b",
    name: "Coastal Breeze Resort",
    slug: "coastal-breeze",
    currency: "KES",
    timezone: "Africa/Nairobi",
    status: HotelStatus.ACTIVE,
    createdAt: new Date(),
  });

  users.set("user-b-owner", {
    id: "user-b-owner",
    name: "Bob Resort Owner",
    email: "bob@coastal.com",
    platformRole: null,
    isActive: true,
  });

  memberships.set("mem-b-owner", {
    id: "mem-b-owner",
    userId: "user-b-owner",
    hotelId: "hotel-b",
    role: HotelRole.HOTEL_OWNER,
    status: MembershipStatus.ACTIVE,
    createdAt: new Date(),
  });

  subscriptions.set("hotel-b", {
    id: "sub-b",
    hotelId: "hotel-b",
    planId: "GROWTH",
    status: SubscriptionStatus.ACTIVE,
    trialStartsAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    trialEndsAt: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000),
    currentPeriodStartsAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
    currentPeriodEndsAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: false,
    billingInterval: BillingInterval.MONTHLY,
    amount: 9500,
    currency: "KES",
  });

  // Hotel C: Expired Trial Hotel
  hotels.set("hotel-c", {
    id: "hotel-c",
    name: "Sunset Lodge",
    slug: "sunset-lodge",
    currency: "USD",
    timezone: "Africa/Nairobi",
    status: HotelStatus.ACTIVE,
    createdAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
  });

  subscriptions.set("hotel-c", {
    id: "sub-c",
    hotelId: "hotel-c",
    planId: "STARTER",
    status: SubscriptionStatus.TRIALING,
    trialStartsAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
    trialEndsAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000), // expired 6 days ago
    currentPeriodStartsAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
    currentPeriodEndsAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
    cancelAtPeriodEnd: false,
    billingInterval: BillingInterval.MONTHLY,
    amount: 4500,
    currency: "KES",
  });

  // Hotel D: Suspended Subscription Hotel
  hotels.set("hotel-d", {
    id: "hotel-d",
    name: "Valley Inn",
    slug: "valley-inn",
    currency: "KES",
    timezone: "Africa/Nairobi",
    status: HotelStatus.ACTIVE,
    createdAt: new Date(),
  });

  subscriptions.set("hotel-d", {
    id: "sub-d",
    hotelId: "hotel-d",
    planId: "STARTER",
    status: SubscriptionStatus.SUSPENDED,
    trialStartsAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
    trialEndsAt: null,
    currentPeriodStartsAt: new Date(),
    currentPeriodEndsAt: null,
    cancelAtPeriodEnd: false,
    suspensionReason: "Non-payment of past due invoices",
    billingInterval: BillingInterval.MONTHLY,
    amount: 4500,
    currency: "KES",
  });

  return {
    users,
    hotels,
    memberships,
    subscriptions,
    rooms,
    auditLogs: [],
  };
}

vi.doMock("server-only", () => ({}));

vi.doMock("bcryptjs", () => ({
  default: {
    hash: async (pw: string) => `hashed-${pw}`,
    compare: async (pw: string, hash: string) => hash === `hashed-${pw}`,
  },
  hash: async (pw: string) => `hashed-${pw}`,
  compare: async (pw: string, hash: string) => hash === `hashed-${pw}`,
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

let mockActiveCookie: string | null = null;

vi.doMock("next/headers", () => ({
  cookies: async () => ({
    get: (key: string) => (key === "active_hotel_id" && mockActiveCookie ? { value: mockActiveCookie } : undefined),
    set: (key: string, value: string) => {
      if (key === "active_hotel_id") mockActiveCookie = value;
    },
    delete: (key: string) => {
      if (key === "active_hotel_id") mockActiveCookie = null;
    },
  }),
}));

let mockCurrentSession: any = null;

vi.doMock("next-auth", () => ({
  getServerSession: async () => mockCurrentSession,
}));

vi.doMock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.doMock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: any) => {
        if (where?.id) return db.users.get(where.id) || null;
        if (where?.email) {
          for (const u of db.users.values()) {
            if (u.email.toLowerCase() === where.email.toLowerCase()) return u;
          }
        }
        return null;
      },
    },
    hotel: {
      findUnique: async ({ where }: any) => {
        if (where?.id) return db.hotels.get(where.id) || null;
        if (where?.slug) {
          for (const h of db.hotels.values()) {
            if (h.slug === where.slug) return h;
          }
        }
        return null;
      },
      findMany: async () => {
        return Array.from(db.hotels.values()).map((h) => ({
          ...h,
          subscription: db.subscriptions.get(h.id) || null,
          _count: {
            rooms: Array.from(db.rooms.values()).filter((r) => r.hotelId === h.id && r.isActive).length,
            memberships: Array.from(db.memberships.values()).filter((m) => m.hotelId === h.id && m.status === "ACTIVE").length,
          },
        }));
      },
    },
    hotelMembership: {
      findUnique: async ({ where }: any) => {
        if (where?.userId_hotelId) {
          const { userId, hotelId } = where.userId_hotelId;
          for (const m of db.memberships.values()) {
            if (m.userId === userId && m.hotelId === hotelId) {
              return {
                ...m,
                hotel: db.hotels.get(m.hotelId) || null,
                user: db.users.get(m.userId) || null,
              };
            }
          }
        }
        if (where?.id) {
          const m = db.memberships.get(where.id);
          if (m) {
            return {
              ...m,
              hotel: db.hotels.get(m.hotelId) || null,
              user: db.users.get(m.userId) || null,
            };
          }
        }
        return null;
      },
      findFirst: async ({ where }: any) => {
        for (const m of db.memberships.values()) {
          if (where?.hotelId && m.hotelId !== where.hotelId) continue;
          if (where?.id && m.id !== where.id) continue;
          if (where?.userId && m.userId !== where.userId) continue;
          if (where?.OR && Array.isArray(where.OR)) {
            const matchesOr = where.OR.some((cond: any) => {
              if (cond.id && m.id === cond.id) return true;
              if (cond.userId && m.userId === cond.userId) return true;
              return false;
            });
            if (!matchesOr) continue;
          }
          return {
            ...m,
            hotel: db.hotels.get(m.hotelId) || null,
            user: db.users.get(m.userId) || null,
          };
        }
        return null;
      },
      findMany: async ({ where }: any) => {
        let results = Array.from(db.memberships.values());
        if (where?.userId) {
          results = results.filter((m) => m.userId === where.userId);
        }
        if (where?.hotelId) {
          results = results.filter((m) => m.hotelId === where.hotelId);
        }
        if (where?.status) {
          if (typeof where.status === "object" && where.status?.in) {
            results = results.filter((m) => where.status.in.includes(m.status));
          } else {
            results = results.filter((m) => m.status === where.status);
          }
        }
        return results.map((m) => ({
          ...m,
          hotel: db.hotels.get(m.hotelId) || null,
          user: db.users.get(m.userId) || null,
        }));
      },
      count: async ({ where }: any) => {
        let count = 0;
        for (const m of db.memberships.values()) {
          if (m.hotelId === where?.hotelId && (!where?.status || m.status === where.status)) {
            count++;
          }
        }
        return count;
      },
      update: async ({ where, data }: any) => {
        const id = where?.id;
        const existing = db.memberships.get(id);
        if (!existing) throw new Error("Membership not found");
        const updated = { ...existing, ...data };
        db.memberships.set(id, updated);
        return {
          ...updated,
          hotel: db.hotels.get(updated.hotelId) || null,
          user: db.users.get(updated.userId) || null,
        };
      },
    },
    room: {
      count: async ({ where }: any) => {
        let count = 0;
        for (const r of db.rooms.values()) {
          if (r.hotelId === where?.hotelId && (where?.isActive === undefined || r.isActive === where.isActive)) {
            count++;
          }
        }
        return count;
      },
      findUnique: async ({ where }: any) => {
        if (where?.id_hotelId) {
          const { id, hotelId } = where.id_hotelId;
          const r = db.rooms.get(id);
          return r && r.hotelId === hotelId ? r : null;
        }
        if (where?.id) return db.rooms.get(where.id) || null;
        return null;
      },
      findFirst: async ({ where }: any) => {
        for (const r of db.rooms.values()) {
          if (where?.id && r.id !== where.id) continue;
          if (where?.hotelId && r.hotelId !== where.hotelId) continue;
          if (where?.isActive !== undefined && r.isActive !== where.isActive) continue;
          return r;
        }
        return null;
      },
      findMany: async ({ where }: any) => Array.from(db.rooms.values()).filter((room) => room.hotelId === where?.hotelId),
      create: async ({ data }: any) => {
        const id = `room-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const r = { id, isActive: true, ...data };
        db.rooms.set(id, r);
        return r;
      },
      update: async ({ where, data }: any) => {
        const id = where?.id_hotelId?.id || where?.id;
        const existing = db.rooms.get(id);
        if (!existing) throw new Error("Room not found");
        const updated = { ...existing, ...data };
        db.rooms.set(id, updated);
        return updated;
      },
    },
    roomType: {
      findUnique: async () => ({ id: "rt-1", name: "Standard", baseRate: 100 }),
      findMany: async () => [],
    },
    reservation: {
      count: async () => 0,
      findMany: async () => [],
      create: async ({ data }: any) => ({ id: "res-1", code: "RES-101", ...data }),
    },
    maintenanceTicket: {
      findMany: async ({ where }: any) => [],
      findFirst: async ({ where }: any) => ({ id: where.id, hotelId: where.hotelId, title: "AC Repair", status: "OPEN" }),
      create: async ({ data }: any) => ({ id: "ticket-1", ...data }),
      update: async ({ where, data }: any) => ({ id: where.id, ...data }),
    },
    housekeepingTask: {
      findMany: async ({ where }: any) => [],
      findFirst: async ({ where }: any) => ({ id: where.id, hotelId: where.hotelId, status: "NEEDS_CLEANING", roomId: "rm-1" }),
      create: async ({ data }: any) => ({ id: "hk-1", ...data }),
      update: async ({ where, data }: any) => ({ id: where.id, ...data }),
    },
    expense: {
      findMany: async ({ where }: any) => [],
      create: async ({ data }: any) => ({ id: "exp-1", ...data, requestedBy: { name: "Requester" } }),
    },
    inventoryItem: {
      findMany: async ({ where }: any) => [],
      create: async ({ data }: any) => ({ id: "inv-1", ...data }),
    },
   folio: {
      findMany: async () => [],
      findUnique: async ({ where }: any) => {
        if (where?.id_hotelId?.id === "fol-1" &&
            where?.id_hotelId?.hotelId === "hotel-a") {
          return {
            id: "fol-1",
            hotelId: "hotel-a",
            isClosed: false,
            guest: { fullName: "Test Guest" },
          };
        }
        return null;
      },
    },
    folioItem: {
      findMany: async () => [],
      aggregate: async () => ({ _sum: { total: 0 } }),
      create: async ({ data }: any) => ({ id: "folio-item-1", ...data }),
    },
    menuCategory: {
      findMany: async ({ where }: any) => [],
      create: async ({ data }: any) => ({ id: "cat-1", ...data }),
    },
    menuItem: {
      findMany: async () => [
        {
          id: "mi-1",
          hotelId: "hotel-a",
          name: "Burger",
          price: 100,
          isActive: true,
        },
    ],
  create: async ({ data }: any) => ({ id: "item-1", ...data }),
},
    subscription: {
      findUnique: async ({ where }: any) => {
        if (where?.hotelId) return db.subscriptions.get(where.hotelId) || null;
        return null;
      },
      create: async ({ data }: any) => {
        const id = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const s = { id, ...data };
        db.subscriptions.set(data.hotelId, s);
        return s;
      },
      upsert: async ({ where, create, update }: any) => {
        const existing = db.subscriptions.get(where.hotelId);
        if (existing) {
          const updated = { ...existing, ...update };
          db.subscriptions.set(where.hotelId, updated);
          return updated;
        }
        const id = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const s = { id, ...create };
        db.subscriptions.set(where.hotelId, s);
        return s;
      },
      update: async ({ where, data }: any) => {
        const existing = db.subscriptions.get(where.hotelId);
        if (!existing) throw new Error("Subscription not found");
        const updated = { ...existing, ...data };
        db.subscriptions.set(where.hotelId, updated);
        return updated;
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        const id = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const log = { id, createdAt: new Date(), ...data };
        db.auditLogs.push(log);
        return log;
      },
      findMany: async () => db.auditLogs,
    },
    $transaction: async (fnOrArray: any) => {
      if (Array.isArray(fnOrArray)) {
        return Promise.all(fnOrArray);
      }
      return fnOrArray({
        $queryRaw: async () => [{ locked: "true" }],
        room: {
          count: async ({ where }: any) => Array.from(db.rooms.values()).filter((room) =>
            room.hotelId === where?.hotelId && (where?.isActive === undefined || room.isActive === where.isActive)
          ).length,
        },
        hotelMembership: {
          count: async ({ where }: any) => Array.from(db.memberships.values()).filter((membership) =>
            membership.hotelId === where?.hotelId && (!where?.status || membership.status === where.status)
          ).length,
        },
        subscription: {
          update: async ({ where, data }: any) => {
            const existing = db.subscriptions.get(where.hotelId);
            const updated = { ...existing, ...data };
            db.subscriptions.set(where.hotelId, updated);
            return updated;
          },
        },
        auditLog: {
          create: async ({ data }: any) => {
            const id = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const log = { id, createdAt: new Date(), ...data };
            db.auditLogs.push(log);
            return log;
          },
        },
        folio: {
          findUnique: async ({ where }: any) => {
            if (
              where?.id_hotelId?.id === "fol-1" &&
              where?.id_hotelId?.hotelId === "hotel-a"
            ) {
              return {
                id: "fol-1",
                hotelId: "hotel-a",
                isClosed: false,
                guest: { fullName: "Test Guest" },
              };
            }
            return null;
          },
        },
        menuItem: {
          findMany: async () => [
            {
              id: "mi-1",
              hotelId: "hotel-a",
              name: "Burger",
              price: 100,
              isActive: true,
            },
          ],
        },
        folioItem: {
          create: async ({ data }: any) => ({ id: "folio-item-1", ...data }),
        },
        recipe: {
          findMany: async () => [],
        },
      });
    },
  },
}));

beforeAll(async () => {
  const entitlements = await import("@/lib/entitlements");
  evaluateSubscriptionStatus = entitlements.evaluateSubscriptionStatus;
  checkModuleEntitlement = entitlements.checkModuleEntitlement;
  checkUsageLimit = entitlements.checkUsageLimit;
  withUsageLimitLock = entitlements.withUsageLimitLock;
  getOrBootstrapSubscription = entitlements.getOrBootstrapSubscription;
  getHotelUsageAndSubscription = entitlements.getHotelUsageAndSubscription;
});

describe("Phase 7: SaaS Subscription Foundation and Plan Enforcement", () => {
  beforeEach(() => {
    db = resetDB();
    mockCurrentSession = null;
    mockActiveCookie = null;
  });

  describe("1. Plan Definitions and Metadata", () => {
    it("defines standard plans (Starter, Growth, Enterprise) with valid pricing and features", () => {
      const starter = getPlan("STARTER");
      const growth = getPlan("GROWTH");
      const enterprise = getPlan("ENTERPRISE");

      expect(starter.id).toBe("STARTER");
      expect(starter.limits.maxRooms).toBe(15);
      expect(starter.limits.maxStaff).toBe(5);
      expect(starter.modules).toContain("RESERVATIONS");
      expect(starter.modules).toContain("FOLIOS");
      expect(starter.modules).toContain("RESTAURANT_POS");
      expect(starter.modules).toContain("MAINTENANCE");

      expect(growth.id).toBe("GROWTH");
      expect(growth.limits.maxRooms).toBe(50);
      expect(growth.limits.maxStaff).toBe(25);
      expect(growth.modules).toContain("RESTAURANT_POS");
      expect(growth.modules).toContain("INVENTORY");
      expect(growth.modules).toContain("EXPENSES");
      expect(growth.modules).toContain("MAINTENANCE");

      expect(enterprise.id).toBe("ENTERPRISE");
      expect(isFinite(enterprise.limits.maxRooms)).toBe(false);
      expect(isFinite(enterprise.limits.maxStaff)).toBe(false);
      expect(enterprise.modules).toContain("MAINTENANCE");
      expect(enterprise.modules).toContain("RESTAURANT_POS");
    });

    it("falls back safely to default plan when unrecognized plan ID is queried", () => {
      const fallback = getPlan("UNKNOWN_PLAN_TIER");
      expect(fallback.id).toBe(DEFAULT_PLAN_ID);
    });

    it("marks retired legacy plans as inactive for new subscriptions", () => {
      expect(isPlanAvailableForNewSub("STARTER")).toBe(true);
      expect(isPlanAvailableForNewSub("GROWTH")).toBe(true);
      expect(isPlanAvailableForNewSub("LEGACY_BASIC")).toBe(false);

      const activeOnly = getAllPlans(true);
      const allPlans = getAllPlans(false);
      expect(activeOnly.some((p) => p.id === "LEGACY_BASIC")).toBe(false);
      expect(allPlans.some((p) => p.id === "LEGACY_BASIC")).toBe(false);
      expect(SUBSCRIPTION_PLANS.LEGACY_BASIC.isActive).toBe(false);
      expect(SUBSCRIPTION_PLANS.LEGACY_BASIC.limits.maxRooms).toBe(10);
    });
  });

  describe("2. Authoritative Subscription State Evaluation", () => {
    it("evaluates active trial with remaining days as TRIALING and operational", () => {
      const futureEnd = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000);
      const res = evaluateSubscriptionStatus({
        status: SubscriptionStatus.TRIALING,
        trialEndsAt: futureEnd,
      });

      expect(res.effectiveStatus).toBe("TRIALING");
      expect(res.isOperational).toBe(true);
      expect(res.isOverdue).toBe(false);
      expect(res.daysRemaining).toBeGreaterThan(0);
    });

    it("evaluates expired trial as TRIAL_EXPIRED, non-operational, and overdue", () => {
      const pastEnd = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
      const res = evaluateSubscriptionStatus({
        status: SubscriptionStatus.TRIALING,
        trialEndsAt: pastEnd,
      });

      expect(res.effectiveStatus).toBe("TRIAL_EXPIRED");
      expect(res.isOperational).toBe(false);
      expect(res.isOverdue).toBe(true);
      expect(res.daysRemaining).toBe(0);
    });

    it("evaluates paid active subscription within period as ACTIVE and operational", () => {
      const futureEnd = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000);
      const res = evaluateSubscriptionStatus({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEndsAt: futureEnd,
      });

      expect(res.effectiveStatus).toBe("ACTIVE");
      expect(res.isOperational).toBe(true);
      expect(res.isOverdue).toBe(false);
    });

    it("keeps an expired ACTIVE period operational only during the configured past-due grace period", () => {
      const pastPeriod = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000);
      const inGrace = evaluateSubscriptionStatus({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEndsAt: pastPeriod,
      });
      const afterGrace = evaluateSubscriptionStatus({
        status: SubscriptionStatus.ACTIVE,
        currentPeriodEndsAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      });

      expect(inGrace.effectiveStatus).toBe("PAST_DUE");
      expect(inGrace.isOperational).toBe(true);
      expect(inGrace.isOverdue).toBe(true);
      expect(afterGrace.effectiveStatus).toBe("PAST_DUE");
      expect(afterGrace.isOperational).toBe(false);
    });

    it("applies the same grace window to stored PAST_DUE status and fails closed when its due date is missing", () => {
      expect(evaluateSubscriptionStatus({
        status: SubscriptionStatus.PAST_DUE,
        currentPeriodEndsAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000),
      }).isOperational).toBe(true);
      expect(evaluateSubscriptionStatus({
        status: SubscriptionStatus.PAST_DUE,
        currentPeriodEndsAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      }).isOperational).toBe(false);
      expect(() => evaluateSubscriptionStatus({ status: SubscriptionStatus.PAST_DUE })).toThrow("Past-due subscription period end is missing.");
    });

    it("evaluates suspended status as SUSPENDED and strictly non-operational", () => {
      const res = evaluateSubscriptionStatus({
        status: SubscriptionStatus.SUSPENDED,
      });

      expect(res.effectiveStatus).toBe("SUSPENDED");
      expect(res.isOperational).toBe(false);
    });

    it("evaluates cancelled status as CANCELLED and strictly non-operational", () => {
      const res = evaluateSubscriptionStatus({ status: SubscriptionStatus.CANCELLED });
      expect(res.effectiveStatus).toBe("CANCELLED");
      expect(res.isOperational).toBe(false);
    });
  });

  describe("3. Module Entitlement Enforcement", () => {
    it("allows Starter plan hotel to access included modules (Reservations, Folios, Housekeeping)", async () => {
      const resReservations = await checkModuleEntitlement("hotel-a", "RESERVATIONS");
      const resFolios = await checkModuleEntitlement("hotel-a", "FOLIOS");
      const resHk = await checkModuleEntitlement("hotel-a", "HOUSEKEEPING");

      expect(resReservations.allowed).toBe(true);
      expect(resFolios.allowed).toBe(true);
      expect(resHk.allowed).toBe(true);
    });

    it("allows Starter plan hotel to access all core modules under room-band pricing", async () => {
      const resPos = await checkModuleEntitlement("hotel-a", "RESTAURANT_POS");
      const resMaint = await checkModuleEntitlement("hotel-a", "MAINTENANCE");

      expect(resPos.allowed).toBe(true);
      expect(resMaint.allowed).toBe(true);
    });

    it("allows Growth plan hotel to access all core modules under room-band pricing", async () => {
      const resPos = await checkModuleEntitlement("hotel-b", "RESTAURANT_POS");
      const resInv = await checkModuleEntitlement("hotel-b", "INVENTORY");
      const resMaint = await checkModuleEntitlement("hotel-b", "MAINTENANCE");

      expect(resPos.allowed).toBe(true);
      expect(resInv.allowed).toBe(true);
      expect(resMaint.allowed).toBe(true);
    });

    it("locks out operational modules when hotel trial has expired", async () => {
      const res = await checkModuleEntitlement("hotel-c", "RESERVATIONS");
      expect(res.allowed).toBe(false);
      expect(res.code).toBe("TRIAL_EXPIRED");
      expect(res.effectiveStatus).toBe("TRIAL_EXPIRED");
    });

    it("locks out operational modules when hotel subscription is suspended", async () => {
      const res = await checkModuleEntitlement("hotel-d", "RESERVATIONS");
      expect(res.allowed).toBe(false);
      expect(res.code).toBe("SUBSCRIPTION_SUSPENDED");
      expect(res.reason).toContain("Non-payment");
    });

    it("keeps subscription status and billing details readable after a trial expires", async () => {
      mockCurrentSession = { user: { id: "user-a-owner" } };
      mockActiveCookie = "hotel-a";
      db.hotels.set("hotel-a", { ...db.hotels.get("hotel-a"), status: HotelStatus.SUSPENDED });
      db.subscriptions.set("hotel-a", {
        ...db.subscriptions.get("hotel-a"),
        trialEndsAt: new Date(Date.now() - 1_000),
      });
      const { GET } = await import("@/app/api/hotel/subscription/route");

      const response = await GET();
      const json = await response.json();

      expect(response.status).toBe(200);
      expect(json.hotel.status).toBe(HotelStatus.SUSPENDED);
      expect(json.subscription.effectiveStatus).toBe("TRIAL_EXPIRED");
      expect(json.subscription.isOperational).toBe(false);
      expect(json.policy.pastDueGracePeriodDays).toBe(7);
    });

    it("restricts detailed hotel subscription data to owners and administrators", async () => {
      mockCurrentSession = { user: { id: "user-a-owner" } };
      mockActiveCookie = "hotel-a";
      db.memberships.set("mem-a-owner", {
        ...db.memberships.get("mem-a-owner"),
        role: HotelRole.RECEPTIONIST,
      });
      const { GET } = await import("@/app/api/hotel/subscription/route");

      const response = await GET();

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "You don't have permission to do that." });
    });

    it("retains every core module across all active room bands", () => {
      const coreModules = ["RESERVATIONS", "FOLIOS", "HOUSEKEEPING", "RESTAURANT_POS", "INVENTORY", "EXPENSES", "MAINTENANCE", "REPORTS"];
      for (const plan of getAllPlans(true)) {
        for (const module of coreModules) {
          expect(plan.modules, `${plan.id} includes ${module}`).toContain(module);
        }
      }
    });
  });

  describe("4. Usage Limit Enforcement & Cross-Tenant Isolation", () => {
    it("allows adding rooms while under the plan limit", async () => {
      // Hotel A has Starter plan (maxRooms: 15) and 0 rooms currently
      const check = await checkUsageLimit("hotel-a", "maxRooms", 1);
      expect(check.allowed).toBe(true);
      expect(check.currentCount).toBe(0);
      expect(check.maxLimit).toBe(15);
    });

    it("rejects adding rooms when the plan limit would be exceeded", async () => {
      // Populate 15 rooms for hotel-a
      for (let i = 1; i <= 15; i++) {
        db.rooms.set(`rm-${i}`, {
          id: `rm-${i}`,
          hotelId: "hotel-a",
          number: `10${i}`,
          isActive: true,
        });
      }

      const check = await checkUsageLimit("hotel-a", "maxRooms", 1);
      expect(check.allowed).toBe(false);
      expect(check.code).toBe("PLAN_LIMIT_EXCEEDED");
      expect(check.currentCount).toBe(15);
      expect(check.maxLimit).toBe(15);
      expect(check.reason).toContain("allows a maximum of 15 rooms");
    });

    it("checks quota and performs a room write in one advisory-locked transaction", async () => {
      const { prisma } = await import("@/lib/prisma");
      const order: string[] = [];
      const tx = {
        $queryRaw: async () => { order.push("lock"); return []; },
        room: { count: async () => { order.push("count"); return 14; } },
      };
      const transactionSpy = vi.spyOn(prisma as any, "$transaction").mockImplementation(
        ((callback: any) => Promise.resolve(callback(tx))) as any
      );
      const result = await withUsageLimitLock("hotel-a", "maxRooms", 1, async (sameTx) => {
        expect(sameTx).toBe(tx);
        order.push("write");
        return "room-created";
      });

      expect(result).toEqual({ allowed: true, value: "room-created" });
      expect(order).toEqual(["lock", "count", "write"]);
      transactionSpy.mockRestore();
    });

    it("fails closed when the quota lock cannot be acquired", async () => {
      const { prisma } = await import("@/lib/prisma");
      const transactionSpy = vi.spyOn(prisma as any, "$transaction").mockImplementation(
        ((callback: any) => Promise.resolve(callback({ $queryRaw: async () => { throw new Error("database unavailable"); } }))) as any
      );
      const operation = vi.fn(async () => "should-not-write");

      await expect(withUsageLimitLock("hotel-a", "maxRooms", 1, operation)).rejects.toMatchObject({
        code: "USAGE_LIMIT_UNAVAILABLE",
        statusCode: 503,
      });
      expect(operation).not.toHaveBeenCalled();
      transactionSpy.mockRestore();
    });

    it("enforces staff member usage limits for active memberships", async () => {
      // Hotel A has Starter plan (maxStaff: 5). Currently 1 owner.
      // Add 4 more staff members (total 5)
      for (let i = 1; i <= 4; i++) {
        db.memberships.set(`mem-a-${i}`, {
          id: `mem-a-${i}`,
          userId: `user-a-${i}`,
          hotelId: "hotel-a",
          role: HotelRole.RECEPTIONIST,
          status: MembershipStatus.ACTIVE,
        });
      }

      // Trying to add a 6th staff member
      const check = await checkUsageLimit("hotel-a", "maxStaff", 1);
      expect(check.allowed).toBe(false);
      expect(check.code).toBe("PLAN_LIMIT_EXCEEDED");
      expect(check.currentCount).toBe(5);
      expect(check.maxLimit).toBe(5);
    });

    it("ensures usage limits in Hotel A do not impact Hotel B (Cross-Tenant Isolation)", async () => {
      // Hotel A is at 15/15 rooms
      for (let i = 1; i <= 15; i++) {
        db.rooms.set(`rm-a-${i}`, {
          id: `rm-a-${i}`,
          hotelId: "hotel-a",
          number: `A-${i}`,
          isActive: true,
        });
      }

      // Hotel B has 0 rooms on Growth plan (maxRooms: 50)
      const checkB = await checkUsageLimit("hotel-b", "maxRooms", 1);
      expect(checkB.allowed).toBe(true);
      expect(checkB.currentCount).toBe(0);
      expect(checkB.maxLimit).toBe(50);
    });
  });

  describe("5. Platform Administration & Plan Adjustments", () => {
    it("allows platform super admin to upgrade a hotel plan and logs audit accountability", async () => {
      const { PATCH } = await import("@/app/api/platform/hotels/[id]/subscription/route");

      mockCurrentSession = {
        user: { id: "super-admin-user" },
      };

      const req = new Request("http://localhost/api/platform/hotels/hotel-a/subscription", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "CHANGE_PLAN",
          planId: "GROWTH",
          reason: "Customer requested upgrade to Growth tier for restaurant POS integration",
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: "hotel-a" }) });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.subscription.planId).toBe("GROWTH");
      expect(json.subscription.planName).toContain("Growth (Legacy 16");

      // Verify Audit Log was recorded
      expect(db.auditLogs.length).toBeGreaterThan(0);
      const lastLog = db.auditLogs[db.auditLogs.length - 1];
      expect(lastLog.action).toBe("PLATFORM_PLAN_CHANGED");
      expect(lastLog.entity).toBe("Subscription");
      expect(lastLog.metadata.previousPlan).toBe("STARTER");
      expect(lastLog.metadata.newPlan).toBe("GROWTH");
      expect(lastLog.metadata.reason).toContain("restaurant POS");
    });

    it("allows extending a trial with valid reason and updates trial expiration", async () => {
      const { PATCH } = await import("@/app/api/platform/hotels/[id]/subscription/route");

      mockCurrentSession = {
        user: { id: "billing-admin-user" },
      };

      const req = new Request("http://localhost/api/platform/hotels/hotel-a/subscription", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "EXTEND_TRIAL",
          extendDays: 14,
          reason: "Granted 14-day trial extension for comprehensive pilot onboarding",
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: "hotel-a" }) });
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.subscription.storedStatus).toBe(SubscriptionStatus.TRIALING);

      const lastLog = db.auditLogs[db.auditLogs.length - 1];
      expect(lastLog.action).toBe("PLATFORM_TRIAL_EXTENDED");
      expect(lastLog.metadata.daysExtended).toBe(14);
    });

    it("rejects administrative adjustments without a valid operational reason (< 5 chars)", async () => {
      const { PATCH } = await import("@/app/api/platform/hotels/[id]/subscription/route");

      mockCurrentSession = {
        user: { id: "super-admin-user" },
      };

      const req = new Request("http://localhost/api/platform/hotels/hotel-a/subscription", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "CHANGE_PLAN",
          planId: "GROWTH",
          reason: "ok", // Too short!
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: "hotel-a" }) });
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe("REASON_REQUIRED");
    });

    it("requires explicit confirmation when setting subscription to SUSPENDED or CANCELLED", async () => {
      const { PATCH } = await import("@/app/api/platform/hotels/[id]/subscription/route");

      mockCurrentSession = {
        user: { id: "super-admin-user" },
      };

      // Missing confirmed: true
      const req = new Request("http://localhost/api/platform/hotels/hotel-a/subscription", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "CHANGE_STATUS",
          newStatus: "SUSPENDED",
          reason: "Overdue unpaid billing invoice past 60 days",
          confirmed: false,
        }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: "hotel-a" }) });
      expect(res.status).toBe(400);

      const json = await res.json();
      expect(json.error).toBe("CONFIRMATION_REQUIRED");
    });

    it("rejects non-platform users (e.g. ordinary hotel owners) from accessing platform subscriptions API", async () => {
      const { GET } = await import("@/app/api/platform/subscriptions/route");

      mockCurrentSession = {
        user: { id: "user-a-owner" }, // No platformRole!
      };

      const req = new Request("http://localhost/api/platform/subscriptions");
      const res = await GET(req);

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("FORBIDDEN");
    });
  });

  describe("6. Platform Subscriptions Overview Aggregates", () => {
    it("calculates accurate summary metrics for subscriptions", async () => {
      const { GET } = await import("@/app/api/platform/subscriptions/route");

      mockCurrentSession = {
        user: { id: "super-admin-user" },
      };

      const req = new Request("http://localhost/api/platform/subscriptions");
      const res = await GET(req);

      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.summary.totalHotels).toBe(4);
      expect(json.summary.activeCount).toBe(1); // Hotel B
      expect(json.summary.trialingCount).toBe(1); // Hotel A
      expect(json.summary.suspendedCount).toBe(1); // Hotel D
      expect(json.summary.overdueCount).toBeGreaterThan(0); // Hotel C expired trial
      expect(json.subscriptions.length).toBe(4);
      expect(json.availablePlans.length).toBeGreaterThan(0);
      expect(json.summary.mrrByCurrency.KES).toBe(9500); // Hotel B is active paid
      expect(json.summary.mrrByCurrency.USD).toBe(0);
      expect(json.summary.pastDueAtRiskByCurrency).toBeDefined();
    });
  });

  describe("7. Server-Side Route Entitlement Enforcement for All Paid Modules", () => {
    it("allows Starter plan hotel to use POS charge-to-room", async () => {
      const { POST } = await import("@/app/api/restaurant/charge-to-room/route");

      mockCurrentSession = { user: { id: "user-a-owner" } };
      mockActiveCookie = "hotel-a";

      const req = new Request("http://localhost/api/restaurant/charge-to-room", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folioId: "fol-1", items: [{ menuItemId: "mi-1", quantity: 1, price: 100 }] }),
      });

      const res = await POST(req);
      expect(res.status).toBe(201);
      const json = await res.json();
    });

    it("allows Starter plan hotel to access open-folios", async () => {
      const { GET } = await import("@/app/api/restaurant/open-folios/route");

      mockCurrentSession = { user: { id: "user-a-owner" } };
      mockActiveCookie = "hotel-a";

      const res = await GET();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).not.toBe("MODULE_NOT_ENTITLED");
    });

    it("allows Starter plan hotel to access restaurant activity", async () => {
      const { GET } = await import("@/app/api/restaurant/activity/route");

      mockCurrentSession = { user: { id: "user-a-owner" } };
      mockActiveCookie = "hotel-a";

      const res = await GET();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).not.toBe("MODULE_NOT_ENTITLED");
    });

    it("allows Starter plan hotel to create menu items", async () => {
      const { POST } = await import("@/app/api/menu/route");

      mockCurrentSession = { user: { id: "user-a-owner" } };
      mockActiveCookie = "hotel-a";

      const req = new Request("http://localhost/api/menu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Burger", price: 500, categoryId: "cat-1" }),
      });

      const res = await POST(req);
      expect(res.status).toBe(201);
      const json = await res.json();
    });

    it("allows Starter plan hotel to access inventory", async () => {
      const { GET } = await import("@/app/api/inventory/route");

      mockCurrentSession = { user: { id: "user-a-owner" } };
      mockActiveCookie = "hotel-a";

      const req = new Request("http://localhost/api/inventory");
      const res = await GET(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).not.toBe("MODULE_NOT_ENTITLED");
    });

    it("allows Starter plan hotel to access expenses", async () => {
      const { GET } = await import("@/app/api/expenses/route");

      mockCurrentSession = { user: { id: "user-a-owner" } };
      mockActiveCookie = "hotel-a";

      const res = await GET();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).not.toBe("MODULE_NOT_ENTITLED");
    });

    it("allows Growth plan hotel to access maintenance", async () => {
      const { GET } = await import("@/app/api/maintenance/route");

      mockCurrentSession = { user: { id: "user-b-owner" } };
      mockActiveCookie = "hotel-b";

      const res = await GET();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.error).not.toBe("MODULE_NOT_ENTITLED");
    });

    it("locks out expired trial hotel (Hotel C) from creating reservations", async () => {
      const { POST } = await import("@/app/api/reservations/route");

      db.users.set("user-c-owner", {
        id: "user-c-owner",
        email: "c@sunset.com",
        isActive: true,
      });
      db.memberships.set("mem-c-owner", {
        id: "mem-c-owner",
        userId: "user-c-owner",
        hotelId: "hotel-c",
        role: HotelRole.HOTEL_OWNER,
        status: MembershipStatus.ACTIVE,
      });

      mockCurrentSession = { user: { id: "user-c-owner" } };
      mockActiveCookie = "hotel-c";

      const req = new Request("http://localhost/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestName: "John Doe",
          checkInDate: "2026-11-01",
          checkOutDate: "2026-11-05",
          roomId: "rm-1",
          tariffId: "tar-1",
          occupancy: "SINGLE",
          mealPlan: "BED_ONLY",
        }),
      });

      const res = await POST(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("TRIAL_EXPIRED");
    });

    it("locks out suspended hotel (Hotel D) from operational access", async () => {
      const { GET } = await import("@/app/api/housekeeping/route");

      db.users.set("user-d-owner", {
        id: "user-d-owner",
        email: "d@valley.com",
        isActive: true,
      });
      db.memberships.set("mem-d-owner", {
        id: "mem-d-owner",
        userId: "user-d-owner",
        hotelId: "hotel-d",
        role: HotelRole.HOTEL_OWNER,
        status: MembershipStatus.ACTIVE,
      });

      mockCurrentSession = { user: { id: "user-d-owner" } };
      mockActiveCookie = "hotel-d";

      const res = await GET();
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("SUBSCRIPTION_SUSPENDED");
    });
  });

  describe("8. Room and Staff Reactivation Quota Enforcement", () => {
    it("rejects reactivating an inactive room when already at plan room limit", async () => {
      const { PUT } = await import("@/app/api/rooms/[id]/route");

      mockCurrentSession = { user: { id: "user-a-owner" } };
      mockActiveCookie = "hotel-a";

      // Set up 15 active rooms (at limit) and 1 inactive room
      for (let i = 1; i <= 15; i++) {
        db.rooms.set(`rm-act-${i}`, {
          id: `rm-act-${i}`,
          hotelId: "hotel-a",
          number: `10${i}`,
          isActive: true,
          status: "AVAILABLE",
          roomTypeId: "rt-1",
        });
      }
      db.rooms.set("rm-inact", {
        id: "rm-inact",
        hotelId: "hotel-a",
        number: "999",
        isActive: false,
        status: "AVAILABLE",
        roomTypeId: "rt-1",
      });

      const req = new Request("http://localhost/api/rooms/rm-inact", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: true }),
      });

      const res = await PUT(req, { params: Promise.resolve({ id: "rm-inact" }) });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("PLAN_LIMIT_EXCEEDED");
      expect(json.message).toContain("maximum of 15 rooms");
    });

    it("rejects reactivating a suspended staff member when already at plan staff limit", async () => {
      const { PATCH } = await import("@/app/api/staff/[id]/route");

      mockCurrentSession = { user: { id: "user-a-owner" } };
      mockActiveCookie = "hotel-a";

      // 5 active staff members (at limit)
      for (let i = 1; i <= 4; i++) {
        db.memberships.set(`mem-staff-${i}`, {
          id: `mem-staff-${i}`,
          userId: `u-${i}`,
          hotelId: "hotel-a",
          role: HotelRole.RECEPTIONIST,
          status: MembershipStatus.ACTIVE,
        });
      }
      // 1 suspended member
      db.memberships.set("mem-suspended", {
        id: "mem-suspended",
        userId: "u-susp",
        hotelId: "hotel-a",
        role: HotelRole.WAITER,
        status: MembershipStatus.SUSPENDED,
      });

      const req = new Request("http://localhost/api/staff/mem-suspended", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: MembershipStatus.ACTIVE }),
      });

      const res = await PATCH(req, { params: Promise.resolve({ id: "mem-suspended" }) });
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("PLAN_LIMIT_EXCEEDED");
      expect(json.message).toContain("maximum of 5 active staff members");
    });
  });

  describe("9. Multi-Currency and Annual MRR / ARR Revenue Calculations", () => {
    it("normalizes annual subscriptions to monthly equivalents and strictly separates KES and USD", async () => {
      const { GET } = await import("@/app/api/platform/subscriptions/route");

      // Add Hotel E: Enterprise, Annual USD ($3,600 / yr = $300 / mo MRR)
      db.hotels.set("hotel-e", {
        id: "hotel-e",
        name: "Grand Enterprise Hotel",
        slug: "grand-enterprise",
        currency: "USD",
        status: HotelStatus.ACTIVE,
        createdAt: new Date(),
      });
      db.subscriptions.set("hotel-e", {
        id: "sub-e",
        hotelId: "hotel-e",
        planId: "ENTERPRISE",
        status: SubscriptionStatus.ACTIVE,
        trialStartsAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
        trialEndsAt: null,
        currentPeriodStartsAt: new Date(),
        currentPeriodEndsAt: new Date(Date.now() + 300 * 24 * 60 * 60 * 1000),
        billingInterval: BillingInterval.YEARLY,
        amount: 3600,
        currency: "USD",
      });

      mockCurrentSession = { user: { id: "super-admin-user" } };

      const req = new Request("http://localhost/api/platform/subscriptions");
      const res = await GET(req);
      expect(res.status).toBe(200);

      const json = await res.json();

      // KES MRR should still be exactly 9,500 (Hotel B)
      expect(json.summary.mrrByCurrency.KES).toBe(9500);
      // USD MRR should be normalized: 3600 / 12 = 300
      expect(json.summary.mrrByCurrency.USD).toBe(300);
      // USD ARR should be 3600
      expect(json.summary.arrByCurrency.USD).toBe(3600);
      // KES ARR should be 9500 * 12 = 114000
      expect(json.summary.arrByCurrency.KES).toBe(114000);

      // Verify trial, suspended, and expired accounts are strictly excluded from paying count
      expect(json.summary.payingCount).toBe(2); // Hotel B and Hotel E
    });
  });

  describe("10. Downgrade Quota Safety & Safe Subscription Idempotency", () => {
    it("does not delete existing rooms on downgrade, but prohibits adding new rooms over quota", async () => {
      // Hotel B has Growth plan (50 rooms). Create 20 rooms.
      for (let i = 1; i <= 20; i++) {
        db.rooms.set(`rm-b-${i}`, {
          id: `rm-b-${i}`,
          hotelId: "hotel-b",
          number: `20${i}`,
          isActive: true,
        });
      }

      // Platform admin downgrades Hotel B from Growth to Starter (limit: 15)
      const { PATCH } = await import("@/app/api/platform/hotels/[id]/subscription/route");
      mockCurrentSession = { user: { id: "super-admin-user" } };

      const patchReq = new Request("http://localhost/api/platform/hotels/hotel-b/subscription", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "CHANGE_PLAN",
          planId: "STARTER",
          reason: "Customer requested downgrade to Starter tier",
        }),
      });

      const patchRes = await PATCH(patchReq, { params: Promise.resolve({ id: "hotel-b" }) });
      expect(patchRes.status).toBe(200);

      // Verify all 20 existing rooms are completely untouched (zero destructive deletion)
      const roomCount = Array.from(db.rooms.values()).filter((r) => r.hotelId === "hotel-b").length;
      expect(roomCount).toBe(20);

      // Verify new room creation is immediately prohibited over the new quota
      const check = await checkUsageLimit("hotel-b", "maxRooms", 1);
      expect(check.allowed).toBe(false);
      expect(check.code).toBe("PLAN_LIMIT_EXCEEDED");
      expect(check.currentCount).toBe(20);
      expect(check.maxLimit).toBe(15);
    });

    it("guarantees idempotent subscription bootstrapping without duplicate records", async () => {
      db.hotels.set("hotel-new-bootstrap", {
        id: "hotel-new-bootstrap",
        name: "New Bootstrap Hotel",
        createdAt: new Date(),
      });

      const [sub1, sub2] = await Promise.all([
        getOrBootstrapSubscription("hotel-new-bootstrap"),
        getOrBootstrapSubscription("hotel-new-bootstrap"),
      ]);

      expect(sub1.id).toBe(sub2.id);
      expect(sub1.hotelId).toBe("hotel-new-bootstrap");
      expect(sub1.planId).toBe(DEFAULT_PLAN_ID);
      expect(db.subscriptions.size).toBe(5);
    });

    it("leaves an existing subscription record untouched during authorization reads", async () => {
      const { prisma } = await import("@/lib/prisma");
      const original = structuredClone(db.subscriptions.get("hotel-a"));
      const upsertSpy = vi.spyOn((prisma as any).subscription, "upsert");

      await getOrBootstrapSubscription("hotel-a");

      expect(db.subscriptions.get("hotel-a")).toEqual(original);
      expect(upsertSpy).not.toHaveBeenCalled();
      upsertSpy.mockRestore();
    });

    it("does not bootstrap a trial when the subscription lookup itself fails", async () => {
      const { prisma } = await import("@/lib/prisma");
      const findSpy = vi.spyOn((prisma as any).subscription, "findUnique").mockRejectedValueOnce(new Error("database unavailable"));
      const upsertSpy = vi.spyOn((prisma as any).subscription, "upsert");

      await expect(getOrBootstrapSubscription("hotel-a")).rejects.toMatchObject({
        code: "SUBSCRIPTION_STATUS_UNAVAILABLE",
        statusCode: 503,
      });
      expect(upsertSpy).not.toHaveBeenCalled();
      findSpy.mockRestore();
      upsertSpy.mockRestore();
    });

    it("does not silently turn malformed persisted state into an operational default", async () => {
      const { prisma } = await import("@/lib/prisma");
      const findSpy = vi.spyOn((prisma as any).subscription, "findUnique").mockResolvedValueOnce({
        ...db.subscriptions.get("hotel-a"),
        status: "UNRECOGNIZED",
      });

      await expect(getOrBootstrapSubscription("hotel-a")).rejects.toMatchObject({
        code: "SUBSCRIPTION_STATUS_UNAVAILABLE",
      });
      findSpy.mockRestore();
    });

    it("returns a consistent 503 from the shared operational authorization path when subscription lookup fails", async () => {
      const { prisma } = await import("@/lib/prisma");
      const findSpy = vi.spyOn((prisma as any).subscription, "findUnique").mockRejectedValueOnce(new Error("database unavailable"));
      const { requireModule } = await import("@/lib/authz");

      const response = await requireModule("hotel-a", "EXPENSES");

      expect(response?.status).toBe(503);
      expect(await response?.json()).toMatchObject({ error: "SUBSCRIPTION_STATUS_UNAVAILABLE" });
      findSpy.mockRestore();
    });
  });
});
