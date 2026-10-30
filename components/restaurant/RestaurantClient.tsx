"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Minus, Plus, Trash2, ShoppingCart, UtensilsCrossed, Settings2, X } from "lucide-react";
import type { HotelRole } from "@prisma/client";
import clsx from "clsx";
import { hasRole, ROLE_GROUPS } from "@/lib/permissions";
import { isRequiredMenuCategory } from "@/lib/menu-categories";
import {
  CheckoutLockBusyError,
  CheckoutOwnershipError,
  CheckoutTenantMismatchError,
  LegacyCheckoutAttemptError,
  LockedAttemptStorage,
  POS_LEGACY_STORAGE_KEY,
  decideStorageEvent,
  tenantPOSStorageKey,
  withPOSCheckoutOwnership,
  type LockManagerLike,
} from "@/lib/pos-checkout-ownership";

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
  hotelId: string;
  operation: "PAY_NOW" | "CHARGE_TO_ROOM";
  idempotencyKey: string;
  items: OrderLine[];
  paymentMethodId?: string;
  customerName?: string;
  reference?: string;
  folioId?: string;
  tableNumber: string;
  timestamp: number;
  isExpired?: boolean;
  status?: "IN_FLIGHT" | "UNCERTAIN" | "PAYLOAD_MISMATCH" | "EXPIRED";
}

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
function responseRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function responseText(value: unknown, field: string): string | undefined {
  const record = responseRecord(value);
  const text = record?.[field];
  return typeof text === "string" ? text : undefined;
}

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
  if (typeof obj.hotelId !== "string" || !obj.hotelId || obj.hotelId.trim() !== obj.hotelId) return null;
  const operation = obj.operation;
  if (operation !== "PAY_NOW" && operation !== "CHARGE_TO_ROOM") return null;
  if (operation === "PAY_NOW" && (typeof obj.paymentMethodId !== "string" || !obj.paymentMethodId.trim())) {
    return null;
  }
  if (operation === "CHARGE_TO_ROOM" && (typeof obj.folioId !== "string" || !obj.folioId.trim())) {
    return null;
  }

  // Calculate whether snapshot is older than 24h TTL or futuristic
  const isExpired =
    typeof obj.timestamp === "number" &&
    (Date.now() - obj.timestamp > POS_SNAPSHOT_TTL_MS || obj.timestamp <= 0);
  const status: PendingCheckoutSnapshot["status"] =
    obj.status === "IN_FLIGHT" || obj.status === "UNCERTAIN" || obj.status === "PAYLOAD_MISMATCH" || obj.status === "EXPIRED"
      ? obj.status
      : isExpired
        ? "EXPIRED"
        : "UNCERTAIN";

  return {
    hotelId: obj.hotelId,
    operation,
    idempotencyKey: obj.idempotencyKey,
    items: obj.items as OrderLine[],
    ...(typeof obj.paymentMethodId === "string" ? { paymentMethodId: obj.paymentMethodId } : {}),
    customerName: typeof obj.customerName === "string" ? obj.customerName : "",
    reference: typeof obj.reference === "string" ? obj.reference : "",
    ...(typeof obj.folioId === "string" ? { folioId: obj.folioId } : {}),
    tableNumber: typeof obj.tableNumber === "string" ? obj.tableNumber : "",
    timestamp: typeof obj.timestamp === "number" ? obj.timestamp : Date.now(),
    isExpired,
    status,
  };
}

export function buildChargeToRoomRequest(attempt: PendingCheckoutSnapshot): {
  idempotencyKey: string;
  payload: { items: OrderLine[]; folioId: string; tableNumber: string };
} {
  if (attempt.operation !== "CHARGE_TO_ROOM" || !attempt.folioId) {
    throw new Error("A room-charge attempt requires its saved operation and folio destination.");
  }
  return {
    idempotencyKey: attempt.idempotencyKey,
    payload: {
      items: attempt.items,
      folioId: attempt.folioId,
      tableNumber: attempt.tableNumber,
    },
  };
}

export function samePendingRequest(left: PendingCheckoutSnapshot, right: PendingCheckoutSnapshot): boolean {
  if (left.hotelId !== right.hotelId || left.operation !== right.operation || left.idempotencyKey !== right.idempotencyKey) return false;
  if (left.operation === "CHARGE_TO_ROOM" && right.operation === "CHARGE_TO_ROOM") {
    try {
      return JSON.stringify(buildChargeToRoomRequest(left).payload) ===
        JSON.stringify(buildChargeToRoomRequest(right).payload);
    } catch {
      return false;
    }
  }
  const leftPayload = {
    items: left.items,
    paymentMethodId: left.paymentMethodId,
    customerName: left.customerName,
    reference: left.reference,
    tableNumber: left.tableNumber,
  };
  const rightPayload = {
    items: right.items,
    paymentMethodId: right.paymentMethodId,
    customerName: right.customerName,
    reference: right.reference,
    tableNumber: right.tableNumber,
  };
  return JSON.stringify(leftPayload) === JSON.stringify(rightPayload);
}

