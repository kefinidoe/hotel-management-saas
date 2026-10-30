// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import CreateReservationModal from "@/components/reservations/CreateReservationModal";
import { addDays, isoDay } from "@/lib/dates";

/**
 * Regression tests for the two controls that were dead in owner testing:
 * "Approved rate per night" showing "--" and "Create Reservation" being
 * permanently disabled. Both came from the same place: the rate was looked up
 * by matching the tariff *name* against Single/Double/Twin, so a hotel whose
 * room types are named "Standard"/"Deluxe" had no match at all.
 */

const today = isoDay(new Date());
const tomorrow = isoDay(addDays(new Date(), 1));

// A hotel that names its room types after itself, not after an occupancy.
const roomTypes = [
  { id: "rt-standard", name: "Standard", baseRate: 4500, mealPlan: null },
  { id: "rt-deluxe", name: "Deluxe Garden", baseRate: 8500, mealPlan: null },
];

const rooms = [
  { id: "room-101", number: "101", roomTypeId: "rt-standard", roomTypeName: "Standard", baseRate: 4500, status: "AVAILABLE" as const },
  { id: "room-201", number: "201", roomTypeId: "rt-deluxe", roomTypeName: "Deluxe Garden", baseRate: 8500, status: "AVAILABLE" as const },
  { id: "room-301", number: "301", roomTypeId: "rt-standard", roomTypeName: "Standard", baseRate: 4500, status: "OCCUPIED" as const },
];

let fetchMock: ReturnType<typeof vi.fn>;
let created: string[];
let errors: (string | null)[];

function renderModal(overrides: Partial<Parameters<typeof CreateReservationModal>[0]> = {}) {
  return render(
    <CreateReservationModal
      rooms={rooms}
      roomTypes={roomTypes}
      defaultRoomId="room-101"
      defaultDate={new Date()}
      currency="KES"
      canApplyDiscount={false}
      onClose={() => {}}
      onCreated={(id) => created.push(id)}
      onError={(message) => errors.push(message)}
      {...overrides}
    />
  );
}

const submitButton = () => screen.getByRole("button", { name: /create reservation/i }) as HTMLButtonElement;
const rateBox = () => screen.getByTestId("approved-rate");

function dateInputs(): HTMLInputElement[] {
  const inputs = Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
  expect(inputs).toHaveLength(2);
  return inputs;
}

function typeGuestName(value = "Amina Wanjiru") {
  const nameInput = document.querySelector("form input:not([type])") as HTMLInputElement;
  fireEvent.change(nameInput, { target: { value } });
}

beforeEach(() => {
  created = [];
  errors = [];
  fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ id: "res-new", code: "RES-2026-000123" }), {
      status: 201,
      headers: { "Content-Type": "application/json" },
    })
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CreateReservationModal approved rate", () => {
  it("shows the rate for a room whose type is not named after an occupancy", () => {
    renderModal();
    expect(rateBox().textContent).not.toBe("--");
    expect(rateBox().textContent).toContain("4,500");
  });

  it("labels the rate with the hotel's currency, never a hardcoded KSh", () => {
    renderModal({ currency: "USD" });
    expect(screen.getByText(/Approved rate per night \(USD\)/)).toBeTruthy();
    expect(rateBox().textContent).toContain("$");
    expect(document.body.textContent ?? "").not.toContain("KSh");
  });

  it("re-prices when a different room (room type) is selected", () => {
    renderModal();
    expect(rateBox().textContent).toContain("4,500");
    fireEvent.click(screen.getByRole("button", { name: /Room 201/ }));
    expect(rateBox().textContent).toContain("8,500");
  });

  it("shows the total for the number of nights", () => {
    renderModal();
    const total = screen.getByTestId("stay-total");
    expect(total.textContent).toContain("1 night");
    expect(total.textContent).toContain("4,500");
  });

  it("prices the room being sold even when an occupancy tariff also exists", () => {
    renderModal({
      roomTypes: [
        { id: "rt-standard", name: "Standard", baseRate: 4500, mealPlan: null },
        { id: "t-single-bo", name: "Single - Bed Only", baseRate: 5200, mealPlan: "BED_ONLY" },
      ],
    });
    expect(rateBox().textContent).toContain("4,500");
    expect(screen.getByTestId("approved-rate-source").textContent).toContain("Standard");
  });

  it("falls back to the occupancy tariff when the room type has no rate", () => {
    renderModal({
      rooms: [{ id: "room-blank", number: "900", roomTypeId: "rt-blank", roomTypeName: "Unpriced", baseRate: 0, status: "AVAILABLE" }],
      roomTypes: [
        { id: "rt-blank", name: "Unpriced", baseRate: 0, mealPlan: null },
        { id: "t-single-bo", name: "Single - Bed Only", baseRate: 5200, mealPlan: "BED_ONLY" },
      ],
      defaultRoomId: "room-blank",
    });
    expect(rateBox().textContent).toContain("5,200");
    expect(screen.getByTestId("approved-rate-source").textContent).toContain("Single - Bed Only");
  });
});

