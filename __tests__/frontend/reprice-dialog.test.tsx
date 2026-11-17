// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import RepriceDialog from "@/components/reservations/RepriceDialog";

/**
 * Repricing is the only deliberate way an existing reservation's price moves, so
 * the dialog must send the reason, show what changed, and surface a refusal
 * instead of pretending the stay was updated.
 */

let calls: { url: string; body: Record<string, unknown> }[] = [];
let response: { status: number; body: unknown } = { status: 200, body: {} };
const repriced: string[] = [];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  calls = [];
  repriced.length = 0;
  response = { status: 200, body: { ok: true, previousTotal: 20700, total: 24000 } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return jsonResponse(response.body, response.status);
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function renderDialog() {
  return render(
    <RepriceDialog
      reservation={{ id: "res-1", code: "RES-2026-000042", guestName: "Amina Wanjiru", requiredAmount: 20700 }}
      currency="KES"
      onClose={() => {}}
      onRepriced={(message) => repriced.push(message)}
    />
  );
}

const repriceButton = () => screen.getByRole("button", { name: /reprice at current rates/i });

describe("RepriceDialog", () => {
  it("shows the currently agreed amount before anything changes", () => {
    renderDialog();
    expect(screen.getByTestId("reprice-current").textContent).toContain("20,700");
  });

  it("reprices the reservation it was opened for and reports the change", async () => {
    renderDialog();
    fireEvent.change(screen.getByPlaceholderText(/rate correction/i), {
      target: { value: "guest extended" },
    });
    fireEvent.click(repriceButton());

    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].url).toBe("/api/reservations/res-1/reprice");
    expect(calls[0].body).toMatchObject({ reason: "guest extended" });
    await waitFor(() => expect(screen.getByTestId("reprice-result")).toBeTruthy());
    expect(screen.getByTestId("reprice-result").textContent).toContain("20,700");
    expect(screen.getByTestId("reprice-result").textContent).toContain("24,000");
    expect(repriced[0]).toContain("RES-2026-000042");
  });

  it("sends no reason when the field is left blank", async () => {
    renderDialog();
    fireEvent.click(repriceButton());
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].body.reason).toBeUndefined();
  });

  it("surfaces a refusal and does not claim the price moved", async () => {
    response = { status: 400, body: { error: "Only a pending or confirmed reservation can be repriced." } };
    renderDialog();
    fireEvent.click(repriceButton());

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Only a pending or confirmed reservation")
    );
    expect(screen.queryByTestId("reprice-result")).toBeNull();
    expect(repriced).toHaveLength(0);
  });

  it("does not reprice twice from the same confirmation", async () => {
    renderDialog();
    fireEvent.click(repriceButton());
    await waitFor(() => expect(screen.getByTestId("reprice-result")).toBeTruthy());
    const button = screen.getByRole("button", { name: /repriced/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(calls).toHaveLength(1);
  });
});
