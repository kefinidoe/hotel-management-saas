import { describe, it, expect, vi, beforeEach } from "vitest";

export const HotelRole = {
  HOTEL_OWNER: "HOTEL_OWNER",
  HOTEL_ADMIN: "HOTEL_ADMIN",
  MANAGER: "MANAGER",
  RECEPTIONIST: "RECEPTIONIST",
  CASHIER: "CASHIER",
  ACCOUNTANT: "ACCOUNTANT",
  WAITER: "WAITER",
  HOUSEKEEPER: "HOUSEKEEPER",
  TECHNICIAN: "TECHNICIAN",
} as const;

export const MembershipStatus = {
  ACTIVE: "ACTIVE",
  SUSPENDED: "SUSPENDED",
} as const;

export const PlatformRole = {
  PLATFORM_SUPER_ADMIN: "PLATFORM_SUPER_ADMIN",
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

export const HotelStatus = {
  ACTIVE: "ACTIVE",
  TRIALING: "TRIALING",
  SUSPENDED: "SUSPENDED",
  CANCELLED: "CANCELLED",
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
  HotelRole,
  MembershipStatus,
  PlatformRole,
  HotelStatus,
  SubscriptionStatus,
  BillingInterval,
  Prisma: {},
}));

let mockTenantContext: any = null;

vi.doMock("@/lib/authz", () => ({
  getTenantFromRoute: async () => {
    if (!mockTenantContext) {
      return CustomNextResponse.json({ error: "UNAUTHORIZED", message: "Authentication required" }, { status: 401 });
    }
    return mockTenantContext;
  },
  requireModule: async () => null,
  requireRole: (role: any, allowed: readonly string[]) => {
    if (!role || !allowed.includes(role)) {
      return CustomNextResponse.json({ error: "You don't have permission to do that." }, { status: 403 });
    }
    return null;
  },
  ROLE_GROUPS: {
    STAFF_VIEW: [HotelRole.HOTEL_OWNER, HotelRole.HOTEL_ADMIN, HotelRole.MANAGER],
    STAFF_ADMIN: [HotelRole.HOTEL_OWNER, HotelRole.HOTEL_ADMIN],
  },
  getPlatformAdminFromRoute: async () => {
    return CustomNextResponse.json({ error: "FORBIDDEN", message: "Insufficient permissions" }, { status: 403 });
  },
}));

interface DBState {
  users: Map<string, any>;
  memberships: Map<string, any>;
  reservations: any[];
  payments: any[];
  housekeeping: any[];
  maintenance: any[];
}

let db: DBState;
let subscriptionStorageAvailable = true;

