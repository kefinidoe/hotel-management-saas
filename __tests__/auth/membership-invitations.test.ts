import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Invitation consent for existing accounts.
 *
 * An administrator may add an existing global account to their hotel, but the
 * account holder — not the administrator — decides whether that becomes access.
 * These tests pin the whole lifecycle: invitation creates no access, only the
 * invitee can accept, acceptance enforces the plan's staff limit, and declining
 * leaves nothing behind.
 */

class CustomNextResponse extends Response {
  static json(data: any, init?: ResponseInit) {
    return new CustomNextResponse(JSON.stringify(data), {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
  }
}

vi.doMock("server-only", () => ({}));
vi.doMock("next/server", () => ({ NextResponse: CustomNextResponse }));
// This is a mocked invitation-lifecycle suite, not a limiter-store test.
const mockLimitAuthRequest = vi.fn();
vi.doMock("@/lib/auth-rate-limit", () => ({ limitAuthRequest: mockLimitAuthRequest }));

let currentUserId: string | null = null;
vi.doMock("next-auth", () => ({
  getServerSession: async () =>
    currentUserId ? { user: { id: currentUserId, email: "someone@example.test" } } : null,
}));
vi.doMock("@/lib/auth", () => ({ authOptions: {} }));

let mockTenant: any = null;
vi.doMock("@/lib/authz", () => ({
  getTenantFromRoute: async () => mockTenant ?? CustomNextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 }),
  requireRole: (role: string, allowed: readonly string[]) =>
    allowed.includes(role) ? null : CustomNextResponse.json({ error: "FORBIDDEN" }, { status: 403 }),
  requireModule: async () => null,
  ROLE_GROUPS: { STAFF_ADMIN: ["HOTEL_OWNER", "HOTEL_ADMIN"], STAFF_VIEW: ["HOTEL_OWNER", "HOTEL_ADMIN"] },
}));

// ---------------------------------------------------------------------------
// Fake Prisma covering only what these routes touch.
// ---------------------------------------------------------------------------
interface UserRow { id: string; name: string; email: string; passwordHash: string; isActive: boolean }
interface MembershipRow {
  id: string;
  userId: string;
  hotelId: string;
  role: string;
  department: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}
interface AuditRow { id: string; hotelId: string; userId: string | null; action: string; entity: string; entityId: string; metadata: any; createdAt: Date }

let users: Map<string, UserRow>;
let memberships: Map<string, MembershipRow>;
let hotels: Map<string, { id: string; name: string; slug: string; status: string }>;
let audit: AuditRow[];
let subscriptions: Map<string, any>;
let seq: number;

