// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import CreateReservationModal from "@/components/reservations/CreateReservationModal";
import { addDays, isoDay } from "@/lib/dates";

/**
 * The modal displays a provisional local estimate until the server supplies an
 * authoritative quote. Only the server determines the reservation price.
 */

const today = isoDay(new Date());
const nextWeek = isoDay(addDays(new Date(), 7));

const roomTypes = [
  { id: "rt-standard", name: "Standard", baseRate: 4500, mealPlan: null },
  { id: "rt-deluxe", name: "Deluxe Garden", baseRate: 8500, mealPlan: null },
];

const rooms = [
  { id: "room-101", number: "101", roomTypeId: "rt-standard", roomTypeName: "Standard", baseRate: 4500, status: "AVAILABLE" as const },
  { id: "room-201", number: "201", roomTypeId: "rt-deluxe", roomTypeName: "Deluxe Garden", baseRate: 8500, status: "AVAILABLE" as const },
  { id: "room-301", number: "301", roomTypeId: "rt-standard", roomTypeName: "Standard", baseRate: 4500, status: "OCCUPIED" as const },
];

type Quote = Record<string, unknown>;

function quoteFor(overrides: Quote = {}): Quote {
  const nightly = (overrides.nightlyRate as number) ?? 4500;
  const nights = (overrides.nights as number) ?? 1;
  const meals = (overrides.meals as number) ?? 0;
  const room = nightly * nights;
  const total = room + meals;
  return {
    ok: true,
    currency: "KES",
    pricingModel: "ROOM_TYPE_OCCUPANCY",
    nights,
    roomTypeId: "rt-standard",
    roomTypeName: "Standard",
    occupancyTypeId: "occ-double",
    occupancyName: "Double",
    mealPlanId: null,
    mealPlanName: null,
    mealPlanBasis: null,
    nightlyRate: nightly,
    effectiveNightlyRate: nightly,
    adults: 2,
    children: 0,
    extraBeds: 0,
    perNight: [],
    lines: [
      { kind: "ROOM", code: "ROOM", label: `Standard — Double × ${nights} night(s)`, quantity: nights, unitPrice: nightly, amount: room },
      ...(meals
        ? [{ kind: "MEAL_PLAN", code: "MEAL_PLAN", label: "Half Board", quantity: 4, unitPrice: 1500, amount: meals }]
        : []),
    ],
    totals: {
      room,
      adjustments: 0,
      meals,
      extras: 0,
      subtotal: total,
      discount: 0,
      tax: 0,
      grandTotal: total,
      averagePerNight: total / nights,
    },
    taxInclusive: false,
    roomId: "room-101",
    roomNumber: "101",
    availableOccupancies: [
      { id: "occ-single", name: "Single", minAdults: 1, maxAdults: 1, nightlyRate: nightly },
      { id: "occ-double", name: "Double", minAdults: 2, maxAdults: 2, nightlyRate: nightly },
    ],
    availableMealPlans: [
      { id: "mp-half", name: "Half Board", pricingBasis: "PER_PERSON_PER_NIGHT", charge: 1500 },
    ],
    ...overrides,
  };
}

let quotes: Quote[] = [];
// Optional per-call script of successes and refusals, consumed in order.
let quotePlan: (Quote | { __error: string })[] = [];
let quoteCalls: Record<string, unknown>[];
let submitCalls: Record<string, unknown>[];
let quoteError: { status: number; body: { error: string } } | null;
let created: string[];
let errors: (string | null)[];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  quotes = [];
  quotePlan = [];
  quoteCalls = [];
  submitCalls = [];
  quoteError = null;
  created = [];
  errors = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/settings/hotel") return jsonResponse({ useModularPricing: false });
      if (url === "/api/reservations/quote") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        quoteCalls.push(body);
        if (quoteError) return jsonResponse(quoteError.body, quoteError.status);
        const planned = quotePlan.shift();
        if (planned && "__error" in planned) {
          return jsonResponse({ error: planned.__error }, 400);
        }
        const next = planned ?? quotes.shift();
        return jsonResponse(next ?? quoteFor());
      }
      if (url === "/api/reservations") {
        submitCalls.push(JSON.parse(String(init?.body ?? "{}")));
        return jsonResponse({ id: "res-new", code: "RES-2026-000123" }, 201);
      }
      return jsonResponse({ error: "unexpected" }, 500);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

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

