// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import SubscriptionClient from "@/components/subscription/SubscriptionClient";

const subscriptionData = {
  hotel: { id: "hotel-123", name: "Example Hotel", currency: "KES" },
  subscription: {
    effectiveStatus: "PAST_DUE", bandName: "Starter", planId: "STARTER",
    billingInterval: "MONTHLY", amount: 10, currency: "USD", limits: { maxRooms: 10 },
    currentPeriodStartsAt: "2026-01-01T00:00:00.000Z", currentPeriodEndsAt: null,
  },
  billableBreakdown: { billableActiveRooms: 3, statusBreakdown: {}, recommendedBandId: "STARTER" },
  pricingSchedule: { isScheduleApproved: false, defaultAnnualDiscountPercent: 0, options: { yearly: { savingsVsMonthly: 0 } } },
  roomBands: [{ id: "STARTER", name: "Starter", minRooms: 1, maxRooms: 10, monthlyPriceUSD: 10, monthlyPriceKES: 1500, yearlyPriceUSD: 120, yearlyPriceKES: 18000 }],
};

afterEach(() => vi.unstubAllGlobals());

describe("subscription manual payment instructions", () => {
  it("shows payment details and the current hotel's reference without initiating payment", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(subscriptionData), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SubscriptionClient />);
    const region = await screen.findByRole("region", { name: "Pay your subscription manually" });
    expect(within(region).getByText("400200")).toBeTruthy();
    expect(within(region).getByText("01102662965002")).toBeTruthy();
    expect(within(region).getByText("hotel-123")).toBeTruthy();
    expect(within(region).getByText("Example Hotel")).toBeTruthy();
    expect(within(region).getByText(/Account reference: your Hotel ID or hotel name/)).toBeTruthy();
    expect(within(region).getByText(/Payment reference: your Hotel ID or hotel name/)).toBeTruthy();
    expect(within(region).getByText(/transaction reference/).textContent).toMatch(/verify and record the payment/);
    expect(within(region).getByText(/Payment does not activate/)).toBeTruthy();
    expect(within(region).getByText(/Confirm the amount and currency/)).toBeTruthy();
    expect(within(region).queryByRole("button")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/subscription");
    expect(screen.getAllByText("$10").length).toBeGreaterThan(0);
    expect(screen.getByText("Not specified")).toBeTruthy();
    expect(screen.queryByText(/Automatic Monthly Renewal/)).toBeNull();
    expect(screen.queryByText(/Live automated billing/)).toBeNull();
  });

  it("does not display payment instructions when subscription details fail to load", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    render(<SubscriptionClient />);
    expect(await screen.findByText(/Failed to load subscription \(403\)/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Pay your subscription manually" })).toBeNull();
  });
});
