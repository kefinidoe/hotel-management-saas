"use client";

import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { addDays, isoDay } from "@/lib/dates";
import { roundMoney, stayNights } from "@/lib/billing";
import { formatDisplayDate } from "@/lib/dates";

type ExtendableStay = {
  id: string;
  code: string;
  guestName: string;
  roomNumbers: string;
  checkOutDate: string;
  requiredAmount: number;
  paidAmount: number;
  nightlyRateTotal: number;
};

type ExtensionRecord = {
  id: string;
  previousCheckOut: string;
  newCheckOut: string;
  additionalNights: number;
  nightlyRate: string | number;
  additionalCharge: string | number;
  currency: string;
  createdAt: string;
  approvedBy?: { name: string } | null;
};

function money(value: number) {
  return `KSh ${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function ExtendStayModal({
  reservation,
  onClose,
  onExtended,
}: {
  reservation: ExtendableStay;
  onClose: () => void;
  onExtended: (folioId: string) => void;
}) {
  const currentCheckOut = new Date(reservation.checkOutDate);
  const firstExtensionDate = addDays(currentCheckOut, 1);
  const [newCheckOutDate, setNewCheckOutDate] = useState(isoDay(firstExtensionDate));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Previous extensions of this stay, read from the reservation detail endpoint
  // so the agreement history is visible where the next extension is approved.
  const [history, setHistory] = useState<ExtensionRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/reservations/${reservation.id}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data) => {
        if (cancelled || !data) return;
        const rows = Array.isArray(data.stayExtensions) ? data.stayExtensions : [];
        setHistory(rows);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [reservation.id]);

  let additionalNights = 0;
  try {
    additionalNights = stayNights(currentCheckOut, new Date(newCheckOutDate));
  } catch {
    additionalNights = 0;
  }

  const additionalCharge = roundMoney(additionalNights * reservation.nightlyRateTotal);
  const newRequired = roundMoney(reservation.requiredAmount + additionalCharge);
  const newBalance = roundMoney(newRequired - reservation.paidAmount);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (additionalNights < 1) {
      setError("Choose a date after the current check-out date.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/reservations/${reservation.id}/extend`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkOutDate: new Date(newCheckOutDate).toISOString(),
        }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not extend the stay.");
      onExtended(data.folioId);
      onClose();
    } catch (extensionError) {
      setError(
        extensionError instanceof Error ? extensionError.message : "Could not extend the stay."
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/30 p-4">
      <div className="card w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2>Add Days</h2>
            <p className="text-sm text-text-secondary mt-1">
              {reservation.guestName} · Room {reservation.roomNumbers} · {reservation.code}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-text-secondary hover:text-text-primary"
          >
            <X size={18} />
          </button>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium mb-1.5">New check-out date</label>
            <input
              type="date"
              min={isoDay(firstExtensionDate)}
              value={newCheckOutDate}
              onChange={(event) => setNewCheckOutDate(event.target.value)}
              required
              className="w-full rounded-control border border-border px-3 py-2 text-sm"
            />
            <p className="text-xs text-text-muted mt-1">
              Current check-out: {formatDisplayDate(currentCheckOut)}
            </p>
          </div>

          <div className="rounded-control border border-border bg-bg px-3 py-3 text-sm space-y-2">
            <div className="flex justify-between">
              <span className="text-text-secondary">Original agreed nightly rate</span>
              <span>{money(reservation.nightlyRateTotal)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">Additional nights</span>
              <span>{additionalNights}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">Additional charge</span>
              <span className="font-medium">{money(additionalCharge)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-2">
              <span className="text-text-secondary">New amount required</span>
              <span className="font-medium">{money(newRequired)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">Amount already paid</span>
              <span className="text-success">{money(reservation.paidAmount)}</span>
            </div>
            <div className="flex justify-between border-t border-border pt-2 font-semibold">
              <span>New balance due</span>
              <span className={newBalance > 0 ? "text-danger" : "text-success"}>
                {money(Math.max(0, newBalance))}
              </span>
            </div>
          </div>

          <p className="text-xs text-text-muted">
            The extension charge will be added to the guest folio. You can collect the additional
            payment immediately after saving. The original booking price is not changed; each
            extension is recorded separately with its dates, nights, rate and who approved it.
          </p>

          {history.length > 0 && (
            <div className="rounded-control border border-border bg-bg px-3 py-3 text-sm">
              <p className="font-medium mb-2">Previous extensions</p>
              <ul className="space-y-1 text-xs text-text-secondary">
                {history.map((entry) => (
                  <li key={entry.id} className="flex justify-between gap-3">
                    <span>
                      {formatDisplayDate(new Date(entry.previousCheckOut))} to{" "}
                      {formatDisplayDate(new Date(entry.newCheckOut))} — {entry.additionalNights} night
                      {entry.additionalNights === 1 ? "" : "s"}
                    </span>
                    <span className="whitespace-nowrap">
                      {money(Number(entry.additionalCharge))}
                      {entry.approvedBy?.name ? ` · ${entry.approvedBy.name}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <p className="text-sm text-danger bg-danger/5 border border-danger/20 rounded-control px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading || additionalNights < 1}
              className="btn-primary"
            >
              {loading
                ? "Saving..."
                : `Add ${additionalNights} Night${additionalNights === 1 ? "" : "s"}`}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