function typeGuestName(value = "Amina Wanjiru") {
  const nameInput = document.querySelector("form input:not([type])") as HTMLInputElement;
  fireEvent.change(nameInput, { target: { value } });
}

async function waitForQuote() {
  await waitFor(() => expect(quoteCalls.length).toBeGreaterThan(0));
  await waitFor(() => expect(screen.getByText(/Approved rate per night/)).toBeTruthy());
}

describe("CreateReservationModal pricing", () => {
  it("shows the rate the server quoted", async () => {
    quotes = [quoteFor({ nightlyRate: 4500 })];
    renderModal();
    await waitForQuote();
    expect(rateBox().textContent).toContain("4,500");
    expect(quoteCalls[0]).toMatchObject({ roomId: "room-101" });
  });

  it("labels amounts in the hotel's currency, never a hardcoded KSh", async () => {
    quotes = [quoteFor({ currency: "USD", nightlyRate: 120 })];
    renderModal({ currency: "USD" });
    await waitForQuote();
    expect(screen.getByText(/Approved rate per night \(USD\)/)).toBeTruthy();
    expect(rateBox().textContent).toContain("$");
    expect(document.body.textContent ?? "").not.toContain("KSh");
  });

  it("re-quotes when a different room is chosen and shows the new rate", async () => {
    quotes = [quoteFor({ nightlyRate: 4500 }), quoteFor({ nightlyRate: 8500, roomTypeName: "Deluxe Garden" })];
    renderModal();
    await waitForQuote();
    expect(rateBox().textContent).toContain("4,500");

    fireEvent.click(screen.getByRole("button", { name: /Room 201/ }));
    await waitFor(() => expect(quoteCalls.at(-1)).toMatchObject({ roomId: "room-201" }));
    await waitFor(() => expect(screen.getByText(/Approved rate per night/)).toBeTruthy());
    expect(rateBox().textContent).toContain("8,500");
  });

  it("re-quotes when the meal plan changes and shows the meal charge", async () => {
    quotes = [quoteFor({ nightlyRate: 4500 }), quoteFor({ nightlyRate: 4500, meals: 6000, mealPlanName: "Half Board", mealPlanId: "mp-half" })];
    renderModal();
    await waitForQuote();
    expect(screen.queryByTestId("price-total")?.textContent).toContain("4,500");

    fireEvent.change(screen.getByTestId("meal-plan-select"), { target: { value: "mp-half" } });
    await waitFor(() => expect(screen.getByTestId("price-total").textContent).toContain("10,500"));
    expect(quoteCalls.at(-1)).toMatchObject({ mealPlanId: "mp-half" });
    expect(screen.getByText("Half Board")).toBeTruthy();
  });

  it("re-quotes when the dates change so the nights and totals follow", async () => {
    quotes = [quoteFor({ nightlyRate: 4500, nights: 1 }), quoteFor({ nightlyRate: 4500, nights: 3 })];
    renderModal();
    await waitForQuote();

    const [, checkOut] = Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    fireEvent.change(checkOut, { target: { value: isoDay(addDays(new Date(), 3)) } });

    await waitFor(() => expect(screen.getByTestId("price-total").textContent).toContain("13,500"));
    expect(screen.getByTestId("price-breakdown").textContent).toContain("Price breakdown");
  });

  it("shows the occupancy options the server says this room is sold as", async () => {
    renderModal();
    await waitForQuote();
    const select = screen.getByTestId("occupancy-select") as HTMLSelectElement;
    const options = Array.from(select.options).map((option) => option.textContent);
    expect(options).toContain("Single");
    expect(options).toContain("Double");
  });

  it("keeps the occupancy pickers when a later quote fails", async () => {
    // A capacity refusal is exactly when the receptionist needs to change the
    // occupancy, so the options must not disappear with the failed quote.
    quotes = [quoteFor()];
    renderModal();
    await waitForQuote();

    quoteError = { status: 400, body: { error: "Double allows 2-2 adults." } };
    fireEvent.change(screen.getByTestId("adults"), { target: { value: "3" } });

    await waitFor(() => expect(screen.getByText(/allows 2-2 adults/)).toBeTruthy());
    const select = screen.getByTestId("occupancy-select") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.textContent)).toContain("Double");
    typeGuestName();
    expect(submitButton().disabled).toBe(true);
  });

  it("asks the server for a different occupancy when the party no longer fits", async () => {
    quotePlan = [
      quoteFor({ occupancyTypeId: "occ-single", occupancyName: "Single", nightlyRate: 4500 }),
      { __error: "Single allows 1-1 adults." },
      quoteFor({ occupancyTypeId: "occ-double", occupancyName: "Double", nightlyRate: 8500 }),
    ];
    renderModal();
    await waitForQuote();

    fireEvent.change(screen.getByTestId("adults"), { target: { value: "2" } });

    await waitFor(() =>
      expect((screen.getByTestId("occupancy-select") as HTMLSelectElement).value).toBe("occ-double")
    );
    await waitFor(() => expect(rateBox().textContent).toContain("8,500"));
    expect(quoteCalls.at(-1)).toMatchObject({ roomId: "room-101" });
    expect(quoteCalls.at(-1)?.occupancyTypeId ?? undefined).toBeUndefined();
  });

  it("adopts the occupancy the server defaults to and submits it", async () => {
    quotes = [quoteFor({ occupancyTypeId: "occ-double", occupancyName: "Double" })];
    renderModal();
    await waitForQuote();

    const select = screen.getByTestId("occupancy-select") as HTMLSelectElement;
    expect(select.value).toBe("occ-double");

    typeGuestName();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitCalls.length).toBe(1));
    expect(submitCalls[0]).toMatchObject({ occupancyTypeId: "occ-double", roomId: "room-101" });
  });
});

