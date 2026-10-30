import { afterEach, describe, it, expect, vi, beforeEach } from "vitest";

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
}));

import { HotelRole, HotelStatus, MembershipStatus, PlatformRole } from "@prisma/client";

// Hoisted mocks
const {
  mockGetServerSession,
  mockCookiesGet,
  mockPrismaUser,
  mockPrismaHotelMembership,
  mockDeleteMany,
  mockUpdateMany,
} = vi.hoisted(() => ({
  mockGetServerSession: vi.fn(),
  mockCookiesGet: vi.fn(),
  mockPrismaUser: { findUnique: vi.fn() },
  mockPrismaHotelMembership: { findUnique: vi.fn(), findMany: vi.fn() },
  mockDeleteMany: vi.fn().mockResolvedValue({ count: 5 }),
  mockUpdateMany: vi.fn().mockResolvedValue({ count: 2 }),
}));

vi.mock("next-auth", () => ({
  getServerSession: mockGetServerSession,
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: mockCookiesGet,
  })),
}));

vi.mock("next/server", () => {
  class MockNextResponse extends Response {
    cookies = {
      _store: new Map<string, any>(),
      get: (name: string) => this.cookies._store.get(name),
      set: (name: string, value: string, opts?: any) => {
        this.cookies._store.set(name, { name, value, ...opts });
      },
      delete: (name: string) => {
        this.cookies._store.delete(name);
      },
    };

    static json(data: any, init?: ResponseInit) {
      const res = new MockNextResponse(JSON.stringify(data), {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      });
      return res;
    }
  }

  return { NextResponse: MockNextResponse };
});

const mockPrismaTable = {
  deleteMany: mockDeleteMany,
  updateMany: mockUpdateMany,
};

vi.mock("@/lib/prisma", () => {
  const table = {
    deleteMany: mockDeleteMany,
    updateMany: mockUpdateMany,
  };
  return {
    prisma: {
      user: mockPrismaUser,
      hotelMembership: mockPrismaHotelMembership,
      payment: table,
      folioItem: table,
      orderItem: table,
      order: table,
      folio: table,
      reservationRoom: table,
      reservation: table,
      housekeepingTask: table,
      maintenanceTicket: table,
      stockMovement: table,
      purchase: table,
      wastage: table,
      expense: table,
      notification: table,
      auditLog: table,
      guest: table,
      room: table,
    },
  };
});

vi.mock("@/lib/auth", () => ({
  authOptions: {},
}));

import {
  getTenantContext,
  requireHotelRole,
  requirePlatformRole,
  TenantAuthError,
} from "../../lib/tenant-context";

