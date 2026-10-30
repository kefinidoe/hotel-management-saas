export const POS_CHECKOUT_LOCK_NAME = "hms_pos_checkout_lock";
export const POS_LEGACY_STORAGE_KEY = "hms_pos_pending_attempt_v1";
export const POS_TENANT_STORAGE_PREFIX = "hms_pos_pending_attempt_v2:";
export const POS_TENANT_LOCK_PREFIX = `${POS_CHECKOUT_LOCK_NAME}:tenant:`;

export function tenantPOSStorageKey(tenantId: string): string {
  if (!tenantId || tenantId.trim() !== tenantId) {
    throw new CheckoutOwnershipError("A trusted active tenant is required for POS recovery.");
  }
  return `${POS_TENANT_STORAGE_PREFIX}${encodeURIComponent(tenantId)}`;
}

export function tenantPOSLockName(tenantId: string): string {
  if (!tenantId || tenantId.trim() !== tenantId) {
    throw new CheckoutOwnershipError("A trusted active tenant is required for POS recovery.");
  }
  return `${POS_TENANT_LOCK_PREFIX}${encodeURIComponent(tenantId)}`;
}

export interface LockManagerLike {
  request<T>(
    name: string,
    options: { mode: "exclusive"; ifAvailable: true },
    callback: (lock: unknown | null) => Promise<T>,
  ): Promise<T>;
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class CheckoutOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckoutOwnershipError";
  }
}

export class CheckoutLockBusyError extends CheckoutOwnershipError {
  constructor() {
    super("Another browser tab currently owns the POS checkout lock.");
    this.name = "CheckoutLockBusyError";
  }
}

export class CheckoutTenantMismatchError extends CheckoutOwnershipError {
  constructor() {
    super("The active hotel changed. This saved checkout was preserved; refresh the dashboard in its original hotel before recovery.");
    this.name = "CheckoutTenantMismatchError";
  }
}

export class LegacyCheckoutAttemptError extends CheckoutOwnershipError {
  constructor() {
    super("An older checkout record without tenant identity was preserved. Do not submit another charge until the original attempt is verified.");
    this.name = "LegacyCheckoutAttemptError";
  }
}

/**
 * The legacy origin-wide lock is retained as an outer migration barrier so a
 * still-open older POS tab cannot race the new tenant-scoped record. The inner
 * tenant lock and storage key isolate each tenant. The shared legacy barrier
 * intentionally serializes POS transactions across tenants during mixed-version
 * deployments; separate tenant records still coexist without overwriting.
 */
export async function withPOSCheckoutOwnership<T>(
  locks: LockManagerLike | null | undefined,
  storage: StorageLike | null | undefined,
  storageKey: string,
  work: (attempts: LockedAttemptStorage) => Promise<T>,
  tenantId?: string,
): Promise<T> {
  if (!locks || typeof locks.request !== "function") {
    throw new CheckoutOwnershipError("This browser cannot safely coordinate POS recovery across tabs.");
  }
  if (!storage) {
    throw new CheckoutOwnershipError("Shared browser storage is unavailable; no checkout was sent.");
  }
  if (tenantId && storageKey !== tenantPOSStorageKey(tenantId)) {
    throw new CheckoutTenantMismatchError();
  }

  let workStarted = false;
  const lockNames = tenantId
    ? [POS_CHECKOUT_LOCK_NAME, tenantPOSLockName(tenantId)]
    : [POS_CHECKOUT_LOCK_NAME];

  const acquire = async (index: number): Promise<T> => locks.request(
    lockNames[index],
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) throw new CheckoutLockBusyError();
      if (index + 1 < lockNames.length) return acquire(index + 1);

      const lease = { active: true };
      const attempts = new LockedAttemptStorage(storage, storageKey, lease, LOCK_LEASE_TOKEN, tenantId);
      try {
        workStarted = true;
        return await work(attempts);
      } finally {
        lease.active = false;
      }
    },
  );

  try {
    return await acquire(0);
  } catch (error) {
    if (workStarted || error instanceof CheckoutOwnershipError) throw error;
    throw new CheckoutOwnershipError("Safe cross-tab checkout coordination failed; no request was sent.");
  }
}

const LOCK_LEASE_TOKEN = Symbol("POS lock lease");

export function decideStorageEvent<T>(
  current: T | null,
  latestStored: T | null,
  sameRequest: (left: T, right: T) => boolean,
): "IGNORE" | "ADOPT" | "KEEP" | "CONFLICT" {
  if (!latestStored) return "IGNORE";
  if (!current) return "ADOPT";
  return sameRequest(current, latestStored) ? "KEEP" : "CONFLICT";
}

export class LockedAttemptStorage {
  constructor(
    private readonly storage: StorageLike,
    private readonly storageKey: string,
    private readonly lease: { active: boolean },
    token: symbol,
    private readonly tenantId?: string,
  ) {
    if (token !== LOCK_LEASE_TOKEN) {
      throw new CheckoutOwnershipError("Attempt storage is available only while holding the POS checkout lock.");
    }
  }

  private assertLocked() {
    if (!this.lease.active) {
      throw new CheckoutOwnershipError("The POS checkout lock is no longer held.");
    }
  }

  private assertTenant(attempt: unknown) {
    if (!this.tenantId) return;
    if (!attempt || typeof attempt !== "object" ||
      (attempt as Record<string, unknown>).hotelId !== this.tenantId) {
      throw new CheckoutTenantMismatchError();
    }
  }

  readRaw(key = this.storageKey): string | null {
    this.assertLocked();
    try {
      return this.storage.getItem(key);
    } catch {
      throw new CheckoutOwnershipError("Could not read shared checkout recovery storage.");
    }
  }

  read<T>(validate: (value: unknown) => T | null): T | null {
    const raw = this.readRaw();
    if (raw === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new CheckoutOwnershipError("Stored checkout recovery data is malformed; no new request was sent.");
    }
    const attempt = validate(parsed);
    if (!attempt) {
      throw new CheckoutOwnershipError("Stored checkout recovery data could not be validated; no new request was sent.");
    }
    this.assertTenant(attempt);
    return attempt;
  }

  /** Claim or refresh the identical request while holding the Web Lock. */
  claim<T>(
    attempt: T,
    validate: (value: unknown) => T | null,
    sameRequest: (left: T, right: T) => boolean,
  ): boolean {
    this.assertLocked();
    this.assertTenant(attempt);
    const current = this.read(validate);
    if (current && !sameRequest(current, attempt)) return false;

    try {
      const serialized = JSON.stringify(attempt);
      if (typeof serialized !== "string") throw new Error("Attempt did not serialize.");
      this.storage.setItem(this.storageKey, serialized);
    } catch {
      throw new CheckoutOwnershipError("Could not persist the shared checkout attempt; no request was sent.");
    }

    const saved = this.read(validate);
    return Boolean(saved && sameRequest(saved, attempt));
  }

  /**
   * Compare-and-remove is safe only while the exclusive cross-tab lock is held.
   * The stored and requested attempts must also match the bound tenant.
   */
  clearIfOwned<T>(
    attempt: T,
    validate: (value: unknown) => T | null,
    sameRequest: (left: T, right: T) => boolean,
  ): boolean {
    this.assertLocked();
    this.assertTenant(attempt);
    const current = this.read(validate);
    if (!current) return true;
    if (!sameRequest(current, attempt)) return false;

    try {
      this.storage.removeItem(this.storageKey);
      return true;
    } catch {
      throw new CheckoutOwnershipError("Could not clear the resolved checkout recovery record.");
    }
  }
}