function reset() {
  users = new Map([
    ["user-invitee", { id: "user-invitee", name: "Invitee", email: "invitee@other.test", passwordHash: "hashed-original", isActive: true }],
    ["user-owner", { id: "user-owner", name: "Owner", email: "owner@hotel-a.test", passwordHash: "hashed-owner", isActive: true }],
  ]);
  hotels = new Map([
    ["hotel-a", { id: "hotel-a", name: "Alpha", slug: "alpha", status: "ACTIVE" }],
    ["hotel-b", { id: "hotel-b", name: "Beta", slug: "beta", status: "ACTIVE" }],
  ]);
  memberships = new Map([
    ["mem-owner-a", { id: "mem-owner-a", userId: "user-owner", hotelId: "hotel-a", role: "HOTEL_OWNER", department: null, status: "ACTIVE", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-01") }],
    ["mem-invitee-b", { id: "mem-invitee-b", userId: "user-invitee", hotelId: "hotel-b", role: "WAITER", department: null, status: "ACTIVE", createdAt: new Date("2026-01-02"), updatedAt: new Date("2026-01-02") }],
  ]);
  audit = [];
  subscriptions = new Map([
    ["hotel-a", { id: "sub-a", hotelId: "hotel-a", planId: "BAND_1_10", status: "ACTIVE", billingInterval: "MONTHLY", currency: "KES", amount: 3000, trialStartsAt: new Date(), trialEndsAt: new Date(Date.now() + 86_400_000), currentPeriodStartsAt: new Date(), currentPeriodEndsAt: new Date(Date.now() + 30 * 86_400_000) }],
  ]);
  seq = 100;
}

function withHotel(m: MembershipRow) {
  return { ...m, hotel: hotels.get(m.hotelId)!, user: users.get(m.userId)! };
}

let prismaMock: any;

function buildPrisma() {
  const client: any = {
    user: {
      findFirst: async ({ where }: any) => {
        const wanted = where.email?.equals?.toLowerCase?.() ?? where.email;
        return [...users.values()].find((u) => u.email.toLowerCase() === String(wanted).toLowerCase()) ?? null;
      },
      findUnique: async ({ where }: any) => users.get(where.id) ?? null,
    },
    hotelMembership: {
      findUnique: async ({ where }: any) => {
        if (where.id) {
          const row = memberships.get(where.id);
          return row ? withHotel(row) : null;
        }
        if (where.userId_hotelId) {
          const row = [...memberships.values()].find(
            (m) => m.userId === where.userId_hotelId.userId && m.hotelId === where.userId_hotelId.hotelId
          );
          return row ? withHotel(row) : null;
        }
        return null;
      },
      findFirst: async ({ where }: any) => {
        const row = [...memberships.values()].find(
          (m) => (where.OR ? (where.OR.some((clause: any) => clause.id === m.id || clause.userId === m.userId)) : m.id === where.id) && (!where.hotelId || m.hotelId === where.hotelId) && (where.userId === undefined || m.userId === where.userId)
        );
        return row ? withHotel(row) : null;
      },
      findMany: async ({ where }: any = {}) =>
        [...memberships.values()]
          .filter((m) => (where?.userId ? m.userId === where.userId : true))
          .filter((m) => (where?.status ? m.status === where.status : true))
          .map((m) => ({ ...m, hotel: hotels.get(m.hotelId)! })),
      create: async ({ data }: any) => {
        const id = `mem-${++seq}`;
        const row: MembershipRow = {
          id,
          userId: data.userId,
          hotelId: data.hotelId,
          role: data.role,
          department: data.department ?? null,
          status: data.status ?? "ACTIVE",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        memberships.set(id, row);
        return withHotel(row);
      },
      update: async ({ where, data }: any) => {
        const row = memberships.get(where.id)!;
        Object.assign(row, data, { updatedAt: new Date() });
        return withHotel(row);
      },
      findUniqueOrThrow: async ({ where }: any) => withHotel(memberships.get(where.id)!),
      updateMany: async ({ where, data }: any) => {
        const row = memberships.get(where.id);
        if (!row || row.userId !== where.userId || row.hotelId !== where.hotelId || row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      },
      deleteMany: async ({ where }: any) => {
        const row = memberships.get(where.id);
        if (!row || row.userId !== where.userId || row.hotelId !== where.hotelId || row.status !== where.status) return { count: 0 };
        memberships.delete(where.id);
        return { count: 1 };
      },
      delete: async ({ where }: any) => {
        const row = memberships.get(where.id)!;
        memberships.delete(where.id);
        return { ...row };
      },
      count: async ({ where }: any) =>
        [...memberships.values()].filter(
          (m) => m.hotelId === where.hotelId && (!where.status || m.status === where.status)
        ).length,
    },
    subscription: {
      findUnique: async ({ where }: any) => subscriptions.get(where.hotelId) ?? null,
      upsert: async ({ where, create }: any) => {
        if (!subscriptions.has(where.hotelId)) subscriptions.set(where.hotelId, { id: "sub-new", ...create });
        return subscriptions.get(where.hotelId);
      },
      update: async ({ where, data }: any) => {
        Object.assign(subscriptions.get(where.hotelId)!, data);
        return subscriptions.get(where.hotelId);
      },
    },
    auditLog: {
      findMany: async ({ where }: any) =>
        audit
          .filter((row) => row.entity === where.entity)
          .filter((row) => (where.entityId?.in ? where.entityId.in.includes(row.entityId) : true))
          .filter((row) => (where.action?.in ? where.action.in.includes(row.action) : true))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
      create: async ({ data }: any) => {
        const row = { id: `audit-${++seq}`, createdAt: new Date(), ...data } as AuditRow;
        audit.push(row);
        return row;
      },
    },
    room: { count: async () => 4 },
    $transaction: async (fn: any) => {
      const savedMemberships = structuredClone(memberships);
      const savedAudit = structuredClone(audit);
      try { return await fn(client); } catch (error) { memberships = savedMemberships; audit = savedAudit; throw error; }
    },
    $queryRaw: async () => [{ locked: "" }],
  };
  return client;
}

vi.doMock("@/lib/prisma", () => ({ get prisma() { return prismaMock; } }));

const staffRoute = await import("@/app/api/staff/route");
const staffMemberRoute = await import("@/app/api/staff/[id]/route");
const invitationRoute = await import("@/app/api/auth/invitations/[id]/route");
const { listPendingInvitations, latestEventsByMembership, isPendingInvitation } = await import("@/lib/invitations");

const inviteBody = {
  name: "Invitee",
  email: "invitee@other.test",
  password: "AdminChosenPassword123!",
  role: "RECEPTIONIST",
};

function invitationRequest(url: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("sec-fetch-site", "same-origin");
  if (!init.body) { headers.set("Content-Type", "application/json"); init = { ...init, body: JSON.stringify({ action: "accept" }) }; }
  return new Request(url, { ...init, headers });
}

function post(path: string) {
  return new Request(`http://localhost:3000${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(inviteBody),
  });
}

beforeEach(() => {
  mockLimitAuthRequest.mockReset().mockResolvedValue(null);
  // The route refuses to run at all when the database is not configured.
  vi.stubEnv("DATABASE_URL", "postgresql://test-role@db.example.test:5432/hms_recovery");
  reset();
  prismaMock = buildPrisma();
  mockTenant = { hotelId: "hotel-a", userId: "user-owner", role: "HOTEL_OWNER" };
  currentUserId = "user-invitee";
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("invitation lifecycle", () => {
  it("requires an explicit decision", async () => {
    const created = await staffRoute.POST(post("/api/staff"));
    const { id } = await created.json();
    const res = await invitationRoute.POST(new Request("http://localhost/x", { method: "POST", headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: "{}" }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(400);
    expect(memberships.get(id)!.status).toBe("SUSPENDED");
  });
  it("rejects cross-site invitation acceptance", async () => {
    const res = await invitationRoute.POST(new Request("http://localhost/x", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }), { params: Promise.resolve({ id: "anything" }) });
    expect(res.status).toBe(403);
  });
  it("blocks an administrator from activating a pending or expired invitation", async () => {
    const created = await staffRoute.POST(post("/api/staff"));
    const { id } = await created.json();
    audit.find((row) => row.entityId === id && row.action === "STAFF_INVITATION_CREATED")!.createdAt = new Date(Date.now() - 8 * 86400000);
    const response = await staffMemberRoute.PATCH(new Request("http://localhost/api/staff/" + id, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "ACTIVE" }),
    }), { params: Promise.resolve({ id }) });
    expect(response.status).toBe(403);
    expect(memberships.get(id)!.status).toBe("SUSPENDED");
  });

  it("revokes a pending invitation so it cannot be accepted later", async () => {
    const created = await staffRoute.POST(post("/api/staff"));
    const { id } = await created.json();
    const revoked = await staffMemberRoute.DELETE(new Request("http://localhost/api/staff/" + id, { method: "DELETE" }), { params: Promise.resolve({ id }) });
    expect(revoked.status).toBe(200);
    expect(memberships.get(id)?.status).toBe("SUSPENDED");
    expect(audit.some((row) => row.entityId === id && row.action === "STAFF_INVITATION_REVOKED")).toBe(true);
    const accepted = await invitationRoute.POST(invitationRequest("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id }) });
    expect(accepted.status).toBe(404);
  });

  it("rolls back invitation creation when its audit record fails", async () => {
    prismaMock.auditLog.create = async () => { throw new Error("audit unavailable"); };
    const created = await staffRoute.POST(post("/api/staff"));
    expect(created.status).toBe(500);
    expect([...memberships.values()].some((m) => m.userId === "user-invitee" && m.hotelId === "hotel-a")).toBe(false);
  });

  it("requires renewed consent for ambiguous legacy suspensions", async () => {
    memberships.set("legacy", { id: "legacy", hotelId: "hotel-a", userId: "user-invitee", role: "WAITER", department: null, status: "SUSPENDED", createdAt: new Date("2020-01-01"), updatedAt: new Date("2020-01-01") });
    const patch = (body: unknown) => staffMemberRoute.PATCH(new Request("http://localhost/api/staff/legacy", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: "legacy" }) });
    expect((await patch({ status: "ACTIVE" })).status).toBe(403);
    expect((await patch({ reinvite: true })).status).toBe(200);
    expect(memberships.get("legacy")!.status).toBe("SUSPENDED");
    expect((await listPendingInvitations("user-invitee")).some((entry: any) => entry.id === "legacy")).toBe(true);
    const accepted = await invitationRoute.POST(invitationRequest("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id: "legacy" }) });
    expect(accepted.status).toBe(200);
    expect(memberships.get("legacy")!.status).toBe("ACTIVE");
  });

  it("rejects expired invitations", async () => {
    const created = await staffRoute.POST(post("/api/staff"));
    const { id } = await created.json();
    audit.find((row) => row.entityId === id && row.action === "STAFF_INVITATION_CREATED")!.createdAt = new Date(Date.now() - 8 * 86400000);
    const result = await invitationRoute.POST(invitationRequest("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id }) });
    expect(result.status).toBe(404);
    expect(memberships.get(id)!.status).toBe("SUSPENDED");
  });

  it("rolls back acceptance if the mandatory audit write fails", async () => {
    const created = await staffRoute.POST(post("/api/staff"));
    const { id } = await created.json();
    prismaMock.auditLog.create = async () => { throw new Error("audit unavailable"); };
    const result = await invitationRoute.POST(invitationRequest("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id }) });
    expect(result.status).toBe(500);
    expect(memberships.get(id)!.status).toBe("SUSPENDED");
  });

  it("refuses to run in an offline preview", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const res = await invitationRoute.POST(invitationRequest("http://localhost:3000/x", { method: "POST" }), {
      params: Promise.resolve({ id: "mem-invitee-b" }),
    });
    expect(res.status).toBe(503);
    expect(memberships.get("mem-invitee-b")!.status).toBe("ACTIVE");
  });

  it("adding an existing account creates an invitation, not access", async () => {
    const res = await staffRoute.POST(post("/api/staff"));
    expect(res.status).toBe(202);
    const data = await res.json();
    expect(data.invitationPending).toBe(true);
    expect(data.status).toBe("SUSPENDED");

    const membership = memberships.get(data.id)!;
    expect(membership.status).toBe("SUSPENDED");
    expect(membership.hotelId).toBe("hotel-a");
    expect(membership.role).toBe("RECEPTIONIST");

    // The invitee's global account is untouched.
    expect(users.get("user-invitee")!.passwordHash).toBe("hashed-original");
    expect(memberships.get("mem-invitee-b")!.status).toBe("ACTIVE");
  });

  it("records who invited whom", async () => {
    const res = await staffRoute.POST(post("/api/staff"));
    const { id } = await res.json();
    const created = audit.find((row) => row.entityId === id && row.action === "STAFF_INVITATION_CREATED");
    expect(created).toBeTruthy();
    expect(created!.userId).toBe("user-owner");
    expect(created!.metadata.invitedUserId).toBe("user-invitee");
  });

  it("lists the invitation for the invitee only", async () => {
    await staffRoute.POST(post("/api/staff"));
    const forInvitee = await listPendingInvitations("user-invitee");
    expect(forInvitee).toHaveLength(1);
    expect(forInvitee[0].hotelId).toBe("hotel-a");

    const forOwner = await listPendingInvitations("user-owner");
    expect(forOwner).toHaveLength(0);
  });

  it("nobody else can accept the invitation", async () => {
    const res = await staffRoute.POST(post("/api/staff"));
    const { id } = await res.json();

    currentUserId = "user-owner";
    const attempt = await invitationRoute.POST(invitationRequest("http://localhost:3000/x", { method: "POST" }), {
      params: Promise.resolve({ id }),
    });
    expect(attempt.status).toBe(404);
    expect(memberships.get(id)!.status).toBe("SUSPENDED");
  });

  it("accepting turns the invitation into an active membership", async () => {
    const res = await staffRoute.POST(post("/api/staff"));
    const { id } = await res.json();

    const accept = await invitationRoute.POST(
      invitationRequest("http://localhost:3000/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "accept" }),
      }),
      { params: Promise.resolve({ id }) }
    );
    expect(accept.status).toBe(200);
    const body = await accept.json();
    expect(body.decision).toBe("accepted");
    expect(memberships.get(id)!.status).toBe("ACTIVE");
    expect(audit.some((row) => row.entityId === id && row.action === "STAFF_INVITATION_ACCEPTED")).toBe(true);

    // It is no longer offered as a pending invitation.
    expect(await listPendingInvitations("user-invitee")).toHaveLength(0);
  });

  it("accepting twice is refused", async () => {
    const res = await staffRoute.POST(post("/api/staff"));
    const { id } = await res.json();
    const accept = () =>
      invitationRoute.POST(invitationRequest("http://localhost:3000/x", { method: "POST" }), {
        params: Promise.resolve({ id }),
      });
    expect((await accept()).status).toBe(200);
    expect((await accept()).status).toBe(404);
  });

  it("declining retains the suspended membership and leaves the account intact", async () => {
    const res = await staffRoute.POST(post("/api/staff"));
    const { id } = await res.json();

    const decline = await invitationRoute.POST(
      invitationRequest("http://localhost:3000/x", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "decline" }),
      }),
      { params: Promise.resolve({ id }) }
    );
    expect(decline.status).toBe(200);
    expect(memberships.get(id)?.status).toBe("SUSPENDED");
    expect(users.get("user-invitee")!.isActive).toBe(true);
    expect(audit.some((row) => row.action === "STAFF_INVITATION_DECLINED")).toBe(true);
  });

  it("acceptance enforces the staff seat limit", async () => {
    // Fill the plan: BAND_1_10 allows 10 active staff, so make 10 active rows.
    for (let i = 0; i < 10; i++) {
      const userId = `filler-${i}`;
      users.set(userId, { id: userId, name: `F${i}`, email: `f${i}@x.test`, passwordHash: "h", isActive: true });
      memberships.set(`fill-${i}`, {
        id: `fill-${i}`,
        userId,
        hotelId: "hotel-a",
        role: "WAITER",
        department: null,
        status: "ACTIVE",
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    const res = await staffRoute.POST(post("/api/staff"));
    const { id } = await res.json();

    const accept = await invitationRoute.POST(invitationRequest("http://localhost:3000/x", { method: "POST" }), {
      params: Promise.resolve({ id }),
    });
    expect(accept.status).toBe(403);
    const body = await accept.json();
    expect(body.error).toBe("PLAN_LIMIT_EXCEEDED");
    expect(memberships.get(id)!.status).toBe("SUSPENDED");
  });

  it("a suspended (revoked) membership is not offered as an invitation", async () => {
    memberships.set("mem-revoked", {
      id: "mem-revoked",
      userId: "user-invitee",
      hotelId: "hotel-a",
      role: "WAITER",
      department: null,
      status: "SUSPENDED",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    audit.push({
      id: "audit-revoke",
      hotelId: "hotel-a",
      userId: "user-owner",
      action: "STAFF_MEMBERSHIP_SUSPENDED",
      entity: "HOTEL_MEMBERSHIP",
      entityId: "mem-revoked",
      metadata: {},
      createdAt: new Date(),
    });

    expect(await listPendingInvitations("user-invitee")).toHaveLength(0);
    const accept = await invitationRoute.POST(invitationRequest("http://localhost:3000/x", { method: "POST" }), {
      params: Promise.resolve({ id: "mem-revoked" }),
    });
    expect(accept.status).toBe(404);
  });
});

describe("invitation helpers", () => {
  it("keeps the newest event per membership regardless of row order", () => {
    const latest = latestEventsByMembership([
      { entityId: "m1", action: "STAFF_INVITATION_CREATED", createdAt: "2026-01-01T00:00:00Z" },
      { entityId: "m1", action: "STAFF_INVITATION_ACCEPTED", createdAt: "2026-01-02T00:00:00Z" },
      { entityId: "m2", action: "STAFF_INVITATION_DECLINED", createdAt: "2026-01-02T00:00:00Z" },
      { entityId: "m2", action: "STAFF_INVITATION_CREATED", createdAt: "2026-01-03T00:00:00Z" },
    ]);
    expect(latest.get("m1")).toBe("STAFF_INVITATION_ACCEPTED");
    expect(latest.get("m2")).toBe("STAFF_INVITATION_CREATED");
    expect(isPendingInvitation(latest.get("m1"))).toBe(false);
    expect(isPendingInvitation(latest.get("m2"))).toBe(true);
    expect(isPendingInvitation(undefined)).toBe(false);
  });
});
