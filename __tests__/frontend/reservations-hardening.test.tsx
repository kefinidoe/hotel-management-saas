// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import ReservationsClient from "@/components/reservations/ReservationsClient";
import { addDays, isoDay, startOfWeek } from "@/lib/dates";

vi.mock("@/components/reservations/CreateReservationModal", () => ({
  default: ({ onError }: { onError: (message: string) => void }) => (
    <button type="button" onClick={() => onError("Reservation creation was rejected.")}>
      Simulate reservation creation failure
    </button>
  ),
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const room = {
  id: "room-a",
  number: "101",
  roomTypeName: "Standard",
  baseRate: 5000,
  status: "AVAILABLE" as const,
};
const roomType = { id: "type-a", name: "Standard", baseRate: 5000, mealPlan: "BED_ONLY" };
const weekStart = startOfWeek(new Date());
const validReservation = {
  id: "reservation-a",
  code: "RES-2026-1",
  status: "CONFIRMED",
  checkInDate: addDays(weekStart, 1).toISOString(),
  checkOutDate: addDays(weekStart, 3).toISOString(),
  guestName: "Mara Guest",
  guestPhone: null,
  rooms: [{ roomId: room.id, roomNumber: room.number, rate: 5000 }],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderCalendar(responseBody: unknown, rooms = [room]) {
  fetchMock.mockResolvedValueOnce(jsonResponse(responseBody));
  render(
    <ReservationsClient
      rooms={rooms}
      roomTypes={[roomType]}
      currency="KES"
        currentUserRole={"RECEPTIONIST" as never}
    />,
  );
}

function createTransfer() {
  const values = new Map<string, string>();
  return {
    setData(key: string, value: string) { values.set(key, value); },
    getData(key: string) { return values.get(key) ?? ""; },
  };
}

async function dragReservation(payloadEdit?: (payload: Record<string, unknown>) => Record<string, unknown>) {
  const bar = await screen.findByText(validReservation.guestName);
  const transfer = createTransfer();
  fireEvent.dragStart(bar, { dataTransfer: transfer });
  const payload = JSON.parse(transfer.getData("text/plain")) as Record<string, unknown>;
  transfer.setData("text/plain", JSON.stringify(payloadEdit ? payloadEdit(payload) : payload));
  return transfer;
}

describe("ReservationsClient response and drag/drop hardening", () => {
  it.each([
    ["null records", [null]],
    ["invalid calendar dates", [{ ...validReservation, checkInDate: "2026-02-30T00:00:00.000Z" }]],
    ["reversed calendar dates", [{ ...validReservation, checkOutDate: validReservation.checkInDate }]],
    ["non-array room data", [{ ...validReservation, rooms: null }]],
    ["malformed nested room data", [{ ...validReservation, rooms: [null] }]],
    ["invalid room rates", [{ ...validReservation, rooms: [{ ...validReservation.rooms[0], rate: Number.NaN }] }]],
  ])("rejects %s without rendering a reservation bar", async (_case, data) => {
    renderCalendar(data);

    expect((await screen.findByRole("alert")).textContent).toContain("invalid reservation data");
    expect(screen.queryByText(validReservation.guestName)).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not place a valid reservation on a calendar date when the server returns it outside the loaded week", async () => {
    const outsideWeek = {
      ...validReservation,
      checkInDate: addDays(weekStart, -4).toISOString(),
      checkOutDate: addDays(weekStart, -2).toISOString(),
    };
    renderCalendar([outsideWeek]);

    await screen.findByText("No reservations overlap this week.");
    expect(screen.queryByText(validReservation.guestName)).toBeNull();
  });

  it("rejects a dragged source index that is not the reservation's current calendar position", async () => {
    renderCalendar([validReservation]);
    const transfer = await dragReservation((payload) => ({ ...payload, originalStartCol: 6 }));

    fireEvent.drop(
      screen.getByRole("gridcell", { name: `Room ${room.number}, ${isoDay(addDays(weekStart, 4))}` }),
      { dataTransfer: transfer },
    );

    expect((await screen.findByRole("alert")).textContent).toContain("source position is no longer valid");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an unknown reservation ID in drag data before sending a request", async () => {
    renderCalendar([validReservation]);
    const transfer = await dragReservation((payload) => ({ ...payload, id: "not-on-calendar" }));

    fireEvent.drop(
      screen.getByRole("gridcell", { name: `Room ${room.number}, ${isoDay(addDays(weekStart, 4))}` }),
      { dataTransfer: transfer },
    );

    expect((await screen.findByRole("alert")).textContent).toContain("no longer on the loaded calendar");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a target room that is not a valid loaded calendar room", async () => {
    const invalidTargetRoom = { ...room, id: " ", number: "999" };
    renderCalendar([validReservation], [room, invalidTargetRoom]);
    const transfer = await dragReservation();

    fireEvent.drop(
      screen.getByRole("gridcell", { name: `Room 999, ${isoDay(addDays(weekStart, 4))}` }),
      { dataTransfer: transfer },
    );

    expect((await screen.findByRole("alert")).textContent).toContain("target room or date is no longer available");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("shows server rejection after a valid drag and preserves the loaded reservation", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse([validReservation]))
      .mockResolvedValueOnce(jsonResponse({ error: "Room is already booked for those dates." }, 409));
    render(
      <ReservationsClient
        rooms={[room]}
        roomTypes={[roomType]}
        currency="KES"
        currentUserRole={"RECEPTIONIST" as never}
      />,
    );
    const transfer = await dragReservation();

    fireEvent.drop(
      screen.getByRole("gridcell", { name: `Room ${room.number}, ${isoDay(addDays(weekStart, 4))}` }),
      { dataTransfer: transfer },
    );

    expect((await screen.findByRole("alert")).textContent).toContain("Room is already booked for those dates.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe(`/api/reservations/${validReservation.id}`);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "PUT" });
    expect(screen.getByText(validReservation.guestName)).not.toBeNull();
  });

  it("keeps a drag failure associated with its initiating week after navigating forward", async () => {
    const mutationRequest = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(jsonResponse([validReservation]))
      .mockReturnValueOnce(mutationRequest.promise)
      .mockResolvedValueOnce(jsonResponse([]));
    render(
      <ReservationsClient rooms={[room]} roomTypes={[roomType]} currency="KES"
        currentUserRole={"RECEPTIONIST" as never} />,
    );
    const transfer = await dragReservation();
    fireEvent.drop(
      screen.getByRole("gridcell", { name: `Room ${room.number}, ${isoDay(addDays(weekStart, 4))}` }),
      { dataTransfer: transfer },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await screen.findByText("No reservations overlap this week.");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    await act(async () => {
      mutationRequest.resolve(jsonResponse({ error: "Room is already booked for those dates." }, 409));
      await mutationRequest.promise;
    });

    const mutationAlert = screen.getByTestId("reservation-mutation-error");
    const initiatingWeekLabel = weekStart.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    expect(mutationAlert.textContent).toContain(`week of ${initiatingWeekLabel}`);
    expect(mutationAlert.textContent).toContain("Room is already booked for those dates.");
    expect(screen.queryByTestId("calendar-load-error")).toBeNull();
    expect(screen.getByRole("button", { name: "View affected week" })).not.toBeNull();
    expect(screen.getByText("No reservations overlap this week.")).not.toBeNull();
  });

  it("keeps a cancellation failure associated with its initiating week after navigation", async () => {
    const mutationRequest = deferred<Response>();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock
      .mockResolvedValueOnce(jsonResponse([validReservation]))
      .mockReturnValueOnce(mutationRequest.promise)
      .mockResolvedValueOnce(jsonResponse([]));
    render(
      <ReservationsClient rooms={[room]} roomTypes={[roomType]} currency="KES"
        currentUserRole={"RECEPTIONIST" as never} />,
    );
    fireEvent.click(await screen.findByText(validReservation.guestName));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await screen.findByText("No reservations overlap this week.");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    await act(async () => {
      mutationRequest.resolve(jsonResponse({ error: "This reservation can no longer be cancelled." }, 409));
      await mutationRequest.promise;
    });

    const mutationAlert = screen.getByTestId("reservation-mutation-error");
    const initiatingWeekLabel = weekStart.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    expect(mutationAlert.textContent).toContain(`week of ${initiatingWeekLabel}`);
    expect(mutationAlert.textContent).toContain("This reservation can no longer be cancelled.");
    expect(screen.queryByTestId("calendar-load-error")).toBeNull();
  });

  it("keeps a create-modal failure labeled with the week where the modal was opened", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([])).mockResolvedValueOnce(jsonResponse([]));
    render(
      <ReservationsClient rooms={[room]} roomTypes={[roomType]} currency="KES"
        currentUserRole={"RECEPTIONIST" as never} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(
      screen.getByRole("gridcell", { name: `Room ${room.number}, ${isoDay(addDays(weekStart, 2))}` }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await screen.findByText("No reservations overlap this week.");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Simulate reservation creation failure" }));

    const mutationAlert = screen.getByTestId("reservation-mutation-error");
    const initiatingWeekLabel = weekStart.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    expect(mutationAlert.textContent).toContain(`week of ${initiatingWeekLabel}`);
    expect(mutationAlert.textContent).toContain("Reservation creation was rejected.");
    expect(screen.queryByTestId("calendar-load-error")).toBeNull();
  });

  it("keeps the selected week's reservations when an older week response arrives last", async () => {
    const olderRequest = deferred<Response>();
    const newerRequest = deferred<Response>();
    const nextWeekStart = addDays(weekStart, 7);
    const nextWeekReservation = {
      ...validReservation,
      id: "reservation-next-week",
      guestName: "Next Week Guest",
      checkInDate: addDays(nextWeekStart, 1).toISOString(),
      checkOutDate: addDays(nextWeekStart, 3).toISOString(),
    };
    fetchMock.mockReturnValueOnce(olderRequest.promise).mockReturnValueOnce(newerRequest.promise);
    render(
      <ReservationsClient rooms={[room]} roomTypes={[roomType]} currency="KES"
        currentUserRole={"RECEPTIONIST" as never} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      newerRequest.resolve(jsonResponse([nextWeekReservation]));
      await newerRequest.promise;
    });
    expect(await screen.findByText("Next Week Guest")).not.toBeNull();
    expect(screen.queryByText("Loading...")).toBeNull();

    await act(async () => {
      olderRequest.resolve(jsonResponse([nextWeekReservation]));
      await olderRequest.promise;
    });
    expect(screen.getByText("Next Week Guest")).not.toBeNull();
    expect(screen.queryByText("No reservations overlap this week.")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps the active week's loading indicator when the older request finishes first", async () => {
    const olderRequest = deferred<Response>();
    const newerRequest = deferred<Response>();
    const nextWeekStart = addDays(weekStart, 7);
    const nextWeekReservation = {
      ...validReservation,
      id: "reservation-next-week",
      guestName: "Next Week Guest",
      checkInDate: addDays(nextWeekStart, 1).toISOString(),
      checkOutDate: addDays(nextWeekStart, 3).toISOString(),
    };
    fetchMock.mockReturnValueOnce(olderRequest.promise).mockReturnValueOnce(newerRequest.promise);
    render(
      <ReservationsClient rooms={[room]} roomTypes={[roomType]} currency="KES"
        currentUserRole={"RECEPTIONIST" as never} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      olderRequest.resolve(jsonResponse([validReservation]));
      await olderRequest.promise;
    });
    expect(screen.getByText("Loading...")).not.toBeNull();
    expect(screen.queryByText(validReservation.guestName)).toBeNull();
    expect(screen.queryByTestId("calendar-load-error")).toBeNull();

    await act(async () => {
      newerRequest.resolve(jsonResponse([nextWeekReservation]));
      await newerRequest.promise;
    });
    expect(await screen.findByText("Next Week Guest")).not.toBeNull();
    expect(screen.queryByText("Loading...")).toBeNull();
    expect(screen.queryByText(validReservation.guestName)).toBeNull();
  });

  it("preserves the active week's load error when an older request fails afterward", async () => {
    const olderRequest = deferred<Response>();
    fetchMock
      .mockReturnValueOnce(olderRequest.promise)
      .mockResolvedValueOnce(jsonResponse({ error: "Week B calendar unavailable." }, 409));
    render(
      <ReservationsClient rooms={[room]} roomTypes={[roomType]} currency="KES"
        currentUserRole={"RECEPTIONIST" as never} />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));

    const weekBError = await screen.findByTestId("calendar-load-error");
    expect(weekBError.textContent).toContain("Week B calendar unavailable.");
    await act(async () => {
      olderRequest.reject(new TypeError("stale calendar network failure"));
      await olderRequest.promise.catch(() => undefined);
    });

    expect(screen.getByTestId("calendar-load-error").textContent).toContain("Week B calendar unavailable.");
    expect(screen.getByTestId("calendar-load-error").textContent).not.toContain("stale calendar network failure");
    expect(screen.queryByText("Loading...")).toBeNull();
  });
});