function resetDB(): DBState {
  subscriptionStorageAvailable = true;
  const users = new Map<string, any>();
  const memberships = new Map<string, any>();

  // Hotel A: Owner & Receptionist
  users.set("user-a-owner", {
    id: "user-a-owner",
    name: "Alice Owner",
    email: "alice@hotela.com",
    department: "Executive",
    isActive: true,
  });
  memberships.set("mem-a-owner", {
    id: "mem-a-owner",
    userId: "user-a-owner",
    hotelId: "hotel-a",
    role: HotelRole.HOTEL_OWNER,
    department: "Executive",
    status: MembershipStatus.ACTIVE,
    createdAt: new Date(),
  });

  users.set("user-a-recep", {
    id: "user-a-recep",
    name: "Adam Reception",
    email: "adam@hotela.com",
    department: "Front Desk",
    isActive: true,
  });
  memberships.set("mem-a-recep", {
    id: "mem-a-recep",
    userId: "user-a-recep",
    hotelId: "hotel-a",
    role: HotelRole.RECEPTIONIST,
    department: "Front Desk",
    status: MembershipStatus.ACTIVE,
    createdAt: new Date(),
  });

  // Hotel B: Staff (Foreign Tenant)
  users.set("user-b-owner", {
    id: "user-b-owner",
    name: "Bob Owner",
    email: "bob@hotelb.com",
    department: "Executive",
    passwordHash: "hashed-bobs-original-password",
    isActive: true,
  });
  memberships.set("mem-b-owner", {
    id: "mem-b-owner",
    userId: "user-b-owner",
    hotelId: "hotel-b",
    role: HotelRole.HOTEL_OWNER,
    department: "Executive",
    status: MembershipStatus.ACTIVE,
    createdAt: new Date(),
  });

  return {
    users,
    memberships,
    reservations: [],
    payments: [],
    housekeeping: [],
    maintenance: [],
  };
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
        const id = data.id || `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const created = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
        db.users.set(id, created);
        return created;
      },
      update: async ({ where, data }: any) => {
        const existing = db.users.get(where.id);
        if (!existing) throw new Error("User not found");
        const updated = { ...existing, ...data };
        db.users.set(where.id, updated);
        return updated;
      },
    },
    subscription: {
      findUnique: async ({ where }: any) => {
        if (!subscriptionStorageAvailable) throw new Error("Simulated subscription storage outage");
        if (where.hotelId !== "hotel-a") return null;
        const trialStartsAt = new Date("2026-01-01T00:00:00.000Z");
        const trialEndsAt = new Date("2035-01-01T00:00:00.000Z");
        return {
          id: "subscription-hotel-a",
          hotelId: "hotel-a",
          planId: "BAND_1_10",
          status: SubscriptionStatus.TRIALING,
          trialStartsAt,
          trialEndsAt,
          currentPeriodStartsAt: trialStartsAt,
          currentPeriodEndsAt: trialEndsAt,
          cancelAtPeriodEnd: false,
          suspensionReason: null,
          billingInterval: BillingInterval.MONTHLY,
          amount: 3500,
          currency: "KES",
        };
      },
    },
    hotelMembership: {
      findMany: async ({ where }: any) => {
        const results: any[] = [];
        for (const m of db.memberships.values()) {
          if (where?.hotelId && m.hotelId !== where.hotelId) continue;
          if (where?.status && m.status !== where.status) continue;
          const user = db.users.get(m.userId);
          results.push({ ...m, user });
        }
        return results;
      },
      findUnique: async ({ where }: any) => {
        if (where?.id) return db.memberships.get(where.id) || null;
        if (where?.userId_hotelId) {
          const { userId, hotelId } = where.userId_hotelId;
          for (const m of db.memberships.values()) {
            if (m.userId === userId && m.hotelId === hotelId) return m;
          }
          return null;
        }
        return null;
      },
      findFirst: async ({ where }: any) => {
        for (const m of db.memberships.values()) {
          if (where?.hotelId && m.hotelId !== where.hotelId) continue;
          if (where?.OR) {
            const matches = where.OR.some((cond: any) => cond.id === m.id || cond.userId === m.userId);
            if (matches) {
              const user = db.users.get(m.userId);
              return { ...m, user };
            }
          }
        }
        return null;
      },
      create: async ({ data }: any) => {
        const id = data.id || `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const created = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
        db.memberships.set(id, created);
        const user = db.users.get(data.userId);
        return { ...created, user };
      },
      update: async ({ where, data }: any) => {
        const existing = db.memberships.get(where.id);
        if (!existing) throw new Error("Membership not found");
        const updated = { ...existing, ...data };
        db.memberships.set(where.id, updated);
        const user = db.users.get(updated.userId);
        return { ...updated, user };
      },
      delete: async ({ where }: any) => {
        const existing = db.memberships.get(where.id);
        db.memberships.delete(where.id);
        return existing;
      },
      count: async ({ where }: any) => {
        let count = 0;
        for (const m of db.memberships.values()) {
          if (where?.hotelId && m.hotelId !== where.hotelId) continue;
          if (where?.role && m.role !== where.role) continue;
          if (where?.status && m.status !== where.status) continue;
          if (where?.id?.not && m.id === where.id.not) continue;
          count++;
        }
        return count;
      },
    },
    reservation: {
      count: async ({ where }: any) => {
        return db.reservations.filter((r) => r.hotelId === where.hotelId && r.createdById === where.createdById).length;
      },
    },
    payment: {
      count: async ({ where }: any) => {
        return db.payments.filter((p) => p.hotelId === where.hotelId && p.cashierId === where.cashierId).length;
      },
    },
    housekeepingTask: {
      count: async ({ where }: any) => {
        return db.housekeeping.filter((h) => h.hotelId === where.hotelId && h.assigneeId === where.assigneeId).length;
      },
    },
    maintenanceTicket: {
      count: async ({ where }: any) => {
        return db.maintenance.filter((m) => m.hotelId === where.hotelId && m.assigneeId === where.assigneeId).length;
      },
    },
    $transaction: async (arg: any) => {
      if (Array.isArray(arg)) return await Promise.all(arg);

      const tx = {
        // The test double cannot exercise PostgreSQL advisory locks, but it does
        // execute the real quota check and its writes through this transaction client.
        $queryRaw: async () => [],
        user: {
          create: async ({ data }: any) => {
            const id = data.id || `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const created = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
            db.users.set(id, created);
            return created;
          },
          update: async ({ where, data }: any) => {
            const existing = db.users.get(where.id);
            if (!existing) throw new Error("User not found");
            const changes = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
            const updated = { ...existing, ...changes };
            db.users.set(where.id, updated);
            return updated;
          },
        },
        hotelMembership: {
          count: async ({ where }: any) => Array.from(db.memberships.values()).filter((membership) =>
            (!where?.hotelId || membership.hotelId === where.hotelId) &&
            (!where?.status || membership.status === where.status)
          ).length,
          create: async ({ data }: any) => {
            const id = data.id || `mem-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const created = { id, createdAt: new Date(), updatedAt: new Date(), ...data };
            db.memberships.set(id, created);
            return { ...created, user: db.users.get(created.userId) };
          },
          update: async ({ where, data }: any) => {
            const existing = db.memberships.get(where.id);
            if (!existing) throw new Error("Membership not found");
            const changes = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
            const updated = { ...existing, ...changes, updatedAt: new Date() };
            db.memberships.set(where.id, updated);
            return { ...updated, user: db.users.get(updated.userId) };
          },
        },
      };
      return await arg(tx);
    },
  },
}));