export function isChargeToRoomResponse(value: unknown, attempt: PendingCheckoutSnapshot): value is {
  ok: true;
  operation: "CHARGE_TO_ROOM";
  idempotencyKey: string;
  requestFingerprint: string;
  orderId: string;
  folioId: string;
  guestName: string;
  total: number;
} {
  return Boolean(
    value && typeof value === "object" &&
    (value as Record<string, unknown>).ok === true &&
    (value as Record<string, unknown>).operation === "CHARGE_TO_ROOM" &&
    (value as Record<string, unknown>).idempotencyKey === attempt.idempotencyKey &&
    (value as Record<string, unknown>).folioId === attempt.folioId &&
    typeof (value as Record<string, unknown>).requestFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test((value as Record<string, unknown>).requestFingerprint as string) &&
    typeof (value as Record<string, unknown>).orderId === "string" &&
    Boolean(((value as Record<string, unknown>).orderId as string).trim()) &&
    typeof (value as Record<string, unknown>).guestName === "string" &&
    Boolean(((value as Record<string, unknown>).guestName as string).trim()) &&
    Number.isFinite((value as Record<string, unknown>).total) &&
    ((value as Record<string, unknown>).total as number) >= 0
  );
}

export function isExplicitNotCommittedResponse(value: unknown, status: number): boolean {
  if (status !== 400 && status !== 409) return false;
  return Boolean(value && typeof value === "object" &&
    (value as Record<string, unknown>).outcome === "NOT_COMMITTED");
}

export async function computePayNowAttemptFingerprint(attempt: PendingCheckoutSnapshot): Promise<string> {
  if (attempt.operation !== "PAY_NOW" || !attempt.paymentMethodId?.trim()) {
    throw new Error("A Pay-now attempt with its original payment method is required for verification.");
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error("Secure browser fingerprinting is unavailable; the saved payment was not reconciled.");
  }

  const quantities = new Map<string, number>();
  for (const item of attempt.items) {
    const menuItemId = item.menuItemId.trim();
    if (!menuItemId || !Number.isInteger(item.quantity) || item.quantity < 1) {
      throw new Error("The saved Pay-now request cannot be fingerprinted safely.");
    }
    const quantity = (quantities.get(menuItemId) ?? 0) + item.quantity;
    if (quantity > 1000) throw new Error("The saved Pay-now quantity is outside the allowed range.");
    quantities.set(menuItemId, quantity);
  }

  // Keep property order and canonical fields aligned with computePosFingerprint
  // on the server. The POS request does not send customerPhone today.
  const canonical = {
    hotelId: attempt.hotelId.trim(),
    items: [...quantities.entries()]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([menuItemId, quantity]) => ({ menuItemId, quantity })),
    paymentMethodId: attempt.paymentMethodId.trim(),
    customerName: (attempt.customerName ?? "").trim(),
    customerPhone: "",
    tableNumber: (attempt.tableNumber ?? "").trim(),
    reference: (attempt.reference ?? "").trim(),
  };
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function isPayNowResponse(
  value: unknown,
  attempt: PendingCheckoutSnapshot,
  expectedFingerprint: string,
): value is {
  ok: true;
  operation: "PAY_NOW";
  idempotencyKey: string;
  requestFingerprint: string;
  hotelId: string;
  paymentId: string;
  folioId: string;
  guestName: string;
  total: number;
  method: string;
  isIdempotentReplay?: boolean;
} {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return Boolean(
    attempt.operation === "PAY_NOW" &&
    /^[a-f0-9]{64}$/.test(expectedFingerprint) &&
    data.ok === true &&
    data.hotelId === attempt.hotelId &&
    data.operation === "PAY_NOW" &&
    data.idempotencyKey === attempt.idempotencyKey &&
    data.requestFingerprint === expectedFingerprint &&
    typeof data.requestFingerprint === "string" && /^[a-f0-9]{64}$/.test(data.requestFingerprint) &&
    (data.isIdempotentReplay === undefined || typeof data.isIdempotentReplay === "boolean") &&
    typeof data.paymentId === "string" && Boolean(data.paymentId.trim()) &&
    typeof data.folioId === "string" && Boolean(data.folioId.trim()) &&
    typeof data.guestName === "string" && Boolean(data.guestName.trim()) &&
    typeof data.total === "number" && Number.isFinite(data.total) && data.total >= 0 &&
    typeof data.method === "string" && Boolean(data.method.trim())
  );
}

export function isConfirmedPayNowStatusResponse(
  value: unknown,
  attempt: PendingCheckoutSnapshot,
  expectedFingerprint: string,
): value is {
  found: true;
  hotelId: string;
  operation: "PAY_NOW";
  idempotencyKey: string;
  requestFingerprint: string;
  matchesFingerprint: true;
  status: "COMPLETED";
  paymentId: string;
  folioId: string;
  guestName: string;
  method: string;
  total: number;
} {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return Boolean(
    attempt.operation === "PAY_NOW" &&
    /^[a-f0-9]{64}$/.test(expectedFingerprint) &&
    data.found === true &&
    data.hotelId === attempt.hotelId &&
    data.operation === "PAY_NOW" &&
    data.idempotencyKey === attempt.idempotencyKey &&
    data.requestFingerprint === expectedFingerprint &&
    data.matchesFingerprint === true &&
    data.status === "COMPLETED" &&
    typeof data.paymentId === "string" && Boolean(data.paymentId.trim()) &&
    typeof data.folioId === "string" && Boolean(data.folioId.trim()) &&
    typeof data.guestName === "string" && Boolean(data.guestName.trim()) &&
    typeof data.method === "string" && Boolean(data.method.trim()) &&
    typeof data.total === "number" && Number.isFinite(data.total) && data.total >= 0
  );
}

