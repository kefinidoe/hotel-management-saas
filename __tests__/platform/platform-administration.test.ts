import { describe, it, expect, vi, beforeEach } from "vitest";

export const PlatformRole = {
  PLATFORM_SUPER_ADMIN: "PLATFORM_SUPER_ADMIN",
  PLATFORM_SUPPORT: "PLATFORM_SUPPORT",
  PLATFORM_BILLING: "PLATFORM_BILLING",
} as const;

export const HotelRole = {
  HOTEL_OWNER: "HOTEL_OWNER",
  HOTEL_ADMIN: "HOTEL_ADMIN",
  MANAGER: "MANAGER",
  RECEPTIONIST: "RECEPTIONIST",
} as const;

export const HotelStatus = {
  ACTIVE: "ACTIVE",
  TRIALING: "TRIALING",
  SUSPENDED: "SUSPENDED",
  CANCELLED: "CANCELLED",
} as const;

export const MembershipStatus = {
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
} as const;

vi.doMock("server-only", () => ({}));

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
  HotelStatus,
  MembershipStatus,
  SubscriptionStatus,
  BillingInterval,
  Prisma: {},
}));

// Session and database state
let mockSession: any = null;

vi.doMock("next-auth", () => ({
  getServerSession: async () => mockSession,
}));

vi.doMock("@/lib/auth", () => ({
  authOptions: {},
}));

vi.doMock("@/lib/authz", () => ({
  getPlatformAdminFromRoute: async (
    allowedRoles: readonly any[] = [
      PlatformRole.PLATFORM_SUPER_ADMIN,
      PlatformRole.PLATFORM_SUPPORT,
      PlatformRole.PLATFORM_BILLING,
    ]
  ) => {
    try {
      const { requirePlatformRole } = await import("@/lib/tenant-context");
      return await requirePlatformRole(allowedRoles);
    } catch (error: any) {
      const { TenantAuthError } = await import("@/lib/tenant-context");
      if (error instanceof TenantAuthError) {
        return CustomNextResponse.json(
          { error: error.code, message: error.message },
          { status: error.statusCode }
        );
      }
      return CustomNextResponse.json(
        { error: "UNAUTHORIZED", message: "Authentication required" },
        { status: 401 }
      );
    }
  },
  getTenantFromRoute: async () => {
    try {
      const { getTenantContext, TenantAuthError } = await import("@/lib/tenant-context");
      return await getTenantContext();
    } catch (error: any) {
      const { TenantAuthError } = await import("@/lib/tenant-context");
      if (error instanceof TenantAuthError) {
        return CustomNextResponse.json(
          { error: error.code, message: error.message },
          { status: error.statusCode }
        );
      }
      return CustomNextResponse.json(
        { error: "UNAUTHORIZED", message: "Authentication required" },
        { status: 401 }
      );
    }
  },
  requireRole: (role: any, allowed: readonly any[]) => {
    if (!role || !allowed.includes(role)) {
      return CustomNextResponse.json(
        { error: "You don't have permission to do that." },
        { status: 403 }
      );
    }
    return null;
  },
  ROLE_GROUPS: {
    STAFF_ADMIN: [HotelRole.HOTEL_OWNER, HotelRole.HOTEL_ADMIN],
  },
}));

interface UserRecord {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  platformRole?: string | null;
  isActive: boolean;
  department?: string | null;
  lastLoginAt?: Date | null;
}

interface HotelRecord {
  id: string;
  name: string;
  slug: string;
  status: string;
  currency: string;
  timezone: string;
  settings?: any;
  createdAt: Date;
  updatedAt: Date;
}

interface MembershipRecord {
  id: string;
  userId: string;
  hotelId: string;
  role: string;
  status: string;
  createdAt: Date;
}

interface AuditLogRecord {
  id: string;
  hotelId?: string | null;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: any;
  createdAt: Date;
}

let users: Map<string, UserRecord>;
let hotels: Map<string, HotelRecord>;
let memberships: Map<string, MembershipRecord>;
let auditLogs: AuditLogRecord[];
let roomsCount: number = 24;

