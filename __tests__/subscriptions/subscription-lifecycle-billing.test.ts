import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import {
  evaluateSubscriptionStatus,
  getSubscriptionLifecycleSummary,
} from "@/lib/entitlements";
import { PRICING_CONFIG, SubscriptionStatus, BillingInterval } from "@/lib/plans";
import {
  buildSubscriptionInvoicePdf,
  serializeSubscriptionInvoice,
} from "@/lib/subscription-invoices";
import {
  buildTenantExportPdf,
  buildTenantExportWorkbook,
  type TenantExportPayload,
} from "@/lib/subscription-export";

const DAY_MS = 86_400_000;

const mocks = vi.hoisted(() => ({
  billingTenant: vi.fn(),
  invoiceFindFirst: vi.fn(),
  hotelFindUnique: vi.fn(),
  auditCreate: vi.fn(),
}));

describe("Subscription lifecycle, invoices, recovery, and export regressions", () => {
  it("keeps commercial pricing schedule unapproved unless explicitly signed off", () => {
    expect(PRICING_CONFIG.isScheduleApproved).toBe(false);
  });

  it("evaluates the complete trial escalation ladder accurately", () => {
    const now = new Date("2026-06-01T12:00:00.000Z");

    const activeTrial = evaluateSubscriptionStatus(
      { status: SubscriptionStatus.TRIALING, trialEndsAt: new Date(now.getTime() + 5 * DAY_MS) },
      now
    );
    expect(activeTrial).toMatchObject({ effectiveStatus: "TRIALING", isOperational: true, isOverdue: false });

    const expiredTrial = evaluateSubscriptionStatus(
      { status: SubscriptionStatus.TRIALING, trialEndsAt: new Date(now.getTime() - 3 * DAY_MS) },
      now
    );
    expect(expiredTrial).toMatchObject({ effectiveStatus: "TRIAL_EXPIRED", isOperational: false, isOverdue: true });

    const restrictedTrial = evaluateSubscriptionStatus(
      { status: SubscriptionStatus.TRIALING, trialEndsAt: new Date(now.getTime() - 10 * DAY_MS) },
      now
    );
    expect(restrictedTrial).toMatchObject({ effectiveStatus: "RESTRICTED", isOperational: false, isOverdue: true });

    const readOnlyTrial = evaluateSubscriptionStatus(
      { status: SubscriptionStatus.TRIALING, trialEndsAt: new Date(now.getTime() - 20 * DAY_MS) },
      now
    );
    expect(readOnlyTrial).toMatchObject({ effectiveStatus: "READ_ONLY", isOperational: false, isOverdue: true });

    const suspendedTrial = evaluateSubscriptionStatus(
      { status: SubscriptionStatus.TRIALING, trialEndsAt: new Date(now.getTime() - 35 * DAY_MS) },
      now
    );
    expect(suspendedTrial).toMatchObject({ effectiveStatus: "SUSPENDED", isOperational: false, isOverdue: true });
  });

  it("evaluates the complete paid lifecycle escalation ladder (ACTIVE -> PAST_DUE grace -> PAST_DUE locked -> RESTRICTED -> READ_ONLY -> SUSPENDED -> CANCELLED)", () => {
    const now = new Date("2026-06-01T12:00:00.000Z");

    expect(
      evaluateSubscriptionStatus(
        { status: SubscriptionStatus.ACTIVE, currentPeriodEndsAt: new Date(now.getTime() + 10 * DAY_MS) },
        now
      )
    ).toMatchObject({ effectiveStatus: "ACTIVE", isOperational: true, isOverdue: false });

    expect(
      evaluateSubscriptionStatus(
        { status: SubscriptionStatus.ACTIVE, currentPeriodEndsAt: new Date(now.getTime() - 4 * DAY_MS) },
        now
      )
    ).toMatchObject({ effectiveStatus: "PAST_DUE", isOperational: true, isOverdue: true });

    expect(
      evaluateSubscriptionStatus(
        { status: SubscriptionStatus.ACTIVE, currentPeriodEndsAt: new Date(now.getTime() - 10 * DAY_MS) },
        now
      )
    ).toMatchObject({ effectiveStatus: "PAST_DUE", isOperational: false, isOverdue: true });

    expect(
      evaluateSubscriptionStatus(
        { status: SubscriptionStatus.ACTIVE, currentPeriodEndsAt: new Date(now.getTime() - 18 * DAY_MS) },
        now
      )
    ).toMatchObject({ effectiveStatus: "RESTRICTED", isOperational: false, isOverdue: true });

    expect(
      evaluateSubscriptionStatus(
        { status: SubscriptionStatus.ACTIVE, currentPeriodEndsAt: new Date(now.getTime() - 28 * DAY_MS) },
        now
      )
    ).toMatchObject({ effectiveStatus: "READ_ONLY", isOperational: false, isOverdue: true });

    expect(
      evaluateSubscriptionStatus(
        { status: SubscriptionStatus.ACTIVE, currentPeriodEndsAt: new Date(now.getTime() - 40 * DAY_MS) },
        now
      )
    ).toMatchObject({ effectiveStatus: "SUSPENDED", isOperational: false, isOverdue: true });

    expect(
      evaluateSubscriptionStatus({ status: SubscriptionStatus.CANCELLED }, now)
    ).toMatchObject({ effectiveStatus: "CANCELLED", isOperational: false, isOverdue: false });
  });

  it("produces accurate lifecycle access mode and recovery countdowns", () => {
    const now = new Date("2026-06-01T12:00:00.000Z");
    const periodEnd = new Date(now.getTime() - 16 * DAY_MS);
    const summary = getSubscriptionLifecycleSummary(
      {
        storedStatus: SubscriptionStatus.ACTIVE,
        effectiveStatus: "RESTRICTED",
        isOperational: false,
        trialEndsAt: null,
        currentPeriodEndsAt: periodEnd,
        suspensionReason: null,
      },
      now
    );

    expect(summary.accessMode).toBe("READ_ONLY");
    expect(summary.canReadOperations).toBe(true);
    expect(summary.canWriteOperations).toBe(false);
    expect(summary.canExportRecords).toBe(true);
    expect(summary.canRecoverBilling).toBe(true);
    expect(summary.nextStage).toBe("READ_ONLY");
    expect(summary.daysUntilNextStage).toBe(5);

    const cancelledSummary = getSubscriptionLifecycleSummary(
      {
        storedStatus: SubscriptionStatus.CANCELLED,
        effectiveStatus: "CANCELLED",
        isOperational: false,
        trialEndsAt: null,
        currentPeriodEndsAt: periodEnd,
        suspensionReason: "Closed property",
      },
      now
    );
    expect(cancelledSummary.accessMode).toBe("BILLING_EXPORT_ONLY");
    expect(cancelledSummary.canReadOperations).toBe(false);
    expect(cancelledSummary.canExportRecords).toBe(true);
  });

  it("generates exact Decimal invoice serialization and valid invoice PDFs", async () => {
    const serialized = serializeSubscriptionInvoice({
      id: "inv-100",
      hotelId: "hotel-1",
      subscriptionId: "sub-1",
      invoiceNumber: "SUB-INV-2026-0001",
      status: "ISSUED",
      planId: "BAND_11_25",
      planName: "Band 2 (11–25 Rooms)",
      billingInterval: BillingInterval.MONTHLY,
      currency: "USD",
      subtotal: new Prisma.Decimal("0.10"),
      taxAmount: new Prisma.Decimal("0.20"),
      amount: new Prisma.Decimal("0.30"),
      amountPaid: new Prisma.Decimal("0.00"),
      periodStartsAt: new Date("2026-06-01T00:00:00.000Z"),
      periodEndsAt: new Date("2026-07-01T00:00:00.000Z"),
      issuedAt: new Date("2026-06-01T00:00:00.000Z"),
      dueAt: new Date("2026-06-08T00:00:00.000Z"),
      paymentMethod: "MANUAL_COOP_MPESA",
    });

    expect(serialized.amount).toBe(0.3);
    expect(serialized.balanceDue).toBe(0.3);
    expect(serialized.downloadPdfUrl).toBe("/api/subscription/invoices/inv-100?format=pdf");

    const pdfBytes = await buildSubscriptionInvoicePdf({
      invoice: serialized,
      hotel: { id: "hotel-1", name: "Coastal Haven", slug: "coastal-haven" },
    });
    expect(Buffer.from(pdfBytes).subarray(0, 5).toString("utf8")).toBe("%PDF-");
  });

  it("builds valid multi-sheet Excel (.xlsx) and summary PDF tenant exports", async () => {
    const payload: TenantExportPayload = {
      exportedAt: "2026-06-01T12:00:00.000Z",
      hotel: {
        id: "hotel-export-1",
        name: "Alpine Retreat",
        slug: "alpine-retreat",
        currency: "KES",
        timezone: "Africa/Nairobi",
        status: "SUSPENDED",
      },
      subscription: {
        id: "sub-1",
        planId: "BAND_1_10",
        planName: "Band 1 (1–10 Rooms)",
        storedStatus: "SUSPENDED",
        effectiveStatus: "SUSPENDED",
        billingInterval: "MONTHLY",
        amount: 2500,
        currency: "KES",
        trialStartsAt: "2026-01-01T00:00:00.000Z",
        trialEndsAt: null,
        currentPeriodStartsAt: "2026-02-01T00:00:00.000Z",
        currentPeriodEndsAt: "2026-03-01T00:00:00.000Z",
        lifecycleSummary: "Suspended workspace",
      },
      billingHistory: [],
      rooms: [{ id: "r1", number: "101", floor: "1", roomType: "Deluxe", baseRate: "5000.00", status: "AVAILABLE", isActive: true }],
      guests: [{ id: "g1", fullName: "Amina Ali", phone: "+254700000001", email: null, idNumber: null, nationality: "KE", isArchived: false, createdAt: "2026-05-01T00:00:00.000Z" }],
      reservations: [{ id: "res1", code: "RES-001", guestName: "Amina Ali", status: "CHECKED_OUT", source: "WALK_IN", checkInDate: "2026-05-02T00:00:00.000Z", checkOutDate: "2026-05-04T00:00:00.000Z", adults: 1, children: 0, rooms: ["101"], discount: "0.00", createdAt: "2026-05-02T00:00:00.000Z" }],
      payments: [{ id: "p1", folioId: "f1", amount: "10000.00", method: "M-Pesa", reference: "MP123", status: "CONFIRMED", reversalOfId: null, createdAt: "2026-05-02T00:00:00.000Z" }],
      expenses: [{ id: "e1", category: "UTILITIES", description: "Water", amount: "1200.50", paymentMethod: "CASH", status: "APPROVED", createdAt: "2026-05-03T00:00:00.000Z" }],
    };

    const xlsxBytes = buildTenantExportWorkbook(payload);
    // ZIP/XLSX magic signature "PK"
    expect(Buffer.from(xlsxBytes).subarray(0, 2).toString("utf8")).toBe("PK");

    const pdfBytes = await buildTenantExportPdf(payload);
    expect(Buffer.from(pdfBytes).subarray(0, 5).toString("utf8")).toBe("%PDF-");
  });
});

