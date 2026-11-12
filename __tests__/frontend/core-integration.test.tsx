// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReservationsClient from "@/components/reservations/ReservationsClient";
import GuestsClient from "@/components/guests/GuestsClient";
import RoomsClient from "@/components/rooms/RoomsClient";
import CheckInModal from "@/components/frontdesk/CheckInModal";
import FolioModal from "@/components/frontdesk/FolioModal";
import { addDays, isoDay, startOfWeek } from "@/lib/dates";

vi.mock("@/components/reservations/CreateReservationModal", () => ({
  default: () => null,
}));

vi.mock("@prisma/client", () => ({
  HotelRole: {
    HOTEL_OWNER: "HOTEL_OWNER",
    HOTEL_ADMIN: "HOTEL_ADMIN",
    MANAGER: "MANAGER",
    RECEPTIONIST: "RECEPTIONIST",
    ACCOUNTANT: "ACCOUNTANT",
    HOUSEKEEPER: "HOUSEKEEPER",
    WAITER: "WAITER",
    CASHIER: "CASHIER",
    TECHNICIAN: "TECHNICIAN",
  },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const room = {
  id: "room-a",
  number: "101",
  roomTypeName: "Standard",
  baseRate: 5000,
  status: "AVAILABLE" as const,
};
const roomType = { id: "type-a", name: "Standard", baseRate: 5000, capacity: 2, description: null, mealPlan: "BED_ONLY" };

const guest = {
  id: "guest-a",
  fullName: "Amina Guest",
  phone: "+254700000001",
  email: "amina@example.test",
  isArchived: false,
  currentRoom: null,
  lastStatus: null,
  checkInDate: null,
  checkOutDate: null,
};
const guestDetail = {
  id: guest.id,
  fullName: guest.fullName,
  phone: guest.phone,
  email: guest.email,
  idNumber: null,
  nationality: null,
  vehicleRegistration: null,
  notes: null,
  isArchived: false,
  reservations: [],
  folios: [],
};

let fetchMock: ReturnType<typeof vi.fn>;
let confirmSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  window.sessionStorage.clear();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("core frontend API integrations", () => {
  it("renders the reservations API's empty-list contract", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([]));

    render(
      <ReservationsClient
        rooms={[room]}
        roomTypes={[roomType]}
        currency="KES"
        currentUserRole={"RECEPTIONIST" as never}
      />,
    );

    expect(await screen.findByText("No reservations overlap this week.")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^\/api\/reservations\?from=/), undefined);
  });

  it("shows an actionable sign-in message for an unauthorized reservations response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "UNAUTHENTICATED" }, 401));

    render(
      <ReservationsClient
        rooms={[room]}
        roomTypes={[roomType]}
        currency="KES"
        currentUserRole={"RECEPTIONIST" as never}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toContain("session has expired");
  });

  it("shows a network error instead of treating a rejected reservations fetch as data", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(
      <ReservationsClient
        rooms={[room]}
        roomTypes={[roomType]}
        currency="KES"
        currentUserRole={"RECEPTIONIST" as never}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toContain("Unable to reach the server");
  });

  it("surfaces reservation drag-and-drop conflict responses and keeps the existing data", async () => {
    const weekStart = startOfWeek(new Date());
    const reservation = {
      id: "reservation-a",
      code: "RES-2026-1",
      status: "CONFIRMED",
      checkInDate: addDays(weekStart, 1).toISOString(),
      checkOutDate: addDays(weekStart, 2).toISOString(),
      guestName: "Mara Guest",
      guestPhone: null,
      rooms: [{ roomId: room.id, roomNumber: room.number, rate: 5000 }],
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse([reservation]))
      .mockResolvedValueOnce(jsonResponse({ error: "Room is already booked for those dates." }, 409));

    render(
      <ReservationsClient
        rooms={[room]}
        roomTypes={[roomType]}
        currency="KES"
        currentUserRole={"RECEPTIONIST" as never}
      />,
    );

    const reservationBar = await screen.findByText("Mara Guest");
    const transfer = {
      values: new Map<string, string>(),
      setData(key: string, value: string) { this.values.set(key, value); },
      getData(key: string) { return this.values.get(key) ?? ""; },
    };
    fireEvent.dragStart(reservationBar, { dataTransfer: transfer });
    fireEvent.drop(
      screen.getByRole("gridcell", { name: `Room ${room.number}, ${isoDay(addDays(weekStart, 3))}` }),
      { dataTransfer: transfer },
    );

    expect((await screen.findByRole("alert")).textContent).toContain("Room is already booked for those dates.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/reservations/${reservation.id}`);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "PUT" });
    expect(screen.getByText("Mara Guest")).not.toBeNull();
  });

  it("shows guest archive mutation failures without a browser alert", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(guestDetail))
      .mockResolvedValueOnce(jsonResponse({ error: "Guest is currently checked in." }, 400));

    render(<GuestsClient initialGuests={[guest]} />);
    fireEvent.click(screen.getByText(guest.fullName));
    fireEvent.click(await screen.findByRole("button", { name: /Archive guest/i }));

    expect((await screen.findByRole("alert")).textContent).toContain("Guest is currently checked in.");
    expect(confirmSpy).toHaveBeenCalledOnce();
  });

  it("shows guest search network errors and retains the existing server-rendered list", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    render(<GuestsClient initialGuests={[guest]} />);
    fireEvent.change(screen.getByPlaceholderText("Search guests..."), { target: { value: "Amina" } });

    expect((await screen.findByRole("alert")).textContent).toContain("Unable to reach the server");
    expect(screen.getByText(guest.fullName)).not.toBeNull();
  });

  it("uses the existing room-type PUT contract and reports an HTTP failure", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Room type not found." }, 404));

    render(<RoomsClient initialRooms={[]} initialRoomTypes={[roomType]} canManage />);
    fireEvent.click(screen.getByRole("button", { name: /Room Types/i }));
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByPlaceholderText("Name (e.g. Deluxe)"), { target: { value: "Standard Plus" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Room type not found.");
    expect(fetchMock).toHaveBeenCalledWith("/api/room-types/type-a", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ name: "Standard Plus", baseRate: 5000, capacity: 2, mealPlan: "BED_ONLY" }),
    }));
  });

  it("surfaces a failed check-in mutation without bypassing its API contract", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([{ id: "method-a", name: "Cash" }]))
      .mockResolvedValueOnce(jsonResponse({ error: "Reservation changed; refresh and retry." }, 409));

    render(
      <CheckInModal
        reservation={{ id: "reservation-a", code: "RES-1", guestName: "Mara Guest", roomId: room.id, roomNumbers: room.number, requiredAmount: 5000 }}
        rooms={[{ id: room.id, number: room.number, status: "AVAILABLE" as never }]}
        onClose={vi.fn()}
        onCheckedIn={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Confirm Check-in" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Reservation changed; refresh and retry.");
    expect(fetchMock.mock.calls[1][0]).toBe("/api/check-in");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toMatchObject({
      reservationId: "reservation-a",
      amountPaid: 5000,
      paymentMethodId: "method-a",
    });
  });

  it("surfaces checkout authorization/conflict errors from the existing folio workflow", async () => {
    const folio = {
      id: "folio-a",
      guestName: "Mara Guest",
      isClosed: false,
      items: [{ id: "item-a", description: "Room charge", quantity: 1, unitPrice: 5000, total: 5000 }],
      payments: [],
      required: 5000,
      total: 5000,
      paid: 5000,
      balance: 0,
    };
    fetchMock
      .mockResolvedValueOnce(jsonResponse(folio))
      .mockResolvedValueOnce(jsonResponse([{ id: "method-a", name: "Cash" }]))
      .mockResolvedValueOnce(jsonResponse({ error: "Checkout is not allowed." }, 403));

    render(
      <FolioModal
        activeTenantId="hotel-a"
        folioId="folio-a"
        reservationId="reservation-a"
        canCheckout
        canOverrideBalance={false}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Complete Checkout" }));
    expect((await screen.findByRole("alert")).textContent).toContain("You do not have permission to perform this action.");
    expect(fetchMock.mock.calls[2][0]).toBe("/api/check-out");
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).toEqual({
      reservationId: "reservation-a",
      allowOutstandingBalance: false,
    });
  });

  it("preserves a payment recovery record when its saved hotel differs from the active hotel", async () => {
    const savedAttempt = {
      hotelId: "hotel-a",
      key: "folio-payment-tenant-switch",
      payload: { folioId: "folio-a", paymentMethodId: "method-a", amount: 1000, reference: "A-REF" },
      outcome: "uncertain",
    };
    const rawAttempt = JSON.stringify(savedAttempt);
    window.sessionStorage.setItem("hotel-flow:pending-folio-payment:v1:folio-a", rawAttempt);
    const onClose = vi.fn();

    render(
      <FolioModal
        activeTenantId="hotel-b"
        folioId="folio-a"
        reservationId="reservation-a"
        canCheckout={false}
        canOverrideBalance={false}
        onClose={onClose}
        onDone={vi.fn()}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toContain("another or unknown hotel");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("hotel-flow:pending-folio-payment:v1:folio-a")).toBe(rawAttempt);
    fireEvent.click(screen.getByRole("button", { name: "Close folio" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(window.sessionStorage.getItem("hotel-flow:pending-folio-payment:v1:folio-a")).toBe(rawAttempt);
  });

  it("fails closed on legacy recovery attempts without a tenant binding", async () => {
    const legacyAttempt = {
      key: "folio-payment-legacy-key",
      payload: { folioId: "folio-a", paymentMethodId: "method-a", amount: 1000, reference: "OLD-REF" },
      outcome: "uncertain",
    };
    const rawAttempt = JSON.stringify(legacyAttempt);
    window.sessionStorage.setItem("hotel-flow:pending-folio-payment:v1:folio-a", rawAttempt);

    render(
      <FolioModal
        activeTenantId="hotel-a"
        folioId="folio-a"
        reservationId="reservation-a"
        canCheckout={false}
        canOverrideBalance={false}
        onClose={vi.fn()}
        onDone={vi.fn()}
      />,
    );

    expect((await screen.findByRole("alert")).textContent).toContain("another or unknown hotel");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("hotel-flow:pending-folio-payment:v1:folio-a")).toBe(rawAttempt);
  });

  it("keeps a confirmed payment distinct from a failed folio refresh and retries GET only", async () => {
    const folio = {
      id: "folio-a", guestName: "Mara Guest", isClosed: false,
      items: [{ id: "item-a", description: "Room charge", quantity: 1, unitPrice: 5000, total: 5000 }],
      payments: [], required: 5000, paid: 1000, balance: 4000,
    };
    const updatedFolio = { ...folio, paid: 2000, balance: 3000, payments: [{
      id: "payment-a", amount: 1000, method: "Cash", reference: null, createdAt: "2026-10-29T10:00:00.000Z",
    }] };
    const onDone = vi.fn();
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue("folio-payment-key-001");
    fetchMock
      .mockResolvedValueOnce(jsonResponse(folio))
      .mockResolvedValueOnce(jsonResponse([{ id: "method-a", name: "Cash" }]))
      .mockResolvedValueOnce(jsonResponse({ id: "payment-a", required: 5000, paid: 2000, balance: 3000 }, 201))
      .mockResolvedValueOnce(jsonResponse({ error: "Temporary folio read failure" }, 500))
      .mockResolvedValueOnce(jsonResponse(updatedFolio));

    render(
      <FolioModal activeTenantId="hotel-a" folioId="folio-a" reservationId="reservation-a" canCheckout={false} canOverrideBalance={false} onClose={vi.fn()} onDone={onDone} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Record Payment" }));

    expect(await screen.findByText("Payment recorded successfully.")).not.toBeNull();
    expect(screen.queryByText("Balance due")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("payment was recorded, but the folio could not be refreshed");
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/payments" && init?.method === "POST")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Retry folio refresh" }));
    expect(await screen.findByText("Balance due")).not.toBeNull();
    expect(onDone).toHaveBeenCalledOnce();
    expect(uuid).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/payments" && init?.method === "POST")).toHaveLength(1);
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      headers: expect.objectContaining({
        "Idempotency-Key": "folio-payment-key-001",
        "X-Expected-Hotel-Id": "hotel-a",
      }),
    });
  });

  it("retries an ambiguous payment with the exact same payload and key, and blocks a repeated in-flight submit", async () => {
    const folio = {
      id: "folio-a", guestName: "Mara Guest", isClosed: false,
      items: [{ id: "item-a", description: "Room charge", quantity: 1, unitPrice: 5000, total: 5000 }],
      payments: [], required: 5000, paid: 1000, balance: 4000,
    };
    const updatedFolio = { ...folio, paid: 2234.5, balance: 2765.5 };
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue("folio-payment-key-ambiguous");
    let resolveRetry!: (response: Response) => void;
    const retryResponse = new Promise<Response>((resolve) => { resolveRetry = resolve; });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(folio))
      .mockResolvedValueOnce(jsonResponse([{ id: "method-a", name: "Cash" }]))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockReturnValueOnce(retryResponse)
      .mockResolvedValueOnce(jsonResponse(updatedFolio));

    render(
      <FolioModal activeTenantId="hotel-a" folioId="folio-a" reservationId="reservation-a" canCheckout={false} canOverrideBalance={false} onClose={vi.fn()} onDone={vi.fn()} />,
    );
    fireEvent.change(await screen.findByPlaceholderText("Amount (KSh)"), { target: { value: "1234.5" } });
    fireEvent.change(screen.getByPlaceholderText("Reference (for example, M-Pesa code) — optional"), { target: { value: "MPESA-EXACT-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Record Payment" }));

    expect((await screen.findByRole("alert")).textContent).toContain("outcome is not yet confirmed");
    expect((screen.getByRole("button", { name: "Close folio" }) as HTMLButtonElement).disabled).toBe(true);
    const retryButton = screen.getByRole("button", { name: "Retry same payment" });
    fireEvent.click(retryButton);
    fireEvent.click(retryButton);

    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/payments" && init?.method === "POST")).toHaveLength(2));
    expect((screen.getByRole("button", { name: "Verifying payment…" }) as HTMLButtonElement).disabled).toBe(true);
    const firstPost = fetchMock.mock.calls[2][1];
    const retryPost = fetchMock.mock.calls[3][1];
    expect(firstPost.headers).toMatchObject({ "Idempotency-Key": "folio-payment-key-ambiguous" });
    expect(retryPost.headers).toMatchObject({ "Idempotency-Key": "folio-payment-key-ambiguous" });
    expect(retryPost.body).toBe(firstPost.body);
    expect(JSON.parse(firstPost.body as string)).toEqual({
      folioId: "folio-a",
      paymentMethodId: "method-a",
      amount: 1234.5,
      reference: "MPESA-EXACT-123",
      idempotencyKey: "folio-payment-key-ambiguous",
    });
    expect(uuid).toHaveBeenCalledOnce();

    resolveRetry(jsonResponse({ id: "payment-retry", required: 5000, paid: 2234.5, balance: 2765.5 }, 201));
    expect(await screen.findByText("Balance due")).not.toBeNull();
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/payments" && init?.method === "POST")).toHaveLength(2);
  });

  it("restores an uncertain payment attempt from the current browser session after remount", async () => {
    const folio = {
      id: "folio-a", guestName: "Mara Guest", isClosed: false,
      items: [{ id: "item-a", description: "Room charge", quantity: 1, unitPrice: 5000, total: 5000 }],
      payments: [], required: 5000, paid: 1000, balance: 4000,
    };
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue("folio-payment-key-restored");
    fetchMock
      .mockResolvedValueOnce(jsonResponse(folio))
      .mockResolvedValueOnce(jsonResponse([{ id: "method-a", name: "Cash" }]))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse({ id: "payment-restored", required: 5000, paid: 2000, balance: 3000 }, 201))
      .mockResolvedValueOnce(jsonResponse({ ...folio, paid: 2000, balance: 3000 }))
      .mockResolvedValueOnce(jsonResponse([{ id: "method-a", name: "Cash" }]));

    const props = { activeTenantId: "hotel-a", folioId: "folio-a", reservationId: "reservation-a", canCheckout: false, canOverrideBalance: false, onClose: vi.fn(), onDone: vi.fn() };
    const firstRender = render(<FolioModal {...props} />);
    fireEvent.change(await screen.findByPlaceholderText("Amount (KSh)"), { target: { value: "1000" } });
    fireEvent.change(screen.getByPlaceholderText("Reference (for example, M-Pesa code) — optional"), { target: { value: "SESSION-REF" } });
    fireEvent.click(screen.getByRole("button", { name: "Record Payment" }));
    expect((await screen.findByRole("alert")).textContent).toContain("outcome is not yet confirmed");
    const originalBody = fetchMock.mock.calls[2][1].body;
    firstRender.unmount();

    render(<FolioModal {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry same payment" }));
    expect(await screen.findByText("Balance due")).not.toBeNull();
    expect(fetchMock.mock.calls[3][1].body).toBe(originalBody);
    expect(fetchMock.mock.calls[3][1].headers).toMatchObject({ "Idempotency-Key": "folio-payment-key-restored" });
    expect(uuid).toHaveBeenCalledOnce();
  });

  it("retains the exact payment attempt after an HTTP 500 and retries with the same key and payload", async () => {
    const folio = {
      id: "folio-a", guestName: "Mara Guest", isClosed: false,
      items: [{ id: "item-a", description: "Room charge", quantity: 1, unitPrice: 5000, total: 5000 }],
      payments: [], required: 5000, paid: 1000, balance: 4000,
    };
    const updatedFolio = { ...folio, paid: 2000, balance: 3000 };
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue("folio-payment-key-http-500");
    fetchMock
      .mockResolvedValueOnce(jsonResponse(folio))
      .mockResolvedValueOnce(jsonResponse([{ id: "method-a", name: "Cash" }]))
      .mockResolvedValueOnce(jsonResponse({ error: "Temporary payment service error" }, 500))
      .mockResolvedValueOnce(jsonResponse({ id: "payment-500-retry", required: 5000, paid: 2000, balance: 3000 }, 201))
      .mockResolvedValueOnce(jsonResponse(updatedFolio));

    render(
      <FolioModal activeTenantId="hotel-a" folioId="folio-a" reservationId="reservation-a" canCheckout={false} canOverrideBalance={false} onClose={vi.fn()} onDone={vi.fn()} />,
    );
    fireEvent.change(await screen.findByPlaceholderText("Amount (KSh)"), { target: { value: "1000" } });
    fireEvent.change(screen.getByPlaceholderText("Reference (for example, M-Pesa code) — optional"), { target: { value: "HTTP-500-REF" } });
    fireEvent.click(screen.getByRole("button", { name: "Record Payment" }));

    expect((await screen.findByRole("alert")).textContent).toContain("outcome is not yet confirmed");
    const storedAttempt = JSON.parse(window.sessionStorage.getItem("hotel-flow:pending-folio-payment:v1:folio-a")!);
    expect(storedAttempt).toMatchObject({
      hotelId: "hotel-a",
      key: "folio-payment-key-http-500",
      payload: { folioId: "folio-a", paymentMethodId: "method-a", amount: 1000, reference: "HTTP-500-REF" },
      outcome: "uncertain",
    });

    fireEvent.click(screen.getByRole("button", { name: "Retry same payment" }));
    expect(await screen.findByText("Balance due")).not.toBeNull();
    expect(fetchMock.mock.calls[2][1].body).toBe(fetchMock.mock.calls[3][1].body);
    expect(fetchMock.mock.calls[2][1].headers).toMatchObject({ "Idempotency-Key": "folio-payment-key-http-500" });
    expect(fetchMock.mock.calls[3][1].headers).toMatchObject({ "Idempotency-Key": "folio-payment-key-http-500" });
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/payments" && init?.method === "POST")).toHaveLength(2);
    expect(uuid).toHaveBeenCalledOnce();
  });

  it("restores a confirmed attempt after remount and performs a folio GET without another payment POST", async () => {
    const folio = {
      id: "folio-a", guestName: "Mara Guest", isClosed: false,
      items: [{ id: "item-a", description: "Room charge", quantity: 1, unitPrice: 5000, total: 5000 }],
      payments: [], required: 5000, paid: 1000, balance: 4000,
    };
    const updatedFolio = { ...folio, paid: 2000, balance: 3000 };
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue("folio-payment-key-confirmed");
    fetchMock
      .mockResolvedValueOnce(jsonResponse(folio))
      .mockResolvedValueOnce(jsonResponse([{ id: "method-a", name: "Cash" }]))
      .mockResolvedValueOnce(jsonResponse({ id: "payment-confirmed", required: 5000, paid: 2000, balance: 3000 }, 201))
      .mockResolvedValueOnce(jsonResponse({ error: "Temporary folio read failure" }, 500))
      .mockResolvedValueOnce(jsonResponse(updatedFolio))
      .mockResolvedValueOnce(jsonResponse([{ id: "method-a", name: "Cash" }]));

    const props = { activeTenantId: "hotel-a", folioId: "folio-a", reservationId: "reservation-a", canCheckout: false, canOverrideBalance: false, onClose: vi.fn(), onDone: vi.fn() };
    const firstRender = render(<FolioModal {...props} />);
    fireEvent.click(await screen.findByRole("button", { name: "Record Payment" }));
    expect(await screen.findByRole("button", { name: "Retry folio refresh" })).not.toBeNull();
    expect(JSON.parse(window.sessionStorage.getItem("hotel-flow:pending-folio-payment:v1:folio-a")!).outcome).toBe("confirmed");
    firstRender.unmount();

    render(<FolioModal {...props} />);
    expect(await screen.findByText("Balance due")).not.toBeNull();
    expect(fetchMock.mock.calls[4][0]).toBe("/api/folios/folio-a");
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/payments" && init?.method === "POST")).toHaveLength(1);
    expect(uuid).toHaveBeenCalledOnce();
  });

  it("does not submit payment if session storage cannot save the pending attempt", async () => {
    const folio = {
      id: "folio-a", guestName: "Mara Guest", isClosed: false,
      items: [{ id: "item-a", description: "Room charge", quantity: 1, unitPrice: 5000, total: 5000 }],
      payments: [], required: 5000, paid: 1000, balance: 4000,
    };
    vi.spyOn(crypto, "randomUUID").mockReturnValue("folio-payment-key-storage-fail");
    vi.spyOn(window.Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage disabled", "SecurityError");
    });
    fetchMock
      .mockResolvedValueOnce(jsonResponse(folio))
      .mockResolvedValueOnce(jsonResponse([{ id: "method-a", name: "Cash" }]));

    render(
      <FolioModal activeTenantId="hotel-a" folioId="folio-a" reservationId="reservation-a" canCheckout={false} canOverrideBalance={false} onClose={vi.fn()} onDone={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Record Payment" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Payment was not submitted because this browser could not save the pending payment attempt"));
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/payments" && init?.method === "POST")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Record Payment" })).not.toBeNull();
    expect(screen.queryByRole("button", { name: "Retry same payment" })).toBeNull();
  });

  it.each([
    { status: 401, kind: "expired session" },
    { status: 403, kind: "permission denial" },
  ])("treats a pre-transaction $kind response as a recoverable no-payment rejection", async ({ status }) => {
    const folio = {
      id: "folio-a", guestName: "Mara Guest", isClosed: false,
      items: [{ id: "item-a", description: "Room charge", quantity: 1, unitPrice: 5000, total: 5000 }],
      payments: [], required: 5000, paid: 1000, balance: 4000,
    };
    const uuid = vi.spyOn(crypto, "randomUUID").mockReturnValue("folio-payment-key-auth-reject");
    fetchMock
      .mockResolvedValueOnce(jsonResponse(folio))
      .mockResolvedValueOnce(jsonResponse([{ id: "method-a", name: "Cash" }]))
      .mockResolvedValueOnce(jsonResponse({ error: status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN" }, status))
      .mockResolvedValueOnce(jsonResponse(folio));

    render(
      <FolioModal activeTenantId="hotel-a" folioId="folio-a" reservationId="reservation-a" canCheckout={false} canOverrideBalance={false} onClose={vi.fn()} onDone={vi.fn()} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Record Payment" }));

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Payment was not submitted."));
    expect(window.sessionStorage.getItem("hotel-flow:pending-folio-payment:v1:folio-a")).toBeNull();
    expect(await screen.findByRole("button", { name: "Record Payment" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "Close folio" }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Retry same payment" })).toBeNull();
    expect(fetchMock.mock.calls.filter(([url, init]) => url === "/api/payments" && init?.method === "POST")).toHaveLength(1);
    expect(uuid).toHaveBeenCalledOnce();
  });
});
