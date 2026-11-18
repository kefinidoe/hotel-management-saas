// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CreateReservationModal from "@/components/reservations/CreateReservationModal";
import { priceCustomStay } from "@/lib/pricing/custom-rate-rules";

const meals = [
  { id: "meal-a", name: "Breakfast", pricePerNight: 100, perGuest: true, isActive: true },
  { id: "meal-b", name: "Dinner", pricePerNight: 200, perGuest: false, isActive: true },
];
const occupancies = [
  { id: "occ-a", label: "Single", includedAdults: 1, surchargeAmount: 50, extraAdultRate: 75, isActive: true },
  { id: "occ-b", label: "Double", includedAdults: 2, surchargeAmount: 250, extraAdultRate: 50, isActive: true },
];
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
afterEach(() => vi.unstubAllGlobals());
it("re-quotes occupancy, meal and guest changes and submits the approved selection", async () => {
  const calls: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/settings/hotel") return json({ useModularPricing: false, useCustomRateRules: true });
    if (url === "/api/settings/pricing/rules") return json({ mealPlanRates: meals, occupancyRateRules: occupancies });
    if (url === "/api/reservations/quote") {
      const body = JSON.parse(String(init?.body)); calls.push(body);
      const breakdown = priceCustomStay({ currency: "KES", roomType: { id: "rt", name: "Suite", baseRate: 1000, maxAdults: 4, maxChildren: 3 }, meal: meals.find((row) => row.id === body.mealPlanId)!, occupancy: occupancies.find((row) => row.id === body.occupancyTypeId)!, adults: body.adults, children: body.children, checkIn: new Date(body.checkInDate), checkOut: new Date(body.checkOutDate), discount: 0 });
      return json({ ...breakdown, roomId: "room", roomNumber: "101", availableOccupancies: [], availableMealPlans: [] });
    }
    return json({ id: "reservation", code: "R1" });
  });
  vi.stubGlobal("fetch", fetcher);
  render(<CreateReservationModal rooms={[{ id: "room", number: "101", roomTypeId: "rt", roomTypeName: "Suite", baseRate: 1000, status: "AVAILABLE" }]} roomTypes={[{ id: "rt", name: "Suite", baseRate: 1000, mealPlan: null, maxAdults: 4, maxChildren: 3 }]} defaultRoomId="room" defaultDate={new Date("2027-12-01T00:00:00Z")} currency="KES" canApplyDiscount={false} onClose={() => {}} onCreated={() => {}} onError={() => {}} />);
  await screen.findByTestId("custom-occupancy");
  await waitFor(() => expect(screen.getByText(/Approved rate per night/)).toBeTruthy());
  expect(screen.getByTestId("approved-rate").textContent).toContain("1,150");
  fireEvent.change(screen.getByTestId("adults"), { target: { value: "2" } });
  fireEvent.change(screen.getByTestId("children"), { target: { value: "1" } });
  fireEvent.change(screen.getByTestId("custom-occupancy"), { target: { value: "occ-b" } });
  fireEvent.change(screen.getByTestId("custom-meal"), { target: { value: "meal-b" } });
  expect(screen.getByTestId("approved-rate").textContent).toContain("1,450");
  expect(screen.getByTestId("price-breakdown").textContent).toContain("1,450");
  await waitFor(() => expect(calls.at(-1)).toMatchObject({ occupancyTypeId: "occ-b", mealPlanId: "meal-b", adults: 2, children: 1 }));
  await waitFor(() => expect(screen.getByText(/Approved rate per night/)).toBeTruthy());
  const name = document.querySelector("form input:not([type])") as HTMLInputElement;
  fireEvent.change(name, { target: { value: "Amina" } });
  fireEvent.click(screen.getByRole("button", { name: /create reservation/i }));
  await waitFor(() => expect(fetcher.mock.calls.some(([url, init]) => url === "/api/reservations" && JSON.parse(String(init?.body)).approvedRate === 1450)).toBe(true));
});