describe("Phase 4: Multi-Tenant Context & Access Control", () => {
  const activeUser = {
    id: "user-123",
    isActive: true,
    platformRole: null,
  };

  const sampleHotel = {
    id: "hotel-alpha",
    name: "Hotel Alpha",
    slug: "hotel-alpha",
    currency: "USD",
    timezone: "UTC",
    status: HotelStatus.ACTIVE,
  };

  const activeMembership = {
    id: "mem-1",
    userId: "user-123",
    hotelId: "hotel-alpha",
    role: HotelRole.HOTEL_ADMIN,
    status: MembershipStatus.ACTIVE,
    hotel: sampleHotel,
  };

  beforeEach(() => {
    vi.stubEnv("DATABASE_URL", "postgresql://mock:mock@localhost/mock");
    vi.clearAllMocks();
  });

  afterEach(() => vi.unstubAllEnvs());

  describe("1. Active Hotel Resolution & Strict Validation", () => {
    it("resolves context when valid explicit active_hotel_id cookie is provided", async () => {
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce(activeUser);
      mockCookiesGet.mockReturnValueOnce({ value: "hotel-alpha" });
      mockPrismaHotelMembership.findUnique.mockResolvedValueOnce(activeMembership);

      const ctx = await getTenantContext();
      expect(ctx.userId).toBe("user-123");
      expect(ctx.hotelId).toBe("hotel-alpha");
      expect(ctx.role).toBe(HotelRole.HOTEL_ADMIN);
      expect(ctx.hotel.name).toBe("Hotel Alpha");
      expect(ctx.isPlatformAdmin).toBe(false);
    });

    it("fails closed and NEVER silently falls back when cookie contains an invalid/unauthorized hotel", async () => {
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce(activeUser);
      mockCookiesGet.mockReturnValueOnce({ value: "hotel-unauthorized" });
      mockPrismaHotelMembership.findUnique.mockResolvedValueOnce(null);

      await expect(getTenantContext()).rejects.toThrow(TenantAuthError);
      try {
        mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
        mockPrismaUser.findUnique.mockResolvedValueOnce(activeUser);
        mockCookiesGet.mockReturnValueOnce({ value: "hotel-unauthorized" });
        mockPrismaHotelMembership.findUnique.mockResolvedValueOnce(null);
        await getTenantContext();
      } catch (err: any) {
        expect(err.code).toBe("INVALID_HOTEL_SELECTION");
        expect(err.statusCode).toBe(403);
        expect(err.clearCookie).toBe(true);
      }
    });

    it("rejects access and flags clearCookie when membership is suspended", async () => {
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce(activeUser);
      mockCookiesGet.mockReturnValueOnce({ value: "hotel-alpha" });
      mockPrismaHotelMembership.findUnique.mockResolvedValueOnce({
        ...activeMembership,
        status: MembershipStatus.SUSPENDED,
      });

      try {
        await getTenantContext();
        expect.unreachable();
      } catch (err: any) {
        expect(err).toBeInstanceOf(TenantAuthError);
        expect(err.code).toBe("MEMBERSHIP_SUSPENDED");
        expect(err.statusCode).toBe(403);
        expect(err.clearCookie).toBe(true);
      }
    });

    it("rejects access and flags clearCookie when target hotel is suspended", async () => {
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce(activeUser);
      mockCookiesGet.mockReturnValueOnce({ value: "hotel-alpha" });
      mockPrismaHotelMembership.findUnique.mockResolvedValueOnce({
        ...activeMembership,
        hotel: { ...sampleHotel, status: HotelStatus.SUSPENDED },
      });

      try {
        await getTenantContext();
        expect.unreachable();
      } catch (err: any) {
        expect(err).toBeInstanceOf(TenantAuthError);
        expect(err.code).toBe("HOTEL_SUSPENDED");
        expect(err.statusCode).toBe(403);
        expect(err.clearCookie).toBe(true);
      }
    });
  });

  describe("2. Default Resolution (No Cookie)", () => {
    it("auto-selects when the user has exactly one active membership", async () => {
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce(activeUser);
      mockCookiesGet.mockReturnValueOnce(undefined);
      mockPrismaHotelMembership.findMany.mockResolvedValueOnce([activeMembership]);

      const ctx = await getTenantContext();
      expect(ctx.hotelId).toBe("hotel-alpha");
      expect(ctx.role).toBe(HotelRole.HOTEL_ADMIN);
    });

    it("fails closed with HOTEL_SELECTION_REQUIRED when user has multiple active memberships", async () => {
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce(activeUser);
      mockCookiesGet.mockReturnValueOnce(undefined);
      mockPrismaHotelMembership.findMany.mockResolvedValueOnce([
        activeMembership,
        {
          ...activeMembership,
          id: "mem-2",
          hotelId: "hotel-beta",
          hotel: { ...sampleHotel, id: "hotel-beta", name: "Hotel Beta" },
        },
      ]);

      try {
        await getTenantContext();
        expect.unreachable();
      } catch (err: any) {
        expect(err).toBeInstanceOf(TenantAuthError);
        expect(err.code).toBe("HOTEL_SELECTION_REQUIRED");
        expect(err.statusCode).toBe(403);
      }
    });

    it("throws NO_ACTIVE_MEMBERSHIP when user belongs to zero operational hotels", async () => {
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce(activeUser);
      mockCookiesGet.mockReturnValueOnce(undefined);
      mockPrismaHotelMembership.findMany.mockResolvedValueOnce([]);

      try {
        await getTenantContext();
        expect.unreachable();
      } catch (err: any) {
        expect(err).toBeInstanceOf(TenantAuthError);
        expect(err.code).toBe("NO_ACTIVE_MEMBERSHIP");
        expect(err.statusCode).toBe(403);
      }
    });
  });

  describe("3. Account Status & Authentication", () => {
    it("throws UNAUTHENTICATED when session is missing", async () => {
      mockGetServerSession.mockResolvedValueOnce(null);

      try {
        await getTenantContext();
        expect.unreachable();
      } catch (err: any) {
        expect(err).toBeInstanceOf(TenantAuthError);
        expect(err.code).toBe("UNAUTHENTICATED");
        expect(err.statusCode).toBe(401);
      }
    });

    it("throws ACCOUNT_INACTIVE and clears cookie when user is deactivated", async () => {
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce({ ...activeUser, isActive: false });

      try {
        await getTenantContext();
        expect.unreachable();
      } catch (err: any) {
        expect(err).toBeInstanceOf(TenantAuthError);
        expect(err.code).toBe("ACCOUNT_INACTIVE");
        expect(err.statusCode).toBe(403);
        expect(err.clearCookie).toBe(true);
      }
    });
  });

  describe("4. Operational vs Platform Role Separation", () => {
    it("requireHotelRole passes for authorized roles and rejects unauthorized roles", async () => {
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce(activeUser);
      mockCookiesGet.mockReturnValueOnce({ value: "hotel-alpha" });
      mockPrismaHotelMembership.findUnique.mockResolvedValueOnce({
        ...activeMembership,
        role: HotelRole.RECEPTIONIST,
      });

      // Authorized check
      const ctx = await requireHotelRole([HotelRole.RECEPTIONIST, HotelRole.MANAGER]);
      expect(ctx.role).toBe(HotelRole.RECEPTIONIST);

      // Unauthorized check
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce(activeUser);
      mockCookiesGet.mockReturnValueOnce({ value: "hotel-alpha" });
      mockPrismaHotelMembership.findUnique.mockResolvedValueOnce({
        ...activeMembership,
        role: HotelRole.WAITER,
      });

      await expect(requireHotelRole([HotelRole.HOTEL_ADMIN])).rejects.toThrow("Insufficient hotel operational permissions");
    });

    it("requirePlatformRole strictly requires platformRole and rejects standard hotel staff", async () => {
      // Standard hotel owner without platformRole
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce({
        ...activeUser,
        platformRole: null,
      });

      await expect(
        requirePlatformRole([PlatformRole.PLATFORM_SUPER_ADMIN])
      ).rejects.toThrow("Insufficient platform administrative permissions");

      // Platform super admin
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "admin-456" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce({
        id: "admin-456",
        isActive: true,
        platformRole: PlatformRole.PLATFORM_SUPER_ADMIN,
      });

      const plat = await requirePlatformRole([PlatformRole.PLATFORM_SUPER_ADMIN]);
      expect(plat.userId).toBe("admin-456");
      expect(plat.platformRole).toBe(PlatformRole.PLATFORM_SUPER_ADMIN);
    });
  });

  describe("5. Hotel Switching Endpoint (/api/auth/switch-hotel)", () => {
    it("rejects cross-origin requests or missing origin", async () => {
      const { POST } = await import("../../app/api/auth/switch-hotel/route");
      const req = new Request("http://localhost:3000/api/auth/switch-hotel", {
        method: "POST",
        headers: {
          origin: "https://malicious-site.com",
        },
        body: JSON.stringify({ hotelId: "hotel-alpha" }),
      });

      const res = await POST(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("CSRF_ORIGIN_INVALID");
    });

    it("rejects switching to a hotel where the user has no active membership", async () => {
      const { POST } = await import("../../app/api/auth/switch-hotel/route");
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaHotelMembership.findUnique.mockResolvedValueOnce(null);

      const req = new Request("http://localhost:3000/api/auth/switch-hotel", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ hotelId: "hotel-other" }),
      });

      const res = await POST(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("NO_ACTIVE_MEMBERSHIP");
    });

    it("returns a clear 503 and preserves membership state while offline", async () => {
      const { POST } = await import("../../app/api/auth/switch-hotel/route");
      vi.stubEnv("DATABASE_URL", "");
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });

      const req = new Request("http://localhost:3000/api/auth/switch-hotel", {
        method: "POST",
        headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ hotelId: "hotel-alpha" }),
      });

      const res = await POST(req);
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("DATABASE_UNAVAILABLE");
      expect(mockPrismaHotelMembership.findUnique).not.toHaveBeenCalled();
    });

    it("sets active_hotel_id cookie when switching to valid operational hotel", async () => {
      const { POST } = await import("../../app/api/auth/switch-hotel/route");
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaHotelMembership.findUnique.mockResolvedValueOnce(activeMembership);

      const req = new Request("http://localhost:3000/api/auth/switch-hotel", {
        method: "POST",
        headers: {
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({ hotelId: "hotel-alpha" }),
      });

      const res = await POST(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.activeHotel.id).toBe("hotel-alpha");
      const cookie = res.cookies.get("active_hotel_id");
      expect(cookie?.value).toBe("hotel-alpha");
    });
  });

  describe("6. Tenant-Isolated Clean Test Data Endpoint (/api/admin/clean-test-data)", () => {
    it("fails closed by default when ALLOW_TEST_DATA_CLEANUP is not set to true", async () => {
      const originalEnv = process.env.ALLOW_TEST_DATA_CLEANUP;
      delete process.env.ALLOW_TEST_DATA_CLEANUP;

      const { POST } = await import("../../app/api/admin/clean-test-data/route");
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce(activeUser);
      mockCookiesGet.mockReturnValueOnce({ value: "hotel-alpha" });
      mockPrismaHotelMembership.findUnique.mockResolvedValueOnce({
        ...activeMembership,
        role: HotelRole.HOTEL_ADMIN,
      });

      const res = await POST();
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("FORBIDDEN");
      expect(json.message).toContain("Test data cleanup is strictly disabled in SaaS environments");

      process.env.ALLOW_TEST_DATA_CLEANUP = originalEnv;
    });

    it("fails closed in production even if ALLOW_TEST_DATA_CLEANUP is true", async () => {
      const originalNodeEnv = process.env.NODE_ENV;
      const originalFlag = process.env.ALLOW_TEST_DATA_CLEANUP;
      (process.env as any).NODE_ENV = "production";
      process.env.ALLOW_TEST_DATA_CLEANUP = "true";

      const { POST } = await import("../../app/api/admin/clean-test-data/route");
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce(activeUser);
      mockCookiesGet.mockReturnValueOnce({ value: "hotel-alpha" });
      mockPrismaHotelMembership.findUnique.mockResolvedValueOnce({
        ...activeMembership,
        role: HotelRole.HOTEL_ADMIN,
      });

      const res = await POST();
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("FORBIDDEN");

      (process.env as any).NODE_ENV = originalNodeEnv;
      process.env.ALLOW_TEST_DATA_CLEANUP = originalFlag;
    });

    it("rejects unauthorized staff without hotel management role (e.g. WAITER) even when flag is enabled", async () => {
      const originalFlag = process.env.ALLOW_TEST_DATA_CLEANUP;
      const originalNodeEnv = process.env.NODE_ENV;
      (process.env as any).NODE_ENV = "test";
      process.env.ALLOW_TEST_DATA_CLEANUP = "true";

      const { POST } = await import("../../app/api/admin/clean-test-data/route");
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce(activeUser);
      mockCookiesGet.mockReturnValueOnce({ value: "hotel-alpha" });
      mockPrismaHotelMembership.findUnique.mockResolvedValueOnce({
        ...activeMembership,
        role: HotelRole.WAITER,
      });

      const res = await POST();
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe("FORBIDDEN");

      (process.env as any).NODE_ENV = originalNodeEnv;
      process.env.ALLOW_TEST_DATA_CLEANUP = originalFlag;
    });

    it("executes destructive cleanup strictly scoped to active hotelId when explicitly opted in and authorized", async () => {
      const originalFlag = process.env.ALLOW_TEST_DATA_CLEANUP;
      const originalNodeEnv = process.env.NODE_ENV;
      (process.env as any).NODE_ENV = "test";
      process.env.ALLOW_TEST_DATA_CLEANUP = "true";

      const { POST } = await import("../../app/api/admin/clean-test-data/route");
      mockGetServerSession.mockResolvedValueOnce({ user: { id: "user-123" } });
      mockPrismaUser.findUnique.mockResolvedValueOnce(activeUser);
      mockCookiesGet.mockReturnValueOnce({ value: "hotel-alpha" });
      mockPrismaHotelMembership.findUnique.mockResolvedValueOnce({
        ...activeMembership,
        role: HotelRole.HOTEL_ADMIN,
      });

      const res = await POST();
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.hotelId).toBe("hotel-alpha");

      // Verify that every single deletion operation was called WITH { where: { hotelId: 'hotel-alpha' } }
      expect(mockDeleteMany).toHaveBeenCalled();
      for (const call of mockDeleteMany.mock.calls) {
        const arg = call[0];
        const hasDirectHotelId = arg?.where?.hotelId === "hotel-alpha";
        const hasParentHotelId =
          arg?.where?.folio?.hotelId === "hotel-alpha" ||
          arg?.where?.order?.hotelId === "hotel-alpha" ||
          arg?.where?.reservation?.hotelId === "hotel-alpha";
        expect(hasDirectHotelId || hasParentHotelId).toBe(true);
      }

      // Verify room update was strictly scoped to hotel-alpha
      expect(mockUpdateMany).toHaveBeenCalledWith({
        where: { hotelId: "hotel-alpha" },
        data: {
          status: "AVAILABLE",
          notes: null,
        },
      });

      (process.env as any).NODE_ENV = originalNodeEnv;
      process.env.ALLOW_TEST_DATA_CLEANUP = originalFlag;
    });
  });
});
