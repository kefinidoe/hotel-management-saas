import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ rows: new Map<string, any>(), effects: 0, failLedger: false, queue: Promise.resolve() }));
vi.mock("next/server", () => ({ NextResponse: class extends Response {
  static json(body: unknown, init?: ResponseInit) { return new Response(JSON.stringify(body), init); }
} }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: async (fn: any) => {
  const previous = state.queue; let release!: () => void;
  state.queue = new Promise<void>((resolve) => { release = resolve; }); await previous;
  const oldRows = new Map(state.rows), oldEffects = state.effects;
  const tx = { $queryRaw: async () => [], inventoryRequest: {
    findUnique: async ({ where }: any) => state.rows.get(JSON.stringify(where.hotelId_operation_requestKey)) ?? null,
    create: async ({ data }: any) => {
      if (state.failLedger) throw new Error("ledger unavailable");
      state.rows.set(JSON.stringify({ hotelId: data.hotelId, operation: data.operation, requestKey: data.requestKey }), data);
    },
  } };
  try { return await fn(tx); } catch (error) { state.rows = oldRows; state.effects = oldEffects; throw error; } finally { release(); }
} } }));
import { inventoryRequest } from "@/lib/inventory-idempotency";
const req = (key?: string) => new Request("https://hotel.test", { headers: key ? { "Idempotency-Key": key } : {} });
const perform = async () => { state.effects++; return { status: 201, body: { id: "effect-" + state.effects } }; };
beforeEach(() => { state.rows = new Map(); state.effects = 0; state.failLedger = false; state.queue = Promise.resolve(); });
describe("inventory replay ledger (mock transactions)", () => {
  it("rejects a missing key and replays a concurrent duplicate", async () => {
    expect((await inventoryRequest(req(), "hotel-a", "actor", "PURCHASE", { qty: 2 }, perform)).status).toBe(400);
    const [a, b] = await Promise.all([inventoryRequest(req("key-123"), "hotel-a", "actor", "PURCHASE", { qty: 2 }, perform), inventoryRequest(req("key-123"), "hotel-a", "actor", "PURCHASE", { qty: 2 }, perform)]);
    expect(a.status).toBe(201); expect(b.status).toBe(201); expect(await a.json()).toEqual(await b.json()); expect(state.effects).toBe(1);
  });
  it("isolates keys by hotel and operation and rejects payload or actor reuse", async () => {
    expect((await inventoryRequest(req("key-123"), "hotel-a", "actor", "PURCHASE", { qty: 2 }, perform)).status).toBe(201);
    expect((await inventoryRequest(req("key-123"), "hotel-a", "actor", "PURCHASE", { qty: 3 }, perform)).status).toBe(409);
    expect((await inventoryRequest(req("key-123"), "hotel-a", "other", "PURCHASE", { qty: 2 }, perform)).status).toBe(409);
    expect((await inventoryRequest(req("key-123"), "hotel-b", "actor", "PURCHASE", { qty: 2 }, perform)).status).toBe(201);
    expect((await inventoryRequest(req("key-123"), "hotel-a", "actor", "WASTAGE", { qty: 2 }, perform)).status).toBe(201);
    expect(state.effects).toBe(3);
  });
  it("rejects stale hotel and actor context before any effect or replay", async () => {
    for (const headers of [{ "X-Expected-Hotel-Id": "hotel-b" }, { "X-Expected-Actor-Id": "other" }] as Record<string, string>[]) {
      const stale = new Request("https://hotel.test", { headers: { "Idempotency-Key": "key-123", ...headers } });
      expect((await inventoryRequest(stale, "hotel-a", "actor", "PURCHASE", { qty: 2 }, perform)).status).toBe(409);
    }
    expect(state.effects).toBe(0);
    expect(state.rows.size).toBe(0);
  });
  it("rolls back the effect if writing the ledger fails", async () => {
    state.failLedger = true;
    await expect(inventoryRequest(req("key-123"), "hotel-a", "actor", "PURCHASE", { qty: 2 }, perform)).rejects.toThrow("ledger unavailable");
    expect(state.effects).toBe(0); expect(state.rows.size).toBe(0);
  });
});
