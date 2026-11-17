import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const m = vi.hoisted(() => ({ tenant: vi.fn(), role: vi.fn(), module: vi.fn(), transaction: vi.fn(), inventoryRequest: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getTenantFromRoute: m.tenant, requireRole: m.role, requireModule: m.module, ROLE_GROUPS: { ALL_STAFF: [], MANAGEMENT: [], FINANCIAL_REPORTS: [], ACCOMMODATION_PAYMENTS: [], RESTAURANT_POS: [] } }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: m.transaction } }));
vi.mock("@/lib/inventory-idempotency", () => ({ inventoryRequest: m.inventoryRequest }));
vi.mock("@/lib/audit", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/notifications", () => ({ syncLowStockAlerts: vi.fn() }));
import { POST as payment } from "@/app/api/payments/route";
import { POST as charge } from "@/app/api/restaurant/charge-to-room/route";
import { POST as payNow } from "@/app/api/restaurant/pay-now/route";
import { POST as expense } from "@/app/api/expenses/route";
import { PATCH as review } from "@/app/api/expenses/[id]/route";
import { POST as purchase } from "@/app/api/purchases/route";

const ctx = { params: Promise.resolve({ id: "expense-1" }) };
const lines = [{ menuItemId: "item-1", quantity: 1, name: "Display", unitPrice: 1 }];
const routes = [
  { name: "payment", method: "POST", run: payment, valid: { folioId: "folio-1", paymentMethodId: "method-1", amount: 10 }, invalid: { folioId: "folio-1", paymentMethodId: "method-1", amount: true } },
  { name: "room charge", method: "POST", run: charge, valid: { folioId: "folio-1", items: lines }, invalid: { folioId: "folio-1", items: [{ menuItemId: "item-1", quantity: 0 }] } },
  { name: "pay now", method: "POST", run: payNow, valid: { paymentMethodId: "method-1", items: lines }, invalid: { paymentMethodId: "method-1", items: [] } },
  { name: "expense", method: "POST", run: expense, valid: { category: "Food", description: "Food", amount: 10, paymentMethod: "Cash" }, invalid: { category: "Food", description: "Food", amount: -10, paymentMethod: "Cash" } },
  { name: "review", method: "PATCH", run: (r: Request) => review(r, ctx), valid: { status: "APPROVED" }, invalid: { status: "PAID" } },
  { name: "purchase", method: "POST", run: purchase, valid: { inventoryItemId: "item-1", supplier: "Supplier", quantity: 5, unitCost: 2 }, invalid: { inventoryItemId: "item-1", supplier: "Supplier", quantity: 0.001, unitCost: 2 } },
];
const req = (method: string, body: string, query = "", headers: Record<string, string> = {}) => new Request(`https://hotel.test/api/example${query}`, { method, headers: { "content-type": "application/json", "idempotency-key": "request-1", ...headers }, body });
beforeEach(() => {
  vi.resetAllMocks();
  m.tenant.mockResolvedValue({ hotelId: "hotel-a", userId: "user-a", role: "MANAGER" });
  m.role.mockReturnValue(null); m.module.mockResolvedValue(null);
  m.transaction.mockResolvedValue({ status: 200, body: {}, id: "payment-1", paid: 10 });
  m.inventoryRequest.mockResolvedValue(NextResponse.json({ ok: true }, { status: 201 }));
});
describe.each(routes)("$name", ({ run, method, valid, invalid }) => {
  it("checks authentication, role and module before parsing invalid input", async () => {
    m.tenant.mockResolvedValueOnce(NextResponse.json({}, { status: 401 }));
    expect((await run(req(method, "{"))).status).toBe(401);
    expect(m.role).not.toHaveBeenCalled();
    m.role.mockReturnValueOnce(NextResponse.json({}, { status: 403 }));
    expect((await run(req(method, "{"))).status).toBe(403);
    expect(m.module).not.toHaveBeenCalled();
    m.module.mockResolvedValueOnce(NextResponse.json({}, { status: 403 }));
    expect((await run(req(method, "{"))).status).toBe(403);
    expect(m.transaction).not.toHaveBeenCalled(); expect(m.inventoryRequest).not.toHaveBeenCalled();
  });
  it("returns structured issues before transactions for malformed, invalid and unknown query input", async () => {
    for (const r of [req(method, "{"), req(method, JSON.stringify(invalid)), req(method, JSON.stringify(valid), "?unexpected=1"), req(method, JSON.stringify({ ...valid, unexpected: true }))]) {
      const response = await run(r);
      expect(response.status).toBe(400);
      const payload = await response.json();
      expect(payload.issues.length).toBeGreaterThan(0);
      expect(payload.issues[0]).toEqual(expect.objectContaining({ code: expect.any(String), path: expect.any(Array), message: expect.any(String) }));
      if (run === charge || run === payNow) expect(payload.outcome).toBe("NOT_COMMITTED");
    }
    expect(m.transaction).not.toHaveBeenCalled(); expect(m.inventoryRequest).not.toHaveBeenCalled();
  });
  it("allows valid input to reach the existing transaction boundary", async () => {
    await run(req(method, JSON.stringify(valid)));
    expect(m.transaction.mock.calls.length + m.inventoryRequest.mock.calls.length).toBe(1);
  });
});

it.each([payment, charge, payNow, expense, purchase])("rejects a stale tenant before body validation", async (run) => {
  const result = await run(req("POST", "{", "", { "x-expected-hotel-id": "hotel-b" }));
  expect(result.status).toBe(409); expect((await result.json()).code).toBe("TENANT_CONTEXT_MISMATCH");
  expect(m.transaction).not.toHaveBeenCalled(); expect(m.inventoryRequest).not.toHaveBeenCalled();
});
it("rejects excess combined POS quantities with an item path", async () => {
  const response = await payNow(req("POST", JSON.stringify({ paymentMethodId: "m", items: [{ menuItemId: "x", quantity: 600 }, { menuItemId: "x", quantity: 500 }] })));
  expect(response.status).toBe(400);
  expect((await response.json()).issues[0].path).toEqual(["items", 1, "quantity"]);
  expect(m.transaction).not.toHaveBeenCalled();
});
it.each([payment, charge, payNow, expense, purchase])("rejects an invalid idempotency key with structured issues", async (run) => {
  const spec = routes.find(item => item.run === run)!;
  const response = await run(req("POST", JSON.stringify(spec.valid), "", { "idempotency-key": "x" }));
  expect(response.status).toBe(400); expect((await response.json()).issues[0].path).toEqual(["idempotencyKey"]);
  expect(m.transaction).not.toHaveBeenCalled(); expect(m.inventoryRequest).not.toHaveBeenCalled();
});
it("rejects invalid calendar dates and oversized purchase totals", async () => {
  for (const extra of [{ purchaseDate: "2025-02-31" }, { quantity: 1000000, unitCost: 1000 }, { quantity: 0 }, { quantity: false }]) {
    const response = await purchase(req("POST", JSON.stringify({ inventoryItemId: "x", supplier: "supplier", quantity: 1, unitCost: 2, ...extra })));
    expect(response.status).toBe(400); expect((await response.json()).issues.length).toBeGreaterThan(0);
  }
  expect(m.inventoryRequest).not.toHaveBeenCalled();
});
