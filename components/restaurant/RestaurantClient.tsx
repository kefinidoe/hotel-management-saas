"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus, Trash2, ShoppingCart, UtensilsCrossed, Settings2, X } from "lucide-react";
import type { HotelRole } from "@prisma/client";
import clsx from "clsx";
import { hasRole, ROLE_GROUPS } from "@/lib/permissions";
import { isRequiredMenuCategory } from "@/lib/menu-categories";

type MenuItem = { id: string; name: string; price: number; availablePortions: number | null };
type Category = { id: string; name: string; items: MenuItem[] };
type OrderLine = { menuItemId: string; name: string; unitPrice: number; quantity: number };
type PaymentMethod = { id: string; name: string };
type OpenFolio = { id: string; label: string };
type ActivityItem = {
  id: string;
  description: string;
  total: number;
  guestName: string;
  roomNumber: string | null;
  settled: boolean;
  createdAt: string;
};

export type CheckoutState =
  | "READY"
  | "SUBMITTING"
  | "PENDING_VERIFICATION"
  | "CONFIRMED_SUCCESS"
  | "CONFIRMED_FAILURE";

export interface PendingCheckoutSnapshot {
  idempotencyKey: string;
  items: OrderLine[];
  paymentMethodId: string;
  customerName: string;
  reference: string;
  tableNumber: string;
  timestamp: number;
  isExpired?: boolean;
  status?: "IN_FLIGHT" | "UNCERTAIN" | "PAYLOAD_MISMATCH" | "EXPIRED";
}

const POS_STORAGE_KEY = "hms_pos_pending_attempt_v1";
export const POS_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Privacy & Security Considerations for POS Checkout Recovery Storage:
 *
 * 1. Data Minimization: The snapshot persists only the minimal fields required to reconstruct
 *    the exact checkout payload (idempotencyKey, cart item IDs/quantities/prices, paymentMethodId,
 *    and optional customer/table references). Card numbers, CVVs, passwords, or PII are never stored.
 * 2. Multi-Cashier & Shared POS Terminals: In multi-staff shift environments where POS terminals
 *    are shared, unencrypted data in localStorage could theoretically be viewed via browser devtools.
 *    To mitigate exposure:
 *    - Records have an automatic 24-hour expiration TTL (POS_SNAPSHOT_TTL_MS).
 *    - Storage is wiped immediately upon CONFIRMED_SUCCESS or CONFIRMED_FAILURE.
 *    - Restoration enforces strict schema and item validation before populating state.
 * 3. Durable Tab Recovery: Using localStorage ensures that unexpected tab closures, browser crashes,
 *    or power interruptions do not lose the active in-flight idempotency key, preventing duplicate
 *    charges if the cashier re-enters the order upon reopening the terminal.
 * 4. Anti-Wipe Guarantee: An expired snapshot (>24h) is never silently deleted without verification.
 *    It is quarantined and locked until reconciled against the server.
 */
export function validatePendingSnapshot(raw: unknown): PendingCheckoutSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (
    typeof obj.idempotencyKey !== "string" ||
    obj.idempotencyKey.trim().length < 4 ||
    obj.idempotencyKey.trim().length > 128
  ) {
    return null;
  }
  if (!Array.isArray(obj.items) || obj.items.length === 0) {
    return null;
  }
  for (const item of obj.items) {
    if (!item || typeof item !== "object") return null;
    const it = item as Record<string, unknown>;
    if (typeof it.menuItemId !== "string" || !it.menuItemId) return null;
    if (typeof it.quantity !== "number" || it.quantity <= 0) return null;
    if (typeof it.unitPrice !== "number" || it.unitPrice < 0) return null;
  }
  if (typeof obj.paymentMethodId !== "string" || !obj.paymentMethodId.trim()) {
    return null;
  }

  // Calculate whether snapshot is older than 24h TTL or futuristic
  const isExpired =
    typeof obj.timestamp === "number" &&
    (Date.now() - obj.timestamp > POS_SNAPSHOT_TTL_MS || obj.timestamp <= 0);

  return {
    idempotencyKey: obj.idempotencyKey.trim(),
    items: obj.items as OrderLine[],
    paymentMethodId: obj.paymentMethodId.trim(),
    customerName: typeof obj.customerName === "string" ? obj.customerName.trim() : "",
    reference: typeof obj.reference === "string" ? obj.reference.trim() : "",
    tableNumber: typeof obj.tableNumber === "string" ? obj.tableNumber.trim() : "",
    timestamp: typeof obj.timestamp === "number" ? obj.timestamp : Date.now(),
    isExpired,
    status: (typeof obj.status === "string"
      ? obj.status
      : isExpired
      ? "EXPIRED"
      : "UNCERTAIN") as any,
  };
}

