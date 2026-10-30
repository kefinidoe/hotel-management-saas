import { beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { PendingCheckoutSnapshot } from "@/components/restaurant/RestaurantClient";
import { computePosFingerprint } from "@/lib/restaurant";
import {
  CheckoutLockBusyError,
  CheckoutOwnershipError,
  CheckoutTenantMismatchError,
  POS_LEGACY_STORAGE_KEY,
  decideStorageEvent,
  tenantPOSLockName,
  tenantPOSStorageKey,
  withPOSCheckoutOwnership,
} from "@/lib/pos-checkout-ownership";

vi.doMock("clsx", () => ({ default: (...args: any[]) => args.filter(Boolean).join(" ") }));
vi.doMock("lucide-react", () => {
  const Dummy = () => null;
  return { Minus: Dummy, Plus: Dummy, Trash2: Dummy, ShoppingCart: Dummy, UtensilsCrossed: Dummy, Settings2: Dummy, X: Dummy };
});
vi.doMock("@/lib/permissions", () => ({ hasRole: () => true, ROLE_GROUPS: { MANAGEMENT: [] } }));
vi.doMock("@/lib/menu-categories", () => ({ isRequiredMenuCategory: () => false }));

type RestaurantRecoveryHelpers = typeof import("@/components/restaurant/RestaurantClient");
let buildChargeToRoomRequest: RestaurantRecoveryHelpers["buildChargeToRoomRequest"];
let isChargeToRoomResponse: RestaurantRecoveryHelpers["isChargeToRoomResponse"];
let isPayNowResponse: RestaurantRecoveryHelpers["isPayNowResponse"];
let computePayNowAttemptFingerprint: RestaurantRecoveryHelpers["computePayNowAttemptFingerprint"];
let isConfirmedPayNowStatusResponse: RestaurantRecoveryHelpers["isConfirmedPayNowStatusResponse"];
let isExplicitNotCommittedResponse: RestaurantRecoveryHelpers["isExplicitNotCommittedResponse"];
let samePendingRequest: RestaurantRecoveryHelpers["samePendingRequest"];
let validatePendingSnapshot: RestaurantRecoveryHelpers["validatePendingSnapshot"];
beforeAll(async () => {
  const component = await import("@/components/restaurant/RestaurantClient");
  buildChargeToRoomRequest = component.buildChargeToRoomRequest;
  isChargeToRoomResponse = component.isChargeToRoomResponse;
  isPayNowResponse = component.isPayNowResponse;
  computePayNowAttemptFingerprint = component.computePayNowAttemptFingerprint;
  isConfirmedPayNowStatusResponse = component.isConfirmedPayNowStatusResponse;
  isExplicitNotCommittedResponse = component.isExplicitNotCommittedResponse;
  samePendingRequest = component.samePendingRequest;
  validatePendingSnapshot = component.validatePendingSnapshot;
});

const attempt = {
  hotelId: "hotel-a",
  operation: "CHARGE_TO_ROOM" as const,
  idempotencyKey: "room-recovery-key-123",
  items: [{ menuItemId: "menu-soup", name: "Soup", unitPrice: 430, quantity: 2 }],
  folioId: "folio-guest-a",
  tableNumber: " Table 7 / dinner note ",
  timestamp: Date.now(),
  status: "UNCERTAIN" as const,
};

class MemoryStorage {
  private values = new Map<string, string>();
  failRead = false;
  failWrite = false;
  failRemove = false;

  getItem(key: string) {
    if (this.failRead) throw new Error("storage read blocked");
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrite) throw new Error("storage write blocked");
    this.values.set(key, String(value));
  }
  removeItem(key: string) {
    if (this.failRemove) throw new Error("storage remove blocked");
    this.values.delete(key);
  }
}

class MockWebLocks {
  private held = new Set<string>();
  fail = false;
  async request<T>(name: string, _options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: unknown | null) => Promise<T>): Promise<T> {
    if (this.fail) throw new Error("lock service failed");
    if (this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ mockLock: true, name });
    } finally {
      this.held.delete(name);
    }
  }
}

