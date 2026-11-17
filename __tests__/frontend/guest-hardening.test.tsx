// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import GuestsClient from "@/components/guests/GuestsClient";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function guestRow(id: string, fullName: string, isArchived = false) {
  return {
    id,
    fullName,
    phone: null,
    email: `${id}@example.test`,
    isArchived,
    currentRoom: null,
    lastStatus: null,
    checkInDate: null,
    checkOutDate: null,
  };
}

function guestDetail(id: string, fullName: string, isArchived = false) {
  return {
    id,
    fullName,
    phone: null,
    email: `${id}@example.test`,
    idNumber: null,
    nationality: null,
    vehicleRegistration: null,
    notes: null,
    isArchived,
    reservations: [],
    folios: [],
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("GuestsClient stale request handling", () => {
  it("keeps the newest search results when the older query resolves last", async () => {
    const olderRequest = deferred<Response>();
    const newerRequest = deferred<Response>();
    fetchMock.mockReturnValueOnce(olderRequest.promise).mockReturnValueOnce(newerRequest.promise);
    render(<GuestsClient initialGuests={[guestRow("seed", "Seed Guest")]} />);
    const input = screen.getByPlaceholderText("Search guests...");

    fireEvent.change(input, { target: { value: "old query" } });
    fireEvent.change(input, { target: { value: "new query" } });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      newerRequest.resolve(jsonResponse([guestRow("new", "New Query Guest")]));
      await newerRequest.promise;
    });
    expect(screen.getByText("New Query Guest")).not.toBeNull();
    expect(screen.queryByRole("status")).toBeNull();

    await act(async () => {
      olderRequest.resolve(jsonResponse([guestRow("old", "Old Query Guest")]));
      await olderRequest.promise;
    });
    expect(screen.getByText("New Query Guest")).not.toBeNull();
    expect(screen.queryByText("Old Query Guest")).toBeNull();
    expect(screen.getByDisplayValue("new query")).not.toBeNull();
  });

  it("does not show an error from an outdated search after the active query succeeds", async () => {
    const olderRequest = deferred<Response>();
    const newerRequest = deferred<Response>();
    fetchMock.mockReturnValueOnce(olderRequest.promise).mockReturnValueOnce(newerRequest.promise);
    render(<GuestsClient initialGuests={[]} />);
    const input = screen.getByPlaceholderText("Search guests...");

    fireEvent.change(input, { target: { value: "slow" } });
    fireEvent.change(input, { target: { value: "fast" } });
    await act(async () => {
      newerRequest.resolve(jsonResponse([guestRow("fast", "Fast Guest")]));
      await newerRequest.promise;
    });
    await act(async () => {
      olderRequest.reject(new TypeError("outdated network failure"));
      await olderRequest.promise.catch(() => undefined);
    });

    expect(screen.getByText("Fast Guest")).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("keeps guest B selected when guest A's detail response arrives late and archives B only", async () => {
    const guestARequest = deferred<Response>();
    const guestBRequest = deferred<Response>();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock
      .mockReturnValueOnce(guestARequest.promise)
      .mockReturnValueOnce(guestBRequest.promise)
      .mockResolvedValueOnce(jsonResponse({ id: "guest-b", isArchived: true }))
      .mockResolvedValueOnce(jsonResponse([]));

    render(<GuestsClient initialGuests={[guestRow("guest-a", "Guest A"), guestRow("guest-b", "Guest B")]} />);
    fireEvent.click(screen.getByText("Guest A"));
    fireEvent.click(screen.getByText("Guest B"));

    await act(async () => {
      guestBRequest.resolve(jsonResponse(guestDetail("guest-b", "Guest B")));
      await guestBRequest.promise;
    });
    expect(screen.getByRole("heading", { name: "Guest B" })).not.toBeNull();
    expect(screen.getByText(/guest-b@example\.test/)).not.toBeNull();

    await act(async () => {
      guestARequest.resolve(jsonResponse(guestDetail("guest-a", "Guest A")));
      await guestARequest.promise;
    });
    expect(screen.getByRole("heading", { name: "Guest B" })).not.toBeNull();
    expect(screen.queryByText(/guest-a@example\.test/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Archive guest" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(fetchMock.mock.calls[2][0]).toBe("/api/guests/guest-b");
    expect(fetchMock.mock.calls[2][1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ isArchived: true }),
    });
    expect(fetchMock.mock.calls[3][0]).toBe("/api/guests?q=");
  });

  it("treats a missing guest as a return-to-list and refresh path, not an endless retry", async () => {
    const refreshed = guestRow("guest-new", "Freshly Loaded Guest");
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: "Guest not found." }, 404))
      .mockResolvedValueOnce(jsonResponse([refreshed]));
    render(<GuestsClient initialGuests={[guestRow("guest-missing", "Missing Guest")]} />);

    fireEvent.click(screen.getByText("Missing Guest"));
    expect((await screen.findByRole("alert")).textContent).toContain("Guest not found.");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Back to guest list" }));
    expect(await screen.findByText("Freshly Loaded Guest")).not.toBeNull();
    expect(screen.queryByRole("heading", { name: "Guest details" })).toBeNull();
    expect(fetchMock.mock.calls[1][0]).toBe("/api/guests?q=");
  });

  it.each([
    [401, "session has expired", "/login"],
    [403, "permission", null],
  ])("provides the appropriate recovery for guest detail status %i", async (status, message, link) => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: status === 401 ? "UNAUTHENTICATED" : "FORBIDDEN" }, status));
    render(<GuestsClient initialGuests={[guestRow("guest-a", "Guest A")]} />);

    fireEvent.click(screen.getByText("Guest A"));
    expect((await screen.findByRole("alert")).textContent).toContain(message);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    if (link) expect(screen.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(link);
    expect(screen.getByRole("button", { name: "Back to guest list" })).not.toBeNull();
  });

  it("offers retry after a network failure while loading guest details", async () => {
    fetchMock
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(jsonResponse(guestDetail("guest-a", "Guest A")));
    render(<GuestsClient initialGuests={[guestRow("guest-a", "Guest A")]} />);

    fireEvent.click(screen.getByText("Guest A"));
    expect((await screen.findByRole("alert")).textContent).toContain("Unable to reach the server");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByText(/guest-a@example\.test/)).not.toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
