// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import DynamicPricingRules from "@/components/settings/DynamicPricingRules";
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());
it("creates a meal rate and shows that activation is unavailable", async () => {
  const bundle = { useCustomRateRules: false, activationAvailable: false, mealPlanRates: [], occupancyRateRules: [] };
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? response({ id: "new" }, 201) : response(bundle));
  vi.stubGlobal("fetch", fetchMock); render(<DynamicPricingRules />);
  expect((await screen.findByLabelText("Enable Dynamic Pricing Rules") as HTMLInputElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Code"), { target: { value: "BB" } });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Breakfast" } });
  fireEvent.change(screen.getByLabelText("Price per night"), { target: { value: "250" } });
  fireEvent.click(screen.getByRole("button", { name: "Save meal plan" }));
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/settings/pricing/rules", expect.objectContaining({ method: "POST", body: JSON.stringify({ kind: "meal", code: "BB", name: "Breakfast", perGuest: true, isActive: true, pricePerNight: 250 }) })));
  expect(await screen.findByRole("status")).toBeTruthy();
});
