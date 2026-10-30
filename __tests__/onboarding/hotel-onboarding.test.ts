import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

export const HotelRole = {
  HOTEL_OWNER: "HOTEL_OWNER",
  HOTEL_ADMIN: "HOTEL_ADMIN",
  MANAGER: "MANAGER",
  RECEPTIONIST: "RECEPTIONIST",
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
} as const;

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
  cookies = {
    _map: new Map<string, any>(),
    set: (name: string, value: string, opts?: any) => {
      this.cookies._map.set(name, { name, value, ...opts });
      this.headers.append("set-cookie", `${name}=${value}`);
    },
    get: (name: string) => this.cookies._map.get(name),
    delete: (name: string) => {
      this.cookies._map.delete(name);
      this.headers.append("set-cookie", `${name}=; Max-Age=0`);
    },
  };

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

export const PlatformRole = {
  PLATFORM_SUPER_ADMIN: "PLATFORM_SUPER_ADMIN",
  PLATFORM_SUPPORT: "PLATFORM_SUPPORT",
  PLATFORM_BILLING: "PLATFORM_BILLING",
} as const;

export const SubscriptionStatus = {
  TRIALING: "TRIALING",
  ACTIVE: "ACTIVE",
  PAST_DUE: "PAST_DUE",
  SUSPENDED: "SUSPENDED",
  CANCELLED: "CANCELLED",
} as const;

export const BillingInterval = {
  MONTHLY: "MONTHLY",
  YEARLY: "YEARLY",
} as const;

vi.doMock("@prisma/client", () => ({
  PlatformRole,
  HotelRole,
  MembershipStatus,
  HotelStatus,
  SubscriptionStatus,
  BillingInterval,
  Prisma: {},
}));

let mockSession: any = null;
let forceRegistrationUniqueConflict = false;
let forceHotelSlugUniqueConflict = false;

vi.doMock("next-auth", () => ({
  getServerSession: async () => mockSession,
}));

vi.doMock("@/lib/auth", () => ({
  authOptions: {},
}));

// In-memory test store
interface DBState {
  users: Map<string, any>;
  hotels: Map<string, any>;
  memberships: Map<string, any>;
  paymentMethods: Map<string, any>;
}

let db: DBState;

function resetDB(): DBState {
  const users = new Map<string, any>();
  const hotels = new Map<string, any>();
  const memberships = new Map<string, any>();
  const paymentMethods = new Map<string, any>();

  // Seed initial user
  users.set("user-1", {
    id: "user-1",
    name: "Alice Owner",
    email: "alice@example.com",
    phone: "+254711111111",
    passwordHash: "hashed-pw",
    isActive: true,
  });

  return { users, hotels, memberships, paymentMethods };
}

vi.doMock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: any) => {
        if (where?.id) return db.users.get(where.id) || null;
        if (where?.email) {
          for (const u of db.users.values()) {
            if (u.email.toLowerCase() === where.email.toLowerCase()) return u;
          }
          return null;
        }
        return null;
      },
      findFirst: async ({ where }: any) => {
        if (where?.email?.equals) {
          const target = where.email.equals.toLowerCase();
          for (const u of db.users.values()) {
            if (u.email.toLowerCase() === target) return u;
          }
        }
        return null;
      },
      create: async ({ data }: any) => {
        if (forceRegistrationUniqueConflict) {
          forceRegistrationUniqueConflict = false;
          throw { code: "P2002", meta: { target: ["email"] } };
        }
        const id = data.id || `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const created = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
        db.users.set(id, created);
        return created;
      },
    },
    hotel: {
      findUnique: async ({ where }: any) => {
        if (where?.id) return db.hotels.get(where.id) || null;
        if (where?.slug) {
          for (const h of db.hotels.values()) {
            if (h.slug === where.slug) return h;
          }
          return null;
        }
        return null;
      },
      create: async ({ data }: any) => {
        const id = data.id || `hotel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const created = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
        db.hotels.set(id, created);
        return created;
      },
    },
    hotelMembership: {
      findUnique: async ({ where }: any) => {
        if (where?.userId_hotelId) {
          const { userId, hotelId } = where.userId_hotelId;
          for (const m of db.memberships.values()) {
            if (m.userId === userId && m.hotelId === hotelId) return m;
          }
          return null;
        }
        return null;
      },
      create: async ({ data }: any) => {
        const id = data.id || `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const created = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
        db.memberships.set(id, created);
        return created;
      },
    },
    paymentMethod: {
      create: async ({ data }: any) => {
        const id = data.id || `pm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const created = { id, ...data };
        db.paymentMethods.set(id, created);
        return created;
      },
    },
    $transaction: async (fn: any) => {
      // Execute transaction with in-memory db
      return await fn({
        hotel: {
          findUnique: async ({ where }: any) => {
            if (where?.slug) {
              for (const h of db.hotels.values()) {
                if (h.slug === where.slug) return h;
              }
              return null;
            }
            return null;
          },
          create: async ({ data }: any) => {
            if (forceHotelSlugUniqueConflict) {
              forceHotelSlugUniqueConflict = false;
              throw { code: "P2002", meta: { target: ["slug"] } };
            }
            const id = `hotel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const created = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
            db.hotels.set(id, created);
            return created;
          },
        },
        hotelMembership: {
          create: async ({ data }: any) => {
            const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const created = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
            db.memberships.set(id, created);
            return created;
          },
        },
        paymentMethod: {
          create: async ({ data }: any) => {
            const id = `pm-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const created = { id, ...data };
            db.paymentMethods.set(id, created);
            return created;
          },
        },
      });
    },
  },
}));