describe("Tenant invoice & export route authorization and cross-tenant isolation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
  });

  it("blocks Hotel A from accessing Hotel B's subscription invoice PDF (404 tenant-isolated)", async () => {
    vi.doMock("@/lib/authz", () => ({
      getBillingTenantFromRoute: mocks.billingTenant,
      requireRole: (role: string, allowed: readonly string[]) =>
        allowed.includes(role) ? null : NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }),
    }));
    vi.doMock("@/lib/prisma", () => ({
      prisma: {
        subscriptionInvoice: { findFirst: mocks.invoiceFindFirst },
        hotel: { findUnique: mocks.hotelFindUnique },
      },
    }));

    mocks.billingTenant.mockResolvedValue({
      userId: "owner-a",
      hotelId: "hotel-a",
      role: "HOTEL_OWNER",
      hotel: { id: "hotel-a", name: "Hotel A", slug: "hotel-a", currency: "KES", status: "SUSPENDED" },
    });
    mocks.invoiceFindFirst.mockResolvedValue(null);

    const { GET } = await import("@/app/api/subscription/invoices/[id]/route");
    const res = await GET(new Request("http://localhost/api/subscription/invoices/inv-hotel-b?format=pdf"), {
      params: Promise.resolve({ id: "inv-hotel-b" }),
    });

    expect(res.status).toBe(404);
    expect(mocks.invoiceFindFirst).toHaveBeenCalledWith({
      where: { id: "inv-hotel-b", hotelId: "hotel-a" },
    });
  });

  it("allows Hotel A owner to export JSON workspace backup even when hotel is SUSPENDED, and rejects non-admin staff", async () => {
    vi.doMock("@/lib/authz", () => ({
      getBillingTenantFromRoute: mocks.billingTenant,
      requireRole: (role: string, allowed: readonly string[]) =>
        allowed.includes(role) ? null : NextResponse.json({ error: "FORBIDDEN" }, { status: 403 }),
    }));
    vi.doMock("@/lib/prisma", () => ({
      prisma: {
        auditLog: { create: mocks.auditCreate },
      },
    }));
    vi.doMock("@/lib/subscription-export", () => ({
      buildTenantExportPayload: vi.fn().mockResolvedValue({
        exportedAt: "2026-06-01T00:00:00.000Z",
        hotel: { id: "hotel-a", name: "Hotel A", slug: "hotel-a", currency: "KES", timezone: "UTC", status: "SUSPENDED" },
        subscription: { id: "sub-a", effectiveStatus: "SUSPENDED" },
        billingHistory: [],
        rooms: [{ id: "r1" }],
        guests: [],
        reservations: [],
        payments: [],
        expenses: [],
      }),
      buildTenantExportWorkbook: vi.fn(),
      buildTenantExportPdf: vi.fn(),
    }));

    mocks.billingTenant.mockResolvedValue({
      userId: "owner-a",
      hotelId: "hotel-a",
      role: "HOTEL_OWNER",
      hotel: { id: "hotel-a", name: "Hotel A", slug: "hotel-a", currency: "KES", status: "SUSPENDED" },
    });

    const { GET } = await import("@/app/api/subscription/export/route");
    const ownerRes = await GET(new Request("http://localhost/api/subscription/export?format=json"));
    expect(ownerRes.status).toBe(200);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          hotelId: "hotel-a",
          action: "SUBSCRIPTION_DATA_EXPORTED",
        }),
      })
    );

    mocks.billingTenant.mockResolvedValue({
      userId: "staff-a",
      hotelId: "hotel-a",
      role: "RECEPTIONIST",
      hotel: { id: "hotel-a", name: "Hotel A", slug: "hotel-a", currency: "KES", status: "SUSPENDED" },
    });
    const staffRes = await GET(new Request("http://localhost/api/subscription/export?format=json"));
    expect(staffRes.status).toBe(403);
  });
});