describe("CreateReservationModal provisional pricing", () => {
  it("shows an estimate and allows a valid submission while the quote is pending, without sending a price", async () => {
    const pending = new Promise<Response>(() => {});
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/settings/hotel") return jsonResponse({ useModularPricing: false });
      if (String(input) === "/api/reservations/quote") return pending;
      submitCalls.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ id: "res-new", code: "RES-1" }, 201);
    }));
    renderModal();
    typeGuestName();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    expect(screen.getByText(/Estimated rate per night/)).toBeTruthy();
    expect(screen.getByText(/Estimate only; the server determines the final price/)).toBeTruthy();
    expect(screen.queryByText(/Approved rate per night/)).toBeNull();
    expect(rateBox().textContent).toContain("4,500");
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitCalls).toHaveLength(1));
    expect(submitCalls[0]).toMatchObject({ roomId: "room-101", tariffId: "rt-standard" });
    expect(submitCalls[0]).not.toHaveProperty("rate");
    expect(submitCalls[0]).not.toHaveProperty("total");
    await waitFor(() => expect(created).toEqual(["res-new"]));
  });

  it("immediately switches the estimate to the selected room's base rate without tariff rows", async () => {
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => String(input) === "/api/settings/hotel" ? Promise.resolve(jsonResponse({ useModularPricing: false })) : new Promise<Response>(() => {})));
    renderModal({ roomTypes: [] });
    typeGuestName();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    expect(rateBox().textContent).toContain("4,500");
    fireEvent.click(screen.getByRole("button", { name: /Room 201/ }));
    expect(rateBox().textContent).toContain("8,500");
    expect(screen.getByText(/Estimated rate per night/)).toBeTruthy();
    expect(submitButton().disabled).toBe(false);
  });

  it("does not use a different room type's matching tariff in place of the selected room's base rate", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/settings/hotel") return jsonResponse({ useModularPricing: false });
      if (String(input) === "/api/reservations/quote") return new Promise<Response>(() => {});
      submitCalls.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ id: "res-new", code: "RES-1" }, 201);
    }));
    renderModal({ roomTypes: [{ id: "other", name: "Single — Bed Only", mealPlan: "BED_ONLY", baseRate: 1000 }] });
    typeGuestName();
    await waitFor(() => expect(submitButton().disabled).toBe(false));
    expect(rateBox().textContent).toContain("4,500");
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitCalls).toHaveLength(1));
    expect(submitCalls[0].tariffId).toBe("rt-standard");
  });

  it("surfaces a server rejection after a provisional attempt", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/settings/hotel" ? jsonResponse({ useModularPricing: false }) : String(input) === "/api/reservations/quote"
        ? jsonResponse({ error: "Choose an occupancy for this room." }, 400)
        : jsonResponse({ error: "Configure occupancy rates before booking." }, 400)
    ));
    renderModal({ roomTypes: [] });
    typeGuestName();
    await waitFor(() => expect(screen.getByText(/Choose an occupancy for this room/)).toBeTruthy());
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() => expect(errors).toContain("Configure occupancy rates before booking."));
    expect(created).toEqual([]);
  });

  it("keeps the fallback provisional and permits retry when quoting is unavailable", async () => {
    quoteError = { status: 503, body: { error: "unavailable" } };
    renderModal();
    typeGuestName();
    await waitFor(() => expect(screen.getByText(/server encountered an error/i)).toBeTruthy());
    expect(screen.getByText(/Estimated rate per night/)).toBeTruthy();
    expect(screen.queryByText(/Approved rate per night/)).toBeNull();
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitCalls).toHaveLength(1));
    expect(submitCalls[0]).not.toHaveProperty("rate");
    expect(submitCalls[0]).not.toHaveProperty("total");
  });

  it("does not enable submission when neither the quote nor the room has a usable rate", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    renderModal({
      rooms: [{ ...rooms[0], baseRate: Number.NaN }],
      roomTypes: [{ ...roomTypes[0], baseRate: 0 }],
    });
    typeGuestName();
    expect(rateBox().textContent).not.toMatch(/NaN|--/);
    expect(screen.getByText(/Set a valid room rate/)).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });

  it("ignores a delayed quote for a room that is no longer selected", async () => {
    let resolveFirst!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => { resolveFirst = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(_input) === "/api/settings/hotel") return jsonResponse({ useModularPricing: false });
      const body = JSON.parse(String(init?.body ?? "{}"));
      quoteCalls.push(body);
      if (body.roomId === "room-101") return pending;
      return jsonResponse(quoteFor({ roomId: "room-201", roomTypeName: "Deluxe Garden", nightlyRate: 8500 }));
    }));
    renderModal();
    await waitFor(() => expect(quoteCalls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Room 201/ }));
    await waitFor(() => expect(screen.getByText(/Approved rate per night/)).toBeTruthy());
    expect(rateBox().textContent).toContain("8,500");
    await act(async () => { resolveFirst(jsonResponse(quoteFor({ nightlyRate: 1200 }))); });
    expect(rateBox().textContent).toContain("8,500");
    expect(rateBox().textContent).not.toContain("1,200");
  });
});

