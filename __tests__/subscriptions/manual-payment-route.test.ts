import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const state = vi.hoisted(() => ({
  admin: vi.fn(), transaction: vi.fn(), query: vi.fn(), find: vi.fn(), update: vi.fn(), audit: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({ getPlatformAdminFromRoute: state.admin }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: state.transaction } }));
vi.mock("@/lib/entitlements", () => ({ evaluateSubscriptionStatus: vi.fn(), getOrBootstrapSubscription: vi.fn(), getHotelUsageAndSubscription: vi.fn() }));
import { PATCH } from "@/app/api/platform/hotels/[id]/subscription/route";

const input = { action: "ACTIVATE_MANUAL_PAYMENT", referenceCode: "  sjk89l2m1p ", amountPaid: 1500, durationDays: 30, reason: "Verified deposit" };
const params = { params: Promise.resolve({ id: "hotel-a" }) };
const request = (value: unknown) => new Request("https://example.test/api/platform/hotels/hotel-a/subscription", { method: "PATCH", body: JSON.stringify(value) });

beforeEach(() => {
  vi.resetAllMocks();
  state.admin.mockResolvedValue({ userId: "admin-a", platformRole: "PLATFORM_SUPER_ADMIN" });
  state.query.mockImplementation(async (strings: TemplateStringsArray) => strings.join("").includes("SELECT EXISTS") ? [{ duplicate: false }] : []);
  state.find.mockResolvedValue({ id: "sub-a", hotelId: "hotel-a", status: "ACTIVE", currency: "KES", currentPeriodStartsAt: new Date("2026-01-01Z"), currentPeriodEndsAt: new Date("2099-01-01Z"), metadata: { payments: [] } });
  state.update.mockImplementation(async ({ data }) => ({ id: "sub-a", hotelId: "hotel-a", ...data }));
  state.audit.mockResolvedValue({ id: "audit-1" });
  state.transaction.mockImplementation(async (callback) => callback({ $queryRaw: state.query, subscription: { findUnique: state.find, update: state.update }, auditLog: { create: state.audit } }));
});

describe("manual payment subscription action", () => {
  it("normalizes the reference, extends a prepaid period and records audit data", async () => {
    const response = await PATCH(request(input), params);
    expect(response.status).toBe(200);
    expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: "ACTIVE", suspendedAt: null, suspensionReason: null,
      currentPeriodStartsAt: new Date("2026-01-01Z"), currentPeriodEndsAt: new Date("2099-01-31Z"),
      metadata: expect.objectContaining({ payments: [expect.objectContaining({ referenceCode: "SJK89L2M1P", amountPaid: 1500, adminUserId: "admin-a" })] }),
    }) }));
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: "PLATFORM_MANUAL_PAYMENT_ACTIVATED", hotelId: "hotel-a", userId: "admin-a", metadata: expect.objectContaining({ referenceCode: "SJK89L2M1P" }) }) }));
  });
  it("returns 409 for a previously redeemed normalized reference without updating", async () => {
    state.query.mockImplementation(async (strings: TemplateStringsArray) => strings.join("").includes("SELECT EXISTS") ? [{ duplicate: true }] : []);
    const response = await PATCH(request(input), params);
    expect(response.status).toBe(409);
    expect(state.query.mock.calls[1][1]).toBe("SJK89L2M1P");
    expect(state.update).not.toHaveBeenCalled();
    expect(state.audit).not.toHaveBeenCalled();
  });
  it("rejects invalid data before touching the database", async () => {
    const response = await PATCH(request({ ...input, amountPaid: 0 }), params);
    expect(response.status).toBe(400);
    expect((await response.json()).issues.length).toBeGreaterThan(0);
    expect(state.transaction).not.toHaveBeenCalled();
  });
  it("does not call the transaction for an unauthorized actor", async () => {
    state.admin.mockResolvedValue(NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }));
    expect((await PATCH(request(input), params)).status).toBe(403);
    expect(state.transaction).not.toHaveBeenCalled();
  });
  it("reports audit failure rather than reporting a successful activation", async () => {
    state.audit.mockRejectedValue(new Error("audit unavailable"));
    expect((await PATCH(request(input), params)).status).toBe(500);
  });
});