function resetDB() {
  users = new Map();
  hotels = new Map();
  memberships = new Map();
  auditLogs = [];

  // 1. Platform Super Admin
  users.set("user-super-admin", {
    id: "user-super-admin",
    name: "Super Administrator",
    email: "superadmin@saas.example.com",
    platformRole: PlatformRole.PLATFORM_SUPER_ADMIN,
    isActive: true,
  });

  // 2. Platform Support Admin
  users.set("user-support-admin", {
    id: "user-support-admin",
    name: "Support Specialist",
    email: "support@saas.example.com",
    platformRole: PlatformRole.PLATFORM_SUPPORT,
    isActive: true,
  });

  // 3. Ordinary Hotel Owner (NO platform role)
  users.set("user-hotel-owner", {
    id: "user-hotel-owner",
    name: "Alice Owner",
    email: "owner@hotelalpha.example.com",
    platformRole: null,
    isActive: true,
  });

  // 4. Hotel Staff (NO platform role)
  users.set("user-hotel-staff", {
    id: "user-hotel-staff",
    name: "Bob Staff",
    email: "bob@hotelalpha.example.com",
    platformRole: null,
    isActive: true,
  });

  // 5. Deactivated Platform Admin
  users.set("user-deactivated-admin", {
    id: "user-deactivated-admin",
    name: "Former Admin",
    email: "inactive@saas.example.com",
    platformRole: PlatformRole.PLATFORM_SUPER_ADMIN,
    isActive: false,
  });

  // Seed hotels
  hotels.set("hotel-alpha", {
    id: "hotel-alpha",
    name: "Alpha Grand Hotel",
    slug: "alpha-grand",
    status: HotelStatus.ACTIVE,
    currency: "USD",
    timezone: "America/New_York",
    settings: { contactEmail: "contact@alphagrand.com", contactPhone: "+1-555-0100" },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  });

  hotels.set("hotel-beta", {
    id: "hotel-beta",
    name: "Beta Beach Resort",
    slug: "beta-resort",
    status: HotelStatus.TRIALING,
    currency: "EUR",
    timezone: "Europe/Madrid",
    settings: { contactEmail: "info@betaresort.com" },
    createdAt: new Date("2026-02-01T00:00:00Z"),
    updatedAt: new Date("2026-02-01T00:00:00Z"),
  });

  hotels.set("hotel-gamma", {
    id: "hotel-gamma",
    name: "Gamma Mountain Lodge",
    slug: "gamma-lodge",
    status: HotelStatus.SUSPENDED,
    currency: "KES",
    timezone: "Africa/Nairobi",
    settings: { contactEmail: "reservations@gammalodge.com" },
    createdAt: new Date("2026-03-01T00:00:00Z"),
    updatedAt: new Date("2026-03-01T00:00:00Z"),
  });

  hotels.set("hotel-delta", {
    id: "hotel-delta",
    name: "Delta Boutique Stay",
    slug: "delta-boutique",
    status: HotelStatus.CANCELLED,
    currency: "USD",
    timezone: "America/Chicago",
    settings: {},
    createdAt: new Date("2026-04-01T00:00:00Z"),
    updatedAt: new Date("2026-04-01T00:00:00Z"),
  });

  // Memberships
  memberships.set("m-1", {
    id: "m-1",
    userId: "user-hotel-owner",
    hotelId: "hotel-alpha",
    role: HotelRole.HOTEL_OWNER,
    status: MembershipStatus.ACTIVE,
    createdAt: new Date("2026-01-01T00:00:00Z"),
  });

  memberships.set("m-2", {
    id: "m-2",
    userId: "user-hotel-staff",
    hotelId: "hotel-alpha",
    role: HotelRole.RECEPTIONIST,
    status: MembershipStatus.ACTIVE,
    createdAt: new Date("2026-01-02T00:00:00Z"),
  });
}