describe("CreateReservationModal submit state", () => {
  it("stays disabled until the guest name is entered", async () => {
    renderModal();
    await waitForQuote();
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByText("Enter the guest's full name.")).toBeTruthy();
    typeGuestName();
    expect(submitButton().disabled).toBe(false);
    expect(screen.queryByText("Enter the guest's full name.")).toBeNull();
  });

  it("refuses a checkout that is not after check-in", async () => {
    renderModal();
    await waitForQuote();
    typeGuestName();
    const [checkIn] = Array.from(document.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    fireEvent.change(checkIn, { target: { value: isoDay(addDays(new Date(), 2)) } });
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByText("Check-out must be at least one night after check-in.")).toBeTruthy();
  });

  it("shows a provisional room rate and allows an attempt when an occupancy rate is missing", async () => {
    quoteError = { status: 400, body: { error: "This room has no nightly rate configured. Set one on the Pricing page." } };
    renderModal({ roomTypes: [] });
    typeGuestName();
    await waitFor(() => expect(screen.getByText(/no nightly rate configured/)).toBeTruthy());
    expect(screen.getByText(/Estimated rate per night/)).toBeTruthy();
    expect(rateBox().textContent).toContain("4,500");
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitCalls).toHaveLength(1));
    expect(submitCalls[0]).not.toHaveProperty("rate");
    expect(submitCalls[0]).not.toHaveProperty("total");
  });

  it("retains a capacity refusal as a validation error", async () => {
    quoteError = { status: 400, body: { error: "Standard sleeps 2. Reduce the guests or the extra beds." } };
    renderModal();
    typeGuestName();
    await waitFor(() => expect(screen.getByText(/sleeps 2/)).toBeTruthy());
    expect(submitButton().disabled).toBe(true);
  });

  it("still blocks an authorization refusal even when its text mentions a missing rate", async () => {
    quoteError = { status: 403, body: { error: "no nightly rate configured" } };
    renderModal();
    typeGuestName();
    await waitFor(() => expect(screen.getByText(/do not have permission/)).toBeTruthy());
    expect(submitButton().disabled).toBe(true);
  });

  it("refuses an occupied room and explains why", async () => {
    renderModal({ defaultRoomId: "room-301" });
    await waitForQuote();
    typeGuestName();
    expect(submitButton().disabled).toBe(true);
    expect(screen.getAllByText(/Room 301 is Occupied/).length).toBeGreaterThan(0);
  });

  it("posts the selected occupancy and meal plan, and no price of its own", async () => {
    quotes = [quoteFor({ nightlyRate: 8500 })];
    renderModal();
    await waitForQuote();
    typeGuestName();
    fireEvent.click(submitButton());

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    const body = submitCalls[0];
    expect(body).toMatchObject({ guestName: "Amina Wanjiru", roomId: "room-101" });
    expect(body.occupancyTypeId).toBe("occ-double");
    expect(body.discount).toBeNull();
    // Nothing that looks like a calculated amount is sent from the browser.
    expect(body).not.toHaveProperty("rate");
    expect(body).not.toHaveProperty("total");
    await waitFor(() => expect(created).toEqual(["res-new"]));
  });

  it("falls back to the legacy tariff fields for a hotel that has not configured occupancy rates", async () => {
    quotes = [quoteFor({ pricingModel: "LEGACY_BASE_RATE", availableOccupancies: [], availableMealPlans: [] })];
    renderModal();
    await waitForQuote();
    typeGuestName();
    fireEvent.click(submitButton());

    await waitFor(() => expect(submitCalls).toHaveLength(1));
    const body = submitCalls[0];
    expect(body.occupancyTypeId).toBeUndefined();
    expect(body.tariffId).toBe("rt-standard");
    expect(body.occupancy).toBe("SINGLE");
    expect(body.mealPlan).toBe("BED_ONLY");
  });

  it("surfaces a rejected submission and re-enables the button", async () => {
    renderModal();
    await waitForQuote();
    typeGuestName();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementationOnce(async () =>
      jsonResponse({ error: "That room is already booked for those dates." }, 409)
    );
    fireEvent.click(submitButton());

    await waitFor(() => expect(errors).toContain("That room is already booked for those dates."));
    expect(created).toEqual([]);
    await waitFor(() => expect(submitButton().disabled).toBe(false));
  });

  it("does not offer a discount to a role that may not set one", async () => {
    renderModal({ canApplyDiscount: false });
    await waitForQuote();
    expect(screen.queryByText(/Discount \(/)).toBeNull();
    expect(screen.getByText(/Only an owner, admin or manager can apply a discount/)).toBeTruthy();
  });
});