let getStaffRoute: any = null;
let postStaffRoute: any = null;
let patchStaffRoute: any = null;
let deleteStaffRoute: any = null;

describe("Phase 5: Multi-Tenant Staff Management", () => {
  beforeEach(async () => {
    db = resetDB();
    mockTenantContext = {
      hotelId: "hotel-a",
      userId: "user-a-owner",
      role: HotelRole.HOTEL_OWNER,
    };
    if (!getStaffRoute) {
      const staffMod = await import("../../app/api/staff/route");
      getStaffRoute = staffMod.GET;
      postStaffRoute = staffMod.POST;

      const staffIdMod = await import("../../app/api/staff/[id]/route");
      patchStaffRoute = staffIdMod.PATCH;
      deleteStaffRoute = staffIdMod.DELETE;
    }
  });

  describe("1. GET /api/staff (Tenant-Scoped Member Listing)", () => {
    it("lists staff members belonging ONLY to active hotel (Hotel A does not see Hotel B)", async () => {
      const res = await getStaffRoute();
      expect(res.status).toBe(200);
      const members = await res.json();
      expect(members.length).toBe(2);

      const names = members.map((m: any) => m.name);
      expect(names).toContain("Alice Owner");
      expect(names).toContain("Adam Reception");
      expect(names).not.toContain("Bob Owner"); // Hotel B member must NEVER leak!
    });
  });

  describe("2. POST /api/staff (Adding Staff & Role Privilege Checks)", () => {
    it("successfully creates and assigns a new staff member to active hotel", async () => {
      const req = new Request("http://localhost:3000/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Charlie Chef",
          email: "charlie@hotela.com",
          password: "StaffPassword123!",
          role: "WAITER",
          department: "Kitchen",
        }),
      });

      const res = await postStaffRoute(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.name).toBe("Charlie Chef");
      expect(data.role).toBe("WAITER");

      // Verify membership saved for hotel-a
      const membership = Array.from(db.memberships.values()).find(
        (m) => m.userId === data.userId && m.hotelId === "hotel-a"
      );
      expect(membership).toBeDefined();
      expect(membership.role).toBe("WAITER");
      expect(membership.department).toBe("Kitchen");
      expect(db.users.get(data.userId).department).toBeUndefined();
    });

    it("adds a shared existing account without changing global credentials or Hotel B membership", async () => {
      mockTenantContext.role = HotelRole.HOTEL_ADMIN;
      const userBefore = { ...db.users.get("user-b-owner") };
      const hotelBMembershipBefore = { ...db.memberships.get("mem-b-owner") };
      const req = new Request("http://localhost:3000/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Bob Owner",
          email: "bob@hotelb.com",
          password: "MaliciousResetPassword123!",
          role: "WAITER",
          department: "Kitchen",
        }),
      });

      const res = await postStaffRoute(req);
      expect(res.status).toBe(201);
      const data = await res.json();
      const hotelAMembership = db.memberships.get(data.id);
      expect(hotelAMembership).toMatchObject({
        userId: "user-b-owner",
        hotelId: "hotel-a",
        role: "WAITER",
        department: "Kitchen",
      });
      expect(db.users.get("user-b-owner")).toEqual(userBefore);
      expect(db.memberships.get("mem-b-owner")).toEqual(hotelBMembershipBefore);

      const passwordReset = new Request(`http://localhost:3000/api/staff/${data.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newPassword: "AnotherAdminChosenPassword123!" }),
      });
      const passwordResetRes = await patchStaffRoute(passwordReset, { params: Promise.resolve({ id: data.id }) });
      expect(passwordResetRes.status).toBe(403);
      expect(db.users.get("user-b-owner").passwordHash).toBe(userBefore.passwordHash);

      const membershipEdit = new Request(`http://localhost:3000/api/staff/${data.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "MANAGER", department: "Service" }),
      });
      const membershipEditRes = await patchStaffRoute(membershipEdit, { params: Promise.resolve({ id: data.id }) });
      expect(membershipEditRes.status).toBe(200);
      expect(db.memberships.get(data.id)).toMatchObject({ role: "MANAGER", department: "Service" });
      expect(db.users.get("user-b-owner")).toEqual(userBefore);
      expect(db.memberships.get("mem-b-owner")).toEqual(hotelBMembershipBefore);
    });

    it("fails closed when subscription storage is unavailable", async () => {
      subscriptionStorageAvailable = false;
      const initialUserCount = db.users.size;
      const initialMembershipCount = db.memberships.size;
      const req = new Request("http://localhost:3000/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Unverified Staff",
          email: "unverified@hotela.com",
          password: "StaffPassword123!",
          role: "WAITER",
        }),
      });

      const res = await postStaffRoute(req);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "SUBSCRIPTION_STATUS_UNAVAILABLE" });
      expect(db.users.size).toBe(initialUserCount);
      expect(db.memberships.size).toBe(initialMembershipCount);
    });

    it("prevents non-owners (e.g. HOTEL_ADMIN) from assigning HOTEL_OWNER role", async () => {
      mockTenantContext.role = HotelRole.HOTEL_ADMIN;
      const req = new Request("http://localhost:3000/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Fake Owner",
          email: "fakeowner@hotela.com",
          password: "StaffPassword123!",
          role: "HOTEL_OWNER",
        }),
      });

      const res = await postStaffRoute(req);
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.error).toContain("Only hotel owners can grant the HOTEL_OWNER role");
    });

    it("strictly prevents assigning platform administrative privileges", async () => {
      const req = new Request("http://localhost:3000/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Platform Hacker",
          email: "hacker@hotela.com",
          password: "StaffPassword123!",
          role: "PLATFORM_SUPER_ADMIN", // Illegal role in hotel staff context
        }),
      });

      const res = await postStaffRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("Invalid role");
    });

    it("rejects duplicate membership if user is already in this hotel with 409 Conflict", async () => {
      const req = new Request("http://localhost:3000/api/staff", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "Adam Reception Duplicate",
          email: "adam@hotela.com",
          password: "StaffPassword123!",
          role: "CASHIER",
        }),
      });

      const res = await postStaffRoute(req);
      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.error).toContain("already a member of this hotel workspace");
    });
  });

  describe("3. PATCH /api/staff/[id] (Role Updates & Lockout Guards)", () => {
    it("updates staff role within permitted hotel roles", async () => {
      const req = new Request("http://localhost:3000/api/staff/mem-a-recep", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "MANAGER" }),
      });

      const res = await patchStaffRoute(req, { params: Promise.resolve({ id: "mem-a-recep" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.role).toBe("MANAGER");

      const saved = db.memberships.get("mem-a-recep");
      expect(saved.role).toBe("MANAGER");
    });

    it("rejects roles outside the permitted hotel roles", async () => {
      const req = new Request("http://localhost:3000/api/staff/mem-a-recep", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "PLATFORM_ADMIN" }),
      });

      const res = await patchStaffRoute(req, { params: Promise.resolve({ id: "mem-a-recep" }) });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("Invalid role. Permitted hotel roles:");
      expect(db.memberships.get("mem-a-recep").role).toBe("RECEPTIONIST");
    });

    it("prevents self-demotion or self-deactivation", async () => {
      const req = new Request("http://localhost:3000/api/staff/mem-a-owner", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "WAITER" }),
      });

      const res = await patchStaffRoute(req, { params: Promise.resolve({ id: "mem-a-owner" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("cannot change your own role");
    });

    it("prevents cross-tenant tampering: cannot edit a staff member of another hotel", async () => {
      // Hotel A owner attempts to edit Hotel B's member
      const req = new Request("http://localhost:3000/api/staff/mem-b-owner", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: "HOUSEKEEPER" }),
      });

      const res = await patchStaffRoute(req, { params: Promise.resolve({ id: "mem-b-owner" }) });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toContain("Staff member not found in this hotel workspace");
    });
  });

  describe("4. DELETE /api/staff/[id] (Removal & Deactivation Safety)", () => {
    it("cannot delete your own staff account", async () => {
      const req = new Request("http://localhost:3000/api/staff/mem-a-owner", { method: "DELETE" });
      const res = await deleteStaffRoute(req, { params: Promise.resolve({ id: "mem-a-owner" }) });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain("cannot remove your own staff membership");
    });

    it("cleans up membership cleanly if member has no transaction history", async () => {
      const req = new Request("http://localhost:3000/api/staff/mem-a-recep", { method: "DELETE" });
      const res = await deleteStaffRoute(req, { params: Promise.resolve({ id: "mem-a-recep" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.mode).toBe("deleted");

      expect(db.memberships.has("mem-a-recep")).toBe(false);
    });

    it("suspends membership instead of deleting if member has historical hotel activity", async () => {
      // Add activity on record
      db.reservations.push({ hotelId: "hotel-a", createdById: "user-a-recep" });

      const req = new Request("http://localhost:3000/api/staff/mem-a-recep", { method: "DELETE" });
      const res = await deleteStaffRoute(req, { params: Promise.resolve({ id: "mem-a-recep" }) });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.mode).toBe("suspended");

      const mem = db.memberships.get("mem-a-recep");
      expect(mem.status).toBe("SUSPENDED");
    });
  });
});
