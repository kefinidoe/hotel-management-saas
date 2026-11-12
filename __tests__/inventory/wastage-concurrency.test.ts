import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const state = vi.hoisted(() => ({ stock: 0, version: 0, waste: [] as any[], purchases: [] as any[], movements: [] as any[], failMovement: false, ledger: new Map<string, any>(), queue: Promise.resolve() }));
vi.mock("next/server", () => ({ NextResponse: class extends Response {
  static json(body: unknown, init?: ResponseInit) { return new Response(JSON.stringify(body), init); }
} }));
vi.mock("@/lib/authz", () => ({
  getTenantFromRoute: async () => ({ hotelId: "hotel-a", userId: "manager", role: "HOTEL_ADMIN" }),
  requireRole: () => null, requireModule: async () => null, ROLE_GROUPS: { MANAGEMENT: [] },
}));
vi.mock("@/lib/notifications", () => ({ syncLowStockAlerts: async () => {} }));
vi.mock("@/lib/prisma", () => ({ prisma: {
  inventoryItem: { findUnique: async () => ({ id: "item", hotelId: "hotel-a", currentStock: new Prisma.Decimal(state.stock) }) },
  $transaction: async (fn: any) => {
    const previous = state.queue;
    let release!: () => void;
    state.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    const snapshot = { stock: state.stock, version: state.version, waste: [...state.waste], purchases: [...state.purchases], movements: [...state.movements], ledger: new Map(state.ledger) };
    const tx = {
      recipe: { findMany: async () => [{ menuItemId: "dish", portions: 1, menuItem: { id: "dish", hotelId: "hotel-a" }, ingredients: [{ inventoryItemId: "item", quantity: 3, inventoryItem: { id: "item", hotelId: "hotel-a", name: "Rice" } }] }] },
      $queryRaw: async () => [],
      inventoryRequest: {
        findUnique: async ({ where }: any) => state.ledger.get(JSON.stringify(where.hotelId_operation_requestKey)) ?? null,
        create: async ({ data }: any) => { state.ledger.set(JSON.stringify({ hotelId: data.hotelId, operation: data.operation, requestKey: data.requestKey }), data); return data; },
      },
      inventoryItem: {
        updateMany: async ({ where, data }: any) => {
          if (where.hotelId !== "hotel-a" || where.id !== "item" || (where.stockVersion !== undefined && where.stockVersion !== state.version)) return { count: 0 };
          if (typeof where.currentStock?.gte !== "function" && where.currentStock?.gte !== undefined && state.stock < Number(where.currentStock.gte)) return { count: 0 };
          if (where.currentStock !== undefined && (where.currentStock?.gte === undefined || typeof where.currentStock?.gte === "function") && state.stock !== Number(where.currentStock)) return { count: 0 };
          if (data.currentStock?.decrement !== undefined) state.stock -= Number(data.currentStock.decrement);
          else if (data.currentStock?.increment !== undefined) state.stock += Number(data.currentStock.increment);
          else state.stock = Number(data.currentStock);
          state.version++;
          return { count: 1 };
        },
        findMany: async () => [{ id: "item", hotelId: "hotel-a", name: "Rice", unit: "g", currentStock: new Prisma.Decimal(state.stock) }],
        findUnique: async () => ({ id: "item", currentStock: new Prisma.Decimal(state.stock) }),
        findUniqueOrThrow: async () => ({ id: "item", currentStock: new Prisma.Decimal(state.stock) }),
      },
      purchase: { create: async ({ data }: any) => { const row = { ...data, id: "p" + state.purchases.length }; state.purchases.push(row); return row; } },
      wastage: { create: async ({ data }: any) => { const row = { ...data, id: "w" + state.waste.length }; state.waste.push(row); return row; } },
      stockMovement: { create: async ({ data }: any) => { if (state.failMovement) throw new Error("movement failed"); state.movements.push(data); } },
    };
    try { return await fn(tx); } catch (error) { Object.assign(state, snapshot); throw error; } finally { release(); }
  },
} }));
import { POST } from "@/app/api/wastage/route";
import { POST as purchase } from "@/app/api/purchases/route";
import { PATCH as adjust } from "@/app/api/inventory/[id]/route";
import { deductRecipeStock } from "@/lib/recipe-stock";
import { prisma } from "@/lib/prisma";
let sequence = 0;
function request(quantity: number, key = `request-${++sequence}`) { return new Request("https://hotel.test/api/wastage", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ inventoryItemId: "item", quantity, reason: "OTHER", accountableName: "Chef" }) }); }
beforeEach(() => { state.stock = 10; state.version = 0; state.waste = []; state.purchases = []; state.movements = []; state.failMovement = false; state.ledger = new Map(); state.queue = Promise.resolve(); });
describe("inventory stock transaction (simulated row lock)", () => {
  const purchaseRequest = (key: string) => new Request("https://hotel.test/api/purchases", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ inventoryItemId: "item", supplier: "Supplier", quantity: 5, unitCost: 2 }) });
  const adjustment = (key: string, expectedQuantity: number, newQuantity: number, expectedVersion = 0) => new Request("https://hotel.test/api/inventory/item", { method: "PATCH", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify({ expectedQuantity, expectedVersion, newQuantity }) });
  it("serializes concurrent purchases and wastage without losing stock", async () => {
    const results = await Promise.all([purchase(purchaseRequest("purchase-1")), purchase(purchaseRequest("purchase-2")), POST(request(4))]);
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    expect(state.stock).toBe(16);
    expect(state.movements.map((m) => [Number(m.beforeQty), Number(m.afterQty)])).toEqual([[10, 15], [15, 20], [20, 16]]);
  });
  it("serializes meal consumption with a purchase and wastage", async () => {
    const meal = () => prisma.$transaction((tx) => deductRecipeStock(tx, [{ menuItemId: "dish", name: "Dish", unitPrice: 1, quantity: 1 }], "sale", "manager", "hotel-a"));
    const outcomes = await Promise.all([meal(), purchase(purchaseRequest("purchase-meal")), POST(request(4))]);
    expect(outcomes[1].status).toBe(201); expect(outcomes[2].status).toBe(201);
    expect(state.stock).toBe(8); expect(state.movements).toHaveLength(3);
    for (let i = 1; i < state.movements.length; i++) expect(Number(state.movements[i].beforeQty)).toBe(Number(state.movements[i - 1].afterQty));
  });
  it("rejects stale stocktakes rather than overwriting purchases", async () => {
    const params = { params: Promise.resolve({ id: "item" }) };
    const results = await Promise.all([purchase(purchaseRequest("purchase-3")), adjust(adjustment("adjustment-1", 10, 8), params)]);
    expect(results[0].status).toBe(201);
    if (results[1].status === 409) { expect(state.stock).toBe(15); expect(state.movements).toHaveLength(1); }
    else { expect(results[1].status).toBe(200); expect(state.stock).toBe(13); expect(state.movements).toHaveLength(2); }
  });
  it("replays purchase and adjustment without duplicating their movements", async () => {
    const params = { params: Promise.resolve({ id: "item" }) };
    expect((await purchase(purchaseRequest("purchase-replay"))).status).toBe(201);
    expect((await purchase(purchaseRequest("purchase-replay"))).status).toBe(201);
    expect((await adjust(adjustment("adjust-replay", 15, 12, 1), params)).status).toBe(200);
    expect((await adjust(adjustment("adjust-replay", 15, 12, 1), params)).status).toBe(200);
    expect(state.stock).toBe(12); expect(state.movements).toHaveLength(2); expect(state.purchases).toHaveLength(1);
  });
  it("serializes concurrent decrements and rejects an oversell", async () => {
    const responses = await Promise.all([POST(request(6)), POST(request(6))]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(state.stock).toBe(4);
    expect(state.waste).toHaveLength(1);
    expect(state.movements).toHaveLength(1);
    expect(Number(state.movements[0].beforeQty)).toBe(10);
    expect(Number(state.movements[0].afterQty)).toBe(4);
  });
  it("records both successful concurrent decrements with correct balances", async () => {
    const responses = await Promise.all([POST(request(3)), POST(request(4))]);
    expect(responses.map((r) => r.status)).toEqual([201, 201]);
    expect(state.stock).toBe(3);
    expect(state.movements.map((m) => [Number(m.beforeQty), Number(m.afterQty)])).toEqual([[10, 7], [7, 3]]);
  });
  it("rolls back stock and wastage when movement creation fails", async () => {
    state.failMovement = true;
    await expect(POST(request(3))).rejects.toThrow("movement failed");
    expect(state.stock).toBe(10);
    expect(state.waste).toHaveLength(0);
    expect(state.movements).toHaveLength(0);
  });
  it("replays the original response and rejects key reuse with a changed payload", async () => {
    const [first, second] = await Promise.all([POST(request(3, "same-key")), POST(request(3, "same-key"))]);
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    expect(await first.json()).toEqual(await second.json());
    expect(state.stock).toBe(7); expect(state.movements).toHaveLength(1);
    expect((await POST(request(4, "same-key"))).status).toBe(409);
  });
  it("rejects quantities smaller than the stored decimal precision", async () => {
    expect((await POST(request(0.001))).status).toBe(400);
    expect(state.stock).toBe(10);
  });
});
