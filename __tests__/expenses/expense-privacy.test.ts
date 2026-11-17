import { beforeEach, describe, expect, it, vi } from "vitest";
const m = vi.hoisted(() => ({ role: "WAITER", findMany: vi.fn(), create: vi.fn() }));
vi.mock("next/server", () => ({ NextResponse: class extends Response { static json(body: unknown, init?: ResponseInit) { return new Response(JSON.stringify(body), init); } } }));
vi.mock("@/lib/authz", () => ({ getTenantFromRoute: async () => ({ hotelId: "hotel-a", userId: "user-a", role: m.role }), requireRole: () => null, requireModule: async () => null, ROLE_GROUPS: { ALL_STAFF: [], FINANCIAL_REPORTS: ["MANAGER"] } }));
vi.mock("@/lib/prisma", () => ({ prisma: { expense: { findMany: m.findMany } } }));
vi.mock("@/lib/inventory-idempotency", () => ({ inventoryRequest: async (_req: any, _hotel: any, _user: any, _op: any, _body: any, fn: any) => { const result = await fn({ expense: { create: m.create } }); return new Response(JSON.stringify(result.body), { status: result.status }); } }));
import { GET, POST } from "@/app/api/expenses/route";
beforeEach(() => { vi.clearAllMocks(); m.role = "WAITER"; m.findMany.mockResolvedValue([]); m.create.mockResolvedValue({ id: "expense-1" }); });
describe("expense access", () => {
  it("limits staff without financial-report access to their own expenses", async () => {
    await GET(); expect(m.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { hotelId: "hotel-a", requestedById: "user-a" } }));
  });
  it("allows authorized management to view hotel expenses", async () => {
    m.role = "MANAGER"; await GET(); expect(m.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { hotelId: "hotel-a" } }));
  });
  it("rejects invalid money before creating an expense", async () => {
    const result = await POST(new Request("https://hotel.test/api/expenses", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ category: "Food", description: "Food", paymentMethod: "Cash", amount: -1 }) }));
    expect(result.status).toBe(400); expect(m.create).not.toHaveBeenCalled();
  });
});