describe("modular pricing in CreateReservationModal", () => {
  const modularTypes = [
    { ...roomTypes[0], maxAdults: 3, maxChildren: 2, extraAdultFee: 500 },
    { ...roomTypes[1], maxAdults: 2, maxChildren: 1, extraAdultFee: 1000 },
  ];
  const plans = [
    { mealPlan: "ROOM_ONLY", adultSurcharge: 0, childSurcharge: 0, isActive: true },
    { mealPlan: "HALF_BOARD", adultSurcharge: 1000, childSurcharge: 500, isActive: true },
    { mealPlan: "ALL_INCLUSIVE", adultSurcharge: 5000, childSurcharge: 2000, isActive: false },
  ];
  it("calculates a provisional price and sends only the selected meal code, not a browser price", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/settings/hotel") return jsonResponse({ useModularPricing: true });
      if (String(input) === "/api/settings/meals") return jsonResponse(plans);
      if (String(input) === "/api/reservations/quote") return new Promise<Response>(() => {});
      submitCalls.push(JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ id: "res-new", code: "RES-1" }, 201);
    }));
    renderModal({ roomTypes: modularTypes });
    typeGuestName();
    const select = await screen.findByTestId("modular-meal-plan") as HTMLSelectElement;
    expect(select.textContent).toContain("Half Board");
    expect(select.textContent).not.toContain("All-Inclusive");
    fireEvent.change(select, { target: { value: "HALF_BOARD" } });
    fireEvent.change(screen.getByTestId("adults"), { target: { value: "2" } });
    fireEvent.change(screen.getByTestId("children"), { target: { value: "1" } });
    expect(rateBox().textContent).toContain("7,500");
    expect(screen.getByTestId("estimated-stay-total").textContent).toContain("7,500");
    expect(screen.getByText(/Estimated rate per night/)).toBeTruthy();
    expect(submitButton().disabled).toBe(false);
    fireEvent.click(submitButton());
    await waitFor(() => expect(submitCalls).toHaveLength(1));
    expect(submitCalls[0]).toMatchObject({ roomId: "room-101", mealPlanCode: "HALF_BOARD", adults: 2, children: 1 });
    expect(submitCalls[0]).not.toHaveProperty("rate");
    expect(submitCalls[0]).not.toHaveProperty("total");
    expect(submitCalls[0]).not.toHaveProperty("tariffId");
  });
  it("requests and displays the authoritative modular quote with the selected meal code", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/settings/hotel") return jsonResponse({ useModularPricing: true });
      if (String(input) === "/api/settings/meals") return jsonResponse(plans);
      if (String(input) === "/api/reservations/quote") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        quoteCalls.push(body);
        return jsonResponse(quoteFor({ pricingModel: "MODULAR_PRICING", occupancyTypeId: null, occupancyName: null, nightlyRate: body.mealPlanCode === "HALF_BOARD" ? 6500 : 4500 }));
      }
      return jsonResponse({ id: "res-new", code: "RES-1" }, 201);
    }));
    renderModal({ roomTypes: modularTypes });
    const select = await screen.findByTestId("modular-meal-plan");
    fireEvent.change(select, { target: { value: "HALF_BOARD" } });
    await waitFor(() => expect(quoteCalls.at(-1)).toMatchObject({ mealPlanCode: "HALF_BOARD" }));
    await waitFor(() => expect(screen.getByText(/Approved rate per night/)).toBeTruthy());
    expect(rateBox().textContent).toContain("6,500");
  });
  it("blocks submission if pricing mode cannot be determined", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "unavailable" }, 503)));
    renderModal({ roomTypes: modularTypes });
    typeGuestName();
    await waitFor(() => expect(screen.getByText(/server encountered an error/i)).toBeTruthy());
    expect(submitButton().disabled).toBe(true);
  });
  it("requires a valid room capacity and an active meal plan", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/settings/hotel") return jsonResponse({ useModularPricing: true });
      if (String(input) === "/api/settings/meals") return jsonResponse(plans);
      return new Promise<Response>(() => {});
    }));
    renderModal({ roomTypes: modularTypes });
    typeGuestName();
    await screen.findByTestId("modular-meal-plan");
    fireEvent.change(screen.getByTestId("adults"), { target: { value: "4" } });
    expect(screen.getByText(/exceed this room type's capacity/)).toBeTruthy();
    expect(submitButton().disabled).toBe(true);
  });
});
