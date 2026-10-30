"use client";

import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { ApiRequestError, apiErrorMessage, requestJson } from "@/lib/client-api";

type FolioDetail = {
  id: string;
  guestName: string;
  isClosed: boolean;
  items: {
    id: string;
    description: string;
    quantity: number;
    unitPrice: number;
    total: number;
  }[];
  payments: {
    id: string;
    amount: number;
    method: string;
    reference: string | null;
    createdAt: string;
  }[];
  required: number;
  paid: number;
  balance: number;
};

type PaymentMethod = { id: string; name: string };
type PaymentPayload = {
  folioId: string;
  paymentMethodId: string;
  amount: number;
  reference: string;
};
type PendingPaymentAttempt = {
  /** null marks a legacy or malformed tenant association; it must never be retried. */
  hotelId: string | null;
  key: string;
  payload: PaymentPayload;
  outcome: "uncertain" | "confirmed";
};

function pendingPaymentStorageKey(folioId: string) {
  return `hotel-flow:pending-folio-payment:v1:${folioId}`;
}

function readPendingPaymentAttempt(folioId: string): PendingPaymentAttempt | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(pendingPaymentStorageKey(folioId));
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    const payloadValue = candidate.payload;
    if (!payloadValue || typeof payloadValue !== "object" || Array.isArray(payloadValue)) return null;
    const payload = payloadValue as Record<string, unknown>;
    if (
      typeof candidate.key !== "string" || candidate.key.length < 4 || candidate.key.length > 128 ||
      (candidate.outcome !== "uncertain" && candidate.outcome !== "confirmed") ||
      payload.folioId !== folioId || typeof payload.paymentMethodId !== "string" ||
      typeof payload.reference !== "string" || typeof payload.amount !== "number" ||
      !Number.isFinite(payload.amount) || payload.amount <= 0
    ) return null;

    const hotelId = typeof candidate.hotelId === "string" && candidate.hotelId.trim()
      ? candidate.hotelId
      : null;
    return {
      hotelId,
      key: candidate.key,
      payload: {
        folioId,
        paymentMethodId: payload.paymentMethodId,
        amount: payload.amount,
        reference: payload.reference,
      },
      outcome: candidate.outcome,
    };
  } catch {
    return null;
  }
}

function isFolioDetail(value: unknown): value is FolioDetail {
  if (!value || typeof value !== "object") return false;
  const folio = value as Partial<FolioDetail>;
  return (
    typeof folio.id === "string" && typeof folio.guestName === "string" &&
    typeof folio.isClosed === "boolean" && Array.isArray(folio.items) &&
    Array.isArray(folio.payments) && Number.isFinite(folio.required) &&
    Number.isFinite(folio.paid) && Number.isFinite(folio.balance)
  );
}

function isPaymentResult(value: unknown): value is { id: string; required: number; paid: number; balance: number } {
  if (!value || typeof value !== "object") return false;
  const payment = value as Record<string, unknown>;
  return typeof payment.id === "string" && payment.id.length > 0 &&
    Number.isFinite(payment.required) && Number.isFinite(payment.paid) && Number.isFinite(payment.balance);
}