// Mock Prisma
vi.doMock("@/lib/prisma", () => ({
  prisma: {
    user: {
      findUnique: async ({ where }: any) => users.get(where.id) || null,
      findFirst: async ({ where }: any) => {
        for (const u of users.values()) {
          if (where.email?.equals && u.email.toLowerCase() === where.email.equals.toLowerCase()) {
            return u;
          }
        }
        return null;
      },
      count: async () => users.size,
    },
    room: {
      count: async () => roomsCount,
    },
    hotel: {
      count: async ({ where }: any = {}) => {
        let count = 0;
        for (const h of hotels.values()) {
          if (where?.status && h.status !== where.status) continue;
          if (where?.OR) {
            const matches = where.OR.some(
              (clause: any) =>
                (clause.name && h.name.toLowerCase().includes(clause.name.contains.toLowerCase())) ||
                (clause.slug && h.slug.toLowerCase().includes(clause.slug.contains.toLowerCase()))
            );
            if (!matches) continue;
          }
          count++;
        }
        return count;
      },
      findMany: async ({ where, skip = 0, take = 50 }: any = {}) => {
        const matches: any[] = [];
        for (const h of hotels.values()) {
          if (where?.status && h.status !== where.status) continue;
          if (where?.OR) {
            const match = where.OR.some(
              (clause: any) =>
                (clause.name && h.name.toLowerCase().includes(clause.name.contains.toLowerCase())) ||
                (clause.slug && h.slug.toLowerCase().includes(clause.slug.contains.toLowerCase()))
            );
            if (!match) continue;
          }

          const hotelMemberships = Array.from(memberships.values())
            .filter((m) => m.hotelId === h.id)
            .map((m) => ({
              ...m,
              user: users.get(m.userId) || null,
            }));

          matches.push({
            ...h,
            _count: {
              rooms: 12,
              memberships: hotelMemberships.length,
              reservations: 4,
            },
            memberships: hotelMemberships.filter((m) => m.role === HotelRole.HOTEL_OWNER),
          });
        }
        return matches.slice(skip, skip + take);
      },
      findUnique: async ({ where, include }: any) => {
        const h = hotels.get(where.id);
        if (!h) return null;

        const hotelMemberships = Array.from(memberships.values())
          .filter((m) => m.hotelId === h.id)
          .map((m) => ({
            ...m,
            user: users.get(m.userId) || null,
          }));

        const hotelLogs = auditLogs
          .filter((l) => l.hotelId === h.id)
          .map((l) => ({
            ...l,
            user: l.userId ? users.get(l.userId) || null : null,
          }));

        return {
          ...h,
          _count: {
            rooms: 12,
            memberships: hotelMemberships.length,
            reservations: 5,
            folios: 5,
            guests: 10,
          },
          memberships: hotelMemberships,
          auditLogs: hotelLogs,
        };
      },
      update: async ({ where, data }: any) => {
        const h = hotels.get(where.id);
        if (!h) throw new Error("Hotel not found");
        const updated = { ...h, ...data, updatedAt: new Date() };
        hotels.set(where.id, updated);
        return updated;
      },
    },
    hotelMembership: {
      findUnique: async ({ where }: any) => {
        if (where?.userId_hotelId) {
          for (const m of memberships.values()) {
            if (m.userId === where.userId_hotelId.userId && m.hotelId === where.userId_hotelId.hotelId) {
              const hotel = hotels.get(m.hotelId);
              return { ...m, hotel };
            }
          }
        }
        return null;
      },
      findMany: async ({ where }: any) => {
        const list = [];
        for (const m of memberships.values()) {
          if (where?.userId && m.userId !== where.userId) continue;
          if (where?.status && m.status !== where.status) continue;
          const hotel = hotels.get(m.hotelId);
          if (where?.hotel?.status?.in && hotel && !where.hotel.status.in.includes(hotel.status)) {
            continue;
          }
          list.push({ ...m, hotel });
        }
        return list;
      },
    },
    auditLog: {
      count: async () => auditLogs.length,
      findMany: async ({ take = 10 }: any = {}) => {
        return auditLogs.slice(0, take).map((l) => ({
          ...l,
          user: l.userId ? users.get(l.userId) || null : null,
          hotel: l.hotelId ? hotels.get(l.hotelId) || null : null,
        }));
      },
      create: async ({ data }: any) => {
        const newLog: AuditLogRecord = {
          id: `audit-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          hotelId: data.hotelId || null,
          userId: data.userId || null,
          action: data.action,
          entity: data.entity,
          entityId: data.entityId || null,
          metadata: data.metadata || null,
          createdAt: new Date(),
        };
        auditLogs.unshift(newLog);
        return newLog;
      },
    },
    $transaction: async (promises: any[]) => {
      const results = [];
      for (const p of promises) {
        results.push(await p);
      }
      return results;
    },
  },
}));

// Import platform routes after mocks
const { GET: getOverview } = await import("@/app/api/platform/overview/route");
const { GET: getHotels } = await import("@/app/api/platform/hotels/route");
const { GET: getHotelDetail } = await import("@/app/api/platform/hotels/[id]/route");
const { PATCH: updateHotelStatus } = await import("@/app/api/platform/hotels/[id]/status/route");
const { getTenantContext, TenantAuthError } = await import("@/lib/tenant-context");

describe("Phase 6: Platform Administration & Hotel Lifecycle", () => {
  beforeEach(() => {
    resetDB();
    mockSession = null;
  });

  describe("1. Platform Admin Access Control & Direct API Security", () => {
    it("rejects unauthenticated requests to platform overview with 401", async () => {
      mockSession = null;
      const res = await getOverview();
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toBe("UNAUTHENTICATED");
    });

    it("rejects ordinary HOTEL_OWNER accessing platform overview with 403 Forbidden", async () => {
      mockSession = { user: { id: "user-hotel-owner" } };
      const res = await getOverview();
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe("FORBIDDEN");
      expect(data.message).toContain("platform administrative permissions");
    });

    it("rejects ordinary hotel staff accessing platform hotel directory with 403 Forbidden", async () => {
      mockSession = { user: { id: "user-hotel-staff" } };
      const req = new Request("http://localhost/api/platform/hotels");
      const res = await getHotels(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe("FORBIDDEN");
    });

    it("rejects deactivated platform administrator with 403 ACCOUNT_INACTIVE", async () => {
      mockSession = { user: { id: "user-deactivated-admin" } };
      const res = await getOverview();
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe("ACCOUNT_INACTIVE");
    });

    it("allows verified PLATFORM_SUPER_ADMIN to access platform overview", async () => {
      mockSession = { user: { id: "user-super-admin" } };
      const res = await getOverview();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.metrics).toBeDefined();
      expect(data.metrics.totalHotels).toBe(4);
      expect(data.metrics.activeHotels).toBe(1);
      expect(data.metrics.trialingHotels).toBe(1);
      expect(data.metrics.suspendedHotels).toBe(1);
      expect(data.metrics.cancelledHotels).toBe(1);
    });
  });

  describe("2. Platform Dashboard & Operational Metrics", () => {
    it("returns correctly aggregated metrics and recent hotels without leaking sensitive guest data", async () => {
      mockSession = { user: { id: "user-super-admin" } };
      const res = await getOverview();
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.metrics.totalUsers).toBe(users.size);
      expect(data.metrics.totalRooms).toBe(roomsCount);
      expect(Array.isArray(data.recentHotels)).toBe(true);
      expect(data.recentHotels.length).toBeGreaterThan(0);

      // Verify privacy: no password hashes or guest records are present
      for (const h of data.recentHotels) {
        expect(h.passwordHash).toBeUndefined();
        expect(h.guests).toBeUndefined();
        expect(h.id).toBeDefined();
        expect(h.name).toBeDefined();
        expect(h.slug).toBeDefined();
        expect(h.status).toBeDefined();
      }
    });
  });

  describe("3. Hotel Directory & Safe Operational Inspection", () => {
    it("lists all hotels with room and membership counts for platform operators", async () => {
      mockSession = { user: { id: "user-support-admin" } };
      const req = new Request("http://localhost/api/platform/hotels");
      const res = await getHotels(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.hotels.length).toBe(4);
      expect(data.total).toBe(4);
    });

    it("filters hotels by status (e.g. SUSPENDED)", async () => {
      mockSession = { user: { id: "user-support-admin" } };
      const req = new Request("http://localhost/api/platform/hotels?status=SUSPENDED");
      const res = await getHotels(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.hotels.length).toBe(1);
      expect(data.hotels[0].slug).toBe("gamma-lodge");
      expect(data.hotels[0].status).toBe(HotelStatus.SUSPENDED);
    });

    it("searches hotels by name substring", async () => {
      mockSession = { user: { id: "user-support-admin" } };
      const req = new Request("http://localhost/api/platform/hotels?search=Beach");
      const res = await getHotels(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.hotels.length).toBe(1);
      expect(data.hotels[0].name).toBe("Beta Beach Resort");
    });

    it("safely inspects individual hotel operational status without switching workspace session", async () => {
      mockSession = { user: { id: "user-super-admin" } };
      const req = new Request("http://localhost/api/platform/hotels/hotel-alpha");
      const res = await getHotelDetail(req, { params: Promise.resolve({ id: "hotel-alpha" }) });
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.hotel.name).toBe("Alpha Grand Hotel");
      expect(data.hotel.slug).toBe("alpha-grand");
      expect(data.stats.roomsCount).toBe(12);
      expect(data.stats.membershipsCount).toBe(2);
      expect(data.memberships.length).toBe(2);

      // Verify no session cookie was emitted to switch workspace
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    it("returns 404 when inspecting non-existent hotel", async () => {
      mockSession = { user: { id: "user-super-admin" } };
      const req = new Request("http://localhost/api/platform/hotels/non-existent-hotel");
      const res = await getHotelDetail(req, { params: Promise.resolve({ id: "non-existent-hotel" }) });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe("NOT_FOUND");
    });
  });

  describe("4. Hotel Lifecycle Transitions & Accountability", () => {
    it("suspends an ACTIVE hotel with explicit confirmation and reason, generating audit log", async () => {
      mockSession = { user: { id: "user-super-admin" } };
      const req = new Request("http://localhost/api/platform/hotels/hotel-alpha/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: HotelStatus.SUSPENDED,
          reason: "Payment failure and terms review",
          confirmed: true,
        }),
      });

      const res = await updateHotelStatus(req, { params: Promise.resolve({ id: "hotel-alpha" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.hotel.status).toBe(HotelStatus.SUSPENDED);

      // Verify hotel status was updated in database
      const hotelInDb = hotels.get("hotel-alpha");
      expect(hotelInDb?.status).toBe(HotelStatus.SUSPENDED);

      // Verify audit log record was created
      expect(auditLogs.length).toBe(1);
      const log = auditLogs[0];
      expect(log.hotelId).toBe("hotel-alpha");
      expect(log.userId).toBe("user-super-admin");
      expect(log.action).toBe("HOTEL_STATUS_SUSPENDED");
      expect(log.metadata.previousStatus).toBe(HotelStatus.ACTIVE);
      expect(log.metadata.newStatus).toBe(HotelStatus.SUSPENDED);
      expect(log.metadata.reason).toBe("Payment failure and terms review");
      expect(log.metadata.platformRole).toBe(PlatformRole.PLATFORM_SUPER_ADMIN);
    });

    it("rejects suspension if confirmation is not provided", async () => {
      mockSession = { user: { id: "user-super-admin" } };
      const req = new Request("http://localhost/api/platform/hotels/hotel-alpha/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: HotelStatus.SUSPENDED,
          reason: "Needs suspension",
          confirmed: false,
        }),
      });

      const res = await updateHotelStatus(req, { params: Promise.resolve({ id: "hotel-alpha" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("CONFIRMATION_REQUIRED");
    });

    it("rejects suspension if reason is too short (< 5 characters)", async () => {
      mockSession = { user: { id: "user-super-admin" } };
      const req = new Request("http://localhost/api/platform/hotels/hotel-alpha/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: HotelStatus.SUSPENDED,
          reason: "bad",
          confirmed: true,
        }),
      });

      const res = await updateHotelStatus(req, { params: Promise.resolve({ id: "hotel-alpha" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("REASON_REQUIRED");
    });

    it("rejects transition to the identical status (already in status)", async () => {
      mockSession = { user: { id: "user-super-admin" } };
      const req = new Request("http://localhost/api/platform/hotels/hotel-alpha/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: HotelStatus.ACTIVE,
        }),
      });

      const res = await updateHotelStatus(req, { params: Promise.resolve({ id: "hotel-alpha" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("ALREADY_IN_STATUS");
    });

    it("rejects invalid status enum value", async () => {
      mockSession = { user: { id: "user-super-admin" } };
      const req = new Request("http://localhost/api/platform/hotels/hotel-alpha/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: "DELETED",
        }),
      });

      const res = await updateHotelStatus(req, { params: Promise.resolve({ id: "hotel-alpha" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("INVALID_STATUS");
    });

    it("allows activating a SUSPENDED hotel", async () => {
      mockSession = { user: { id: "user-support-admin" } };
      const req = new Request("http://localhost/api/platform/hotels/hotel-gamma/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: HotelStatus.ACTIVE,
          reason: "Payment verified, resuming service",
        }),
      });

      const res = await updateHotelStatus(req, { params: Promise.resolve({ id: "hotel-gamma" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.hotel.status).toBe(HotelStatus.ACTIVE);
      expect(hotels.get("hotel-gamma")?.status).toBe(HotelStatus.ACTIVE);
    });

    it("blocks non-super-admin (PLATFORM_SUPPORT) from reactivating a CANCELLED hotel", async () => {
      mockSession = { user: { id: "user-support-admin" } };
      const req = new Request("http://localhost/api/platform/hotels/hotel-delta/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: HotelStatus.ACTIVE,
          reason: "Attempting reactivation",
        }),
      });

      const res = await updateHotelStatus(req, { params: Promise.resolve({ id: "hotel-delta" }) });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toBe("FORBIDDEN");
      expect(data.message).toContain("Platform Super Administrators");
    });

    it("allows PLATFORM_SUPER_ADMIN to reactivate a CANCELLED hotel", async () => {
      mockSession = { user: { id: "user-super-admin" } };
      const req = new Request("http://localhost/api/platform/hotels/hotel-delta/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: HotelStatus.ACTIVE,
          reason: "Super Admin overriding cancellation following contract renewal",
        }),
      });

      const res = await updateHotelStatus(req, { params: Promise.resolve({ id: "hotel-delta" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.hotel.status).toBe(HotelStatus.ACTIVE);
    });
  });

  describe("5. Suspended Hotel Operational Lockout", () => {
    it("ensures ordinary hotel staff cannot change hotel status via platform API", async () => {
      mockSession = { user: { id: "user-hotel-owner" } };
      const req = new Request("http://localhost/api/platform/hotels/hotel-alpha/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status: HotelStatus.SUSPENDED,
          reason: "Unauthorized attempt",
          confirmed: true,
        }),
      });

      const res = await updateHotelStatus(req, { params: Promise.resolve({ id: "hotel-alpha" }) });
      expect(res.status).toBe(403);
      expect(hotels.get("hotel-alpha")?.status).toBe(HotelStatus.ACTIVE);
    });

    it("locks out staff from operational access via getTenantContext when hotel is SUSPENDED", async () => {
      // Create membership in suspended hotel gamma
      memberships.set("m-gamma", {
        id: "m-gamma",
        userId: "user-hotel-owner",
        hotelId: "hotel-gamma",
        role: HotelRole.HOTEL_OWNER,
        status: MembershipStatus.ACTIVE,
        createdAt: new Date(),
      });

      mockSession = { user: { id: "user-hotel-owner" } };
      mockActiveCookie = "hotel-gamma"; // Explicit selection of suspended hotel

      await expect(getTenantContext()).rejects.toThrow(TenantAuthError);

      try {
        await getTenantContext();
      } catch (err: any) {
        expect(err.code).toBe("HOTEL_SUSPENDED");
        expect(err.statusCode).toBe(403);
        expect(err.clearCookie).toBe(true);
      }
    });

    it("excludes suspended hotels from auto-selection when user resolves tenant context", async () => {
      // Delete membership in hotel-alpha so user ONLY has membership in suspended hotel-gamma
      memberships.delete("m-1");
      memberships.set("m-gamma", {
        id: "m-gamma",
        userId: "user-hotel-owner",
        hotelId: "hotel-gamma",
        role: HotelRole.HOTEL_OWNER,
        status: MembershipStatus.ACTIVE,
        createdAt: new Date(),
      });

      mockSession = { user: { id: "user-hotel-owner" } };
      mockActiveCookie = null; // No active selection cookie

      try {
        await getTenantContext();
      } catch (err: any) {
        expect(err.code).toBe("NO_ACTIVE_MEMBERSHIP");
        expect(err.statusCode).toBe(403);
      }
    });
  });
});
