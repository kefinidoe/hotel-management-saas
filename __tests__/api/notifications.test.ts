import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getTenantFromRoute: vi.fn(),
  requireRole: vi.fn(),
  findMany: vi.fn(),
  count: vi.fn(),
  updateMany: vi.fn(),
  auditFindMany: vi.fn(),
}));

vi.mock("next/server", () => {
  class MockNextResponse extends Response {
    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(JSON.stringify(body), {
        ...init,
        headers: { "Content-Type": "application/json", ...init?.headers },
      });
    }
  }
  return { NextResponse: MockNextResponse };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: {
      findMany: mocks.findMany,
      count: mocks.count,
      updateMany: mocks.updateMany,
    },
    auditLog: { findMany: mocks.auditFindMany },
  },
}));

vi.mock("@/lib/authz", () => ({
  getTenantFromRoute: mocks.getTenantFromRoute,
  requireRole: mocks.requireRole,
  ROLE_GROUPS: { ALL_STAFF: ["HOTEL_OWNER", "RECEPTIONIST"], STAFF_ADMIN: ["HOTEL_OWNER"] },
}));

import { GET as listNotifications, PATCH as markNotifications } from "@/app/api/notifications/route";
import { GET as listAuditLogs } from "@/app/api/audit-logs/route";

const tenant = { hotelId: "hotel-a", userId: "user-a", role: "RECEPTIONIST" };

function request(body: unknown, url = "http://localhost/api/notifications") {
  return new Request(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getTenantFromRoute.mockResolvedValue(tenant);
  mocks.requireRole.mockReturnValue(null);
  mocks.findMany.mockResolvedValue([]);
  mocks.count.mockResolvedValue(0);
  mocks.updateMany.mockResolvedValue({ count: 0 });
});

describe("notifications API", () => {
  it("reads only this user's notifications plus hotel-wide broadcasts", async () => {
    mocks.findMany.mockResolvedValue([
      {
        id: "n1",
        type: "STOCK_ALERT",
        title: "Low stock: Beef Sirloin",
        message: "Down to 4 kg.",
        isRead: false,
        createdAt: new Date().toISOString(),
      },
    ]);
    mocks.count.mockResolvedValue(1);

    const response = await listNotifications();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.unread).toBe(1);
    expect(body.notifications).toHaveLength(1);
    expect(mocks.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { hotelId: "hotel-a", OR: [{ userId: null }, { userId: "user-a" }] },
      })
    );
  });

  it("never counts another user's targeted notification", async () => {
    await listNotifications();
    expect(mocks.count).toHaveBeenCalledWith({
      where: { hotelId: "hotel-a", OR: [{ userId: null }, { userId: "user-a" }], isRead: false },
    });
  });

  it("marks every visible notification read with { all: true }", async () => {
    mocks.updateMany.mockResolvedValue({ count: 3 });

    const response = await markNotifications(request({ all: true }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ updated: 3 });
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { hotelId: "hotel-a", OR: [{ userId: null }, { userId: "user-a" }], isRead: false },
      data: { isRead: true },
    });
  });

  it("scopes a single mark-read to the active hotel", async () => {
    await markNotifications(request({ id: "n1" }));
    expect(mocks.updateMany).toHaveBeenCalledWith({
      where: { hotelId: "hotel-a", OR: [{ userId: null }, { userId: "user-a" }], id: "n1" },
      data: { isRead: true },
    });
  });

  it("rejects a body that names neither a notification nor 'all'", async () => {
    const response = await markNotifications(request({}));
    expect(response.status).toBe(400);
    expect(mocks.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an unauthenticated caller", async () => {
    // Must be an instance of the mocked NextResponse, because that is how the
    // route distinguishes "auth failed, return this response" from a tenant.
    const { NextResponse } = await import("next/server");
    const denied = new NextResponse(JSON.stringify({ error: "UNAUTHENTICATED" }), { status: 401 });
    mocks.getTenantFromRoute.mockResolvedValue(denied);

    const response = await listNotifications();
    expect(response.status).toBe(401);
    expect(mocks.findMany).not.toHaveBeenCalled();
  });
});

describe("audit trail API", () => {
  it("returns the hotel's own entries with the actor resolved", async () => {
    mocks.auditFindMany
      .mockResolvedValueOnce([
        {
          id: "a1",
          action: "PAYMENT_RECORDED",
          entity: "Payment",
          entityId: "payment-1",
          metadata: { amount: 5000 },
          ipAddress: null,
          createdAt: new Date().toISOString(),
          user: { name: "Grace Wanjiku", email: "owner@demo.test" },
        },
      ])
      .mockResolvedValueOnce([{ action: "PAYMENT_RECORDED" }]);

    const response = await listAuditLogs(new Request("http://localhost/api/audit-logs"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.logs[0]).toMatchObject({ action: "PAYMENT_RECORDED", actorName: "Grace Wanjiku" });
    expect(body.actions).toEqual(["PAYMENT_RECORDED"]);
    expect(mocks.auditFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { hotelId: "hotel-a" } })
    );
  });

  it("refuses a role that is not an owner or administrator", async () => {
    mocks.requireRole.mockReturnValue(new Response("forbidden", { status: 403 }));

    const response = await listAuditLogs(new Request("http://localhost/api/audit-logs"));

    expect(response.status).toBe(403);
    expect(mocks.auditFindMany).not.toHaveBeenCalled();
  });
});
