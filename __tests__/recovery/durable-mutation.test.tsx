// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { DurableMutationProvider, readDurableAttempt, useDurableMutation } from "@/components/recovery/DurableMutationProvider";

const key = "hms:pending-mutation:v1:hotel-a:actor-a";
function Form() {
  const { submit } = useDurableMutation();
  return <button onClick={() => { void submit("PURCHASE", "/api/purchases", "POST", { quantity: 2 }).catch(() => {}); }}>Submit</button>;
}
function mount(hotelId = "hotel-a", actorId = "actor-a") {
  return render(<DurableMutationProvider hotelId={hotelId} actorId={actorId}><Form /></DurableMutationProvider>);
}
beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_name: string, _options: unknown, fn: (lock: object | null) => Promise<unknown>) => fn({}) } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
describe("durable mutation recovery", () => {
  it("persists the exact request before sending and recovers it after navigation", async () => {
    const fetchMock = vi.fn(async (_url: string, _options: RequestInit) => { expect(localStorage.getItem(key)).not.toBeNull(); throw new Error("network lost"); });
    vi.stubGlobal("fetch", fetchMock);
    const first = mount(); fireEvent.click(screen.getByText("Submit"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const saved = JSON.parse(localStorage.getItem(key)!);
    expect(saved.body).toBe('{"quantity":2}');
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ "Idempotency-Key": saved.key, "X-Expected-Hotel-Id": "hotel-a", "X-Expected-Actor-Id": "actor-a" });
    first.unmount(); mount();
    expect(await screen.findByText(/Unresolved purchase request/)).toBeTruthy();
    fireEvent.click(screen.getByText("Submit"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(localStorage.getItem(key)!).key).toBe(saved.key);
  });
  it("preserves attempts on HTTP rejection and hides them from other contexts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: "no" }), { status: 403 })));
    const first = mount(); fireEvent.click(screen.getByText("Submit"));
    await waitFor(() => expect(localStorage.getItem(key)).not.toBeNull()); first.unmount();
    mount("hotel-b", "actor-a"); expect(screen.queryByText(/Unresolved purchase/)).toBeNull();
    expect(localStorage.getItem(key)).not.toBeNull();
  });
  it("fails closed without cross-tab locks or storage and rejects malformed saved data", async () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(navigator, "locks", { configurable: true, value: undefined });
    mount(); fireEvent.click(screen.getByText("Submit"));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled(); cleanup();
    localStorage.setItem(key, '{');
    expect(() => readDurableAttempt(localStorage, key, "hotel-a", "actor-a")).toThrow(/unreadable/);
    mount(); expect(await screen.findByText(/unreadable/)).toBeTruthy();
  });
  it("blocks a different payload and fails closed when another tab holds the lock", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("offline"); }); vi.stubGlobal("fetch", fetchMock);
    mount(); fireEvent.click(screen.getByText("Submit"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const saved = JSON.parse(localStorage.getItem(key)!); saved.body = '{"quantity":3}';
    localStorage.setItem(key, JSON.stringify(saved));
    fireEvent.click(screen.getByText("Submit")); await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledOnce();
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_n: string, _o: unknown, fn: (lock: null) => Promise<unknown>) => fn(null) } });
    fireEvent.click(screen.getByText("Submit")); await new Promise(resolve => setTimeout(resolve, 0));
    expect(fetchMock).toHaveBeenCalledOnce(); expect(localStorage.getItem(key)).not.toBeNull();
  });
  it("clears a saved request only after a valid successful response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{"id":"ok"}', { status: 201, headers: { "content-type": "application/json" } })));
    mount(); fireEvent.click(screen.getByText("Submit"));
    await waitFor(() => expect(screen.queryByText(/Unresolved purchase request/)).toBeNull());
    expect(localStorage.getItem(key)).toBeNull();
  });
  it("retains recovery until explicit reconciliation even when a request is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response('{}', { status: 400, headers: { "content-type": "application/json" } })));
    mount(); fireEvent.click(screen.getByText("Submit"));
    await waitFor(() => expect(localStorage.getItem(key)).not.toBeNull());
    expect(await screen.findByText(/Unresolved purchase request/)).toBeTruthy();
  });
});