describe("charge-to-room retry and recovery (mocked cross-tab simulations; not browser atomicity proof)", () => {
  it("restores operation, key, canonical body, and folio from the persisted attempt", () => {
    const persisted = JSON.stringify(attempt);
    const restored = validatePendingSnapshot(JSON.parse(persisted));
    expect(restored).not.toBeNull();
    expect(restored?.operation).toBe("CHARGE_TO_ROOM");
    expect(restored?.folioId).toBe(attempt.folioId);
    expect(buildChargeToRoomRequest(restored!)).toEqual({
      idempotencyKey: attempt.idempotencyKey,
      payload: {
        items: attempt.items,
        folioId: attempt.folioId,
        tableNumber: attempt.tableNumber,
      },
    });
  });

  it("ambiguous retries keep the identical key and payload, even after reload", () => {
    const firstRequest = buildChargeToRoomRequest(attempt);
    const retrySnapshot = { ...attempt, status: "UNCERTAIN" as const };
    const restored = validatePendingSnapshot(JSON.parse(JSON.stringify(retrySnapshot)))!;
    const retryRequest = buildChargeToRoomRequest(restored);
    expect(retryRequest.idempotencyKey).toBe(firstRequest.idempotencyKey);
    expect(JSON.stringify(retryRequest.payload)).toBe(JSON.stringify(firstRequest.payload));
  });

  it("refuses to construct a room request without its original folio destination", () => {
    expect(validatePendingSnapshot({ ...attempt, folioId: undefined })).toBeNull();
    expect(() => buildChargeToRoomRequest({ ...attempt, folioId: undefined })).toThrow(/folio destination/);
  });

  it("accepts only a correlated authoritative server confirmation, not HTTP success alone", () => {
    const valid = {
      ok: true,
      operation: "CHARGE_TO_ROOM",
      idempotencyKey: attempt.idempotencyKey,
      requestFingerprint: "a".repeat(64),
      orderId: "order-1",
      folioId: attempt.folioId,
      guestName: "Guest A",
      total: 860,
    };
    expect(isChargeToRoomResponse(valid, attempt)).toBe(true);
    expect(isChargeToRoomResponse({ ok: true, total: 860 }, attempt)).toBe(false);
    expect(isChargeToRoomResponse({ ...valid, idempotencyKey: "different-key" }, attempt)).toBe(false);
    expect(isChargeToRoomResponse({ ...valid, folioId: "different-folio" }, attempt)).toBe(false);
  });

  it("claims under Web Locks, persists before POST, and keeps ambiguous outcomes locked", () => {
    const source = readFileSync("components/restaurant/RestaurantClient.tsx", "utf8");
    const ownershipSource = readFileSync("lib/pos-checkout-ownership.ts", "utf8");
    const claim = source.indexOf("attempts.claim(activeSnapshot, validateCurrentTenantSnapshot, samePendingRequest)");
    const post = source.indexOf("const res = await fetch(endpoint", claim);
    const ambiguous = source.indexOf('activeSnapshot.status = response?.outcome === "CONFLICT" ? "PAYLOAD_MISMATCH" : "UNCERTAIN"', post);
    expect(source).toContain("await withCurrentPOSOwnership(async (attempts)");
    expect(source).toContain("await assertCurrentAuthenticatedTenant()");
    expect(source).toContain('"X-Expected-Hotel-Id": activeTenantId');
    expect(source).toContain("activeSnapshot.hotelId !== activeTenantId");
    expect(source).toContain("tenantPOSStorageKey(activeTenantId)");
    const submitStart = source.indexOf("async function submit()");
    const tenantMismatchStart = source.indexOf('if (response?.code === "TENANT_CONTEXT_MISMATCH")', submitStart);
    const tenantMismatchEnd = source.indexOf('if (operation === "CHARGE_TO_ROOM")', tenantMismatchStart);
    const tenantMismatchBranch = source.slice(tenantMismatchStart, tenantMismatchEnd);
    expect(tenantMismatchStart).toBeGreaterThan(-1);
    expect(tenantMismatchBranch).not.toContain("activeSnapshot.status =");
    expect(tenantMismatchBranch).not.toContain("attempts.claim(");
    expect(tenantMismatchBranch).not.toContain("clearPendingAttemptStorage");
    expect(source).toContain("attempts.claim(activeSnapshot, validateCurrentTenantSnapshot, samePendingRequest)");
    expect(claim).toBeGreaterThan(-1);
    expect(post).toBeGreaterThan(claim);
    expect(ambiguous).toBeGreaterThan(post);
    expect(source).toContain('if (res.ok && isChargeToRoomResponse(data, activeSnapshot))');
    expect(source).toContain("if (isExplicitNotCommittedResponse(data, res.status))");
    expect(ownershipSource).toContain("POS_CHECKOUT_LOCK_NAME");
    expect(ownershipSource).toContain("POS_TENANT_LOCK_PREFIX");
    expect(ownershipSource).toContain("Could not persist the shared checkout attempt; no request was sent.");
  });

  it("serializes two tabs racing to claim the same cart; loser sends no POST", async () => {
    const locks = new MockWebLocks();
    const storage = new MemoryStorage();
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let posts = 0;

    const first = withPOSCheckoutOwnership(locks, storage, "pending", async (owned) => {
      expect(owned.claim(attempt, validatePendingSnapshot, samePendingRequest)).toBe(true);
      posts += 1;
      entered();
      await hold;
    });
    await inside;

    const competing = { ...attempt, idempotencyKey: "different-key-for-same-cart" };
    await expect(withPOSCheckoutOwnership(locks, storage, "pending", async (owned) => {
      owned.claim(competing, validatePendingSnapshot, samePendingRequest);
      posts += 1;
    })).rejects.toBeInstanceOf(CheckoutLockBusyError);
    expect(posts).toBe(1);
    expect(validatePendingSnapshot(JSON.parse(storage.getItem("pending")!))?.idempotencyKey).toBe(attempt.idempotencyKey);
    release();
    await first;
  });

  it("two tabs observing an existing unresolved attempt reuse its exact key and payload", async () => {
    const locks = new MockWebLocks();
    const storage = new MemoryStorage();
    storage.setItem("pending", JSON.stringify(attempt));
    const observed: string[] = [];
    for (let tab = 0; tab < 2; tab += 1) {
      await withPOSCheckoutOwnership(locks, storage, "pending", async (owned) => {
        const stored = owned.read<PendingCheckoutSnapshot>(validatePendingSnapshot)!;
        expect(samePendingRequest(stored, attempt)).toBe(true);
        observed.push(stored.idempotencyKey);
      });
    }
    expect(observed).toEqual([attempt.idempotencyKey, attempt.idempotencyKey]);
    expect(JSON.parse(storage.getItem("pending")!)).toEqual(attempt);
  });

  it("prevents a competing tab from replacing or clearing an attempt while its owner resolves it", async () => {
    const locks = new MockWebLocks();
    const storage = new MemoryStorage();
    storage.setItem("pending", JSON.stringify(attempt));
    let entered!: () => void;
    let release!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });

    const owner = withPOSCheckoutOwnership(locks, storage, "pending", async (owned) => {
      expect(owned.clearIfOwned(attempt, validatePendingSnapshot, samePendingRequest)).toBe(true);
      entered();
      await hold;
    });
    await inside;
    let competingWorkRan = false;
    const otherAttempt = { ...attempt, idempotencyKey: "replacement-key" };
    await expect(withPOSCheckoutOwnership(locks, storage, "pending", async (owned) => {
      competingWorkRan = true;
      owned.claim(otherAttempt, validatePendingSnapshot, samePendingRequest);
    })).rejects.toBeInstanceOf(CheckoutLockBusyError);
    expect(competingWorkRan).toBe(false);
    expect(storage.getItem("pending")).toBeNull();
    release();
    await owner;
  });

  it("ignores a delayed storage event when the locally unresolved attempt is newer", () => {
    const newer = { ...attempt, idempotencyKey: "newer-owned-key" };
    const staleEventValue = JSON.stringify(attempt);
    const storage = new MemoryStorage();
    storage.setItem("pending", JSON.stringify(newer));
    // Production handler re-reads storage instead of trusting e.newValue.
    const latest = validatePendingSnapshot(JSON.parse(storage.getItem("pending")!)) as typeof newer | null;
    expect(JSON.parse(staleEventValue).idempotencyKey).toBe(attempt.idempotencyKey);
    expect(decideStorageEvent(newer, latest, samePendingRequest)).toBe("KEEP");
    expect(decideStorageEvent(newer, attempt, samePendingRequest)).toBe("CONFLICT");
  });

  it("fails closed without Web Locks or when lock acquisition fails", async () => {
    const storage = new MemoryStorage();
    let workRan = false;
    await expect(withPOSCheckoutOwnership(undefined, storage, "pending", async () => {
      workRan = true;
    })).rejects.toBeInstanceOf(CheckoutOwnershipError);
    const failingLocks = new MockWebLocks();
    failingLocks.fail = true;
    await expect(withPOSCheckoutOwnership(failingLocks, storage, "pending", async () => {
      workRan = true;
    })).rejects.toThrow(/no request was sent/i);
    expect(workRan).toBe(false);
  });

  it("storage failure prevents POST and does not claim a fallback key", async () => {
    const locks = new MockWebLocks();
    const storage = new MemoryStorage();
    storage.failWrite = true;
    let posts = 0;
    await expect(withPOSCheckoutOwnership(locks, storage, "pending", async (owned) => {
      if (!owned.claim(attempt, validatePendingSnapshot, samePendingRequest)) return;
      posts += 1;
    })).rejects.toThrow(/no request was sent/i);
    expect(posts).toBe(0);
    expect(storage.getItem("pending")).toBeNull();
  });

  it("does not clear a different key even when the payload appears identical", async () => {
    const locks = new MockWebLocks();
    const storage = new MemoryStorage();
    const replacement = { ...attempt, idempotencyKey: "another-key-same-cart" };
    storage.setItem("pending", JSON.stringify(replacement));
    await withPOSCheckoutOwnership(locks, storage, "pending", async (owned) => {
      expect(owned.clearIfOwned(attempt, validatePendingSnapshot, samePendingRequest)).toBe(false);
    });
    expect(JSON.parse(storage.getItem("pending")!).idempotencyKey).toBe(replacement.idempotencyKey);
  });

  it("keeps separate tenant attempts under tenant-scoped keys without overwriting", async () => {
    const locks = new MockWebLocks();
    const storage = new MemoryStorage();
    const keyA = tenantPOSStorageKey("hotel-a");
    const keyB = tenantPOSStorageKey("hotel-b");
    const attemptB = { ...attempt, hotelId: "hotel-b", idempotencyKey: "hotel-b-room-key" };
    expect(keyA).toBe("hms_pos_pending_attempt_v2:hotel-a");
    expect(keyB).toBe("hms_pos_pending_attempt_v2:hotel-b");
    expect(tenantPOSLockName("hotel-a")).not.toBe(tenantPOSLockName("hotel-b"));

    await withPOSCheckoutOwnership(locks, storage, keyA, async (owned) => {
      expect(owned.claim(attempt, validatePendingSnapshot, samePendingRequest)).toBe(true);
    }, "hotel-a");
    await withPOSCheckoutOwnership(locks, storage, keyB, async (owned) => {
      expect(owned.claim(attemptB, validatePendingSnapshot, samePendingRequest)).toBe(true);
    }, "hotel-b");

    expect(JSON.parse(storage.getItem(keyA)!)).toEqual(attempt);
    expect(JSON.parse(storage.getItem(keyB)!)).toEqual(attemptB);
    expect(samePendingRequest(attempt, attemptB)).toBe(false);
  });

  it("rejects cross-tenant claim and cleanup while preserving the original record", async () => {
    const locks = new MockWebLocks();
    const storage = new MemoryStorage();
    const keyA = tenantPOSStorageKey("hotel-a");
    const keyB = tenantPOSStorageKey("hotel-b");
    storage.setItem(keyB, JSON.stringify(attempt));
    let posts = 0;

    await expect(withPOSCheckoutOwnership(locks, storage, keyB, async (owned) => {
      owned.claim(attempt, validatePendingSnapshot, samePendingRequest);
      posts += 1;
    }, "hotel-b")).rejects.toBeInstanceOf(CheckoutTenantMismatchError);
    await expect(withPOSCheckoutOwnership(locks, storage, keyA, async (owned) => {
      owned.clearIfOwned(attempt, validatePendingSnapshot, samePendingRequest);
    }, "hotel-b")).rejects.toBeInstanceOf(CheckoutTenantMismatchError);

    expect(posts).toBe(0);
    expect(storage.getItem(keyB)).toBe(JSON.stringify(attempt));
    expect(storage.getItem(keyA)).toBeNull();
  });

  it("fails closed on legacy or malformed attempts without deleting their raw records", async () => {
    const locks = new MockWebLocks();
    const storage = new MemoryStorage();
    const keyA = tenantPOSStorageKey("hotel-a");
    const legacy = { ...attempt } as Record<string, unknown>;
    delete legacy.hotelId;
    delete legacy.operation;
    const rawLegacy = JSON.stringify(legacy);
    storage.setItem(POS_LEGACY_STORAGE_KEY, rawLegacy);
    storage.setItem(keyA, "{malformed");

    expect(validatePendingSnapshot(legacy)).toBeNull();
    await withPOSCheckoutOwnership(locks, storage, keyA, async (owned) => {
      expect(owned.readRaw(POS_LEGACY_STORAGE_KEY)).toBe(rawLegacy);
      await expect(Promise.resolve().then(() => owned.read(validatePendingSnapshot))).rejects.toThrow(/malformed/i);
    }, "hotel-a");
    expect(storage.getItem(POS_LEGACY_STORAGE_KEY)).toBe(rawLegacy);
    expect(storage.getItem(keyA)).toBe("{malformed");
  });

  it("reconciles only an exact completed Pay-now identity and preserves attempts for every ambiguous response", async () => {
    const payNowAttempt = {
      hotelId: "hotel-a",
      operation: "PAY_NOW" as const,
      idempotencyKey: "pay-now-key-123",
      items: [{ menuItemId: "menu-soup", name: "Soup", unitPrice: 430, quantity: 1 }],
      paymentMethodId: "cash-a",
      customerName: "Guest A",
      reference: "",
      tableNumber: "5",
      timestamp: Date.now(),
    };
    const fingerprint = await computePayNowAttemptFingerprint(payNowAttempt);
    expect(fingerprint).toBe(computePosFingerprint({
      hotelId: "hotel-a",
      items: [{ menuItemId: "menu-soup", quantity: 1 }],
      paymentMethodId: "cash-a",
      customerName: "Guest A",
      customerPhone: "",
      tableNumber: "5",
      reference: "",
    }));

    const confirmed = {
      ok: true,
      hotelId: "hotel-a",
      operation: "PAY_NOW",
      idempotencyKey: payNowAttempt.idempotencyKey,
      requestFingerprint: fingerprint,
      paymentId: "payment-1",
      folioId: "folio-1",
      guestName: "Guest A",
      total: 430,
      method: "Cash",
    };
    expect(isPayNowResponse(confirmed, payNowAttempt, fingerprint)).toBe(true);
    expect(isPayNowResponse({ ...confirmed, isIdempotentReplay: true }, payNowAttempt, fingerprint)).toBe(true);
    expect(isPayNowResponse({ ...confirmed, idempotencyKey: "other-key" }, payNowAttempt, fingerprint)).toBe(false);
    expect(isPayNowResponse({ ...confirmed, hotelId: "hotel-b" }, payNowAttempt, fingerprint)).toBe(false);
    expect(isPayNowResponse({ ...confirmed, requestFingerprint: "a".repeat(64) }, payNowAttempt, fingerprint)).toBe(false);
    expect(isPayNowResponse({ ...confirmed, isIdempotentReplay: "yes" }, payNowAttempt, fingerprint)).toBe(false);

    const status = {
      found: true,
      hotelId: "hotel-a",
      operation: "PAY_NOW",
      idempotencyKey: payNowAttempt.idempotencyKey,
      requestFingerprint: fingerprint,
      matchesFingerprint: true,
      status: "COMPLETED",
      paymentId: "payment-1",
      folioId: "folio-1",
      guestName: "Guest A",
      method: "Cash",
      total: 430,
    };
    expect(isConfirmedPayNowStatusResponse(status, payNowAttempt, fingerprint)).toBe(true);
    expect(isConfirmedPayNowStatusResponse({ ...status, hotelId: "hotel-b" }, payNowAttempt, fingerprint)).toBe(false);
    expect(isConfirmedPayNowStatusResponse({ ...status, operation: "CHARGE_TO_ROOM" }, payNowAttempt, fingerprint)).toBe(false);
    expect(isConfirmedPayNowStatusResponse({ ...status, idempotencyKey: "other-key" }, payNowAttempt, fingerprint)).toBe(false);
    expect(isConfirmedPayNowStatusResponse({ ...status, requestFingerprint: "b".repeat(64) }, payNowAttempt, fingerprint)).toBe(false);
    expect(isConfirmedPayNowStatusResponse({ ...status, requestFingerprint: undefined }, payNowAttempt, fingerprint)).toBe(false);
    expect(isConfirmedPayNowStatusResponse({ ...status, matchesFingerprint: false }, payNowAttempt, fingerprint)).toBe(false);
    for (const paymentStatus of ["PENDING", "FAILED", "REFUNDED", "CANCELLED", "UNKNOWN"]) {
      expect(isConfirmedPayNowStatusResponse({ ...status, status: paymentStatus }, payNowAttempt, fingerprint)).toBe(false);
    }
    expect(isConfirmedPayNowStatusResponse({ found: true }, payNowAttempt, fingerprint)).toBe(false);
    expect(isConfirmedPayNowStatusResponse(null, payNowAttempt, fingerprint)).toBe(false);

    const locks = new MockWebLocks();
    const storage = new MemoryStorage();
    const storageKey = tenantPOSStorageKey("hotel-a");
    const rawAttempt = JSON.stringify(payNowAttempt);
    storage.setItem(storageKey, rawAttempt);
    await withPOSCheckoutOwnership(locks, storage, storageKey, async (owned) => {
      const stored = owned.read(validatePendingSnapshot)!;
      const ambiguousResponses = [
        { ...status, status: "PENDING" },
        { ...status, requestFingerprint: undefined },
        { ...status, operation: null },
        { ...status, hotelId: "hotel-b" },
        { found: true, status: "UNKNOWN" },
      ];
      for (const response of ambiguousResponses) {
        if (isConfirmedPayNowStatusResponse(response, stored, fingerprint)) {
          owned.clearIfOwned(stored, validatePendingSnapshot, samePendingRequest);
        }
      }
    }, "hotel-a");
    expect(storage.getItem(storageKey)).toBe(rawAttempt);

    const source = readFileSync("components/restaurant/RestaurantClient.tsx", "utf8");
    const routeSource = readFileSync("app/api/restaurant/payments/status/route.ts", "utf8");
    const reconcileStart = source.indexOf("const reconcilePaymentStatus = useCallback");
    const reconcileEnd = source.indexOf("async function dismissVerifiedFailure", reconcileStart);
    const reconcileSource = source.slice(reconcileStart, reconcileEnd);
    const validateResponse = reconcileSource.indexOf("isConfirmedPayNowStatusResponse(data, stored, fingerprint)");
    const clearAttempt = reconcileSource.indexOf("clearPendingAttemptStorageIfOwned(attempts, stored, pendingStorageKey)");
    expect(validateResponse).toBeGreaterThan(-1);
    expect(clearAttempt).toBeGreaterThan(validateResponse);
    expect(reconcileSource).toContain('operation: "PAY_NOW"');
    expect(reconcileSource).toContain("fingerprint,");
    expect(reconcileSource).toContain("!stored || !samePendingRequest(stored, attempt)");
    expect(reconcileSource).not.toContain("if (res.ok && data.found)");
    expect(routeSource).toContain('operation !== "PAY_NOW"');
    expect(routeSource).toContain("!fingerprint || !/^[a-f0-9]{64}$/");
    expect(routeSource).toContain('matchesFingerprint ? "PAY_NOW" : null');
  });

  it("requires explicit NOT_COMMITTED before a failed Pay-now request can clear", () => {
    const source = readFileSync("components/restaurant/RestaurantClient.tsx", "utf8");
    const routeSource = readFileSync("app/api/restaurant/pay-now/route.ts", "utf8");
    expect(isExplicitNotCommittedResponse({ outcome: "NOT_COMMITTED" }, 400)).toBe(true);
    expect(isExplicitNotCommittedResponse({ outcome: "NOT_COMMITTED" }, 409)).toBe(true);
    expect(isExplicitNotCommittedResponse({ outcome: "UNKNOWN" }, 409)).toBe(false);
    expect(isExplicitNotCommittedResponse({}, 400)).toBe(false);
    expect(isExplicitNotCommittedResponse({ outcome: "NOT_COMMITTED" }, 500)).toBe(false);
    expect(source).toContain("if (isExplicitNotCommittedResponse(data, res.status))");
    expect(source).not.toContain("if (res.status === 400 || res.status === 403)");
    expect(routeSource).toContain('outcome: "NOT_COMMITTED"');
    expect(routeSource).toContain('outcome: "UNKNOWN"');
  });

});
