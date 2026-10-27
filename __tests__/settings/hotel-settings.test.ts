import { describe, it, expect, vi, beforeEach } from "vitest";

export const HotelRole = {
  HOTEL_OWNER: "HOTEL_OWNER",
  HOTEL_ADMIN: "HOTEL_ADMIN",
  MANAGER: "MANAGER",
  RECEPTIONIST: "RECEPTIONIST",
  CASHIER: "CASHIER",
} as const;

export const HotelStatus = {
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

let mockTenantContext: any = null;

vi.doMock("@/lib/authz", () => ({
  getTenantFromRoute: async () => {
    if (!mockTenantContext) {
      return CustomNextResponse.json({ error: "UNAUTHORIZED", message: "Authentication required" }, { status: 401 });
    }
    return mockTenantContext;
  },
  requireRole: (role: any, allowed: readonly string[]) => {
    if (!role || !allowed.includes(role)) {
      return CustomNextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });
    }
    return null;
  },
  ROLE_GROUPS: {
    STAFF_ADMIN: [HotelRole.HOTEL_OWNER, HotelRole.HOTEL_ADMIN],
  },
  getPlatformAdminFromRoute: async () => {
    return CustomNextResponse.json({ error: "FORBIDDEN", message: "Insufficient permissions" }, { status: 403 });
  },
}));

interface HotelRecord {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  currency: string;
  timezone: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

let hotels: Map<string, HotelRecord>;

function resetHotels() {
  hotels = new Map<string, HotelRecord>();
  hotels.set("hotel-alpha", {
    id: "hotel-alpha",
    name: "Alpha Resort",
    slug: "alpha-resort",
    email: "alpha@example.com",
    phone: "+254700000001",
    address: "100 Alpha St",
    currency: "USD",
    timezone: "UTC",
    status: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  hotels.set("hotel-beta", {
    id: "hotel-beta",
    name: "Beta Boutique",
    slug: "beta-boutique",
    email: "beta@example.com",
    phone: "+254700000002",
    address: "200 Beta Ave",
    currency: "EUR",
    timezone: "Europe/Paris",
    status: "ACTIVE",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

vi.doMock("@/lib/prisma", () => ({
  prisma: {
    hotel: {
      findUnique: async ({ where }: any) => {
        return hotels.get(where.id) || null;
      },
      update: async ({ where, data }: any) => {
        const existing = hotels.get(where.id);
        if (!existing) throw new Error("Hotel not found");
        const updated = { ...existing, ...data, updatedAt: new Date() };
        hotels.set(where.id, updated);
        return updated;
      },
    },
  },
}));

let getSettingsRoute: any = null;
let patchSettingsRoute: any = null;

describe("Phase 5: Hotel Settings & Tenant Security", () => {
  beforeEach(async () => {
    resetHotels();
    mockTenantContext = {
      hotelId: "hotel-alpha",
      userId: "user-alpha-owner",
      role: HotelRole.HOTEL_OWNER,
    };
    if (!getSettingsRoute) {
      const mod = await import("../../app/api/hotel/settings/route");
      getSettingsRoute = mod.GET;
      patchSettingsRoute = mod.PATCH;
    }
  });

  describe("1. GET /api/hotel/settings", () => {
    it("returns active hotel settings for authorized owner", async () => {
      const res = await getSettingsRoute();
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.hotel.id).toBe("hotel-alpha");
      expect(data.hotel.name).toBe("Alpha Resort");
      expect(data.hotel.currency).toBe("USD");
      expect(data.hotel.timezone).toBe("UTC");
    });

    it("rejects unauthorized staff roles (e.g. RECEPTIONIST) with 403 Forbidden", async () => {
      mockTenantContext.role = HotelRole.RECEPTIONIST;
      const res = await getSettingsRoute();
      expect(res.status).toBe(403);
    });

    it("rejects unauthenticated requests with 401", async () => {
      mockTenantContext = null;
      const res = await getSettingsRoute();
      expect(res.status).toBe(401);
    });
  });

  describe("2. PATCH /api/hotel/settings (Tenant Isolation & Authorization)", () => {
    it("updates hotel identity, contact, currency, and timezone for active hotel", async () => {
      const req = new Request("http://localhost:3000/api/hotel/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Alpha Grand Resort & Spa",
          email: "management@alphagrand.com",
          currency: "KES",
          timezone: "Africa/Nairobi",
          address: "101 Grand Boulevard, Nakuru",
        }),
      });

      const res = await patchSettingsRoute(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.hotel.name).toBe("Alpha Grand Resort & Spa");
      expect(data.hotel.currency).toBe("KES");
      expect(data.hotel.timezone).toBe("Africa/Nairobi");

      const saved = hotels.get("hotel-alpha")!;
      expect(saved.name).toBe("Alpha Grand Resort & Spa");
      expect(saved.currency).toBe("KES");
    });

    it("strictly prevents cross-tenant modification: client cannot supply another hotelId to edit it", async () => {
      // Attacker tries to inject hotel-beta ID into body
      const req = new Request("http://localhost:3000/api/hotel/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hotelId: "hotel-beta", // Malicious parameter
          name: "Hacked Beta Hotel",
        }),
      });

      const res = await patchSettingsRoute(req);
      expect(res.status).toBe(200);

      // Hotel Beta must remain completely unchanged!
      const beta = hotels.get("hotel-beta")!;
      expect(beta.name).toBe("Beta Boutique");

      // The authenticated tenant (hotel-alpha) was the only one targeted
      const alpha = hotels.get("hotel-alpha")!;
      expect(alpha.name).toBe("Hacked Beta Hotel");
    });

    it("rejects invalid input (unsupported currency, invalid email, empty name)", async () => {
      const badCurrencyReq = new Request("http://localhost:3000/api/hotel/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currency: "BITCOIN" }),
      });
      const res1 = await patchSettingsRoute(badCurrencyReq);
      expect(res1.status).toBe(400);

      const badEmailReq = new Request("http://localhost:3000/api/hotel/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "invalid-email" }),
      });
      const res2 = await patchSettingsRoute(badEmailReq);
      expect(res2.status).toBe(400);

      const shortNameReq = new Request("http://localhost:3000/api/hotel/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "A" }),
      });
      const res3 = await patchSettingsRoute(shortNameReq);
      expect(res3.status).toBe(400);
    });

    it("allows HOTEL_ADMIN to update settings but blocks non-admins", async () => {
      mockTenantContext.role = HotelRole.HOTEL_ADMIN;
      const adminReq = new Request("http://localhost:3000/api/hotel/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "+254799999999" }),
      });
      const resAdmin = await patchSettingsRoute(adminReq);
      expect(resAdmin.status).toBe(200);

      // Cashier cannot update
      mockTenantContext.role = HotelRole.CASHIER;
      const cashierReq = new Request("http://localhost:3000/api/hotel/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: "+254700000000" }),
      });
      const resCashier = await patchSettingsRoute(cashierReq);
      expect(resCashier.status).toBe(403);
    });
  });
});
