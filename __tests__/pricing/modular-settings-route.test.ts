import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
const m = vi.hoisted(() => ({ tenant: vi.fn(), role: vi.fn(), module: vi.fn(), find: vi.fn(), update: vi.fn(), transaction: vi.fn(), lock: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getTenantFromRoute: m.tenant, requireRole: m.role, requireModule: m.module, ROLE_GROUPS: { MANAGEMENT: ["MANAGER"], GUEST_STAYS: ["RECEPTIONIST", "MANAGER"] } }));
vi.mock("@/lib/prisma", () => ({ prisma: { hotel: { findUnique: m.find }, $transaction: m.transaction } }));
vi.mock("@/lib/audit", () => ({ recordAudit: m.audit }));
import { GET, PATCH } from "@/app/api/settings/hotel/route";
const req = (body: string, query = "") => new Request(`https://example.test/api/settings/hotel${query}`, { method: "PATCH", body });
beforeEach(() => {
  vi.resetAllMocks();
  m.tenant.mockResolvedValue({ hotelId: "a", userId: "u", role: "MANAGER" });
  m.role.mockReturnValue(null); m.module.mockResolvedValue(null);
  m.find.mockResolvedValue({ useModularPricing: false });
  m.update.mockResolvedValue({ useModularPricing: true });
  m.transaction.mockImplementation((fn) => fn({ $queryRaw: m.lock, hotel: { findUnique: m.find, update: m.update } }));
  m.audit.mockResolvedValue(true);
});
it("reads the authenticated hotel's mode", async () => {
  expect(await (await GET(new Request("https://example.test/api/settings/hotel"))).json()).toEqual({ useModularPricing: false });
  expect(m.find).toHaveBeenCalledWith({ where: { id: "a" }, select: { useModularPricing: true, useCustomRateRules: true } });
});
it("authorizes read access for guest-stay roles while keeping updates management-only", async () => {
  m.tenant.mockResolvedValue({ hotelId: "a", userId: "u", role: "RECEPTIONIST" });
  await GET(new Request("https://example.test/api/settings/hotel"));
  expect(m.role).toHaveBeenCalledWith("RECEPTIONIST", ["RECEPTIONIST", "MANAGER"]);
  m.role.mockReturnValueOnce(NextResponse.json({}, { status: 403 }));
  expect((await PATCH(req('{"useModularPricing":true}'))).status).toBe(403);
  expect(m.transaction).not.toHaveBeenCalled();
});
it("locks and audits a scoped management update", async () => {
  expect((await PATCH(req('{"useModularPricing":true}'))).status).toBe(200);
  expect(m.role).toHaveBeenCalledWith("MANAGER", ["MANAGER"]);
  expect(m.lock).toHaveBeenCalled();
  expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "a" }, data: { useModularPricing: true } }));
  expect(m.audit).toHaveBeenCalledWith(expect.objectContaining({ hotelId: "a", userId: "u", metadata: { previous: false, next: true } }), expect.anything(), { strict: true });
});
it("denies unauthorized, forged tenant and malformed updates before writes", async () => {
  m.role.mockReturnValueOnce(NextResponse.json({}, { status: 403 }));
  expect((await PATCH(req("{"))).status).toBe(403);
  for (const r of [req('{"useModularPricing":true,"hotelId":"b"}'), req("{"), req('{"useModularPricing":true}', "?hotelId=b")]) expect((await PATCH(r)).status).toBe(400);
  expect(m.transaction).not.toHaveBeenCalled();
});
it("fails when the transactional audit cannot be persisted", async () => {
  m.audit.mockRejectedValue(new Error("audit failure"));
  expect((await PATCH(req('{"useModularPricing":true}'))).status).toBe(500);
});
