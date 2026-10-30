import { describe, it, expect, vi, beforeAll } from "vitest";
import { readFileSync } from "fs";
import { tenantPOSStorageKey } from "@/lib/pos-checkout-ownership";
import { join } from "path";

vi.doMock("clsx", () => ({
  default: (...args: any[]) => args.filter(Boolean).join(" "),
  clsx: (...args: any[]) => args.filter(Boolean).join(" "),
}));

vi.doMock("lucide-react", () => {
  const Dummy = () => null;
  return {
    Minus: Dummy,
    Plus: Dummy,
    Trash2: Dummy,
    ShoppingCart: Dummy,
    UtensilsCrossed: Dummy,
    Settings2: Dummy,
    X: Dummy,
  };
});

vi.doMock("@/lib/permissions", () => ({
  hasRole: () => true,
  ROLE_GROUPS: {
    MANAGEMENT: ["HOTEL_OWNER", "HOTEL_ADMIN"],
  },
}));

vi.doMock("@/lib/menu-categories", () => ({
  isRequiredMenuCategory: () => false,
}));

const TEST_POS_STORAGE_KEY = tenantPOSStorageKey("hotel-a");

let validatePendingSnapshot: any;
let POS_SNAPSHOT_TTL_MS: number;
beforeAll(async () => {
  const mod = await import("../../components/restaurant/RestaurantClient");
  validatePendingSnapshot = mod.validatePendingSnapshot;
  POS_SNAPSHOT_TTL_MS = mod.POS_SNAPSHOT_TTL_MS;
});

describe("Phase 4B.7: Restaurant POS Frontend Source & Safety Audit", () => {
  const componentPath = join(
    __dirname,
    "..",
    "..",
    "components",
    "restaurant",
    "RestaurantClient.tsx"
  );
  const source = readFileSync(componentPath, "utf-8");

  it("Task 1.1: Uses crypto.randomUUID() in browser for idempotency key generation", () => {
    expect(source).toContain("window.crypto?.randomUUID");
    expect(source).not.toMatch(/const\s+.*=\s*crypto\.randomUUID\(\)/);
  });

  it("Task 1.2: Sends key using the X-Idempotency-Key header on pay-now endpoint", () => {
    expect(source).toContain('headers["X-Idempotency-Key"] = activeSnapshot.idempotencyKey');
  });

  it("Task 1.3: In-flight guard and loading state prevent rapid repeated submissions", () => {
    expect(source).toContain("inFlightRef = useRef(false)");
    expect(source).toContain("if (inFlightRef.current || loading || checkoutState === \"SUBMITTING\") return;");
    expect(source).toContain("inFlightRef.current = true;");
    expect(source).toContain("inFlightRef.current = false;");
  });

  it("Task 1.4: Locks cart mutations during PENDING_VERIFICATION and SUBMITTING", () => {
    expect(source).toContain('if (checkoutState === "PENDING_VERIFICATION" || checkoutState === "SUBMITTING")');
    expect(source).toContain("Payment status is uncertain. Do not modify the order until this attempt is verified.");
    expect(source).toContain("Payment status is uncertain. Do not clear the order until this attempt is verified.");
  });

  it("Task 1.5: Claims pending checkouts durably in shared localStorage with a tab-local session mirror", () => {
    expect(source).toContain("tenantPOSStorageKey(activeTenantId)");
    expect(source).toContain("const pendingStorageKey = tenantPOSStorageKey(activeTenantId)");
    expect(source).toContain("attempts.readRaw(POS_LEGACY_STORAGE_KEY)");
    expect(source).toContain("window.sessionStorage?.setItem(storageKey, JSON.stringify(snapshot))");
    expect(source).toContain("await withCurrentPOSOwnership(async (attempts)");
    expect(source).toContain("attempts.claim(activeSnapshot, validateCurrentTenantSnapshot, samePendingRequest)");
  });

  it("Task 1.6: Preserves the exact room attempt on conflict and clears only under ownership", () => {
    expect(source).toContain('activeSnapshot.status = response?.outcome === "CONFLICT" ? "PAYLOAD_MISMATCH" : "UNCERTAIN"');
    expect(source).toContain("attempts.clearIfOwned(attempt, validatePendingSnapshot, samePendingRequest)");
    expect(source).not.toContain("clearPendingAttemptStorage();");
  });

  it("Task 1.7: Provides server reconciliation endpoint integration", () => {
    expect(source).toContain("/api/restaurant/payments/status");
    expect(source).toContain("reconcilePaymentStatus");
    expect(source).toContain("Check Server Status");
  });

  it("Task 1.8: Implements protected storage events and mandatory Web Locks coordination", () => {
    const ownershipSource = readFileSync(join(__dirname, "..", "..", "lib", "pos-checkout-ownership.ts"), "utf8");
    expect(source).toContain("window.addEventListener(\"storage\"");
    expect(source).toContain("This tab will not replace or submit over it.");
    expect(source).toContain("BroadcastChannel");
    expect(ownershipSource).toContain("hms_pos_checkout_lock");
    expect(ownershipSource).toContain("POS_CHECKOUT_LOCK_NAME");
    expect(ownershipSource).toContain("POS_TENANT_LOCK_PREFIX");
  });
});

