import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  tenant: vi.fn(), role: vi.fn(), module: vi.fn(), findRoom: vi.fn(), findType: vi.fn(),
  createType: vi.fn(), updateType: vi.fn(), deleteType: vi.fn(), transaction: vi.fn(), lock: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({
  getTenantFromRoute: mocks.tenant, requireRole: mocks.role, requireModule: mocks.module,
  ROLE_GROUPS: { MANAGEMENT: ["MANAGER"], ALL_STAFF: ["MANAGER"] },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {
  room: { findUnique: mocks.findRoom },
  roomType: { findUnique: mocks.findType, create: mocks.createType, update: mocks.updateType, delete: mocks.deleteType },
  $transaction: mocks.transaction,
} }));
vi.mock("@/lib/entitlements", () => ({ withUsageLimitLock: mocks.lock }));

import { POST as createRoom } from "@/app/api/rooms/route";
import { PUT as updateRoom, DELETE as deleteRoom } from "@/app/api/rooms/[id]/route";
import { POST as createType } from "@/app/api/room-types/route";
import { PUT as updateType, DELETE as deleteType } from "@/app/api/room-types/[id]/route";

const context = { params: Promise.resolve({ id: "room-1" }) };
const request = (method: string, body?: string, query = "") => new Request(`https://hotel.test/api/test${query}`, { method, ...(body === undefined ? {} : { body }) });
const calls = [
  { name: "create room", run: (r: Request) => createRoom(r), method: "POST", invalid: '{"number":4}', valid: '{"number":"101","roomTypeId":"type-1"}' },
  { name: "update room", run: (r: Request) => updateRoom(r, context), method: "PUT", invalid: '{"isActive":"false"}', valid: '{"number":"101"}' },
  { name: "delete room", run: (r: Request) => deleteRoom(r, context), method: "DELETE", invalid: '{"anything":true}', valid: undefined },
  { name: "create room type", run: (r: Request) => createType(r), method: "POST", invalid: '{"name":"","baseRate":-1}', valid: '{"name":"Suite","baseRate":100}' },
  { name: "update room type", run: (r: Request) => updateType(r, context), method: "PUT", invalid: '{"capacity":0}', valid: '{"name":"Suite"}' },
  { name: "delete room type", run: (r: Request) => deleteType(r, context), method: "DELETE", invalid: '{"anything":true}', valid: undefined },
];
beforeEach(() => {
  vi.resetAllMocks();
  mocks.tenant.mockResolvedValue({ hotelId: "hotel-a", role: "MANAGER" });
  mocks.role.mockReturnValue(null);
  mocks.module.mockResolvedValue(null);
});
describe.each(calls)("$name", ({ run, method, invalid, valid }) => {
  it("checks authentication, role and module before parsing", async () => {
    mocks.tenant.mockResolvedValueOnce(NextResponse.json({ error: "Unauthorized" }, { status: 401 }));
    expect((await run(request(method, "not-json"))).status).toBe(401);
    expect(mocks.role).not.toHaveBeenCalled();
    mocks.role.mockReturnValueOnce(NextResponse.json({ error: "Forbidden" }, { status: 403 }));
    expect((await run(request(method, "not-json"))).status).toBe(403);
    expect(mocks.module).not.toHaveBeenCalled();
    mocks.module.mockResolvedValueOnce(NextResponse.json({ error: "Blocked" }, { status: 403 }));
    expect((await run(request(method, "not-json"))).status).toBe(403);
    expect(mocks.findRoom).not.toHaveBeenCalled();
    expect(mocks.findType).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
  it("rejects malformed bodies, invalid fields and unexpected query before business access", async () => {
    for (const r of [request(method, "{"), request(method, invalid), request(method, valid, "?unexpected=1")]) {
      const result = await run(r);
      expect(result.status).toBe(400);
      expect((await result.json()).issues.length).toBeGreaterThan(0);
    }
    expect(mocks.findRoom).not.toHaveBeenCalled();
    expect(mocks.findType).not.toHaveBeenCalled();
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.lock).not.toHaveBeenCalled();
  });
});

it("preserves hotel-scoped lookup on a valid room-type update", async () => {
  mocks.findType.mockResolvedValue({ id: "room-1", hotelId: "hotel-a", name: "Old", baseRate: 50, capacity: 2, mealPlan: null, description: null });
  mocks.updateType.mockResolvedValue({ name: "Suite", baseRate: 50 });
  const response = await updateType(request("PUT", '{"name":"Suite"}'), context);
  expect(response.status).toBe(200);
  expect(mocks.findType).toHaveBeenCalledWith({ where: { id_hotelId: { id: "room-1", hotelId: "hotel-a" } } });
  expect(mocks.updateType).toHaveBeenCalledWith(expect.objectContaining({ where: { id_hotelId: { id: "room-1", hotelId: "hotel-a" } } }));
});

it("creates a room only after resolving its type in the current hotel and taking the usage lock", async () => {
  mocks.findType.mockResolvedValue({ id: "type-1" });
  mocks.lock.mockResolvedValue({ allowed: true, value: { id: "room-1", roomType: { baseRate: 100 } } });
  const response = await createRoom(request("POST", '{"number":"101","roomTypeId":"type-1"}'));
  expect(response.status).toBe(201);
  expect(mocks.findType).toHaveBeenCalledWith({ where: { id_hotelId: { id: "type-1", hotelId: "hotel-a" } } });
  expect(mocks.lock).toHaveBeenCalledWith("hotel-a", "maxRooms", 1, expect.any(Function));
});

it("updates a room using its tenant-scoped identifier", async () => {
  const update = vi.fn().mockResolvedValue({ id: "room-1", roomType: { baseRate: 100 } });
  // The route writes through prisma; assign the mocked method on that shared object.
  const { prisma } = await import("@/lib/prisma");
  (prisma.room as unknown as { update: typeof update }).update = update;
  mocks.findRoom.mockResolvedValue({ id: "room-1", hotelId: "hotel-a", number: "101", roomTypeId: "type-1", status: "AVAILABLE", floor: null, notes: null, isActive: true });
  const response = await updateRoom(request("PUT", '{"number":"102"}'), context);
  expect(response.status).toBe(200);
  expect(update).toHaveBeenCalledWith(expect.objectContaining({ where: { id_hotelId: { id: "room-1", hotelId: "hotel-a" } } }));
});

it("retains the room removal transaction for valid requests", async () => {
  mocks.transaction.mockResolvedValue({ id: "room-1", number: "101", isActive: false });
  expect((await deleteRoom(request("DELETE"), context)).status).toBe(200);
  expect(mocks.transaction).toHaveBeenCalledOnce();
  expect(mocks.transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: "Serializable" });
});

