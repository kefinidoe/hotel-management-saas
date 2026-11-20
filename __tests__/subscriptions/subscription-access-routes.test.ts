import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const m = vi.hoisted(() => ({
  tenant: vi.fn(), billing: vi.fn(), subscription: vi.fn(), module: vi.fn(), rooms: vi.fn(),
  TenantAuthError: class extends Error { code: string; statusCode: number; clearCookie = false; constructor(code: string) { super(code); this.code = code; this.statusCode = 403; } },
}));
vi.mock("@/lib/tenant-context", () => ({ getTenantContext: m.tenant, getBillingTenantContext: m.billing, TenantAuthError: m.TenantAuthError, requireHotelRole: vi.fn(), requirePlatformRole: vi.fn() }));
vi.mock("@/lib/entitlements", () => ({ getOrBootstrapSubscription: m.subscription, checkModuleEntitlement: m.module }));
vi.mock("@/lib/prisma", () => ({ prisma: { room: { findMany: m.rooms } } }));
import { GET, POST } from "@/app/api/rooms/route";
import { DELETE } from "@/app/api/rooms/[id]/route";
import { PATCH } from "@/app/api/notifications/route";
import { getBillingTenantFromRoute, getTenantFromRoute } from "@/lib/authz";

const tenant = { hotelId: "h", userId: "u", role: "HOTEL_ADMIN", hotel: { status: "ACTIVE" } };
const req = (method: string) => new Request("https://example.test/api/rooms", { method });
const params = { params: Promise.resolve({ id: "room" }) };
beforeEach(() => {
  vi.resetAllMocks(); m.tenant.mockResolvedValue(tenant); m.billing.mockResolvedValue(tenant);
  m.rooms.mockResolvedValue([]); m.module.mockImplementation(async (_id, _module, access) => ({ allowed: access === "read" }));
});
describe("subscription state route enforcement", () => {
  it.each(["TRIAL_EXPIRED", "PAST_DUE"])("permits GET and denies POST, PATCH and DELETE for %s", async (status) => {
    m.subscription.mockResolvedValue({ effectiveStatus: status, isOperational: false });
    expect((await GET()).status).toBe(200);
    expect((await POST(req("POST"))).status).toBe(403);
    expect((await PATCH(req("PATCH"))).status).toBe(403);
    expect((await DELETE(req("DELETE"), params)).status).toBe(403);
    expect(m.rooms).toHaveBeenCalledOnce();
  });
  it("permits normal operations during past-due grace", async () => {
    m.subscription.mockResolvedValue({ effectiveStatus: "PAST_DUE", isOperational: true });
    expect(await getTenantFromRoute()).toBe(tenant);
  });
  it("denies reads and writes for a suspended subscription, but permits billing recovery", async () => {
    m.subscription.mockResolvedValue({ effectiveStatus: "SUSPENDED", isOperational: false });
    expect((await GET()).status).toBe(403);
    expect((await POST(req("POST"))).status).toBe(403);
    expect(await getBillingTenantFromRoute()).toBe(tenant);
  });
  it("denies hotel-suspended routes while billing context remains available", async () => {
    const error = new m.TenantAuthError("HOTEL_SUSPENDED");
    error.clearCookie = true;
    m.tenant.mockRejectedValue(error);
    const response = await GET();
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await getBillingTenantFromRoute()).toBe(tenant);
  });
  it("fails closed when subscription status cannot be loaded", async () => {
    m.subscription.mockRejectedValue(new Error("database unavailable"));
    const response = await getTenantFromRoute("read");
    expect(response).toBeInstanceOf(NextResponse);
    expect((response as NextResponse).status).toBe(503);
  });
});
