import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

const state = vi.hoisted(() => ({
  admin: vi.fn(),
  transaction: vi.fn(),
  query: vi.fn(),
  find: vi.fn(),
  update: vi.fn(),
  audit: vi.fn(),
  invoiceFindFirst: vi.fn(),
  invoiceCreate: vi.fn(),
  hotelFind: vi.fn(),
  hotelUpdate: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({ getPlatformAdminFromRoute: state.admin }));
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: state.transaction } }));
vi.mock("@/lib/entitlements", () => ({
  evaluateSubscriptionStatus: vi.fn(),
  getOrBootstrapSubscription: vi.fn(),
  getHotelUsageAndSubscription: vi.fn(),
}));
import { PATCH } from "@/app/api/platform/hotels/[id]/subscription/route";

const input = { action: "ACTIVATE_MANUAL_PAYMENT", referenceCode: "  sjk89l2m1p ", amountPaid: 1500, durationDays: 30, reason: "Verified deposit" };
const params = { params: Promise.resolve({ id: "hotel-a" }) };
const request = (value: unknown) => new Request("https://example.test/api/platform/hotels/hotel-a/subscription", { method: "PATCH", body: JSON.stringify(value) });

beforeEach(() => {
  vi.resetAllMocks();
  state.admin.mockResolvedValue({ userId: "admin-a", platformRole: "PLATFORM_SUPER_ADMIN" });
  state.query.mockImplementation(async (strings: TemplateStringsArray) => strings.join("").includes("SELECT EXISTS") ? [{ duplicate: false }] : []);
  state.find.mockResolvedValue({
    id: "sub-a",
    hotelId: "hotel-a",
    planId: "BAND_1_10",
    billingInterval: "MONTHLY",
    status: "ACTIVE",
    currency: "KES",
    currentPeriodStartsAt: new Date("2026-01-01Z"),
    currentPeriodEndsAt: new Date("2099-01-01Z"),
    metadata: { payments: [] },
  });
  state.update.mockImplementation(async ({ data }) => ({ id: "sub-a", hotelId: "hotel-a", ...data }));
  state.invoiceFindFirst.mockResolvedValue(null);
  state.invoiceCreate.mockImplementation(async ({ data }) => ({ id: "inv-1", ...data }));
  state.hotelFind.mockResolvedValue({ status: "ACTIVE" });
  state.hotelUpdate.mockResolvedValue({ status: "ACTIVE" });
  state.audit.mockResolvedValue({ id: "audit-1" });
  state.transaction.mockImplementation(async (callback) =>
    callback({
      $queryRaw: state.query,
      subscription: { findUnique: state.find, update: state.update },
      subscriptionInvoice: { findFirst: state.invoiceFindFirst, create: state.invoiceCreate },
      hotel: { findUnique: state.hotelFind, update: state.hotelUpdate },
      auditLog: { create: state.audit },
    })
  );
});

describe("manual payment subscription action", () => {
  it("normalizes the reference, extends a prepaid period, issues a PAID invoice, and records audit data", async () => {
    const response = await PATCH(request(input), params);
    expect(response.status).toBe(200);
    expect(state.hotelUpdate).toHaveBeenCalledWith({ where: { id: "hotel-a" }, data: { status: "ACTIVE" } });
    const json = await response.json();
    expect(json.invoiceNumber).toMatch(/^SUB-INV-\d{4}-0001$/);
    expect(state.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      status: "ACTIVE", suspendedAt: null, canceledAt: null, suspensionReason: null, cancelAtPeriodEnd: false,
      currentPeriodStartsAt: new Date("2026-01-01Z"), currentPeriodEndsAt: new Date("2099-01-31Z"),
      metadata: expect.objectContaining({ payments: [expect.objectContaining({ referenceCode: "SJK89L2M1P", amountPaid: 1500, adminUserId: "admin-a" })] }),
    }) }));
    expect(state.invoiceCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        hotelId: "hotel-a",
        status: "PAID",
        paymentReference: "SJK89L2M1P",
        currency: "KES",
      }),
    }));
    expect(state.audit).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        action: "PLATFORM_MANUAL_PAYMENT_ACTIVATED",
        hotelId: "hotel-a",
        userId: "admin-a",
        metadata: expect.objectContaining({ referenceCode: "SJK89L2M1P", invoiceId: "inv-1" }),
      }),
    }));
  });

  it("restores a suspended hotel back to ACTIVE status upon manual payment recovery", async () => {
    state.find.mockResolvedValue({
      id: "sub-a",
      hotelId: "hotel-a",
      planId: "BAND_1_10",
      billingInterval: "MONTHLY",
      status: "SUSPENDED",
      currency: "KES",
      currentPeriodStartsAt: new Date("2025-01-01Z"),
      currentPeriodEndsAt: new Date("2025-02-01Z"),
      metadata: { payments: [] },
    });
    state.hotelFind.mockResolvedValue({ status: "SUSPENDED" });

    const response = await PATCH(request(input), params);
    expect(response.status).toBe(200);
    expect(state.hotelUpdate).toHaveBeenCalledWith({
      where: { id: "hotel-a" },
      data: { status: "ACTIVE" },
    });
  });

  it("returns 409 for a previously redeemed normalized reference without updating", async () => {
    state.query.mockImplementation(async (strings: TemplateStringsArray) => strings.join("").includes("SELECT EXISTS") ? [{ duplicate: true }] : []);
    const response = await PATCH(request(input), params);
    expect(response.status).toBe(409);
    expect(state.query.mock.calls[1][1]).toBe("SJK89L2M1P");
    expect(state.update).not.toHaveBeenCalled();
    expect(state.invoiceCreate).not.toHaveBeenCalled();
    expect(state.audit).not.toHaveBeenCalled();
  });
  it("rejects invalid data before touching the database", async () => {
    const response = await PATCH(request({ ...input, amountPaid: 0 }), params);
    expect(response.status).toBe(400);
    expect((await response.json()).issues.length).toBeGreaterThan(0);
    expect(state.transaction).not.toHaveBeenCalled();
  });
  it("prevents non-super-admin reactivation of a cancelled hotel", async () => {
    state.admin.mockResolvedValue({ userId: "support", platformRole: "PLATFORM_SUPPORT" });
    state.hotelFind.mockResolvedValue({ status: "CANCELLED" });
    const response = await PATCH(request(input), params);
    expect(response.status).toBe(403);
    expect(state.hotelUpdate).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    expect(state.audit).not.toHaveBeenCalled();
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