it("creates and deletes room types within the current hotel", async () => {
  mocks.createType.mockResolvedValue({ id: "type-1", baseRate: 100 });
  expect((await createType(request("POST", '{"name":"Suite","baseRate":100}'))).status).toBe(201);
  expect(mocks.createType).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ hotelId: "hotel-a" }) }));
  mocks.findType.mockResolvedValue({ id: "room-1", rooms: [] });
  mocks.deleteType.mockResolvedValue({});
  expect((await deleteType(request("DELETE"), context)).status).toBe(200);
  expect(mocks.deleteType).toHaveBeenCalledWith({ where: { id_hotelId: { id: "room-1", hotelId: "hotel-a" } } });
});

it("persists validated modular capacities and fees on a tenant-scoped room type", async () => {
  const input = { name: "Family Suite", baseRate: 8000, capacity: 5, maxAdults: 3, maxChildren: 2, extraAdultFee: 500.25 };
  mocks.createType.mockResolvedValue({ id: "type-1", ...input });
  expect((await createType(request("POST", JSON.stringify(input)))).status).toBe(201);
  expect(mocks.createType).toHaveBeenCalledWith({ data: expect.objectContaining({ hotelId: "hotel-a", ...input }) });
  mocks.findType.mockResolvedValue({ id: "room-1", name: "Old", baseRate: 50, capacity: 2, mealPlan: null, description: null });
  mocks.updateType.mockResolvedValue({ ...input });
  expect((await updateType(request("PUT", JSON.stringify(input)), context)).status).toBe(200);
  expect(mocks.updateType).toHaveBeenCalledWith(expect.objectContaining({ where: { id_hotelId: { id: "room-1", hotelId: "hotel-a" } }, data: expect.objectContaining(input) }));
});

it("rejects invalid modular capacities and currency precision before writes", async () => {
  for (const body of [{ name: "Suite", baseRate: 100, maxAdults: 0 }, { name: "Suite", baseRate: 100, maxChildren: -1 }, { name: "Suite", baseRate: 100, extraAdultFee: 1.234 }]) {
    expect((await createType(request("POST", JSON.stringify(body)))).status).toBe(400);
  }
  expect(mocks.createType).not.toHaveBeenCalled();
});
