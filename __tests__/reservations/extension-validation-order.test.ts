import { beforeEach, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
const mocks = vi.hoisted(() => ({ tenant: vi.fn(), role: vi.fn(), module: vi.fn(), transaction: vi.fn() }));
vi.mock("@/lib/authz", () => ({ getTenantFromRoute: mocks.tenant, requireRole: mocks.role, requireModule: mocks.module, ROLE_GROUPS: { GUEST_STAYS: ["MANAGER"] } }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: mocks.transaction } }));
import { POST } from "@/app/api/reservations/[id]/extend/route";
const ctx = { params: Promise.resolve({ id: "reservation-1" }) };
const req = (body: string, query = "") => new Request(`https://hotel.test/api/reservations/reservation-1/extend${query}`, { method: "POST", body });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.tenant.mockResolvedValue({ hotelId: "hotel-a", role: "MANAGER" });
  mocks.role.mockReturnValue(null);
  mocks.module.mockResolvedValue(null);
});
it("runs security checks before validating extension input", async () => {
  mocks.tenant.mockResolvedValueOnce(NextResponse.json({}, { status: 401 }));
  expect((await POST(req("{"), ctx)).status).toBe(401);
  mocks.role.mockReturnValueOnce(NextResponse.json({}, { status: 403 }));
  expect((await POST(req("{"), ctx)).status).toBe(403);
  mocks.module.mockResolvedValueOnce(NextResponse.json({}, { status: 403 }));
  expect((await POST(req("{"), ctx)).status).toBe(403);
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("rejects malformed body, invalid date and unknown query before transaction", async () => {
  for (const request of [req("{"), req('{"checkOutDate":"bad"}'), req('{"checkOutDate":"2030-01-01"}', "?unexpected=1")]) {
    const result = await POST(request, ctx);
    expect(result.status).toBe(400);
    expect((await result.json()).issues.length).toBeGreaterThan(0);
  }
  expect(mocks.transaction).not.toHaveBeenCalled();
});
it("passes a valid request into the existing transaction", async () => {
  mocks.transaction.mockResolvedValue({ reservation: {} });
  await POST(req('{"checkOutDate":"2030-01-01"}'), ctx);
  expect(mocks.transaction).toHaveBeenCalledOnce();
  expect(mocks.transaction.mock.calls[0][1]).toMatchObject({ isolationLevel: "ReadCommitted" });
});
