import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
const m = vi.hoisted(() => ({ tenant: vi.fn(), role: vi.fn(), module: vi.fn(), hotel: vi.fn(), meals: vi.fn(), occupancies: vi.fn(), createMeal: vi.fn(), updateMeal: vi.fn(), deleteMeal: vi.fn(), createOcc: vi.fn(), updateOcc: vi.fn(), deleteOcc: vi.fn(), updateHotel: vi.fn(), countMeals: vi.fn(), countOcc: vi.fn(), lock: vi.fn(), transaction: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getTenantFromRoute: m.tenant, requireRole: m.role, requireModule: m.module, ROLE_GROUPS: { MANAGEMENT: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER"], GUEST_STAYS: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER", "RECEPTIONIST"] } }));
vi.mock("@/lib/prisma", () => ({ prisma: { hotel: { findUnique: m.hotel }, mealPlanRate: { findMany: m.meals }, occupancyRateRule: { findMany: m.occupancies }, $transaction: m.transaction } }));
vi.mock("@/lib/audit", () => ({ recordAudit: m.audit }));
import { GET, POST, PATCH, DELETE } from "@/app/api/settings/pricing/rules/route";
const body = { kind: "meal", code: "BB", name: "Breakfast", pricePerNight: 200, perGuest: true, isActive: true };
const req = (method: string, data: unknown, query = "") => new Request(`https://example.test/api/settings/pricing/rules${query}`, { method, body: JSON.stringify(data) });
beforeEach(() => {
  vi.resetAllMocks(); m.tenant.mockResolvedValue({ hotelId: "hotel-a", userId: "user-a", role: "MANAGER" }); m.role.mockReturnValue(null); m.module.mockResolvedValue(null);
  m.hotel.mockResolvedValue({ useCustomRateRules: false }); m.meals.mockResolvedValue([]); m.occupancies.mockResolvedValue([]);
  m.countMeals.mockResolvedValue(1); m.countOcc.mockResolvedValue(1); m.updateHotel.mockResolvedValue({ useCustomRateRules: true });
  m.createMeal.mockResolvedValue({ id: "meal-1" }); m.createOcc.mockResolvedValue({ id: "occ-1" }); m.updateMeal.mockResolvedValue({ count: 1 }); m.updateOcc.mockResolvedValue({ count: 1 }); m.deleteMeal.mockResolvedValue({ count: 1 }); m.deleteOcc.mockResolvedValue({ count: 1 }); m.audit.mockResolvedValue(true);
  m.transaction.mockImplementation((fn) => fn({ $queryRaw: m.lock, hotel: { update: m.updateHotel }, mealPlanRate: { count: m.countMeals, create: m.createMeal, updateMany: m.updateMeal, deleteMany: m.deleteMeal }, occupancyRateRule: { count: m.countOcc, create: m.createOcc, updateMany: m.updateOcc, deleteMany: m.deleteOcc } }));
});
describe("dynamic pricing rules", () => {
  it("reads only the active hotel's configuration", async () => {
    const response = await GET(new Request("https://example.test/api/settings/pricing/rules"));
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ useCustomRateRules: false, activationAvailable: true });
    expect(m.meals).toHaveBeenCalledWith(expect.objectContaining({ where: { hotelId: "hotel-a" } })); expect(m.occupancies).toHaveBeenCalledWith(expect.objectContaining({ where: { hotelId: "hotel-a" } }));
  });
  it("creates and audits a tenant-owned rate", async () => {
    expect((await POST(req("POST", body))).status).toBe(201);
    expect(m.createMeal).toHaveBeenCalledWith({ data: { hotelId: "hotel-a", code: "BB", name: "Breakfast", pricePerNight: 200, perGuest: true, isActive: true } });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ hotelId: "hotel-a", action: "DYNAMIC_PRICING_RULE_CREATED" }), expect.anything(), { strict: true });
  });
  it("scopes updates and deletes, refusing another hotel's id", async () => {
    m.updateMeal.mockResolvedValueOnce({ count: 0 });
    expect((await PATCH(req("PATCH", { ...body, id: "other" }))).status).toBe(404);
    expect(m.updateMeal).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "other", hotelId: "hotel-a" } }));
    expect((await DELETE(req("DELETE", { kind: "occupancy", id: "occ-1" }))).status).toBe(200);
    expect(m.deleteOcc).toHaveBeenCalledWith({ where: { id: "occ-1", hotelId: "hotel-a" } });
  });
  it("denies unauthorized callers before validation and validates bodies and queries", async () => {
    m.role.mockReturnValueOnce(NextResponse.json({}, { status: 403 })); expect((await POST(req("POST", {}))).status).toBe(403);
    for (const input of [{ ...body, hotelId: "hotel-b" }, { ...body, pricePerNight: -1 }, { ...body, pricePerNight: 1.111 }, { ...body, perGuest: "true" }]) expect((await POST(req("POST", input))).status).toBe(400);
    expect((await POST(req("POST", body, "?hotelId=hotel-b"))).status).toBe(400); expect(m.transaction).not.toHaveBeenCalled();
  });
  it("requires active rules and enables mode with a transactional audit", async () => {
    m.countMeals.mockResolvedValueOnce(0);
    expect((await PATCH(req("PATCH", { kind: "mode", enabled: true }))).status).toBe(409);
    expect(m.updateHotel).not.toHaveBeenCalled();
    expect((await PATCH(req("PATCH", { kind: "mode", enabled: true }))).status).toBe(200);
    expect(m.updateHotel).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "hotel-a" }, data: { useCustomRateRules: true } }));
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "DYNAMIC_PRICING_MODE_UPDATED" }), expect.anything(), { strict: true });
  });
  it("limits receptionists to active rows", async () => {
    m.tenant.mockResolvedValue({ hotelId: "hotel-a", userId: "reception", role: "RECEPTIONIST" });
    expect((await GET(new Request("https://example.test/api/settings/pricing/rules"))).status).toBe(200);
    expect(m.meals).toHaveBeenCalledWith(expect.objectContaining({ where: { hotelId: "hotel-a", isActive: true } }));
  });
  it("fails when the strict audit cannot be written", async () => {
    m.audit.mockRejectedValueOnce(new Error("audit failed")); expect((await POST(req("POST", body))).status).toBe(500);
  });
});
