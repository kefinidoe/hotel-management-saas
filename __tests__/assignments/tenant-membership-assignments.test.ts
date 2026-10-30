import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hotelMembershipFindFirst: vi.fn(),
  housekeepingFindFirst: vi.fn(),
  housekeepingFindMany: vi.fn(),
  housekeepingUpdateMany: vi.fn(),
  maintenanceFindFirst: vi.fn(),
  maintenanceFindMany: vi.fn(),
  maintenanceUpdateMany: vi.fn(),
  hotelMembershipFindMany: vi.fn(),
  wastageCreate: vi.fn(),
  wastageFindMany: vi.fn(),
  inventoryItemFindUnique: vi.fn(),
  inventoryItemUpdate: vi.fn(),
  stockMovementCreate: vi.fn(),
  transaction: vi.fn(),
  tenant: { hotelId: "hotel-a", userId: "owner-a", role: "HOTEL_ADMIN" },
  TestNextResponse: class extends Response {
    static json(body: unknown, init?: ResponseInit) {
      return new Response(JSON.stringify(body), {
        ...init,
        headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
      });
    }
  },
}));

vi.mock("next/server", () => ({ NextResponse: mocks.TestNextResponse }));
vi.mock("@/lib/authz", () => ({
  getTenantFromRoute: async () => mocks.tenant,
  requireRole: () => null,
  requireModule: async () => null,
  ROLE_GROUPS: { HOUSEKEEPING: ["HOTEL_ADMIN"], MAINTENANCE: ["HOTEL_ADMIN"], MANAGEMENT: ["HOTEL_ADMIN"] },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    hotelMembership: { findFirst: mocks.hotelMembershipFindFirst, findMany: mocks.hotelMembershipFindMany },
    housekeepingTask: { findFirst: mocks.housekeepingFindFirst, findMany: mocks.housekeepingFindMany, updateMany: mocks.housekeepingUpdateMany },
    maintenanceTicket: { findFirst: mocks.maintenanceFindFirst, findMany: mocks.maintenanceFindMany, updateMany: mocks.maintenanceUpdateMany },
    wastage: { create: mocks.wastageCreate, findMany: mocks.wastageFindMany },
    inventoryItem: { findUnique: mocks.inventoryItemFindUnique, update: mocks.inventoryItemUpdate },
    stockMovement: { create: mocks.stockMovementCreate },
    $transaction: mocks.transaction,
  },
}));

import { GET as listHousekeeping } from "@/app/api/housekeeping/route";
import { PUT as updateHousekeeping } from "@/app/api/housekeeping/[id]/route";
import { GET as listMaintenance } from "@/app/api/maintenance/route";
import { PUT as updateMaintenance } from "@/app/api/maintenance/[id]/route";
import { GET as listWastage, POST as recordWastage } from "@/app/api/wastage/route";

const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });
const jsonRequest = (url: string, body: unknown) => new Request(url, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant = { hotelId: "hotel-a", userId: "owner-a", role: "HOTEL_ADMIN" };
  mocks.hotelMembershipFindFirst.mockImplementation(async ({ where }: any) => {
    if (where.hotelId === "hotel-a" && where.userId === "staff-a" && where.status === "ACTIVE" && where.user.isActive) {
      return { id: "membership-a", userId: "staff-a", department: "Kitchen", user: { id: "staff-a", name: "Staff A" } };
    }
    return null;
  });
  mocks.housekeepingFindFirst.mockResolvedValue({ id: "task-a", hotelId: "hotel-a", roomId: "room-a" });
  mocks.housekeepingFindMany.mockResolvedValue([{ id: "task-a", status: "NEEDS_CLEANING", priority: "normal", roomId: "room-a", room: { number: "A-1", roomType: { name: "A room" } }, assigneeId: "staff-b", updatedAt: new Date() }]);
  mocks.housekeepingUpdateMany.mockResolvedValue({ count: 1 });
  mocks.maintenanceFindFirst.mockResolvedValue({ id: "ticket-a", hotelId: "hotel-a", roomId: null });
  mocks.maintenanceFindMany.mockResolvedValue([{ id: "ticket-a", title: "Repair", description: null, priority: "normal", status: "OPEN", cost: null, roomId: null, room: null, assigneeId: "staff-b", updatedAt: new Date() }]);
  mocks.hotelMembershipFindMany.mockResolvedValue([{ userId: "staff-a", user: { name: "Staff A" } }]);
  mocks.maintenanceUpdateMany.mockResolvedValue({ count: 1 });
  mocks.inventoryItemFindUnique.mockResolvedValue({ id: "item-a", hotelId: "hotel-a", currentStock: 5, unit: "kg", name: "Rice", costPerUnit: 100 });
  mocks.wastageCreate.mockResolvedValue({ id: "waste-a" });
  mocks.wastageFindMany.mockResolvedValue([{ id: "waste-a", inventoryItem: { name: "Rice", unit: "kg", costPerUnit: 100 }, quantity: 1, reason: "SPOILAGE", department: null, accountableName: null, accountableUserId: "staff-b", recordedById: "staff-b", createdAt: new Date() }]);
  mocks.inventoryItemUpdate.mockResolvedValue({});
  mocks.stockMovementCreate.mockResolvedValue({});
  mocks.transaction.mockImplementation(async (operation: any) => {
    if (Array.isArray(operation)) return Promise.all(operation);
    return operation({
      hotelMembership: { findFirst: mocks.hotelMembershipFindFirst },
      housekeepingTask: { updateMany: mocks.housekeepingUpdateMany, findFirst: mocks.housekeepingFindFirst },
      maintenanceTicket: { updateMany: mocks.maintenanceUpdateMany, findFirst: mocks.maintenanceFindFirst },
    });
  });
});