describe("Operational route write-blocking in RESTRICTED and READ_ONLY stages", () => {
  it("allows read routes and blocks write routes with SUBSCRIPTION_RESTRICTED / SUBSCRIPTION_READ_ONLY", async () => {
    vi.resetModules();
    vi.doUnmock("@/lib/authz");
    vi.doUnmock("@/lib/prisma");
    vi.doUnmock("@/lib/subscription-export");

    let currentEffectiveStatus: "RESTRICTED" | "READ_ONLY" | "SUSPENDED" = "RESTRICTED";
    vi.doMock("@/lib/tenant-context", () => ({
      getTenantContext: vi.fn().mockResolvedValue({
        userId: "user-a",
        hotelId: "hotel-a",
        role: "HOTEL_OWNER",
        hotel: { id: "hotel-a", name: "Hotel A", slug: "hotel-a", currency: "KES", status: "ACTIVE" },
      }),
      getBillingTenantContext: vi.fn(),
      requireHotelRole: vi.fn(),
      requirePlatformRole: vi.fn(),
      TenantAuthError: class extends Error {},
    }));
    vi.doMock("@/lib/entitlements", () => ({
      getOrBootstrapSubscription: vi.fn().mockImplementation(async () => ({
        effectiveStatus: currentEffectiveStatus,
        isOperational: false,
      })),
      checkModuleEntitlement: vi.fn(),
      checkUsageLimit: vi.fn(),
      evaluateSubscriptionStatus: vi.fn(),
      getHotelUsageAndSubscription: vi.fn(),
      getSubscriptionLifecycleSummary: vi.fn(),
    }));

    const { getTenantFromRoute } = await import("@/lib/authz");

    // RESTRICTED: read passes, write returns 403 SUBSCRIPTION_RESTRICTED
    const readRestricted = await getTenantFromRoute("read");
    expect("hotelId" in readRestricted && readRestricted.hotelId).toBe("hotel-a");

    const writeRestricted = await getTenantFromRoute("write");
    expect(writeRestricted instanceof NextResponse).toBe(true);
    expect((writeRestricted as NextResponse).status).toBe(403);
    expect(await (writeRestricted as NextResponse).json()).toMatchObject({ error: "SUBSCRIPTION_RESTRICTED" });

    // READ_ONLY: read passes, write returns 403 SUBSCRIPTION_READ_ONLY
    currentEffectiveStatus = "READ_ONLY";
    const readRo = await getTenantFromRoute("read");
    expect("hotelId" in readRo && readRo.hotelId).toBe("hotel-a");

    const writeRo = await getTenantFromRoute("write");
    expect(writeRo instanceof NextResponse).toBe(true);
    expect((writeRo as NextResponse).status).toBe(403);
    expect(await (writeRo as NextResponse).json()).toMatchObject({ error: "SUBSCRIPTION_READ_ONLY" });

    // SUSPENDED: read AND write fail closed
    currentEffectiveStatus = "SUSPENDED";
    const readSusp = await getTenantFromRoute("read");
    expect(readSusp instanceof NextResponse).toBe(true);
    expect((readSusp as NextResponse).status).toBe(403);
    expect(await (readSusp as NextResponse).json()).toMatchObject({ error: "SUBSCRIPTION_SUSPENDED" });
  });
});