function money(value: number) {
  return `KSh ${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default function FolioModal({
  activeTenantId,
  folioId,
  reservationId,
  canCheckout,
  canOverrideBalance,
  onClose,
  onDone,
}: {
  activeTenantId: string;
  folioId: string;
  reservationId: string;
  canCheckout: boolean;
  canOverrideBalance: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [folio, setFolio] = useState<FolioDetail | null>(null);
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [methodId, setMethodId] = useState("");
  const [amount, setAmount] = useState("");
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [paymentNotice, setPaymentNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingFolio, setLoadingFolio] = useState(true);
  const [folioLoadAttempt, setFolioLoadAttempt] = useState(0);
  const [pendingAttempt, setPendingAttempt] = useState<PendingPaymentAttempt | null>(null);
  const [pendingReadyForFolioId, setPendingReadyForFolioId] = useState<string | null>(null);
  const pendingAttemptRef = useRef<PendingPaymentAttempt | null>(null);
  const operationInFlightRef = useRef(false);
  const retryConfirmedRefreshRef = useRef<() => Promise<void>>(async () => {});

  function storePendingAttempt(attempt: PendingPaymentAttempt | null): boolean {
    pendingAttemptRef.current = attempt;
    setPendingAttempt(attempt);
    try {
      if (attempt) {
        window.sessionStorage.setItem(pendingPaymentStorageKey(folioId), JSON.stringify(attempt));
      } else {
        window.sessionStorage.removeItem(pendingPaymentStorageKey(folioId));
      }
      return true;
    } catch {
      // The caller must not start a new payment unless its exact attempt was saved.
      return false;
    }
  }

  async function fetchFolio(): Promise<FolioDetail> {
    const data = await requestJson<unknown>(`/api/folios/${folioId}`);
    if (!isFolioDetail(data)) throw new Error("The server returned an invalid folio response.");
    return data;
  }

  async function loadFolio() {
    const data = await fetchFolio();
    setFolio(data);
    setAmount(data.balance > 0 ? String(data.balance) : "");
    return data;
  }

  async function refreshConfirmedPayment(attempt: PendingPaymentAttempt) {
    if (attempt.hotelId !== activeTenantId) {
      setFolio(null);
      setPaymentNotice("A saved payment belongs to another or unknown hotel and was preserved.");
      setError("Switch back to the original hotel to refresh this confirmed payment. No recovery record was cleared.");
      setLoadingFolio(false);
      return null;
    }
    setLoadingFolio(true);
    setFolio(null); // Never present the pre-payment balance as current.
    setError(null);
    try {
      await loadFolio();
      storePendingAttempt(null);
      setReference("");
      setPaymentNotice("Payment recorded. The folio has been refreshed.");
      setLoadingFolio(false);
      onDone();

      if (methods.length === 0) {
        try {
          const methodsData = await requestJson<unknown>("/api/payment-methods");
          if (!Array.isArray(methodsData) || !methodsData.every((method) =>
            method && typeof method === "object" && typeof (method as PaymentMethod).id === "string" && typeof (method as PaymentMethod).name === "string"
          )) throw new Error("The server returned an invalid payment-method list.");
          setMethods(methodsData as PaymentMethod[]);
          setMethodId((methodsData[0] as PaymentMethod | undefined)?.id ?? "");
        } catch {
          setError("Payment recorded and folio refreshed, but payment methods could not be loaded. Reopen the folio before recording another payment.");
        }
      }
      return;
    } catch {
      // Keep the confirmed attempt and its key until the folio can be refreshed.
      storePendingAttempt({ ...attempt, outcome: "confirmed" });
      setPaymentNotice("Payment recorded successfully.");
      setError("The payment was recorded, but the folio could not be refreshed. No further payment can be submitted until the current balance is loaded.");
      setFolio(null);
      return null;
    } finally {
      setLoadingFolio(false);
    }
  }

  async function retryConfirmedRefresh() {
    const attempt = pendingAttemptRef.current;
    if (!attempt || attempt.outcome !== "confirmed" || operationInFlightRef.current) return;
    operationInFlightRef.current = true;
    setLoading(true);
    try {
      await refreshConfirmedPayment(attempt);
    } finally {
      operationInFlightRef.current = false;
      setLoading(false);
    }
  }

  retryConfirmedRefreshRef.current = retryConfirmedRefresh;

  useEffect(() => {
    const storedAttempt = readPendingPaymentAttempt(folioId);
    pendingAttemptRef.current = storedAttempt;
    setPendingAttempt(storedAttempt);
    setFolio(null);
    const tenantMismatch = Boolean(storedAttempt && storedAttempt.hotelId !== activeTenantId);
    setError(tenantMismatch
      ? "A saved payment belongs to another or unknown hotel. Its recovery record was preserved; switch back to the original hotel."
      : null);
    setPaymentNotice(tenantMismatch ? "No payment was retried or cleared under the current hotel." : null);
    setLoadingFolio(!tenantMismatch);
    setPendingReadyForFolioId(folioId);
  }, [folioId, activeTenantId]);

  useEffect(() => {
    if (pendingReadyForFolioId !== folioId) return;
    let cancelled = false;
    const storedAttempt = pendingAttemptRef.current;

    if (storedAttempt && storedAttempt.hotelId !== activeTenantId) {
      setFolio(null);
      setLoadingFolio(false);
      setError("A saved payment belongs to another or unknown hotel. Its recovery record was preserved; switch back to the original hotel.");
      return () => { cancelled = true; };
    }
    if (storedAttempt?.outcome === "uncertain") {
      setLoadingFolio(false);
      return () => { cancelled = true; };
    }
    if (storedAttempt?.outcome === "confirmed") {
      void retryConfirmedRefreshRef.current();
      return () => { cancelled = true; };
    }

    async function load() {
      setLoadingFolio(true);
      setError(null);
      try {
        const [folioData, methodsData] = await Promise.all([
          requestJson<unknown>(`/api/folios/${folioId}`),
          requestJson<unknown>("/api/payment-methods"),
        ]);
        if (!isFolioDetail(folioData)) throw new Error("The server returned an invalid folio response.");
        if (!Array.isArray(methodsData) || !methodsData.every((method) =>
          method && typeof method === "object" && typeof (method as PaymentMethod).id === "string" && typeof (method as PaymentMethod).name === "string"
        )) throw new Error("The server returned an invalid payment-method list.");
        if (!cancelled) {
          setFolio(folioData);
          setAmount(folioData.balance > 0 ? String(folioData.balance) : "");
          setMethods(methodsData as PaymentMethod[]);
          setMethodId((methodsData[0] as PaymentMethod | undefined)?.id ?? "");
        }
      } catch (loadError) {
        if (!cancelled) setError(apiErrorMessage(loadError, "Could not load the folio."));
      } finally {
        if (!cancelled) setLoadingFolio(false);
      }
    }

    void load();
    return () => { cancelled = true; };
  }, [folioId, activeTenantId, folioLoadAttempt, pendingReadyForFolioId]);

  async function postPaymentAttempt(attempt: PendingPaymentAttempt) {
    if (attempt.hotelId !== activeTenantId) {
      setFolio(null);
      setError("This saved payment belongs to another or unknown hotel. Its recovery record was preserved; switch to the original hotel before retrying.");
      return;
    }
    if (operationInFlightRef.current) return;
    const existingAttempt = pendingAttemptRef.current;
    if (existingAttempt && (existingAttempt.key !== attempt.key || existingAttempt.outcome !== "uncertain")) return;

    operationInFlightRef.current = true;
    setLoading(true);
    setError(null);
    setPaymentNotice(null);
    // A retry already has this exact attempt saved. For a new attempt, require
    // session storage to accept its complete payload and key before any POST.
    if (!existingAttempt && !storePendingAttempt({ ...attempt, outcome: "uncertain" })) {
      storePendingAttempt(null);
      setError("Payment was not submitted because this browser could not save the pending payment attempt. Check browser storage settings and try again.");
      operationInFlightRef.current = false;
      setLoading(false);
      return;
    }
    setLoadingFolio(false);
    setFolio(null);

    try {
      let result: unknown;
      try {
        result = await requestJson<unknown>("/api/payments", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Expected-Hotel-Id": activeTenantId,
            "Idempotency-Key": attempt.key,
          },
          body: JSON.stringify({ ...attempt.payload, idempotencyKey: attempt.key }),
        });
        if (!isPaymentResult(result)) throw new Error("The server returned an invalid payment response.");
      } catch (paymentError) {
        const definitelyRejected = paymentError instanceof ApiRequestError && (
          (paymentError.kind === "http" && [400, 404].includes(paymentError.status ?? 0)) ||
          (paymentError.kind === "unauthorized" && paymentError.status === 401) ||
          (paymentError.kind === "forbidden" && paymentError.status === 403)
        );
        if (definitelyRejected) {
          storePendingAttempt(null);
          const rejectionMessage = apiErrorMessage(paymentError, "The payment was rejected.");
          setError(`Payment was not submitted. ${rejectionMessage}`);
          setLoadingFolio(true);
          try {
            await loadFolio();
          } catch {
            setError(`Payment was not submitted. ${rejectionMessage} The folio could not be refreshed.`);
          } finally {
            setLoadingFolio(false);
          }
        } else {
          storePendingAttempt({ ...attempt, outcome: "uncertain" });
          setError(`The payment outcome is uncertain. Do not submit a new payment. Retry this same attempt to safely verify it. ${apiErrorMessage(paymentError, "")}`.trim());
        }
        return;
      }

      const confirmedAttempt = { ...attempt, outcome: "confirmed" as const };
      storePendingAttempt(confirmedAttempt);
      setPaymentNotice("Payment recorded successfully. Refreshing the folio…");
      await refreshConfirmedPayment(confirmedAttempt);
    } finally {
      operationInFlightRef.current = false;
      setLoading(false);
    }
  }

  async function collectPayment(event: React.FormEvent) {
    event.preventDefault();
    if (operationInFlightRef.current) return;

    const retainedAttempt = pendingAttemptRef.current;
    if (retainedAttempt) {
      if (retainedAttempt.outcome === "uncertain") await postPaymentAttempt(retainedAttempt);
      else await retryConfirmedRefresh();
      return;
    }

    const paymentAmount = Number(amount);
    if (!methodId || !Number.isFinite(paymentAmount) || paymentAmount <= 0) return;
    await postPaymentAttempt({
      hotelId: activeTenantId,
      key: crypto.randomUUID(),
      payload: { folioId, paymentMethodId: methodId, amount: paymentAmount, reference },
      outcome: "uncertain",
    });
  }

  async function retryUncertainPayment() {
    const attempt = pendingAttemptRef.current;
    if (!attempt || attempt.outcome !== "uncertain") return;
    await postPaymentAttempt(attempt);
  }

  async function completeCheckout() {
    if (!folio) return;

    const hasBalance = folio.balance > 0;
    if (hasBalance && !canOverrideBalance) {
      setError("The outstanding balance must be paid before checkout.");
      return;
    }
    if (
      hasBalance &&
      !confirm(
        `This guest still owes ${money(folio.balance)}. Use the Admin/Manager override and check out anyway?`
      )
    ) {
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await requestJson<{ ok: true; folioId: string }>("/api/check-out", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reservationId,
          allowOutstandingBalance: hasBalance,
        }),
      });
      onDone();
      onClose();
    } catch (checkoutError) {
      setError(apiErrorMessage(checkoutError, "Could not complete checkout."));
    } finally {
      setLoading(false);
    }
  }

  const pendingAttemptTenantMismatch = Boolean(
    pendingAttempt && pendingAttempt.hotelId !== activeTenantId,
  );

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30 p-4">
      <div className="card w-full max-w-md max-h-[85vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2>{folio?.guestName ?? "Folio"}</h2>
          <button
            type="button"
            onClick={() => {
              if ((!pendingAttemptRef.current || pendingAttemptTenantMismatch) && !operationInFlightRef.current) onClose();
            }}
            disabled={(pendingAttempt !== null && !pendingAttemptTenantMismatch) || loading}
            aria-label="Close folio"
            className="text-text-secondary hover:text-text-primary disabled:opacity-50"
          >
            <X size={18} />
          </button>
        </div>

        {paymentNotice && (
          <p role="status" className="mb-3 text-sm text-success bg-success/5 border border-success/20 rounded-control px-3 py-2">
            {paymentNotice}
          </p>
        )}

        {pendingAttemptTenantMismatch && (
          <div className="mb-3 space-y-2 text-sm text-danger bg-danger/5 border border-danger/20 rounded-control px-3 py-2">
            <p role="alert">
              This saved payment belongs to another or unknown hotel. Its exact recovery record was preserved; no retry, refresh, or cleanup was performed under the current hotel.
            </p>
            <p>Switch back to the original hotel to continue recovery. You may close this view without deleting the saved attempt.</p>
          </div>
        )}

        {pendingAttempt?.outcome === "uncertain" && !pendingAttemptTenantMismatch && (
          <div className="mb-3 space-y-2 text-sm text-danger bg-danger/5 border border-danger/20 rounded-control px-3 py-2">
            <p role="alert">
              The payment outcome is not yet confirmed. The previous balance is hidden; retrying will use the exact same amount, method, reference, and idempotency key.
            </p>
            <button type="button" onClick={retryUncertainPayment} disabled={loading} className="underline disabled:opacity-50">
              {loading ? "Verifying payment…" : "Retry same payment"}
            </button>
          </div>
        )}

        {pendingAttempt?.outcome === "confirmed" && !folio && !pendingAttemptTenantMismatch && (
          <div className="mb-3 space-y-2 text-sm text-success bg-success/5 border border-success/20 rounded-control px-3 py-2">
            <p role="status">
              Payment is confirmed, but the folio balance is not current yet. No new payment will be submitted.
            </p>
            {error && <p role="alert">{error}</p>}
            <button type="button" onClick={retryConfirmedRefresh} disabled={loading} className="underline disabled:opacity-50">
              {loading ? "Refreshing folio…" : "Retry folio refresh"}
            </button>
          </div>
        )}

        {!folio && !error && !pendingAttempt && (
          <p role="status" className="text-sm text-text-secondary">
            {loadingFolio ? "Loading folio…" : "Folio details are not available."}
          </p>
        )}

        {folio && (
          <div className="space-y-4">
            <div className="border border-border rounded-control divide-y divide-border">
              {folio.items.map((item) => (
                <div key={item.id} className="flex justify-between gap-3 px-3 py-2 text-sm">
                  <span>{item.description}</span>
                  <span className="font-medium whitespace-nowrap">{money(item.total)}</span>
                </div>
              ))}
              {folio.items.length === 0 && (
                <p className="px-3 py-2 text-sm text-text-secondary">No charges yet.</p>
              )}
            </div>

            <div className="border border-border rounded-control px-3 py-3 text-sm space-y-2">
              <div className="flex justify-between">
                <span className="text-text-secondary">Amount required</span>
                <span>{money(folio.required)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-text-secondary">Amount paid</span>
                <span className="text-success">{money(folio.paid)}</span>
              </div>
              <div className="flex justify-between font-semibold pt-2 border-t border-border">
                <span>{folio.balance < 0 ? "Credit" : "Balance due"}</span>
                <span className={folio.balance > 0 ? "text-danger" : "text-success"}>
                  {money(Math.abs(folio.balance))}
                </span>
              </div>
            </div>

            {folio.payments.length > 0 && (
              <div>
                <p className="text-sm font-medium mb-2">Payments received</p>
                <div className="border border-border rounded-control divide-y divide-border">
                  {folio.payments.map((payment) => (
                    <div key={payment.id} className="px-3 py-2 text-sm">
                      <div className="flex justify-between gap-3">
                        <span>
                          {payment.method} · {new Date(payment.createdAt).toLocaleString()}
                        </span>
                        <span className="font-medium whitespace-nowrap">
                          {money(payment.amount)}
                        </span>
                      </div>
                      {payment.reference && (
                        <p className="text-xs text-text-muted mt-1">
                          Reference: {payment.reference}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {error && (
              <p role="alert" className="text-sm text-danger bg-danger/5 border border-danger/20 rounded-control px-3 py-2">
                {error}
              </p>
            )}

            {!folio.isClosed && folio.balance > 0 && (
              <form onSubmit={collectPayment} className="space-y-2 border-t border-border pt-3">
                <p className="text-sm font-medium">Collect Payment</p>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={methodId}
                    onChange={(event) => setMethodId(event.target.value)}
                    required
                    className="rounded-control border border-border px-3 py-2 text-sm"
                  >
                    {methods.length === 0 && <option value="">No methods available</option>}
                    {methods.map((method) => (
                      <option key={method.id} value={method.id}>
                        {method.name}
                      </option>
                    ))}
                  </select>
                  <input
                    type="number"
                    min="0.01"
                    max={folio.balance}
                    step="0.01"
                    placeholder="Amount (KSh)"
                    value={amount}
                    onChange={(event) => setAmount(event.target.value)}
                    required
                    className="rounded-control border border-border px-3 py-2 text-sm"
                  />
                </div>
                <input
                  placeholder="Reference (for example, M-Pesa code) — optional"
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                  className="w-full rounded-control border border-border px-3 py-2 text-sm"
                />
                <button
                  type="submit"
                  disabled={loading || !methodId}
                  className="btn-secondary w-full"
                >
                  {loading ? "Recording..." : "Record Payment"}
                </button>
              </form>
            )}

            {!folio.isClosed && folio.balance <= 0 && (
              <p className="text-sm text-success bg-success/5 border border-success/20 rounded-control px-3 py-2 text-center">
                This folio is fully paid.
              </p>
            )}

            {!folio.isClosed && canCheckout && folio.balance > 0 && !canOverrideBalance && (
              <p className="text-sm text-danger text-center">
                Collect the outstanding balance before checkout. An Admin or Manager may override.
              </p>
            )}

            {!folio.isClosed &&
              canCheckout &&
              (folio.balance <= 0 || canOverrideBalance) && (
                <button
                  type="button"
                  onClick={completeCheckout}
                  disabled={loading}
                  className="btn-primary w-full"
                >
                  {loading
                    ? "Processing..."
                    : folio.balance > 0
                    ? "Manager Override & Check Out"
                    : "Complete Checkout"}
                </button>
              )}

            {folio.isClosed && (
              <p className="text-sm text-text-secondary text-center">This folio is closed.</p>
            )}
          </div>
        )}

        {!folio && error && !pendingAttempt && (
          <div role="alert" className="flex items-center justify-between gap-3 text-sm text-danger bg-danger/5 border border-danger/20 rounded-control px-3 py-2">
            <span>{error}</span>
            <button
              type="button"
              onClick={() => {
                setLoadingFolio(true);
                setFolioLoadAttempt((attempt) => attempt + 1);
              }}
              disabled={loadingFolio}
              className="underline disabled:opacity-50"
            >
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