function mirrorPendingAttemptToSession(snapshot: PendingCheckoutSnapshot, storageKey: string) {
  try {
    window.sessionStorage?.setItem(storageKey, JSON.stringify(snapshot));
  } catch {
    // localStorage is the required shared claim; sessionStorage is only a tab-local mirror.
  }
}

function clearSessionMirrorIfOwned(attempt: PendingCheckoutSnapshot, storageKey: string) {
  try {
    const raw = window.sessionStorage?.getItem(storageKey);
    if (!raw) return;
    const current = validatePendingSnapshot(JSON.parse(raw));
    if (current && samePendingRequest(current, attempt)) {
      window.sessionStorage.removeItem(storageKey);
    }
  } catch {
    // A stale tab-local mirror is safe: the shared localStorage claim is authoritative.
  }
}

function clearPendingAttemptStorageIfOwned(
  attempts: LockedAttemptStorage,
  attempt: PendingCheckoutSnapshot,
  storageKey: string,
): boolean {
  const cleared = attempts.clearIfOwned(attempt, validatePendingSnapshot, samePendingRequest);
  if (cleared) clearSessionMirrorIfOwned(attempt, storageKey);
  return cleared;
}

const money = (n: number) => `KSh ${n.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

function inputClass() {
  return "w-full rounded-xl border border-border bg-surface px-4 py-3 text-sm shadow-sm transition-all placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary-500/20 focus:border-primary-400";
}

export default function RestaurantClient({
  menu,
  activeTenantId,
  currentUserRole,
  initialFolios,
  initialMethods,
  initialActivity,
  initialTodayTotal,
}: {
  menu: Category[];
  /** Server-rendered from the authenticated active tenant context; never read from storage. */
  activeTenantId: string;
  currentUserRole: HotelRole;
  initialFolios: OpenFolio[];
  initialMethods: PaymentMethod[];
  initialActivity: ActivityItem[];
  initialTodayTotal: number;
}) {
  const pendingStorageKey = tenantPOSStorageKey(activeTenantId);
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
  const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);

  const inFlightRef = useRef(false);
  const pendingAttemptRef = useRef<PendingCheckoutSnapshot | null>(null);
  const waitingForCrossTabAttemptRef = useRef(false);

  useEffect(() => {
    pendingAttemptRef.current = pendingAttempt;
  }, [pendingAttempt]);

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

  function adoptPendingSnapshot(snapshot: PendingCheckoutSnapshot) {
    pendingAttemptRef.current = snapshot;
    setPendingAttempt(snapshot);
    setCheckoutState("PENDING_VERIFICATION");
    setMode(snapshot.operation === "CHARGE_TO_ROOM" ? "ROOM" : "PAY");
    setOrder(snapshot.items);
    if (snapshot.folioId) setFolioId(snapshot.folioId);
    if (snapshot.paymentMethodId) setMethodId(snapshot.paymentMethodId);
    setCustomerName(snapshot.customerName ?? "");
    setReference(snapshot.reference ?? "");
    setTableNumber(snapshot.tableNumber);
  }

  const withCurrentPOSOwnership = useCallback(<T,>(work: (attempts: LockedAttemptStorage) => Promise<T>): Promise<T> => {
    if (typeof window === "undefined") {
      return Promise.reject(new CheckoutOwnershipError("POS recovery is available only in a browser."));
    }
    try {
      const locks = window.navigator?.locks as unknown as LockManagerLike | undefined;
      const storage = window.localStorage;
      return withPOSCheckoutOwnership(locks, storage, pendingStorageKey, work, activeTenantId);
    } catch {
      return Promise.reject(new CheckoutOwnershipError("Safe POS recovery is unavailable in this browser; no request was sent."));
    }
  }, [activeTenantId, pendingStorageKey]);

  const validateCurrentTenantSnapshot = useCallback((raw: unknown): PendingCheckoutSnapshot | null => {
    const attempt = validatePendingSnapshot(raw);
    if (attempt && attempt.hotelId !== activeTenantId) throw new CheckoutTenantMismatchError();
    return attempt;
  }, [activeTenantId]);

  function assertNoLegacyAttempt(attempts: LockedAttemptStorage) {
    if (attempts.readRaw(POS_LEGACY_STORAGE_KEY) !== null) throw new LegacyCheckoutAttemptError();
    try {
      if (window.sessionStorage.getItem(POS_LEGACY_STORAGE_KEY) !== null) throw new LegacyCheckoutAttemptError();
    } catch (error) {
      if (error instanceof LegacyCheckoutAttemptError) throw error;
      throw new CheckoutOwnershipError("Could not safely inspect legacy checkout recovery data.");
    }
  }

  const assertCurrentAuthenticatedTenant = useCallback(async () => {
    const response = await fetch("/api/restaurant/open-folios", { cache: "no-store" });
    const serverTenantId = response.headers.get("X-Active-Hotel-Id");
    if (!response.ok || !serverTenantId) {
      throw new CheckoutOwnershipError("Could not verify the active hotel with the server; no checkout was sent.");
    }
    if (serverTenantId !== activeTenantId) throw new CheckoutTenantMismatchError();
  }, [activeTenantId]);

  // Restore any pending checkout attempt on initial mount, page reload, or tab reopening
  useEffect(() => {
    try {
      const legacyLocal = window.localStorage.getItem(POS_LEGACY_STORAGE_KEY);
      const legacySession = window.sessionStorage.getItem(POS_LEGACY_STORAGE_KEY);
      if (legacyLocal !== null || legacySession !== null) {
        const message = "An older checkout record has no tenant identity. It was preserved unchanged; verify the original transaction with an administrator before submitting another charge.";
        setRecoveryNotice(message);
        setCheckoutState("PENDING_VERIFICATION");
        setError(message);
      } else {
        const stored = window.localStorage.getItem(pendingStorageKey) ??
          window.sessionStorage.getItem(pendingStorageKey);
        if (stored !== null) {
          try {
            const validated = validatePendingSnapshot(JSON.parse(stored));
            if (!validated) throw new CheckoutOwnershipError("Stored checkout recovery data is malformed.");
            if (validated.hotelId !== activeTenantId) throw new CheckoutTenantMismatchError();
            adoptPendingSnapshot(validated);
            if (validated.isExpired) {
              setError("This checkout attempt was created over 24 hours ago and is still unresolved. Reconcile with server before clearing.");
            } else if (validated.status === "PAYLOAD_MISMATCH") {
              setError("This checkout had an idempotency key conflict with previous order details. Reconcile with server before clearing.");
            } else {
              setError("Payment status is uncertain. Do not start another checkout until this attempt is verified.");
            }
          } catch (error) {
            const message = error instanceof CheckoutTenantMismatchError
              ? error.message
              : "Stored checkout recovery data could not be validated. It remains preserved; do not submit a new charge.";
            setRecoveryNotice(message);
            setCheckoutState("PENDING_VERIFICATION");
            setError(message);
          }
        }
      }
    } catch (e) {
      console.error("Failed to restore pending POS checkout:", e);
      const message = "A previous checkout attempt could not be read safely. It was not modified; verify recovery before proceeding.";
      setRecoveryNotice(message);
      setCheckoutState("PENDING_VERIFICATION");
      setError(message);
    }

    // Cross-tab synchronization via storage events
    const handleStorageEvent = (e: StorageEvent) => {
      if ((e.key !== pendingStorageKey && e.key !== POS_LEGACY_STORAGE_KEY) || e.storageArea !== window.localStorage) return;
      try {
        if (e.key === POS_LEGACY_STORAGE_KEY) {
          if (window.localStorage.getItem(POS_LEGACY_STORAGE_KEY) !== null) {
            const message = "An older checkout record has no tenant identity. It was preserved unchanged; verify the original transaction before submitting another charge.";
            setRecoveryNotice(message);
            setCheckoutState("PENDING_VERIFICATION");
            setError(message);
          }
          return;
        }
        // Ignore e.newValue: storage events may arrive late. Re-read the current
        // tenant-scoped value, and never replace a locally unresolved attempt.
        const raw = window.localStorage.getItem(pendingStorageKey);
        if (raw === null) {
          if (!pendingAttemptRef.current && waitingForCrossTabAttemptRef.current) {
            waitingForCrossTabAttemptRef.current = false;
            setCheckoutState("READY");
            setError("The other tab released the checkout lock. Retry when ready; no request was sent from this tab.");
          }
          return;
        }
        const latest = validatePendingSnapshot(JSON.parse(raw));
        if (!latest || latest.hotelId !== activeTenantId) {
          if (!pendingAttemptRef.current) {
            const message = latest
              ? "A recovery record belongs to another hotel. It was preserved; switch back to its original hotel to continue recovery."
              : "Shared checkout recovery data is malformed. It was preserved; do not submit a new charge.";
            setRecoveryNotice(message);
            setCheckoutState("PENDING_VERIFICATION");
            setError(message);
          }
          return;
        }
        const current = pendingAttemptRef.current;
        const decision = decideStorageEvent(current, latest, samePendingRequest);
        if (decision === "CONFLICT") {
          setCheckoutState("PENDING_VERIFICATION");
          setError("Another tab has a different unresolved checkout. This tab will not replace or submit over it.");
          return;
        }
        if (decision !== "ADOPT") return;
        waitingForCrossTabAttemptRef.current = false;
        setRecoveryNotice(null);
        adoptPendingSnapshot(latest);
        setError("Another tab owns an unresolved checkout. Retry that exact saved attempt to verify it.");
      } catch {
        setCheckoutState("PENDING_VERIFICATION");
        setError("Could not safely read shared checkout recovery storage.");
      }
    };

    let bc: BroadcastChannel | null = null;
    try {
      if (typeof window !== "undefined" && "BroadcastChannel" in window) {
        bc = new BroadcastChannel("hms_pos_channel");
        bc.onmessage = (msg) => {
          if (msg.data?.type !== "CHECKOUT_SETTLED" || msg.data.hotelId !== activeTenantId) return;
          const current = pendingAttemptRef.current;
          const messageOperation = msg.data.operation ?? "PAY_NOW";
          if (
            !current ||
            current.idempotencyKey !== msg.data.idempotencyKey ||
            current.operation !== messageOperation
          ) return;
          // A broadcast is advisory, not permission to clear shared storage or
          // local state. Retry under the lock for a fresh server confirmation.
          setCheckoutState("PENDING_VERIFICATION");
          setError("This attempt may have been resolved in another tab. Retry the exact saved request to confirm it safely.");
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
  }, [activeTenantId, pendingStorageKey, loadActivity, loadFolios]);



  const reconcilePaymentStatus = useCallback(async () => {
    const attempt = pendingAttemptRef.current ?? pendingAttempt;
    if (!attempt || attempt.operation !== "PAY_NOW") {
      setError("Only a saved Pay-now attempt can be reconciled through payment status.");
      return;
    }

    setReconciling(true);
    setError(null);
    try {
      const result = await withCurrentPOSOwnership(async (attempts) => {
        await assertCurrentAuthenticatedTenant();
        assertNoLegacyAttempt(attempts);
        const stored = attempts.read(validateCurrentTenantSnapshot);
        if (!stored || !samePendingRequest(stored, attempt)) {
          throw new CheckoutOwnershipError("The exact saved payment attempt is no longer stored; it was not reconciled or cleared.");
        }
        const fingerprint = await computePayNowAttemptFingerprint(stored);
        const query = new URLSearchParams({
          key: stored.idempotencyKey,
          operation: "PAY_NOW",
          fingerprint,
        });
        const res = await fetch(`/api/restaurant/payments/status?${query.toString()}`, {
          headers: { "X-Expected-Hotel-Id": activeTenantId },
          cache: "no-store",
        });
        let data: unknown = null;
        try {
          data = await res.json();
        } catch {
          // A malformed response is ambiguous; retain the original attempt.
        }
        const response = responseRecord(data);

        if (res.ok && isConfirmedPayNowStatusResponse(data, stored, fingerprint)) {
          if (!clearPendingAttemptStorageIfOwned(attempts, stored, pendingStorageKey)) {
            return { kind: "ownership-mismatch" as const, data };
          }
          return { kind: "found" as const, data };
        }
        if (response?.code === "TENANT_CONTEXT_MISMATCH") {
          return { kind: "tenant-mismatch" as const, data };
        }
        if (res.ok && response?.found === false && response?.status === "NOT_FOUND") {
          return { kind: "not-found" as const, data };
        }
        if (res.ok && response?.found === true) {
          return { kind: "unconfirmed" as const, data };
        }
        return { kind: "error" as const, data };
      });

      if (result.kind === "found") {
        setCheckoutState("CONFIRMED_SUCCESS");
        pendingAttemptRef.current = null;
        setRecoveryNotice(null);
        setPendingAttempt(null);
        clearOrderInternal();
        loadActivity();
        loadFolios();
        setSuccess(`Payment of ${money(result.data.total)} verified on server for ${result.data.guestName} via ${result.data.method}. (Reconciled)`);
        setCheckoutState("READY");
        try {
          if (typeof window !== "undefined" && "BroadcastChannel" in window) {
            const bc = new BroadcastChannel("hms_pos_channel");
            bc.postMessage({ type: "CHECKOUT_SETTLED", hotelId: activeTenantId, operation: "PAY_NOW", idempotencyKey: attempt.idempotencyKey, guestName: result.data.guestName, total: result.data.total });
            bc.close();
          }
        } catch {}
      } else if (result.kind === "not-found") {
        setError("Server verification found no payment with this key. The pending attempt remains locked; retry or resolve it with an administrator.");
      } else if (result.kind === "ownership-mismatch") {
        setError("A different recovery record is now stored. It was preserved; do not start another checkout.");
      } else if (result.kind === "tenant-mismatch") {
        const errorMessage = responseText(result.data, "error");
        setRecoveryNotice(errorMessage || "The active hotel changed. This attempt was preserved; refresh in its original hotel.");
        setCheckoutState("PENDING_VERIFICATION");
        setError(errorMessage || "The attempt could not be reconciled under the active hotel.");
      } else if (result.kind === "unconfirmed") {
        setCheckoutState("PENDING_VERIFICATION");
        setError("The server response did not confirm this exact Pay-now attempt as completed. The original recovery record remains unchanged.");
      } else {
        setCheckoutState("PENDING_VERIFICATION");
        setError(responseText(result.data, "error") || "Could not verify this payment. The original recovery record remains unchanged.");
      }
    } catch (error) {
      if (error instanceof CheckoutTenantMismatchError || error instanceof LegacyCheckoutAttemptError || error instanceof CheckoutOwnershipError) {
        setRecoveryNotice(error.message);
      }
      setCheckoutState("PENDING_VERIFICATION");
      setError(error instanceof Error ? error.message : "Safe server reconciliation is unavailable.");
    } finally {
      setReconciling(false);
    }
  }, [
    activeTenantId,
    pendingAttempt,
    pendingStorageKey,
    assertCurrentAuthenticatedTenant,
    validateCurrentTenantSnapshot,
    withCurrentPOSOwnership,
    loadActivity,
    loadFolios,
  ]);

  async function dismissVerifiedFailure() {
    const attempt = pendingAttemptRef.current ?? pendingAttempt;
    if (!attempt || attempt.operation === "CHARGE_TO_ROOM") return;
    try {
      const cleared = await withCurrentPOSOwnership(async (attempts) => {
        await assertCurrentAuthenticatedTenant();
        assertNoLegacyAttempt(attempts);
        const stored = attempts.read(validateCurrentTenantSnapshot);
        if (attempt.hotelId !== activeTenantId || !stored || !samePendingRequest(stored, attempt)) return false;
        return clearPendingAttemptStorageIfOwned(attempts, attempt, pendingStorageKey);
      });
      if (!cleared) {
        setError("This tab no longer owns the stored attempt. It was not cleared.");
        return;
      }
      pendingAttemptRef.current = null;
        setRecoveryNotice(null);
      setPendingAttempt(null);
      clearOrderInternal();
      setCheckoutState("READY");
      setError(null);
    } catch (error) {
      if (error instanceof CheckoutTenantMismatchError || error instanceof LegacyCheckoutAttemptError) {
        setRecoveryNotice(error.message);
        setCheckoutState("PENDING_VERIFICATION");
      }
      setError(error instanceof Error ? error.message : "Could not safely clear the attempt.");
    }
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
    inFlightRef.current = true;

    try {
      await withCurrentPOSOwnership(async (attempts) => {
        await assertCurrentAuthenticatedTenant();
        assertNoLegacyAttempt(attempts);
        let activeSnapshot = pendingAttemptRef.current ?? pendingAttempt;
        if (activeSnapshot && activeSnapshot.hotelId !== activeTenantId) throw new CheckoutTenantMismatchError();
        const storedSnapshot = attempts.read(validateCurrentTenantSnapshot);

        if (storedSnapshot) {
          if (activeSnapshot && !samePendingRequest(activeSnapshot, storedSnapshot)) {
            setCheckoutState("PENDING_VERIFICATION");
            setError("Another tab owns a different unresolved checkout. This tab will not replace it or submit a competing request.");
            return;
          }
          if (!activeSnapshot) {
            // The shared store, not a delayed event, is authoritative. Present
            // the existing attempt and require an explicit retry gesture.
            adoptPendingSnapshot(storedSnapshot);
            setError("Another tab has an unresolved checkout. Retry that exact saved request to verify it.");
            return;
          }
          activeSnapshot = storedSnapshot;
        } else if (!activeSnapshot) {
          if (checkoutState === "PENDING_VERIFICATION") {
            setError("Recovery ownership cannot be verified. No new checkout was sent; restore the exact saved attempt first.");
            return;
          }
          if (order.length === 0) {
            setError("Add at least one item to the order.");
            return;
          }

          const key =
            typeof window !== "undefined" && typeof window.crypto?.randomUUID === "function"
              ? window.crypto.randomUUID()
              : `pos-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
          const operation = mode === "ROOM" ? "CHARGE_TO_ROOM" : "PAY_NOW";
          if (operation === "CHARGE_TO_ROOM" && !folioId) {
            setError("Choose an open folio before charging to a room.");
            return;
          }
          activeSnapshot = operation === "CHARGE_TO_ROOM"
            ? {
                hotelId: activeTenantId,
                operation,
                idempotencyKey: key,
                items: [...order],
                folioId,
                tableNumber,
                timestamp: Date.now(),
                status: "IN_FLIGHT",
              }
            : {
                hotelId: activeTenantId,
                operation,
                idempotencyKey: key,
                items: [...order],
                paymentMethodId: methodId,
                customerName,
                reference,
                tableNumber,
                timestamp: Date.now(),
                status: "IN_FLIGHT",
              };
        }

        if (!activeSnapshot) return;
        if (activeSnapshot.items.length === 0) {
          setError("Add at least one item to the order.");
          return;
        }
        const operation = activeSnapshot.operation;
        const expectedPayNowFingerprint = operation === "PAY_NOW"
          ? await computePayNowAttemptFingerprint(activeSnapshot)
          : null;
        if (!attempts.claim(activeSnapshot, validateCurrentTenantSnapshot, samePendingRequest)) {
          setCheckoutState("PENDING_VERIFICATION");
          setError("A different checkout attempt is already stored. It was preserved; no request was sent.");
          return;
        }
        mirrorPendingAttemptToSession(activeSnapshot, pendingStorageKey);
        pendingAttemptRef.current = activeSnapshot;
        setPendingAttempt(activeSnapshot);
        setCheckoutState("SUBMITTING");
        setLoading(true);
        setError(null);
        setSuccess(null);

        const roomRequest = operation === "CHARGE_TO_ROOM"
          ? buildChargeToRoomRequest(activeSnapshot)
          : null;
        const endpoint = operation === "CHARGE_TO_ROOM"
          ? "/api/restaurant/charge-to-room"
          : "/api/restaurant/pay-now";
        const payload = roomRequest?.payload ?? {
          items: activeSnapshot.items,
          paymentMethodId: activeSnapshot.paymentMethodId,
          customerName: activeSnapshot.customerName,
          reference: activeSnapshot.reference,
          tableNumber: activeSnapshot.tableNumber,
        };
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          "X-Expected-Hotel-Id": activeTenantId,
        };
        headers["X-Idempotency-Key"] = activeSnapshot.idempotencyKey;

        try {
          const res = await fetch(endpoint, {
            method: "POST",
            headers,
            body: JSON.stringify(payload),
          });
          let data: unknown = null;
          try {
            data = await res.json();
          } catch {
            // Non-JSON responses are ambiguous and retain the exact attempt.
          }
          const response = responseRecord(data);

          if (response?.code === "TENANT_CONTEXT_MISMATCH") {
            // Preserve the exact pre-POST snapshot and storage bytes. A stale
            // tenant response is not evidence about the checkout's commit state.
            pendingAttemptRef.current = activeSnapshot;
            setPendingAttempt(activeSnapshot);
            const errorMessage = responseText(data, "error");
            setRecoveryNotice(errorMessage || "The active hotel changed. The saved checkout was preserved; refresh in its original hotel.");
            setCheckoutState("PENDING_VERIFICATION");
            setError(errorMessage || "The active hotel changed. This attempt was preserved and not resolved.");
            return;
          }

          if (operation === "CHARGE_TO_ROOM") {
            if (res.ok && isChargeToRoomResponse(data, activeSnapshot)) {
              if (!clearPendingAttemptStorageIfOwned(attempts, activeSnapshot, pendingStorageKey)) {
                setCheckoutState("PENDING_VERIFICATION");
                setError("The server confirmed this charge, but the stored attempt changed. Its recovery record was preserved; verify it before continuing.");
                return;
              }
              clearSessionMirrorIfOwned(activeSnapshot, pendingStorageKey);
              pendingAttemptRef.current = null;
        setRecoveryNotice(null);
              setPendingAttempt(null);
              setSuccess(`${money(data.total)} charged to ${data.guestName}'s folio.`);
              clearOrderInternal();
              loadActivity();
              loadFolios();
              setCheckoutState("READY");
              try {
                if (typeof window !== "undefined" && "BroadcastChannel" in window) {
                  const bc = new BroadcastChannel("hms_pos_channel");
                  bc.postMessage({ type: "CHECKOUT_SETTLED", hotelId: activeTenantId, operation, idempotencyKey: activeSnapshot.idempotencyKey, guestName: data.guestName, total: data.total });
                  bc.close();
                }
              } catch {}
              return;
            }

            if (isExplicitNotCommittedResponse(data, res.status)) {
              if (!clearPendingAttemptStorageIfOwned(attempts, activeSnapshot, pendingStorageKey)) {
                setCheckoutState("PENDING_VERIFICATION");
                setError("The server rejected this request, but a different attempt now owns recovery storage. Nothing was cleared.");
                return;
              }
              clearSessionMirrorIfOwned(activeSnapshot, pendingStorageKey);
              pendingAttemptRef.current = null;
        setRecoveryNotice(null);
              setPendingAttempt(null);
              setCheckoutState("READY");
              setError(responseText(data, "error") || "The server confirmed that this room charge was not committed.");
              return;
            }

            activeSnapshot.status = response?.outcome === "CONFLICT" ? "PAYLOAD_MISMATCH" : "UNCERTAIN";
            if (!attempts.claim(activeSnapshot, validateCurrentTenantSnapshot, samePendingRequest)) {
              setCheckoutState("PENDING_VERIFICATION");
              setError("A different recovery record now owns the shared store. It was preserved; retry only after verifying ownership.");
              return;
            }
            mirrorPendingAttemptToSession(activeSnapshot, pendingStorageKey);
            pendingAttemptRef.current = activeSnapshot;
            setPendingAttempt(activeSnapshot);
            setCheckoutState("PENDING_VERIFICATION");
            setError(responseText(data, "error") || "Room-charge outcome is uncertain. Retry this exact key and request; do not edit the order or destination.");
            return;
          }

          if (
            res.ok &&
            operation === "PAY_NOW" &&
            expectedPayNowFingerprint !== null &&
            isPayNowResponse(data, activeSnapshot, expectedPayNowFingerprint)
          ) {
            if (!clearPendingAttemptStorageIfOwned(attempts, activeSnapshot, pendingStorageKey)) {
              setCheckoutState("PENDING_VERIFICATION");
              setError("The server response succeeded, but a different attempt owns recovery storage. It was preserved.");
              return;
            }
            clearSessionMirrorIfOwned(activeSnapshot, pendingStorageKey);
            pendingAttemptRef.current = null;
        setRecoveryNotice(null);
            setCheckoutState("CONFIRMED_SUCCESS");
            setPendingAttempt(null);
            setSuccess(`${money(data?.total ?? subtotal)} received from ${data?.guestName ?? "guest"} via ${data?.method ?? "payment"}.${data?.isIdempotentReplay ? " (Verified & Replayed)" : ""}`);
            clearOrderInternal();
            loadActivity();
            loadFolios();
            setCheckoutState("READY");
            try {
              if (typeof window !== "undefined" && "BroadcastChannel" in window) {
                const bc = new BroadcastChannel("hms_pos_channel");
                bc.postMessage({ type: "CHECKOUT_SETTLED", hotelId: activeTenantId, operation, idempotencyKey: activeSnapshot.idempotencyKey, guestName: data?.guestName, total: data?.total ?? subtotal });
                bc.close();
              }
            } catch {}
            return;
          }

          if (isExplicitNotCommittedResponse(data, res.status)) {
            if (!clearPendingAttemptStorageIfOwned(attempts, activeSnapshot, pendingStorageKey)) {
              setCheckoutState("PENDING_VERIFICATION");
              setError("The server confirmed non-commit, but a different attempt owns recovery storage. It was preserved.");
              return;
            }
            clearSessionMirrorIfOwned(activeSnapshot, pendingStorageKey);
            pendingAttemptRef.current = null;
        setRecoveryNotice(null);
            setCheckoutState("CONFIRMED_FAILURE");
            setPendingAttempt(null);
            setError(responseText(data, "error") || "The server confirmed this payment was not committed.");
            setCheckoutState("READY");
            return;
          }

          if (res.status === 409 && response?.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD") {
            activeSnapshot.status = "PAYLOAD_MISMATCH";
          } else {
            activeSnapshot.status = "UNCERTAIN";
          }
          if (!attempts.claim(activeSnapshot, validateCurrentTenantSnapshot, samePendingRequest)) {
            setCheckoutState("PENDING_VERIFICATION");
            setError("A different recovery record now owns the shared store. It was preserved.");
            return;
          }
          mirrorPendingAttemptToSession(activeSnapshot, pendingStorageKey);
          pendingAttemptRef.current = activeSnapshot;
          setPendingAttempt(activeSnapshot);
          setCheckoutState("PENDING_VERIFICATION");
          setError(responseText(data, "error") || "Checkout status is uncertain. Retry this exact saved request.");
        } catch {
          activeSnapshot.status = "UNCERTAIN";
          try {
            if (attempts.claim(activeSnapshot, validateCurrentTenantSnapshot, samePendingRequest)) {
              mirrorPendingAttemptToSession(activeSnapshot, pendingStorageKey);
            }
          } catch {
            // The pre-POST shared claim remains in localStorage if refresh fails.
          }
          pendingAttemptRef.current = activeSnapshot;
          setPendingAttempt(activeSnapshot);
          setCheckoutState("PENDING_VERIFICATION");
          setError("Network error or timeout. Checkout status is uncertain; retry the exact saved request.");
        } finally {
          setLoading(false);
        }
      });
    } catch (error) {
      if (error instanceof CheckoutLockBusyError) {
        waitingForCrossTabAttemptRef.current = !pendingAttemptRef.current;
        setCheckoutState("PENDING_VERIFICATION");
        setError("Another tab is processing a checkout. This tab sent no request and is waiting for the shared recovery record.");
      } else if (error instanceof CheckoutTenantMismatchError || error instanceof LegacyCheckoutAttemptError) {
        waitingForCrossTabAttemptRef.current = false;
        setRecoveryNotice(error.message);
        setCheckoutState("PENDING_VERIFICATION");
        setError(error.message);
      } else {
        setCheckoutState(pendingAttemptRef.current ? "PENDING_VERIFICATION" : "READY");
        setError(error instanceof Error ? error.message : "Safe cross-tab recovery is unavailable; no request was sent.");
      }
    } finally {
      inFlightRef.current = false;
      setLoading(false);
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
                  {recoveryNotice
                    ? "Recovery Requires Attention"
                    : waitingForCrossTabAttemptRef.current
                    ? "Checkout In Progress in Another Tab"
                    : pendingAttempt?.status === "PAYLOAD_MISMATCH"
                    ? "Idempotency Key Conflict / Reused Key"
                    : pendingAttempt?.isExpired
                    ? "Unresolved Checkout Expired (>24h)"
                    : pendingAttempt?.operation === "CHARGE_TO_ROOM"
                    ? "Room-Charge Status Uncertain"
                    : "Payment Status Uncertain"}
                </p>
                <p className="text-text-secondary text-xs">
                  {recoveryNotice
                    ? recoveryNotice
                    : waitingForCrossTabAttemptRef.current
                    ? "This tab sent no request. Wait for the other tab to finish, then check or retry the exact shared recovery attempt."
                    : pendingAttempt?.status === "PAYLOAD_MISMATCH"
                    ? "This key was previously used for different request details. The original transaction may have committed. Retry the exact saved request to verify it; do not clear or edit this attempt."
                    : pendingAttempt?.isExpired
                    ? "This checkout attempt is older than 24 hours. Keep it locked and retry or have an administrator verify the server-side record before resolving it."
                    : pendingAttempt?.operation === "CHARGE_TO_ROOM"
                    ? "The room-charge outcome is uncertain. Retry the exact saved key and request; do not change the items or folio destination."
                    : "Payment status is uncertain. Do not start another checkout until this attempt is verified."}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => waitingForCrossTabAttemptRef.current || pendingAttempt?.operation === "CHARGE_TO_ROOM" ? submit() : reconcilePaymentStatus()}
                    disabled={Boolean(recoveryNotice) || reconciling || loading}
                    className="btn-primary text-xs px-3 py-1.5 rounded-lg shadow-sm !bg-amber-700 hover:!bg-amber-800 !text-white"
                  >
                    {loading || reconciling
                      ? "Checking Server..."
                      : waitingForCrossTabAttemptRef.current
                      ? "Check Shared Attempt"
                      : pendingAttempt?.operation === "CHARGE_TO_ROOM"
                      ? "Retry Exact Room Charge"
                      : "Check Server Status"}
                  </button>
                  <button
                    type="button"
                    onClick={loadActivity}
                    className="btn-secondary text-xs px-3 py-1.5 rounded-lg shadow-sm"
                  >
                    Check Recent Activity
                  </button>
                  {pendingAttempt?.operation !== "CHARGE_TO_ROOM" && (pendingAttempt?.status === "PAYLOAD_MISMATCH" || pendingAttempt?.isExpired) && (
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
                Boolean(recoveryNotice) ||
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
                    <p className={clsx("text-xs", a.settled ? "text-success" : "text-accent-500")}>
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