describe("Phase 4B.7: validatePendingSnapshot Validation & Expiry Rules", () => {
  const validSnapshot = {
    hotelId: "hotel-a",
    operation: "PAY_NOW" as const,
    idempotencyKey: "123e4567-e89b-12d3-a456-426614174000",
    items: [{ menuItemId: "item-1", name: "Burger", unitPrice: 500, quantity: 2 }],
    paymentMethodId: "pm-cash",
    customerName: "Jane Doe",
    reference: "REF-1234",
    tableNumber: "5",
    timestamp: Date.now(),
  };

  it("accepts a well-formed pending snapshot within TTL", () => {
    const validated = validatePendingSnapshot(validSnapshot);
    expect(validated).not.toBeNull();
    expect(validated?.idempotencyKey).toBe(validSnapshot.idempotencyKey);
    expect(validated?.items.length).toBe(1);
    expect(validated?.paymentMethodId).toBe("pm-cash");
    expect(validated?.isExpired).toBe(false);
  });

  it("rejects missing, blank, or out-of-bounds idempotency keys", () => {
    expect(validatePendingSnapshot({ ...validSnapshot, idempotencyKey: "" })).toBeNull();
    expect(validatePendingSnapshot({ ...validSnapshot, idempotencyKey: "   " })).toBeNull();
    expect(validatePendingSnapshot({ ...validSnapshot, idempotencyKey: "abc" })).toBeNull();
    expect(validatePendingSnapshot({ ...validSnapshot, idempotencyKey: "a".repeat(129) })).toBeNull();
  });

  it("rejects empty items array or invalid item attributes", () => {
    expect(validatePendingSnapshot({ ...validSnapshot, items: [] })).toBeNull();
    expect(
      validatePendingSnapshot({
        ...validSnapshot,
        items: [{ menuItemId: "", name: "Burger", unitPrice: 500, quantity: 1 }],
      })
    ).toBeNull();
    expect(
      validatePendingSnapshot({
        ...validSnapshot,
        items: [{ menuItemId: "item-1", name: "Burger", unitPrice: -50, quantity: 1 }],
      })
    ).toBeNull();
    expect(
      validatePendingSnapshot({
        ...validSnapshot,
        items: [{ menuItemId: "item-1", name: "Burger", unitPrice: 500, quantity: 0 }],
      })
    ).toBeNull();
  });

  it("rejects missing or empty paymentMethodId", () => {
    expect(validatePendingSnapshot({ ...validSnapshot, paymentMethodId: "" })).toBeNull();
    expect(validatePendingSnapshot({ ...validSnapshot, paymentMethodId: "   " })).toBeNull();
  });

  it("flags expired snapshot (>24 hours) as isExpired without returning null or destroying recovery data", () => {
    const expiredTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
    const expiredSnapshot = { ...validSnapshot, timestamp: expiredTimestamp };
    const validated = validatePendingSnapshot(expiredSnapshot);
    expect(validated).not.toBeNull();
    expect(validated?.isExpired).toBe(true);
    expect(validated?.idempotencyKey).toBe(validSnapshot.idempotencyKey);
  });
});