let registerRoute: any = null;
let onboardingRoute: any = null;

describe("Phase 5: User Registration & Hotel Onboarding", () => {
  afterEach(() => vi.unstubAllEnvs());

  beforeEach(async () => {
    vi.stubEnv("DATABASE_URL", "postgresql://mock:mock@localhost/mock");
    db = resetDB();
    forceRegistrationUniqueConflict = false;
    forceHotelSlugUniqueConflict = false;
    mockSession = { user: { id: "user-1", email: "alice@example.com" } };
    if (!registerRoute) {
      registerRoute = (await import("../../app/api/auth/register/route")).POST;
    }
    if (!onboardingRoute) {
      onboardingRoute = (await import("../../app/api/hotel/onboarding/route")).POST;
    }
  });

  describe("1. User Registration (POST /api/auth/register)", () => {
    it("successfully creates a new user with hashed password", async () => {
      const req = new Request("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bob Builder",
          email: "bob@example.com",
          phone: "+254722222222",
          password: "SecurePassword123!",
        }),
      });

      const res = await registerRoute(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.user.email).toBe("bob@example.com");
      expect(data.user.name).toBe("Bob Builder");

      const saved = Array.from(db.users.values()).find((u) => u.email === "bob@example.com");
      expect(saved).toBeDefined();
      expect(saved.passwordHash).not.toBe("SecurePassword123!");
      expect(saved.isActive).toBe(true);
    });

    it("rejects duplicate email with 409 Conflict", async () => {
      const req = new Request("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Alice Clone",
          email: "ALICE@EXAMPLE.COM", // case insensitive check
          password: "SecurePassword123!",
        }),
      });

      const res = await registerRoute(req);
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain("already exists");
    });

    it("maps a database uniqueness race to 409 Conflict", async () => {
      forceRegistrationUniqueConflict = true;
      const req = new Request("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bob Builder",
          email: "bob@example.com",
          password: "SecurePassword123!",
        }),
      });

      const res = await registerRoute(req);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toContain("already exists");
    });

    it("returns 503 without attempting persistence when no database is configured", async () => {
      vi.stubEnv("DATABASE_URL", "");
      const req = new Request("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Offline User", email: "offline@example.com", password: "SecurePassword123!" }),
      });

      const res = await registerRoute(req);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("DATABASE_UNAVAILABLE");
      expect(db.users.size).toBe(1);
    });

    it("rejects invalid input (short password, invalid email, missing name)", async () => {
      const reqShortPw = new Request("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Short Pw",
          email: "short@example.com",
          password: "short",
        }),
      });
      const res = await registerRoute(reqShortPw);
      expect(res.status).toBe(400);

      const reqBadEmail = new Request("http://localhost:3000/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bad Email",
          email: "not-an-email",
          password: "validPassword123",
        }),
      });
      const resBad = await registerRoute(reqBadEmail);
      expect(resBad.status).toBe(400);
    });
  });

  describe("2. Hotel Workspace Onboarding (POST /api/hotel/onboarding)", () => {
    it("atomically creates hotel workspace, HOTEL_OWNER membership, and bootstraps payment methods", async () => {
      const req = new Request("http://localhost:3000/api/hotel/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Lakeview Safari Lodge",
          slug: "lakeview-safari",
          currency: "KES",
          timezone: "Africa/Nairobi",
          email: "contact@lakeviewsafari.com",
          phone: "+254700000000",
          address: "Lake Naivasha, Kenya",
        }),
      });

      const res = await onboardingRoute(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.hotel.name).toBe("Lakeview Safari Lodge");
      expect(data.hotel.slug).toBe("lakeview-safari");
      expect(data.role).toBe("HOTEL_OWNER");

      // Verify cookies set active_hotel_id
      const cookieHeader = res.headers.get("set-cookie");
      expect(cookieHeader).toContain("active_hotel_id=");

      // Verify database state: Hotel exists
      const hotel = Array.from(db.hotels.values()).find((h) => h.slug === "lakeview-safari");
      expect(hotel).toBeDefined();
      expect(hotel.status).toBe("ACTIVE");

      // Verify membership exists linking user-1 as HOTEL_OWNER
      const membership = Array.from(db.memberships.values()).find(
        (m) => m.userId === "user-1" && m.hotelId === hotel.id
      );
      expect(membership).toBeDefined();
      expect(membership.role).toBe("HOTEL_OWNER");
      expect(membership.status).toBe("ACTIVE");

      // Verify standard payment methods bootstrapped
      const pms = Array.from(db.paymentMethods.values()).filter((pm) => pm.hotelId === hotel.id);
      expect(pms.length).toBe(4);
      const methodNames = pms.map((p) => p.name);
      expect(methodNames).toContain("Cash");
      expect(methodNames).toContain("Mobile Money / M-Pesa");
    });

    it("auto-generates slug from name if slug not provided", async () => {
      const req = new Request("http://localhost:3000/api/hotel/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Sunset Palm Beach Resort",
          currency: "USD",
        }),
      });

      const res = await onboardingRoute(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.hotel.slug).toBe("sunset-palm-beach-resort");
    });

    it("rejects duplicate slug with 409 Conflict", async () => {
      // First creation
      db.hotels.set("existing-hotel", {
        id: "existing-hotel",
        name: "Existing Hotel",
        slug: "unique-slug-1",
      });

      const req = new Request("http://localhost:3000/api/hotel/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Another Hotel",
          slug: "unique-slug-1",
        }),
      });

      const res = await onboardingRoute(req);
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toBe("SLUG_ALREADY_EXISTS");
    });

    it("maps a concurrent slug uniqueness conflict to 409 Conflict", async () => {
      forceHotelSlugUniqueConflict = true;
      const req = new Request("http://localhost:3000/api/hotel/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Concurrent Hotel", slug: "concurrent-hotel" }),
      });

      const res = await onboardingRoute(req);
      expect(res.status).toBe(409);
      expect((await res.json()).error).toBe("SLUG_ALREADY_EXISTS");
    });

    it("rejects invalid IANA timezone identifiers", async () => {
      const req = new Request("http://localhost:3000/api/hotel/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Bad Timezone Hotel", timezone: "Not/A-Timezone" }),
      });

      const res = await onboardingRoute(req);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBe("INVALID_TIMEZONE");
    });

    it("returns 503 without database access when offline", async () => {
      vi.stubEnv("DATABASE_URL", "");
      const req = new Request("http://localhost:3000/api/hotel/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Offline Hotel" }),
      });

      const res = await onboardingRoute(req);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("DATABASE_UNAVAILABLE");
      expect(db.hotels.size).toBe(0);
    });

    it("rejects unauthenticated requests with 401", async () => {
      mockSession = null;
      const req = new Request("http://localhost:3000/api/hotel/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "Unauth Hotel" }),
      });

      const res = await onboardingRoute(req);
      expect(res.status).toBe(401);
    });

    it("rejects unsupported currency with 400", async () => {
      const req = new Request("http://localhost:3000/api/hotel/onboarding", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bad Currency Hotel",
          currency: "INVALID_CURRENCY",
        }),
      });

      const res = await onboardingRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("INVALID_CURRENCY");
    });
  });
});