describe("CreateReservationModal submit state", () => {
  it("stays disabled until the guest name is entered", () => {
    renderModal();
    // Room, dates and rate are already valid: the guest is the missing piece.
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByText("Enter the guest's full name.")).toBeTruthy();
    typeGuestName();
    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByText("Enter the guest's full name.")).toBeNull();
  });

  it("refuses a checkout that is not after check-in", () => {
    renderModal();
    typeGuestName();
    const [checkIn] = dateInputs();
    fireEvent.change(checkIn, { target: { value: tomorrow } });
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByText("Check-out must be at least one night after check-in.")).toBeTruthy();
  });

  it("refuses a room with no configured rate instead of submitting zero", () => {
    renderModal({
      rooms: [{ id: "room-free", number: "999", roomTypeId: "rt-free", roomTypeName: "Free", baseRate: 0, status: "AVAILABLE" }],
      roomTypes: [{ id: "rt-free", name: "Free", baseRate: 0, mealPlan: null }],
      defaultRoomId: "room-free",
    });
    typeGuestName();
    expect(rateBox().textContent).toBe("--");
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByText(/not a valid amount/)).toBeTruthy();
  });

  it("refuses a room that is occupied today", () => {
    renderModal({ defaultRoomId: "room-301" });
    typeGuestName();
    expect(submitButton().disabled).toBe(true);
    expect(
      screen.getAllByText(/Room 301 is Occupied/).length
    ).toBeGreaterThan(0);
    // and it cannot be started even by hand-crafting a submit
    fireEvent.submit(document.querySelector("form") as HTMLFormElement);
    expect(errors[0]).toMatch(/Room 301 is Occupied/);
  });

  it("posts to the reservations API with the room's own tariff and reports success", async () => {
    renderModal();
    typeGuestName();
    fireEvent.click(submitButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/reservations");
    expect(init.method).toBe("POST");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      guestName: "Amina Wanjiru",
      roomId: "room-101",
      tariffId: "rt-standard",
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
    });
    expect(body.discount).toBeNull();
    await waitFor(() => expect(created).toEqual(["res-new"]));
  });

  it("surfaces a rejected submission and re-enables the button", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "That room is already booked for those dates." }), {
        status: 409,
        headers: { "Content-Type": "application/json" },
      })
    );
    renderModal();
    typeGuestName();
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(errors).toContain("That room is already booked for those dates.")
    );
    expect(created).toEqual([]);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
  });

  it("does not apply a discount for a role that may not set one", async () => {
    renderModal({ canApplyDiscount: false });
    typeGuestName();
    expect(screen.queryByText(/Discount \(/)).toBeNull();
    expect(screen.getByText(/Only an owner, admin or manager can apply a discount/)).toBeTruthy();
  });
});
