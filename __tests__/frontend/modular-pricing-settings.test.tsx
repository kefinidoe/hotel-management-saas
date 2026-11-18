// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import ModularPricingSettings from "@/components/settings/ModularPricingSettings";

const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
let calls: Array<{ url: string; body: unknown }>;
beforeEach(() => {
  calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === "/api/settings/hotel") return reply({ useModularPricing: init?.method === "PATCH" });
    if (url === "/api/settings/meals") return init?.method === "PUT" ? reply({ ok: true }) : reply([
      { mealPlan: "ROOM_ONLY", adultSurcharge: 0, childSurcharge: 0, isActive: true },
      { mealPlan: "HALF_BOARD", adultSurcharge: 500, childSurcharge: 250, isActive: true },
    ]);
    return reply({}, 404);
  }));
});
describe("modular pricing settings", () => {
  it("requires confirmation before activating and explains preserved rates", async () => {
    render(<ModularPricingSettings currency="KES" />);
    const toggle = await screen.findByLabelText(/Enable Modular/);
    fireEvent.click(toggle);
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Existing bookings retain their saved rates/)).toBeTruthy();
    expect(calls.filter((call) => call.url === "/api/settings/hotel")).toHaveLength(1);
    fireEvent.click(within(dialog).getByText("Confirm"));
    await waitFor(() => expect(calls.at(-1)).toEqual({ url: "/api/settings/hotel", body: { useModularPricing: true } }));
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));
  });
  it("saves a plan independently with per-person values", async () => {
    render(<ModularPricingSettings currency="KES" />);
    const adult = await screen.findByLabelText("Half Board adult surcharge");
    fireEvent.change(adult, { target: { value: "800" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Half Board" }));
    await waitFor(() => expect(calls.at(-1)).toEqual({ url: "/api/settings/meals", body: { mealPlan: "HALF_BOARD", adultSurcharge: 800, childSurcharge: 250, isActive: true } }));
  });
});
