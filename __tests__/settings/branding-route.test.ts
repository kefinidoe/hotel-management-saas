import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
const m = vi.hoisted(() => ({ tenant: vi.fn(), role: vi.fn(), module: vi.fn(), find: vi.fn(), update: vi.fn(), transaction: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getTenantFromRoute: m.tenant, requireRole: m.role, requireModule: m.module, ROLE_GROUPS: { MANAGEMENT: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER"] } }));
vi.mock("@/lib/prisma", () => ({ prisma: { hotel: { findUnique: m.find }, $transaction: m.transaction } }));
vi.mock("@/lib/audit", () => ({ recordAudit: m.audit }));
import { GET, PATCH } from "@/app/api/settings/branding/route";
const req = (body: string, query = "") => new Request(`https://example.test/api/settings/branding${query}`, { method: "PATCH", body });
beforeEach(() => {
  vi.resetAllMocks();
  m.tenant.mockResolvedValue({ hotelId: "hotel-a", userId: "actor", role: "MANAGER" });
  m.role.mockReturnValue(null); m.module.mockResolvedValue(null);
  m.find.mockResolvedValue({ name: "Kim Resort", logoUrl: "https://example.test/kim.png" });
  m.update.mockResolvedValue({ name: "Kim Resort", logoUrl: "https://example.test/kim.png" });
  m.transaction.mockImplementation((fn) => fn({ hotel: { update: m.update } }));
  m.audit.mockResolvedValue(true);
});
describe("hotel branding API", () => {
  it("reads only the active tenant's branding", async () => {
    expect(await (await GET(new Request("https://example.test/api/settings/branding"))).json()).toEqual({ name: "Kim Resort", logoUrl: "https://example.test/kim.png" });
    expect(m.find).toHaveBeenCalledWith({ where: { id: "hotel-a" }, select: { name: true, logoUrl: true } });
    expect(m.role).toHaveBeenCalledWith("MANAGER", ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER"]);
  });
  it("writes only the authenticated tenant and records a strict transactional audit", async () => {
    expect((await PATCH(req('{"name":"Kim Resort","logoUrl":"https://example.test/kim.png"}'))).status).toBe(200);
    expect(m.update).toHaveBeenCalledWith({ where: { id: "hotel-a" }, data: { name: "Kim Resort", logoUrl: "https://example.test/kim.png" }, select: { name: true, logoUrl: true } });
    expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ hotelId: "hotel-a", userId: "actor", action: "HOTEL_BRANDING_UPDATED" }), expect.anything(), { strict: true });
  });
  it("denies non-managers before parsing, and rejects forged tenant and unsafe URLs", async () => {
    m.role.mockReturnValueOnce(NextResponse.json({}, { status: 403 }));
    expect((await PATCH(req("{"))).status).toBe(403);
    for (const input of [
      '{"name":"Test","logoUrl":"javascript:alert(1)"}',
      '{"name":"Test","logoUrl":"https://user:password@example.test/logo.png"}',
      '{"name":"Test","logoUrl":"http://example.test/logo.png"}',
      '{"name":"Test","logoUrl":null,"hotelId":"hotel-b"}',
      '{"name":"Test","logoUrl":42}',
    ]) expect((await PATCH(req(input))).status).toBe(400);
    expect((await PATCH(req('{"name":"Test","logoUrl":null}', "?hotelId=hotel-b"))).status).toBe(400);
    expect(m.transaction).not.toHaveBeenCalled();
  });
  it("returns failure when the audit cannot be recorded", async () => {
    m.audit.mockRejectedValue(new Error("audit unavailable"));
    expect((await PATCH(req('{"name":"Test","logoUrl":null}'))).status).toBe(500);
  });
});