describe("Phase 4B.7: Multi-Tab Safety, Reconciliation, and Conflict Simulator", () => {
  class MockStorage {
    private store = new Map<string, string>();
    getItem(k: string) {
      return this.store.get(k) ?? null;
    }
    setItem(k: string, v: string) {
      this.store.set(k, String(v));
    }
    removeItem(k: string) {
      this.store.delete(k);
    }
    clear() {
      this.store.clear();
    }
  }

  class FullPhase4B7Simulator {
    localStorage = new MockStorage();
    sessionStorage = new MockStorage();
    checkoutState: string = "READY";
    pendingAttempt: any = null;
    cart: Array<{ menuItemId: string; name: string; unitPrice: number; quantity: number }> = [];
    methodId = "pm-cash";
    customerName = "";
    reference = "";
    tableNumber = "";
    requestsMade: Array<{ key: string; payload: any }> = [];

    addItem(menuItemId: string, name: string, unitPrice: number) {
      if (this.checkoutState === "PENDING_VERIFICATION" || this.checkoutState === "SUBMITTING") {
        throw new Error("MUTATION_BLOCKED");
      }
      this.cart.push({ menuItemId, name, unitPrice, quantity: 1 });
    }

    changeQty(menuItemId: string, delta: number) {
      if (this.checkoutState === "PENDING_VERIFICATION" || this.checkoutState === "SUBMITTING") {
        throw new Error("MUTATION_BLOCKED");
      }
      const it = this.cart.find((i) => i.menuItemId === menuItemId);
      if (it) it.quantity += delta;
    }

    clearOrder() {
      if (this.checkoutState === "PENDING_VERIFICATION" || this.checkoutState === "SUBMITTING") {
        throw new Error("MUTATION_BLOCKED");
      }
      this.cart = [];
    }

    reloadTerminal() {
      this.sessionStorage.clear();
      this.checkoutState = "READY";
      this.pendingAttempt = null;
      this.cart = [];

      let stored = this.localStorage.getItem(TEST_POS_STORAGE_KEY);
      if (!stored) {
        stored = this.sessionStorage.getItem(TEST_POS_STORAGE_KEY);
      }

      if (stored) {
        const parsed = JSON.parse(stored);
        const validated = validatePendingSnapshot(parsed);
        if (validated) {
          this.pendingAttempt = validated;
          this.checkoutState = "PENDING_VERIFICATION";
          this.cart = [...validated.items];
          this.methodId = validated.paymentMethodId;
          this.customerName = validated.customerName;
          this.reference = validated.reference;
          this.tableNumber = validated.tableNumber;
          // Stays in PENDING_VERIFICATION. Does NOT delete storage!
        } else {
          // Malformed: remains in PENDING_VERIFICATION, does NOT silently delete
          this.checkoutState = "PENDING_VERIFICATION";
          this.pendingAttempt = null;
        }
      }
    }

    async reconcileWithServer(mockStatusApi: (key: string) => Promise<{ ok: boolean; data: any }>) {
      if (!this.pendingAttempt?.idempotencyKey) return;
      const res = await mockStatusApi(this.pendingAttempt.idempotencyKey);
      if (res.ok && res.data.found) {
        this.checkoutState = "CONFIRMED_SUCCESS";
        this.localStorage.removeItem(TEST_POS_STORAGE_KEY);
        this.sessionStorage.removeItem(TEST_POS_STORAGE_KEY);
        this.pendingAttempt = null;
        this.cart = [];
        this.checkoutState = "READY";
        return { reconciled: true, details: res.data };
      }
      if (res.ok && !res.data.found) {
        return { reconciled: false, notFound: true };
      }
      return { reconciled: false, error: "SERVER_ERROR" };
    }

    dismissVerifiedFailure() {
      this.localStorage.removeItem(TEST_POS_STORAGE_KEY);
      this.sessionStorage.removeItem(TEST_POS_STORAGE_KEY);
      this.pendingAttempt = null;
      this.cart = [];
      this.checkoutState = "READY";
    }

    async submit(mockApi: (key: string, payload: any) => Promise<{ ok: boolean; status: number; body?: any }>) {
      if (this.checkoutState === "SUBMITTING") {
        return { rejected: "IN_FLIGHT" };
      }

      // Terminal-wide multi-tab check: Ensure no other checkout is active
      if (!this.pendingAttempt) {
        const existingRaw = this.localStorage.getItem(TEST_POS_STORAGE_KEY);
        if (existingRaw) {
          const validated = validatePendingSnapshot(JSON.parse(existingRaw));
          if (validated) {
            this.pendingAttempt = validated;
            this.checkoutState = "PENDING_VERIFICATION";
            return { rejected: "ANOTHER_TAB_PENDING_ON_TERMINAL" };
          }
        }
      }

      if (this.checkoutState === "PENDING_VERIFICATION" && !this.pendingAttempt) {
        return { error: "CANNOT_PROCEED_WITHOUT_VERIFICATION" };
      }

      this.checkoutState = "SUBMITTING";

      let activeSnapshot = this.pendingAttempt;
      if (!activeSnapshot) {
        activeSnapshot = {
          hotelId: "hotel-a",
          operation: "PAY_NOW" as const,
          idempotencyKey: crypto.randomUUID(),
          items: [...this.cart],
          paymentMethodId: this.methodId,
          customerName: this.customerName,
          reference: this.reference,
          tableNumber: this.tableNumber,
          timestamp: Date.now(),
        };
        this.pendingAttempt = activeSnapshot;
        const serialized = JSON.stringify(activeSnapshot);
        this.localStorage.setItem(TEST_POS_STORAGE_KEY, serialized);
        this.sessionStorage.setItem(TEST_POS_STORAGE_KEY, serialized);
      }

      this.requestsMade.push({
        key: activeSnapshot.idempotencyKey,
        payload: { ...activeSnapshot },
      });

      try {
        const res = await mockApi(activeSnapshot.idempotencyKey, activeSnapshot);

        if (res.ok) {
          this.checkoutState = "CONFIRMED_SUCCESS";
          this.localStorage.removeItem(TEST_POS_STORAGE_KEY);
          this.sessionStorage.removeItem(TEST_POS_STORAGE_KEY);
          this.pendingAttempt = null;
          this.cart = [];
          this.checkoutState = "READY";
          return { success: true, body: res.body };
        }

        if (res.status === 400 || res.status === 403) {
          this.checkoutState = "CONFIRMED_FAILURE";
          this.localStorage.removeItem(TEST_POS_STORAGE_KEY);
          this.sessionStorage.removeItem(TEST_POS_STORAGE_KEY);
          this.pendingAttempt = null;
          this.checkoutState = "READY";
          return { error: res.body?.error || "Validation failure" };
        }

        if (res.status === 409) {
          if (
            res.body?.code === "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD" ||
            (res.body?.error && res.body.error.includes("different order details"))
          ) {
            // Task 1.2: Do NOT clear storage! Preserve attempt in PENDING_VERIFICATION
            this.checkoutState = "PENDING_VERIFICATION";
            activeSnapshot.status = "PAYLOAD_MISMATCH";
            this.localStorage.setItem(TEST_POS_STORAGE_KEY, JSON.stringify(activeSnapshot));
            return { error: res.body.error, preserved: true };
          }

          if (res.body?.code === "DATABASE_UNIQUE_CONSTRAINT_CONFLICT") {
            // Unrelated unique constraint violation: definitive rollback
            this.checkoutState = "CONFIRMED_FAILURE";
            this.localStorage.removeItem(TEST_POS_STORAGE_KEY);
            this.sessionStorage.removeItem(TEST_POS_STORAGE_KEY);
            this.pendingAttempt = null;
            this.checkoutState = "READY";
            return { error: res.body?.error || "Database unique constraint conflict" };
          }

          // Concurrent submission or race: stays in PENDING_VERIFICATION
          this.checkoutState = "PENDING_VERIFICATION";
          return { error: res.body?.error || "UNCERTAIN_OUTCOME" };
        }

        this.checkoutState = "PENDING_VERIFICATION";
        return { error: "UNCERTAIN_OUTCOME" };
      } catch (networkErr) {
        this.checkoutState = "PENDING_VERIFICATION";
        return { error: "NETWORK_ERROR" };
      }
    }
  }

  it("1. Expired snapshots survive reload without silently unlocking checkout to READY", async () => {
    const pos = new FullPhase4B7Simulator();
    pos.addItem("item-1", "Burger", 500);

    // Initial submit times out
    await pos.submit(async () => {
      throw new Error("Network timeout");
    });
    expect(pos.checkoutState).toBe("PENDING_VERIFICATION");

    // Manually backdate snapshot timestamp to 26 hours ago (expired)
    const stored = JSON.parse(pos.localStorage.getItem(TEST_POS_STORAGE_KEY)!);
    stored.timestamp = Date.now() - (26 * 60 * 60 * 1000);
    pos.localStorage.setItem(TEST_POS_STORAGE_KEY, JSON.stringify(stored));

    // Reload 1 (e.g. next morning)
    pos.reloadTerminal();
    expect(pos.checkoutState).toBe("PENDING_VERIFICATION");
    expect(pos.pendingAttempt).not.toBeNull();
    expect(pos.pendingAttempt.isExpired).toBe(true);

    // Reload 2 (pressing F5 again)
    pos.reloadTerminal();
    // MUST STILL BE LOCKED! Must NOT have silently cleared to READY!
    expect(pos.checkoutState).toBe("PENDING_VERIFICATION");
    expect(pos.pendingAttempt).not.toBeNull();
    expect(() => pos.addItem("item-2", "Soda", 100)).toThrow("MUTATION_BLOCKED");
  });

  it("2. IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD preserves original attempt and locks checkout", async () => {
    const pos = new FullPhase4B7Simulator();
    pos.addItem("item-1", "Burger", 500);

    // Initial submission has uncertain network outcome
    await pos.submit(async () => {
      throw new Error("Timeout");
    });
    const key = pos.pendingAttempt.idempotencyKey;

    // Retry hits payload mismatch (server already has payment recorded with different details)
    const res = await pos.submit(async () => ({
      ok: false,
      status: 409,
      body: {
        error: "Idempotency key was previously used with different order details.",
        code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
      },
    }));

    // Must preserve attempt and remain locked in PENDING_VERIFICATION!
    expect(res.preserved).toBe(true);
    expect(pos.checkoutState).toBe("PENDING_VERIFICATION");
    expect(pos.pendingAttempt).not.toBeNull();
    expect(pos.pendingAttempt.idempotencyKey).toBe(key);
    expect(pos.localStorage.getItem(TEST_POS_STORAGE_KEY)).not.toBeNull();
    expect(() => pos.addItem("item-2", "Soda", 100)).toThrow("MUTATION_BLOCKED");
  });

  it("3. Terminal-wide multi-tab check blocks Tab 2 while Tab 1 has an unresolved checkout", async () => {
    const sharedStorage = new MockStorage();

    // Tab 1 creates an unresolved checkout
    const tab1 = new FullPhase4B7Simulator();
    tab1.localStorage = sharedStorage;
    tab1.addItem("item-1", "Burger", 500);
    await tab1.submit(async () => {
      throw new Error("Connection reset");
    });
    expect(tab1.checkoutState).toBe("PENDING_VERIFICATION");

    // Tab 2 is opened on the same workstation
    const tab2 = new FullPhase4B7Simulator();
    tab2.localStorage = sharedStorage;
    tab2.addItem("item-2", "Pizza", 1200);

    // Tab 2 attempts to submit checkout
    const tab2Res = await tab2.submit(async () => ({ ok: true, status: 201 }));

    // Tab 2 must be rejected because Tab 1's unresolved attempt is active on terminal
    expect(tab2Res.rejected).toBe("ANOTHER_TAB_PENDING_ON_TERMINAL");
    expect(tab2.checkoutState).toBe("PENDING_VERIFICATION");
    // Tab 1's snapshot in shared storage was NOT overwritten!
    const activeStored = JSON.parse(sharedStorage.getItem(TEST_POS_STORAGE_KEY)!);
    expect(activeStored.items[0].name).toBe("Burger");
  });

  it("4. Server reconciliation confirms payment, clears storage, and unblocks POS", async () => {
    const pos = new FullPhase4B7Simulator();
    pos.addItem("item-1", "Burger", 500);

    // Timeout occurs
    await pos.submit(async () => {
      throw new Error("Timeout");
    });
    expect(pos.checkoutState).toBe("PENDING_VERIFICATION");

    // Cashier triggers server reconciliation
    const reconRes = await pos.reconcileWithServer(async (key) => ({
      ok: true,
      data: {
        found: true,
        status: "COMPLETED",
        total: 500,
        guestName: "Jane Doe",
        method: "Cash",
      },
    }));

    expect(reconRes?.reconciled).toBe(true);
    expect(pos.checkoutState).toBe("READY");
    expect(pos.pendingAttempt).toBeNull();
    expect(pos.localStorage.getItem(TEST_POS_STORAGE_KEY)).toBeNull();
  });

  it("5. Server reconciliation confirms payment was NOT recorded: allows safe cashier dismissal", async () => {
    const pos = new FullPhase4B7Simulator();
    pos.addItem("item-1", "Burger", 500);

    await pos.submit(async () => {
      throw new Error("Timeout");
    });
    expect(pos.checkoutState).toBe("PENDING_VERIFICATION");

    // Server says record does NOT exist
    const reconRes = await pos.reconcileWithServer(async () => ({
      ok: true,
      data: { found: false, status: "NOT_FOUND" },
    }));

    expect(reconRes?.reconciled).toBe(false);
    expect(reconRes?.notFound).toBe(true);

    // Cashier safely dismisses verified failure
    pos.dismissVerifiedFailure();
    expect(pos.checkoutState).toBe("READY");
    expect(pos.pendingAttempt).toBeNull();
    expect(pos.localStorage.getItem(TEST_POS_STORAGE_KEY)).toBeNull();
  });

  it("6. Unrelated database unique constraint violation clears storage and unlocks without false success", async () => {
    const pos = new FullPhase4B7Simulator();
    pos.addItem("item-1", "Burger", 500);

    const res = await pos.submit(async () => ({
      ok: false,
      status: 409,
      body: {
        error: "A unique record constraint violation occurred. Please verify your records.",
        code: "DATABASE_UNIQUE_CONSTRAINT_CONFLICT",
      },
    }));

    expect(pos.checkoutState).toBe("READY");
    expect(pos.pendingAttempt).toBeNull();
    expect(pos.localStorage.getItem(TEST_POS_STORAGE_KEY)).toBeNull();
    expect(res.error).toContain("unique record constraint violation");
    expect(() => pos.addItem("item-2", "Soda", 100)).not.toThrow();
  });
});