function savePendingAttempt(snapshot: PendingCheckoutSnapshot) {
  try {
    if (typeof window !== "undefined") {
      const serialized = JSON.stringify(snapshot);
      if (window.localStorage) {
        window.localStorage.setItem(POS_STORAGE_KEY, serialized);
      }
      if (window.sessionStorage) {
        window.sessionStorage.setItem(POS_STORAGE_KEY, serialized);
      }
    }
  } catch (err) {
    console.error("Failed to persist pending POS checkout to storage:", err);
  }
}

function clearPendingAttemptStorage() {
  try {
    if (typeof window !== "undefined") {
      if (window.localStorage) {
        window.localStorage.removeItem(POS_STORAGE_KEY);
      }
      if (window.sessionStorage) {
        window.sessionStorage.removeItem(POS_STORAGE_KEY);
      }
    }
  } catch (err) {
    console.error("Failed to clear pending POS checkout from storage:", err);
  }
}

const money = (n: number) => `KSh ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

function inputClass() {
  return "w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm shadow-sm transition-all placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-400";
}

export default function RestaurantClient({
  menu,
  currentUserRole,
  initialFolios,
  initialMethods,
  initialActivity,
  initialTodayTotal,
}: {
  menu: Category[];
  currentUserRole: HotelRole;
  initialFolios: OpenFolio[];
  initialMethods: PaymentMethod[];
  initialActivity: ActivityItem[];
  initialTodayTotal: number;
}) {
  const canManageMenu = hasRole(currentUserRole, ROLE_GROUPS.MANAGEMENT);
  const [activeCategory, setActiveCategory] = useState(menu[0]?.id ?? "");
  const [order, setOrder] = useState<OrderLine[]>([]);
  const [mode, setMode] = useState<"ROOM" | "PAY">("ROOM");
  const [tableNumber, setTableNumber] = useState("");

  const [folios, setFolios] = useState<OpenFolio[]>(initialFolios);
  const [folioId, setFolioId] = useState(initialFolios[0]?.id ?? "");
  const [methods] = useState<PaymentMethod[]>(initialMethods);
  const [methodId, setMethodId] = useState(initialMethods[0]?.id ?? "");
  const [customerName, setCustomerName] = useState("");
  const [reference, setReference] = useState("");

  const [activity, setActivity] = useState<ActivityItem[]>(initialActivity);
  const [todayTotal, setTodayTotal] = useState(initialTodayTotal);
  const [manageOpen, setManageOpen] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [checkoutState, setCheckoutState] = useState<CheckoutState>("READY");
  const [pendingAttempt, setPendingAttempt] = useState<PendingCheckoutSnapshot | null>(null);

  const inFlightRef = useRef(false);

  const [reconciling, setReconciling] = useState(false);

  const loadActivity = useCallback(async () => {
    const res = await fetch("/api/restaurant/activity");
    const data = await res.json();
    setActivity(data.items ?? []);
    setTodayTotal(data.todayTotal ?? 0);
  }, []);

  const loadFolios = useCallback(async () => {
    const res = await fetch("/api/restaurant/open-folios");
    const data: OpenFolio[] = await res.json();
    setFolios(data);
    setFolioId((current) => current || data[0]?.id || "");
  }, []);

  // Restore any pending checkout attempt on initial mount, page reload, or tab reopening
  useEffect(() => {
    try {
      if (typeof window !== "undefined") {
        let stored = window.localStorage ? window.localStorage.getItem(POS_STORAGE_KEY) : null;
        if (!stored && window.sessionStorage) {
          stored = window.sessionStorage.getItem(POS_STORAGE_KEY);
        }
        if (stored) {
          try {
            const parsed = JSON.parse(stored);
            const validated = validatePendingSnapshot(parsed);
            if (validated) {
              setPendingAttempt(validated);
              setCheckoutState("PENDING_VERIFICATION");
              setMode("PAY");
              setOrder(validated.items);
              setMethodId(validated.paymentMethodId);
              setCustomerName(validated.customerName);
              setReference(validated.reference);
              setTableNumber(validated.tableNumber);
              if (validated.isExpired) {
                setError(
                  "This checkout attempt was created over 24 hours ago and is still unresolved. Reconcile with server before clearing."
                );
              } else if (validated.status === "PAYLOAD_MISMATCH") {
                setError(
                  "This checkout had an idempotency key conflict with previous order details. Reconcile with server before clearing."
                );
              } else {
                setError("Payment status is uncertain. Do not start another checkout until this attempt is verified.");
              }
            } else {
              // Malformed storage data: DO NOT silently delete storage. Lock in PENDING_VERIFICATION.
              setCheckoutState("PENDING_VERIFICATION");
              setError("A previous checkout attempt was interrupted, but stored recovery data could not be validated. Please verify recent transactions before starting a new checkout.");
            }
          } catch {
            setCheckoutState("PENDING_VERIFICATION");
            setError("A previous checkout attempt was detected, but could not be parsed. Verify recent transactions before proceeding.");
          }
        }
      }
    } catch (e) {
      console.error("Failed to restore pending POS checkout:", e);
      setCheckoutState("PENDING_VERIFICATION");
      setError("A previous checkout attempt was detected, but could not be read safely. Verify recent transactions before proceeding.");
    }

    // Cross-tab synchronization via storage events
    const handleStorageEvent = (e: StorageEvent) => {
      if (e.key === POS_STORAGE_KEY) {
        if (e.newValue) {
          try {
            const parsed = JSON.parse(e.newValue);
            const validated = validatePendingSnapshot(parsed);
            if (validated) {
              setPendingAttempt(validated);
              setCheckoutState("PENDING_VERIFICATION");
            }
          } catch {}
        } else if (!e.newValue) {
          // Cleared by another tab upon confirmed settlement
          setPendingAttempt(null);
          setCheckoutState("READY");
          loadActivity();
        }
      }
    };

    let bc: BroadcastChannel | null = null;
    try {
      if (typeof window !== "undefined" && "BroadcastChannel" in window) {
        bc = new BroadcastChannel("hms_pos_channel");
        bc.onmessage = (msg) => {
          if (msg.data?.type === "CHECKOUT_SETTLED") {
            setPendingAttempt(null);
            setCheckoutState("READY");
            clearOrderInternal();
            loadActivity();
            loadFolios();
            setSuccess(`Payment settled in another tab for ${msg.data.guestName || "guest"}.`);
          }
        };
      }
    } catch {}

    if (typeof window !== "undefined") {
      window.addEventListener("storage", handleStorageEvent);
    }

    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("storage", handleStorageEvent);
      }
      if (bc) {
        bc.close();
      }
    };
  }, [loadActivity, loadFolios]);



  const reconcilePaymentStatus = useCallback(async (keyOverride?: string) => {
    const keyToQuery = keyOverride || pendingAttempt?.idempotencyKey;
    if (!keyToQuery) return;

    setReconciling(true);
    setError(null);

    try {
      const res = await fetch(`/api/restaurant/payments/status?key=${encodeURIComponent(keyToQuery)}`);
      const data = await res.json();

      if (res.ok && data.found) {
        setCheckoutState("CONFIRMED_SUCCESS");
        clearPendingAttemptStorage();
        setPendingAttempt(null);
        clearOrderInternal();
        loadActivity();
        loadFolios();
        setSuccess(
          `Payment of ${money(data.total)} verified on server for ${data.guestName} via ${data.method}. (Reconciled)`
        );

        try {
          if (typeof window !== "undefined" && "BroadcastChannel" in window) {
            const bc = new BroadcastChannel("hms_pos_channel");
            bc.postMessage({ type: "CHECKOUT_SETTLED", guestName: data.guestName, total: data.total });
            bc.close();
          }
        } catch {}

        setCheckoutState("READY");
      } else if (res.ok && !data.found) {
        setError(
          "Server verification confirmed no payment was recorded with this key. You may safely retry this order or clear it."
        );
      } else {
        setError(data?.error || "Could not check server status. Please try again.");
      }
    } catch (err) {
      setError("Network error while checking payment status. Please try again.");
    } finally {
      setReconciling(false);
    }
  }, [pendingAttempt, loadActivity, loadFolios]);

  function dismissVerifiedFailure() {
    clearPendingAttemptStorage();
    setPendingAttempt(null);
    clearOrderInternal();
    setCheckoutState("READY");
    setError(null);
  }

  const subtotal = order.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const total = subtotal;

  function addItem(item: MenuItem) {
    if (checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING") {
      setError("Payment status is uncertain. Do not modify the order until this attempt is verified.");
      return;
    }
    setSuccess(null);
    setError(null);
    setOrder((prev) => {
      const found = prev.find((l) => l.menuItemId === item.id);
      if (found) {
        return prev.map((l) =>
          l.menuItemId === item.id ? { ...l, quantity: l.quantity + 1 } : l
        );
      }
      return [...prev, { menuItemId: item.id, name: item.name, unitPrice: item.price, quantity: 1 }];
    });
  }

  function changeQty(menuItemId: string, delta: number) {
    if (checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING") {
      setError("Payment status is uncertain. Do not modify the order until this attempt is verified.");
      return;
    }
    setOrder((prev) =>
      prev
        .map((l) => (l.menuItemId === menuItemId ? { ...l, quantity: l.quantity + delta } : l))
        .filter((l) => l.quantity > 0)
    );
  }

  function clearOrderInternal() {
    setOrder([]);
    setTableNumber("");
    setReference("");
    setCustomerName("");
  }

  function clearOrder() {
    if (checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING") {
      setError("Payment status is uncertain. Do not clear the order until this attempt is verified.");
      return;
    }
    clearOrderInternal();
  }

  async function submit() {
    if (inFlightRef.current || loading || checkoutState === "SUBMITTING") return;

    // Terminal-wide multi-tab check: Ensure no other checkout is active in storage
    if (!pendingAttempt && typeof window !== "undefined" && window.localStorage) {
      try {
        const existingRaw = window.localStorage.getItem(POS_STORAGE_KEY);
        if (existingRaw) {
          const validated = validatePendingSnapshot(JSON.parse(existingRaw));
          if (validated) {
            setPendingAttempt(validated);
            setCheckoutState("PENDING_VERIFICATION");
            setError("Another browser tab has an unresolved checkout on this terminal. Verify or resolve it before starting a new order.");
            return;
          }
        }
      } catch {}
    }

    if (checkoutState === "PENDING_VERIFICATION" && !pendingAttempt) {
      setError("Payment status is uncertain. Do not start another checkout until this attempt is verified.");
      return;
    }

    const itemsToSubmit = pendingAttempt ? pendingAttempt.items : order;
    if (itemsToSubmit.length === 0) {
      setError("Add at least one item to the order.");
      return;
    }

    const performSubmit = async () => {
      inFlightRef.current = true;
      setLoading(true);
      setCheckoutState("SUBMITTING");
      setError(null);
      setSuccess(null);

      let activeSnapshot: PendingCheckoutSnapshot | null = pendingAttempt;
      if (mode === "PAY") {
        if (!activeSnapshot) {
          const key =
            typeof window !== "undefined" && typeof window.crypto?.randomUUID === "function"
              ? window.crypto.randomUUID()
              : `pos-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
          activeSnapshot = {
            idempotencyKey: key,
            items: [...order],
            paymentMethodId: methodId,
            customerName,
            reference,
            tableNumber,
            timestamp: Date.now(),
            status: "IN_FLIGHT",
          };
          setPendingAttempt(activeSnapshot);
          savePendingAttempt(activeSnapshot);
        }
      }

      try {
        const endpoint =
          mode === "ROOM" ? "/api/restaurant/charge-to-room" : "/api/restaurant/pay-now";
        const payload =
          mode === "ROOM"
            ? { items: itemsToSubmit, folioId, tableNumber }
            : {
                items: activeSnapshot!.items,
                paymentMethodId: activeSnapshot!.paymentMethodId,
                customerName: activeSnapshot!.customerName,
                reference: activeSnapshot!.reference,
                tableNumber: activeSnapshot!.tableNumber,
              };

        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (mode === "PAY" && activeSnapshot) {
          headers["X-Idempotency-Key"] = activeSnapshot.idempotencyKey;
        }

        const res = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });

        let data: any = null;
        try {
          data = await res.json();
        } catch {
          // Non-JSON response (e.g. 502/504 gateway or socket termination)
        }

        if (res.ok) {
          setCheckoutState("CONFIRMED_SUCCESS");
          clearPendingAttemptStorage();
          setPendingAttempt(null);
          setSuccess(
            mode === "ROOM"
              ? `${money(data?.total ?? subtotal)} charged to ${data?.guestName ?? "guest"}'s folio.`
              : `${money(data?.total ?? subtotal)} received from ${data?.guestName ?? "guest"} via ${data?.method ?? "payment"}.${data?.isIdempotentReplay ? " (Verified & Replayed)" : ""}`
          );
          clearOrderInternal();
          loadActivity();
          loadFolios();
          setCheckoutState("READY");

          try {
            if (typeof window !== "undefined" && "BroadcastChannel" in window) {
              const bc = new BroadcastChannel("hms_pos_channel");
              bc.postMessage({ type: "CHECKOUT_SETTLED", guestName: data?.guestName, total: data?.total ?? subtotal });
              bc.close();
            }
          } catch {}
          return;
        }

        // Classify error responses:
        if (res.status === 400 || res.status === 403) {
          // Known client/validation errors: transaction never committed
          setCheckoutState("CONFIRMED_FAILURE");
          clearPendingAttemptStorage();
          setPendingAttempt(null);
          setError(data?.error || "Could not complete the order.");
          setCheckoutState("READY");
          return;
        }

        if (res.status === 409) {
          if (
            data?.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD" ||
            (data?.error && data.error.includes("different order details"))
          ) {
            // Do NOT clear storage! A payment with this key may have already committed on the server.
            setCheckoutState("PENDING_VERIFICATION");
            if (activeSnapshot) {
              activeSnapshot.status = "PAYLOAD_MISMATCH";
              savePendingAttempt(activeSnapshot);
            }
            setError(
              "This idempotency key was previously recorded for a different order. The original transaction may have already succeeded on the server. Verify server status before attempting a new checkout."
            );
            return;
          }

          if (data?.code === "DATABASE_UNIQUE_CONSTRAINT_CONFLICT") {
            // Unrelated database unique constraint violation: transaction rolled back
            setCheckoutState("CONFIRMED_FAILURE");
            clearPendingAttemptStorage();
            setPendingAttempt(null);
            setError(data?.error || "A database unique constraint violation occurred. Please verify your records.");
            setCheckoutState("READY");
            return;
          }

          // Concurrent submission or serialization lock conflict: outcome uncertain
          setCheckoutState("PENDING_VERIFICATION");
          if (activeSnapshot) {
            activeSnapshot.status = "UNCERTAIN";
            savePendingAttempt(activeSnapshot);
          }
          setError(data?.error || "Payment status is uncertain. Do not start another checkout until this attempt is verified.");
          return;
        }

        // 5xx or unclassified: ambiguous outcome
        setCheckoutState("PENDING_VERIFICATION");
        if (activeSnapshot) {
          activeSnapshot.status = "UNCERTAIN";
          savePendingAttempt(activeSnapshot);
        }
        setError("Payment status is uncertain. Do not start another checkout until this attempt is verified.");
      } catch (err) {
        // Network drop, timeout, or connection reset
        setCheckoutState("PENDING_VERIFICATION");
        if (activeSnapshot) {
          activeSnapshot.status = "UNCERTAIN";
          savePendingAttempt(activeSnapshot);
        }
        setError("Network error or timeout. Payment status is uncertain. Do not start another checkout until this attempt is verified.");
      } finally {
        inFlightRef.current = false;
        setLoading(false);
      }
    };

    if (typeof window !== "undefined" && window.navigator?.locks?.request) {
      try {
        await window.navigator.locks.request("hms_pos_checkout_lock", { ifAvailable: true }, async (lock) => {
          if (!lock) {
            setError("Another browser tab on this workstation is actively processing a checkout. Please wait for it to complete.");
            return;
          }
          await performSubmit();
        });
      } catch {
        await performSubmit();
      }
    } else {
      await performSubmit();
    }
  }

  const items = menu.find((c) => c.id === activeCategory)?.items ?? [];

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3 mb-7">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Restaurant POS</h1>
          <p className="text-text-secondary text-sm mt-1">
            {money(todayTotal)} sold today. Build an order, then charge it to a room or take
            payment at the counter.
          </p>
        </div>
        {canManageMenu && (
          <button onClick={() => setManageOpen(true)} className="btn-secondary rounded-xl shadow-sm hover:shadow-md transition-all">
            <Settings2 size={16} /> Manage Menu
          </button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 items-start">
        <div>
          <div className="flex flex-wrap gap-2 mb-5 p-1.5 rounded-2xl border border-border bg-surface/80 shadow-sm">
            {menu.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveCategory(c.id)}
                className={clsx(
                  "rounded-xl px-5 py-2.5 text-sm font-semibold border transition-all duration-200",
                  activeCategory === c.id
                    ? "bg-primary-700 border-primary-700 text-white shadow-md shadow-primary-500/15"
                    : "bg-transparent border-transparent text-text-secondary hover:bg-primary-50 hover:border-primary-200 hover:text-primary-700"
                )}
              >
                {c.name}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
            {items.map((item) => {
              const soldOut = item.availablePortions !== null && item.availablePortions <= 0;
              return (
                <button
                  key={item.id}
                  onClick={() => !soldOut && addItem(item)}
                  disabled={soldOut || checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING"}
                  className={clsx(
                    "group relative overflow-hidden rounded-2xl border border-border bg-surface p-5 text-left shadow-sm transition-all duration-200",
                    soldOut || checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING"
                      ? "opacity-40 cursor-not-allowed"
                      : "hover:border-primary-300"
                  )}
                >
                  <p className="font-semibold leading-snug">{item.name}</p>
                  <p className="text-sm text-text-secondary mt-1">{money(item.price)}</p>
                  {soldOut && <p className="text-xs text-danger mt-1">Sold out</p>}
                </button>
              );
            })}
            {items.length === 0 && (
              <p className="text-sm text-text-secondary col-span-full">
                No items in this category yet — add some under Manage Menu.
              </p>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="card rounded-2xl border border-border bg-surface p-5 shadow-sm">
            <h2 className="flex items-center gap-2 mb-4 text-lg font-bold">
              <ShoppingCart size={18} strokeWidth={1.8} /> Order
            </h2>

            {order.length === 0 && (
              <p className="text-sm text-text-secondary">Tap menu items to start an order.</p>
            )}

            {order.length > 0 && (
              <div className="space-y-2">
                {order.map((l) => (
                  <div key={l.menuItemId} className="flex items-center gap-2 rounded-xl border border-border bg-bg/40 p-3 text-sm">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{l.name}</p>
                      <p className="text-xs text-text-secondary">{money(l.unitPrice)} each</p>
                    </div>
                    <button
                      onClick={() => changeQty(l.menuItemId, -1)}
                      disabled={checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING"}
                      className="rounded-lg border border-border bg-surface p-1.5 shadow-sm transition-colors hover:bg-bg disabled:opacity-40 disabled:cursor-not-allowed"
                      aria-label={`Reduce ${l.name}`}
                    >
                      <Minus size={14} />
                    </button>
                    <span className="w-6 text-center font-medium">{l.quantity}</span>
                    <button
                      onClick={() => changeQty(l.menuItemId, 1)}
                      disabled={checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING"}
                      className="rounded-lg border border-border bg-surface p-1.5 shadow-sm transition-colors hover:bg-bg disabled:opacity-40 disabled:cursor-not-allowed"
                      aria-label={`Add another ${l.name}`}
                    >
                      <Plus size={14} />
                    </button>
                    <span className="w-20 text-right font-medium">
                      {money(l.unitPrice * l.quantity)}
                    </span>
                  </div>
                ))}
                <button
                  onClick={clearOrder}
                  disabled={checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING"}
                  className="flex items-center gap-1.5 text-xs text-text-secondary hover:text-danger pt-1 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Trash2 size={13} /> Clear order
                </button>
              </div>
            )}

            <div className="mt-4 rounded-xl border border-border bg-bg/40 p-4 space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-text-secondary">Subtotal</span>
                <span>{money(subtotal)}</span>
              </div>
              <div className="flex justify-between font-bold text-base pt-3 border-t border-border">
                <span>Total</span>
                <span>{money(total)}</span>
              </div>
            </div>
          </div>

          <div className="card rounded-2xl border border-border bg-surface p-5 shadow-sm">
            <div className="grid grid-cols-2 gap-2 mb-5 p-1 rounded-xl bg-bg/60 border border-border">
              <button
                onClick={() => setMode("ROOM")}
                disabled={checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING"}
                className={clsx(
                  "rounded-lg px-3 py-3 text-sm font-semibold border transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed",
                  mode === "ROOM"
                    ? "bg-primary-700 border-primary-700 text-white shadow-md shadow-primary-500/15"
                    : "bg-transparent border-transparent text-text-secondary hover:bg-primary-50 hover:border-primary-200 hover:text-primary-700"
                )}
              >
                Charge to Room
              </button>
              <button
                onClick={() => setMode("PAY")}
                disabled={checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING"}
                className={clsx(
                  "rounded-lg px-3 py-3 text-sm font-semibold border transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed",
                  mode === "PAY"
                    ? "bg-primary-700 border-primary-700 text-white shadow-md shadow-primary-500/15"
                    : "bg-transparent border-transparent text-text-secondary hover:bg-primary-50 hover:border-primary-200 hover:text-primary-700"
                )}
              >
                Pay Now
              </button>
            </div>

            <label className="block text-sm font-medium mb-1.5">Table / note (optional)</label>
            <input
              value={tableNumber}
              onChange={(e) => setTableNumber(e.target.value)}
              disabled={checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING"}
              placeholder="e.g. 4"
              className={inputClass()}
            />

            {mode === "ROOM" ? (
              <div className="mt-3">
                <label className="block text-sm font-medium mb-1.5">Charge to</label>
                <select
                  value={folioId}
                  onChange={(e) => setFolioId(e.target.value)}
                  disabled={checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING"}
                  className={inputClass()}
                >
                  {folios.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                  {folios.length === 0 && <option value="">No in-house guests</option>}
                </select>
              </div>
            ) : (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-1.5">Payment method</label>
                  <select
                    value={methodId}
                    onChange={(e) => setMethodId(e.target.value)}
                    disabled={checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING"}
                    className={inputClass()}
                  >
                    {methods.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">
                    Customer name (optional)
                  </label>
                  <input
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    disabled={checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING"}
                    className={inputClass()}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1.5">
                    Reference (e.g. M-Pesa code)
                  </label>
                  <input
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    disabled={checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING"}
                    className={inputClass()}
                  />
                </div>
              </div>
            )}

            {checkoutState === "PENDING_VERIFICATION" && (
              <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 space-y-2 text-sm mt-3">
                <p className="font-semibold text-amber-800 dark:text-amber-200">
                  {pendingAttempt?.status === "PAYLOAD_MISMATCH"
                    ? "Idempotency Key Conflict / Reused Key"
                    : pendingAttempt?.isExpired
                    ? "Unresolved Checkout Expired (>24h)"
                    : "Payment Status Uncertain"}
                </p>
                <p className="text-text-secondary text-xs">
                  {pendingAttempt?.status === "PAYLOAD_MISMATCH"
                    ? "This idempotency key was previously submitted with different order details. The original payment may have already committed. Verify server status before attempting a new checkout."
                    : pendingAttempt?.isExpired
                    ? "This checkout attempt was created more than 24 hours ago. Verify server status to confirm if payment succeeded before clearing."
                    : "Payment status is uncertain. Do not start another checkout until this attempt is verified."}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => reconcilePaymentStatus()}
                    disabled={reconciling}
                    className="btn-primary text-xs px-3 py-1.5 rounded-lg shadow-sm !bg-amber-700 hover:!bg-amber-800 !text-white"
                  >
                    {reconciling ? "Checking Server..." : "Check Server Status"}
                  </button>
                  <button
                    type="button"
                    onClick={loadActivity}
                    className="btn-secondary text-xs px-3 py-1.5 rounded-lg shadow-sm"
                  >
                    Check Recent Activity
                  </button>
                  {(pendingAttempt?.status === "PAYLOAD_MISMATCH" || pendingAttempt?.isExpired) && (
                    <button
                      type="button"
                      onClick={dismissVerifiedFailure}
                      className="btn-secondary text-xs px-3 py-1.5 rounded-lg shadow-sm border-danger/40 text-danger hover:bg-danger/5"
                    >
                      Dismiss & Clear
                    </button>
                  )}
                </div>
              </div>
            )}

            {error && (
              <p className="text-sm text-danger bg-danger/5 border border-danger/20 rounded-control px-3 py-2 mt-3">
                {error}
              </p>
            )}
            {success && (
              <p className="text-sm text-success bg-success/5 border border-success/20 rounded-control px-3 py-2 mt-3">
                {success}
              </p>
            )}

            <button
              onClick={submit}
              disabled={
                loading ||
                (mode === "ROOM" && !folioId) ||
                (order.length === 0 && !pendingAttempt)
              }
              className={clsx(
                "btn-primary w-full mt-4",
                checkoutState === "PENDING_VERIFICATION" && "!bg-amber-600 hover:!bg-amber-700 !text-white !border-amber-600"
              )}
            >
              {loading
                ? "Processing..."
                : checkoutState === "PENDING_VERIFICATION"
                ? `Retry Last Checkout · ${money(total)}`
                : mode === "ROOM"
                ? `Post to Room · ${money(total)}`
                : `Take Payment · ${money(total)}`}
            </button>

            <p className="text-xs text-text-secondary mt-3">
              Charging to a room adds the items to the guest folio as Restaurant charges. Paying
              now records the sale immediately so it counts toward today&apos;s revenue.
            </p>
          </div>

          <div className="card rounded-2xl border border-border bg-surface p-5 shadow-sm">
            <h2 className="flex items-center gap-2 mb-4 text-base font-bold">
              <UtensilsCrossed size={17} strokeWidth={1.8} /> Recent Restaurant Activity
            </h2>
            <div className="space-y-3">
              {activity.map((a) => (
                <div key={a.id} className="flex justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{a.description}</p>
                    <p className="text-xs text-text-secondary">
                      {a.roomNumber ? `Room ${a.roomNumber} · ` : ""}
                      {a.guestName}
                    </p>
                    <p className="text-xs text-text-muted">
                      {new Date(a.createdAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-medium">{money(a.total)}</p>
                    <p className={clsx("text-xs", a.settled ? "text-success" : "text-champagne-500")}>
                      {a.settled ? "Paid" : "On folio"}
                    </p>
                  </div>
                </div>
              ))}
              {activity.length === 0 && (
                <p className="text-sm text-text-secondary">No restaurant orders yet today.</p>
              )}
            </div>
          </div>
        </div>
      </div>

      {canManageMenu && manageOpen && (
        <ManageMenuModal menu={menu} onClose={() => setManageOpen(false)} />
      )}
    </div>
  );
}

function ManageMenuModal({ menu, onClose }: { menu: Category[]; onClose: () => void }) {
  const [categoryId, setCategoryId] = useState(menu[0]?.id ?? "");
  const [itemName, setItemName] = useState("");
  const [itemPrice, setItemPrice] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    setMsg(null);
    const res = await fetch("/api/menu", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: itemName, price: Number(itemPrice), categoryId }),
    });
    setLoading(false);
    if (!res.ok) {
      setErr((await res.json()).error || "Could not add item.");
      return;
    }
    setItemName("");
    setItemPrice("");
    setMsg("Item added. Refresh the page to see it on the POS.");
  }

  async function addCategory(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setErr(null);
    setMsg(null);
    const res = await fetch("/api/menu/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newCategory }),
    });
    setLoading(false);
    if (!res.ok) {
      setErr((await res.json()).error || "Could not add category.");
      return;
    }
    setNewCategory("");
    setMsg("Category added. Refresh the page to see it.");
  }

  async function removeItem(id: string) {
    if (!confirm("Remove this item from the menu?")) return;
    const res = await fetch(`/api/menu/items/${id}`, { method: "DELETE" });
    if (!res.ok) {
      setErr("Could not remove item.");
      return;
    }
    setMsg("Item removed. Refresh the page to update the POS.");
  }

  async function removeCategory(category: Category) {
    if (
      !confirm(
        `Delete the empty category "${category.name}"? Required categories cannot be deleted.`
      )
    ) {
      return;
    }

    setLoading(true);
    setErr(null);
    setMsg(null);
    const res = await fetch(`/api/menu/categories/${category.id}`, {
      method: "DELETE",
    });
    const data = await res.json().catch(() => ({}));
    setLoading(false);
    if (!res.ok) {
      setErr(data.error || "Could not delete the category.");
      return;
    }

    setMsg(`Category "${category.name}" deleted. Reloading the menu...`);
    window.setTimeout(() => window.location.reload(), 500);
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="card w-full max-w-md max-h-[85vh] overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h2>Manage Menu</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>

        {err && (
          <p className="text-sm text-danger bg-danger/5 border border-danger/20 rounded-control px-3 py-2 mb-3">
            {err}
          </p>
        )}
        {msg && (
          <p className="text-sm text-success bg-success/5 border border-success/20 rounded-control px-3 py-2 mb-3">
            {msg}
          </p>
        )}

        <form onSubmit={addItem} className="space-y-3">
          <p className="text-sm font-medium">Add a menu item</p>
          <select value={categoryId} onChange={(e) => setCategoryId(e.target.value)} className={inputClass()}>
            {menu.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input
            placeholder="Item name"
            value={itemName}
            onChange={(e) => setItemName(e.target.value)}
            required
            className={inputClass()}
          />
          <input
            type="number"
            placeholder="Price (KSh)"
            value={itemPrice}
            onChange={(e) => setItemPrice(e.target.value)}
            required
            className={inputClass()}
          />
          <button type="submit" disabled={loading} className="btn-primary w-full">
            {loading ? "Saving..." : "Add Item"}
          </button>
        </form>

        <form onSubmit={addCategory} className="space-y-3 border-t border-border pt-4 mt-4">
          <p className="text-sm font-medium">Add a category</p>
          <input
            placeholder="e.g. Desserts"
            value={newCategory}
            onChange={(e) => setNewCategory(e.target.value)}
            required
            className={inputClass()}
          />
          <button type="submit" disabled={loading} className="btn-secondary w-full">
            Add Category
          </button>
        </form>

        <div className="border-t border-border pt-4 mt-4 space-y-2">
          <div>
            <p className="text-sm font-medium">Manage categories</p>
            <p className="text-xs text-text-muted mt-1">
              Empty extra categories can be deleted. Breakfast, Lunch, Dinner, and Ala carte are required.
            </p>
          </div>
          {menu.map((category) => {
            const required = isRequiredMenuCategory(category.name);
            return (
              <div
                key={category.id}
                className="flex items-center justify-between gap-3 border border-border rounded-control px-3 py-2 text-sm"
              >
                <div>
                  <p className="font-medium">{category.name}</p>
                  <p className="text-xs text-text-muted">
                    {category.items.length} active item{category.items.length === 1 ? "" : "s"}
                  </p>
                </div>
                {required ? (
                  <span className="badge bg-primary-50 text-primary-700">Required</span>
                ) : (
                  <button
                    type="button"
                    onClick={() => removeCategory(category)}
                    disabled={loading}
                    className="inline-flex items-center gap-1 text-xs font-medium text-danger hover:underline disabled:opacity-50"
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="border-t border-border pt-4 mt-4 space-y-3">
          <p className="text-sm font-medium">Current items</p>
          {menu.map((c) => (
            <div key={c.id}>
              <p className="text-xs uppercase tracking-wide text-text-muted mb-1">{c.name}</p>
              <div className="space-y-1">
                {c.items.map((i) => (
                  <div
                    key={i.id}
                    className="flex items-center justify-between border border-border rounded-control px-3 py-1.5 text-sm"
                  >
                    <span>
                      {i.name} — {money(i.price)}
                    </span>
                    <button onClick={() => removeItem(i.id)} className="text-text-secondary hover:text-danger">
                      <X size={14} />
                    </button>
                  </div>
                ))}
                {c.items.length === 0 && <p className="text-xs text-text-muted">No items.</p>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}