describe("Platform billing currency adjustment and invoice issuing", () => {
  it("uses USD rates when ADJUST_BILLING switches interval on a USD subscription", async () => {
    vi.resetModules();
    const updateMock = vi.fn().mockImplementation(async ({ data }) => ({
      id: "sub-usd",
      hotelId: "hotel-usd",
      planId: "BAND_1_10",
      status: "ACTIVE",
      billingInterval: data.billingInterval,
      currency: "USD",
      amount: data.amount,
      trialStartsAt: new Date("2026-01-01Z"),
      trialEndsAt: null,
      currentPeriodStartsAt: new Date("2026-06-01Z"),
      currentPeriodEndsAt: new Date("2027-06-01Z"),
      suspensionReason: null,
    }));
    const auditCreateMock = vi.fn().mockResolvedValue({ id: "aud-1" });

    vi.doMock("@/lib/authz", () => ({
      getPlatformAdminFromRoute: vi.fn().mockResolvedValue({ userId: "admin-1", platformRole: "PLATFORM_SUPER_ADMIN" }),
    }));
    vi.doMock("@/lib/entitlements", () => ({
      evaluateSubscriptionStatus: vi.fn().mockReturnValue({
        effectiveStatus: "ACTIVE",
        isOperational: true,
        isOverdue: false,
        daysRemaining: 365,
      }),
      getOrBootstrapSubscription: vi.fn().mockResolvedValue({ id: "sub-usd" }),
      getHotelUsageAndSubscription: vi.fn(),
    }));
    const currentSub = {
      id: "sub-usd",
      hotelId: "hotel-usd",
      planId: "BAND_1_10",
      status: "ACTIVE",
      billingInterval: "MONTHLY",
      currency: "USD",
      amount: 20,
      trialEndsAt: null,
      currentPeriodEndsAt: new Date("2026-07-01Z"),
    };
    const currentHotel = { status: "ACTIVE", currency: "USD" };

    vi.doMock("@/lib/prisma", () => ({
      prisma: {
        subscription: {
          findUnique: vi.fn().mockResolvedValue(currentSub),
        },
        hotel: {
          findUnique: vi.fn().mockResolvedValue(currentHotel),
        },
        $transaction: vi.fn().mockImplementation(async (cb: any) =>
          cb({
            $queryRaw: vi.fn().mockResolvedValue([]),
            hotel: { findUnique: vi.fn().mockResolvedValue(currentHotel), update: vi.fn().mockResolvedValue(currentHotel) },
            subscription: { findUnique: vi.fn().mockResolvedValue(currentSub), update: updateMock },
            auditLog: { create: auditCreateMock },
          })
        ),
      },
    }));

    const { PATCH } = await import("@/app/api/platform/hotels/[id]/subscription/route");
    const res = await PATCH(
      new Request("http://localhost/api/platform/hotels/hotel-usd/subscription", {
        method: "PATCH",
        body: JSON.stringify({
          action: "ADJUST_BILLING",
          billingInterval: "YEARLY",
          reason: "Hotel requested annual USD billing switch",
        }),
      }),
      { params: Promise.resolve({ id: "hotel-usd" }) }
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    // Must use USD yearly rate (280 USD), NOT KES yearly rate (35,000 KES)
    expect(json.subscription.amount).toBe(280);
    expect(json.subscription.currency).toBe("USD");
  });
});
