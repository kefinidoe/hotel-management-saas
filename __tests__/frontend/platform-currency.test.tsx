// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within, cleanup } from "@testing-library/react";
import PlatformClient from "@/components/platform/PlatformClient";
import { formatPlatformPrice } from "@/lib/platform-currency";

const entry = (id: string, hotelCurrency: string, currency: string | null, amountExact: string) => ({
  hotelId: id, hotelName: id, hotelSlug: id, currency: hotelCurrency,
  subscription: { planId: "STARTER", planName: "Starter", amountExact, currency, billingInterval: "MONTHLY", storedStatus: "ACTIVE", effectiveStatus: "ACTIVE", isOverdue: false, currentPeriodEndsAt: null, daysRemaining: null },
  usage: { rooms: { current: 1, max: 10 }, staff: { current: 1, max: 5 } },
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("platform subscription currency", () => {
  it("formats exact decimal strings and falls back to hotel currency or KES", () => {
    expect(formatPlatformPrice("52.00", "USD", "KES")).toBe("USD 52");
    expect(formatPlatformPrice("3500.00", "KES")).toBe("KES 3,500");
    expect(formatPlatformPrice("12345678901234567890.01", null, "USD")).toBe("USD 12,345,678,901,234,567,890.01");
    expect(formatPlatformPrice("0.10", null, null)).toBe("KES 0.1");
  });
  it("shows the subscription billing currency in both table and Manage Plan modal", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.startsWith("/api/platform/subscriptions")) return Response.json({ subscriptions: [entry("USD Hotel", "KES", "USD", "52.00"), entry("KES Hotel", "KES", null, "3500.00")], summary: null });
      if (url.startsWith("/api/platform/hotels")) return Response.json({ hotels: [] });
      return Response.json({ metrics: null, recentHotels: [], recentAuditLogs: [] });
    }));
    render(<PlatformClient />);
    fireEvent.click(screen.getByRole("button", { name: /Subscriptions & Plans/i }));
    const usd = await screen.findByText("USD 52 / monthly");
    expect(screen.getByText("KES 3,500 / monthly")).toBeTruthy();
    const row = usd.closest("tr")!;
    fireEvent.click(within(row).getByRole("button", { name: /Manage Plan/i }));
    expect(screen.getByText(/Current price: USD 52 \/ monthly/)).toBeTruthy();
  });
});