describe("hotel-local staff assignment validation", () => {
  it("does not serialize foreign assignee identities from task and ticket listings", async () => {
    const housekeepingResponse = await listHousekeeping();
    const maintenanceResponse = await listMaintenance();
    const housekeepingRows = await housekeepingResponse.json();
    const maintenanceRows = await maintenanceResponse.json();

    expect(housekeepingRows[0]).toMatchObject({ assigneeId: null, assigneeName: null });
    expect(maintenanceRows[0]).toMatchObject({ assigneeId: null, assigneeName: null });
    expect(mocks.hotelMembershipFindMany).toHaveBeenCalledTimes(2);
    expect(mocks.hotelMembershipFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ hotelId: "hotel-a", status: "ACTIVE" }),
    }));
  });

  it("rejects a Hotel B user assignment on a Hotel A housekeeping task", async () => {
    const response = await updateHousekeeping(
      jsonRequest("https://hotel.test/api/housekeeping/task-a", { assigneeId: "staff-b" }),
      routeParams("task-a")
    );

    expect(response.status).toBe(400);
    expect(mocks.hotelMembershipFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ hotelId: "hotel-a", userId: "staff-b", status: "ACTIVE" }),
    }));
    expect(mocks.housekeepingUpdateMany).not.toHaveBeenCalled();
  });

  it("accepts only an active Hotel A member when updating a housekeeping task", async () => {
    const response = await updateHousekeeping(
      jsonRequest("https://hotel.test/api/housekeeping/task-a", { assigneeId: "staff-a" }),
      routeParams("task-a")
    );

    expect(response.status).toBe(200);
    expect(mocks.housekeepingUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "task-a", hotelId: "hotel-a" },
      data: expect.objectContaining({ assigneeId: "staff-a" }),
    }));
  });

  it("rejects a Hotel B user assignment on a Hotel A maintenance ticket", async () => {
    const response = await updateMaintenance(
      jsonRequest("https://hotel.test/api/maintenance/ticket-a", { assigneeId: "staff-b" }),
      routeParams("ticket-a")
    );

    expect(response.status).toBe(400);
    expect(mocks.maintenanceUpdateMany).not.toHaveBeenCalled();
  });

  it("scopes maintenance ticket mutation and response lookup to the active hotel", async () => {
    const response = await updateMaintenance(
      jsonRequest("https://hotel.test/api/maintenance/ticket-a", { assigneeId: "staff-a" }),
      routeParams("ticket-a")
    );

    expect(response.status).toBe(200);
    expect(mocks.maintenanceUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "ticket-a", hotelId: "hotel-a" },
      data: expect.objectContaining({ assigneeId: "staff-a" }),
    }));
    expect(mocks.maintenanceFindFirst).toHaveBeenCalledWith({
      where: { id: "ticket-a", hotelId: "hotel-a" },
    });
  });

  it("does not expose foreign users referenced by legacy wastage records", async () => {
    const response = await listWastage();
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload[0]).toMatchObject({
      accountableName: "Not recorded (legacy entry)",
      recordedByName: "Former hotel staff",
    });
    expect(JSON.stringify(payload)).not.toContain("Staff B");
    expect(mocks.wastageFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { hotelId: "hotel-a" },
    }));
  });

  it("rejects cross-hotel wastage accountability before creating or changing stock", async () => {
    const response = await recordWastage(new Request("https://hotel.test/api/wastage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inventoryItemId: "item-a",
        quantity: 1,
        reason: "SPOILAGE",
        accountableUserId: "staff-b",
      }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.inventoryItemFindUnique).not.toHaveBeenCalled();
    expect(mocks.wastageCreate).not.toHaveBeenCalled();
    expect(mocks.inventoryItemUpdate).not.toHaveBeenCalled();
    expect(mocks.stockMovementCreate).not.toHaveBeenCalled();
  });

  it("uses the department on the active membership for wastage accountability", async () => {
    const response = await recordWastage(new Request("https://hotel.test/api/wastage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        inventoryItemId: "item-a",
        quantity: 1,
        reason: "SPOILAGE",
        accountableUserId: "staff-a",
      }),
    }));

    expect(response.status).toBe(201);
    expect(mocks.hotelMembershipFindFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ hotelId: "hotel-a", userId: "staff-a" }),
      select: expect.objectContaining({ department: true }),
    }));
    expect(mocks.wastageCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ accountableUserId: "staff-a", accountableName: "Staff A", department: "Kitchen" }),
    }));
  });
});
