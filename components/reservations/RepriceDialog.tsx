"use client";

import { useState } from "react";
import { X } from "lucide-react";
import { apiErrorMessage, requestJson } from "@/lib/client-api";

/**
 * Explicit repricing of a sold reservation.
 *
 * Configuration edits never move an existing reservation's price — the agreed
 * amount is frozen in its snapshot. This dialog is the deliberate way to bring a
 * stay to today's rates, and the server records who did it, from what to what,
 * and why.
 */
export default function RepriceDialog({
  reservation,
  currency,
  onClose,
  onRepriced,
}: {
  reservation: { id: string; code: string; guestName: string; requiredAmount: number };
  currency: string;
  onClose: () => void;
  onRepriced: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ previous: number | null; total: number } | null>(null);

  function money(amount: number) {
    try {
      return new Intl.NumberFormat("en-KE", { style: "currency", currency }).format(amount);
    } catch {
      return `${currency} ${amount.toLocaleString()}`;
    }
  }

  async function reprice() {
    setBusy(true);
    setError(null);
    try {
      const data = await requestJson<{ previousTotal: number | null; total: number }>(
        `/api/reservations/${reservation.id}/reprice`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: reason.trim() || undefined }),
        }
      );
      setResult({ previous: data.previousTotal, total: data.total });
      onRepriced(`${reservation.code} repriced to ${money(data.total)}.`);
    } catch (submitError) {
      setError(apiErrorMessage(submitError, "Could not reprice this reservation."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30 p-4">
      <div className="card w-full max-w-md" data-testid="reprice-dialog">
        <div className="flex items-center justify-between mb-3">
          <h2>Reprice reservation</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary" aria-label="Close">
            <X size={18} />
          </button>
        </div>

        <p className="text-sm text-text-secondary">
          {reservation.guestName} · {reservation.code}
        </p>
        <p className="mt-2 text-sm text-text-secondary">
          Recalculates this stay with the hotel&apos;s current rates. The reservation keeps its
          frozen price until you confirm here.
        </p>
        <div className="mt-3 flex items-center justify-between rounded-control border border-border px-3 py-2 text-sm">
          <span className="text-text-secondary">Currently agreed</span>
          <span className="font-medium" data-testid="reprice-current">
            {money(reservation.requiredAmount)}
          </span>
        </div>

        <label className="mt-3 block text-sm font-medium">
          Reason (optional)
          <input
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="e.g. guest extended, rate correction"
            className="mt-1 w-full rounded-control border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent"
          />
        </label>

        {result && (
          <p className="mt-3 rounded-control border border-success/40 bg-success/5 px-3 py-2 text-sm text-success" role="status">
            <span data-testid="reprice-result">
              {result.previous === null ? "No previous price" : money(result.previous)} → {money(result.total)}
            </span>
          </p>
        )}
        {error && (
          <p className="mt-3 rounded-control border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger" role="alert">
            {error}
          </p>
        )}

        <div className="mt-4 flex gap-2">
          <button type="button" onClick={onClose} className="btn-secondary flex-1">
            {result ? "Done" : "Cancel"}
          </button>
          <button type="button" onClick={reprice} disabled={busy || Boolean(result)} className="btn-primary flex-1">
            {busy ? "Repricing…" : result ? "Repriced" : "Reprice at current rates"}
          </button>
        </div>
      </div>
    </div>
  );
}
