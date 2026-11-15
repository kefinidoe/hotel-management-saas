import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({ tenant: vi.fn(), role: vi.fn(), module: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), transaction: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/authz", () => ({
  getTenantFromRoute: mocks.tenant, requireRole: mocks.role, requireModule: mocks.module,
  ROLE_GROUPS: { MANAGEMENT: ["manager"], GUEST_STAYS: ["receptionist"] },
}));
vi.mock("@/lib/prisma", () => ({ prisma: { hotelMealPricing: { findMany: mocks.findMany }, $transaction: mocks.transaction } }));
vi.mock("@/lib/audit", () => ({ recordAudit: mocks.audit }));
import { GET, PUT } from "@/app/api/settings/meals/route";

const valid = { mealPlan: "BED_BREAKFAST", adultSurcharge: 500, childSurcharge: 250, isActive: true };
const request = (body?: string, query = "") => new Request(`https://hotel.test/api/settings/meals${query}`, { method: "PUT", body });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.tenant.mockResolvedValue({ hotelId: "hotel-a", userId: "actor", role: "MANAGER" });
  mocks.role.mockReturnValue(null);
  mocks.module.mockResolvedValue(null);
  mocks.findMany.mockResolvedValue([]);
  mocks.transaction.mockImplementation(async (fn) => fn({ hotelMealPricing: { upsert: mocks.upsert } }));
  mocks.upsert.mockImplementation(async ({ create }) => ({ id: "row", ...create }));
  mocks.audit.mockResolvedValue(true);
});

describe("tenant meal pricing settings", () => {
  it("returns all five defaults and reads only the authenticated hotel", async () => {
    const response = await GET(new Request("https://hotel.test/api/settings/meals"));
    expect(response.status).toBe(200);
    const rows = await response.json();
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ mealPlan: "ROOM_ONLY", adultSurcharge: 0, childSurcharge: 0, isActive: true });
    expect(mocks.findMany).toHaveBeenCalledWith({ where: { hotelId: "hotel-a" } });
    expect(mocks.role).toHaveBeenCalledWith("MANAGER", ["receptionist"]);
  });
  it("upserts only the authenticated hotel and audits inside the transaction", async () => {
    const response = await PUT(request(JSON.stringify(valid)));
    expect(response.status).toBe(200);
    expect(mocks.role).toHaveBeenCalledWith("MANAGER", ["manager"]);
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { hotelId_mealPlan: { hotelId: "hotel-a", mealPlan: "BED_BREAKFAST" } },
      create: expect.objectContaining({ hotelId: "hotel-a", ...valid }),
    }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ hotelId: "hotel-a", userId: "actor" }), expect.anything(), { strict: true });
  });
  it("rejects forged tenant IDs, malformed JSON, queries and invalid amounts before writes", async () => {
    for (const req of [request(JSON.stringify({ ...valid, hotelId: "hotel-b" })), request("{"), request(JSON.stringify(valid), "?hotelId=hotel-b"), request(JSON.stringify({ ...valid, adultSurcharge: -1 }))]) {
      const response = await PUT(req);
      expect(response.status).toBe(400);
      expect((await response.json()).issues.length).toBeGreaterThan(0);
    }
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("denies access before validation or database queries", async () => {
    mocks.role.mockReturnValue(NextResponse.json({}, { status: 403 }));
    expect((await PUT(request("{"))).status).toBe(403);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("returns failure when the transactional audit fails", async () => {
    mocks.audit.mockRejectedValue(new Error("audit failed"));
    expect((await PUT(request(JSON.stringify(valid)))).status).toBe(500);
  });
});
