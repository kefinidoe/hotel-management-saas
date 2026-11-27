// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import SubscriptionClient from "@/components/subscription/SubscriptionClient";

const restrictedSubscriptionPayload = {
  hotel: { id: "hotel-123", name: "Coastal Suites", currency: "USD", status: "ACTIVE" },
  subscription: {
    id: "sub-1",
    effectiveStatus: "READ_ONLY",
    storedStatus: "READ_ONLY",
    bandName: "Band 2 (11–25 Rooms)",
    planId: "BAND_11_25",
    billingInterval: "MONTHLY",
    amount: 35,
    currency: "USD",
    limits: { maxRooms: 25 },
    currentPeriodStartsAt: "2026-01-01T00:00:00.000Z",
    currentPeriodEndsAt: "2026-02-01T00:00:00.000Z",
  },
  lifecycle: {
    stage: "READ_ONLY",
    accessMode: "READ_ONLY",
    canReadOperations: true,
    canWriteOperations: false,
    canExportRecords: true,
    canRecoverBilling: true,
    overdueDays: 24,
    nextStage: "SUSPENDED",
    daysUntilNextStage: 11,
    nextTransitionAt: "2026-03-08T00:00:00.000Z",
    summaryMessage: "Account in read-only mode — operational records are view-and-export only.",
    recoverySteps: [
      "Settle via M-Pesa Paybill 400200 or Co-op Bank account 01102662965002.",
    ],
  },
  billingHistory: [
    {
      id: "inv-1",
      invoiceNumber: "SUB-INV-2026-0001",
      status: "ISSUED",
      planName: "Band 2 (11–25 Rooms)",
      currency: "USD",
      amount: 35,
      amountPaid: 0,
      balanceDue: 35,
      periodStartsAt: "2026-02-01T00:00:00.000Z",
      periodEndsAt: "2026-03-01T00:00:00.000Z",
      issuedAt: "2026-02-01T00:00:00.000Z",
      paymentReference: null,
      downloadPdfUrl: "/api/subscription/invoices/inv-1?format=pdf",
    },
  ],
  billableBreakdown: { billableActiveRooms: 14, statusBreakdown: {}, recommendedBandId: "BAND_11_25" },
  pricingSchedule: {
    isScheduleApproved: false,
    defaultAnnualDiscountPercent: 20,
    options: { yearly: { savingsVsMonthly: 84 } },
  },
  roomBands: [
    {
      id: "BAND_11_25",
      name: "Band 2 (11–25 Rooms)",
      minRooms: 11,
      maxRooms: 25,
      monthlyPriceUSD: 35,
      monthlyPriceKES: 4500,
      yearlyPriceUSD: 336,
      yearlyPriceKES: 43200,
    },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe("SubscriptionClient lifecycle, billing history, and export sections", () => {
  it("renders lifecycle recovery banner, invoice history PDF links, and export links in a single mount fetch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(restrictedSubscriptionPayload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    render(<SubscriptionClient />);

    const lifecycleSection = await screen.findByRole("region", {
      name: /Lifecycle Access: READ_ONLY/,
    });
    expect(within(lifecycleSection).getByText(/Operations Write: Blocked/)).toBeTruthy();
    expect(within(lifecycleSection).getByText(/24 day\(s\)/)).toBeTruthy();

    const billingSection = screen.getByRole("region", {
      name: /Subscription Invoices & Billing History/,
    });
    expect(within(billingSection).getByText("SUB-INV-2026-0001")).toBeTruthy();
    const pdfLink = within(billingSection).getByRole("link", { name: /PDF/ });
    expect(pdfLink.getAttribute("href")).toBe("/api/subscription/invoices/inv-1?format=pdf");

    const exportSection = screen.getByRole("region", {
      name: /Workspace Data Export & Backup/,
    });
    expect(within(exportSection).getByRole("link", { name: /Export JSON/ }).getAttribute("href")).toBe(
      "/api/subscription/export?format=json"
    );
    expect(within(exportSection).getByRole("link", { name: /Export Excel/ }).getAttribute("href")).toBe(
      "/api/subscription/export?format=xlsx"
    );
    expect(within(exportSection).getByRole("link", { name: /Summary PDF/ }).getAttribute("href")).toBe(
      "/api/subscription/export?format=pdf"
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/subscription");
  });
});
