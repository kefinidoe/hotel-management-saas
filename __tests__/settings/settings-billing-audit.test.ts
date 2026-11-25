import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks must be declared before the modules under test are imported.
// ---------------------------------------------------------------------------

class CustomNextResponse extends Response {
  static json(data: any, init?: ResponseInit) {
    return new CustomNextResponse(JSON.stringify(data), {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
  }
}

vi.doMock("server-only", () => ({}));
vi.doMock("next/server", () => ({ NextResponse: CustomNextResponse }));

let mockTenant: any = null;
vi.doMock("@/lib/authz", () => ({
  getTenantFromRoute: async () =>
    mockTenant ??
    CustomNextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 }),
  requireRole: (role: string, allowed: readonly string[]) =>
    allowed.includes(role)
      ? null
      : CustomNextResponse.json({ error: "FORBIDDEN" }, { status: 403 }),
  ROLE_GROUPS: { STAFF_ADMIN: ["HOTEL_OWNER", "HOTEL_ADMIN"] },
}));

interface HotelRow {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  currency: string;
  timezone: string;
  status: string;
}
interface SubRow {
  id: string;
  hotelId: string;
  planId: string;
  status: string;
  billingInterval: string;
  amount: number;
  currency: string;
}

let hotels: Map<string, HotelRow>;
let subscriptions: Map<string, SubRow>;
let auditRows: any[];
let auditWritesFail: boolean;
let subscriptionReadsFail: boolean;
let mockPrisma: any;

function resetState() {
  hotels = new Map();
  hotels.set("hotel-alpha", {
    id: "hotel-alpha",
    name: "Alpha Resort",
    slug: "alpha-resort",
    email: "alpha@example.com",
    phone: null,
    address: null,
    currency: "KES",
    timezone: "UTC",
    status: "ACTIVE",
  });
  subscriptions = new Map();
  subscriptions.set("hotel-alpha", {
    id: "sub-alpha",
    hotelId: "hotel-alpha",
    planId: "BAND_1_10",
    status: "ACTIVE",
    billingInterval: "MONTHLY",
    amount: 3000,
    currency: "KES",
  });
  auditRows = [];
  auditWritesFail = false;
  subscriptionReadsFail = false;
}

function buildPrisma() {
  const client: any = {
    hotel: {
      findUnique: async ({ where }: any) => {
        const row = hotels.get(where.id);
        return row ? { ...row } : null;
      },
      update: async ({ where, data }: any) => {
        const row = hotels.get(where.id);
        if (!row) throw new Error("Hotel not found");
        const updated = { ...row, ...data };
        hotels.set(where.id, updated);
        return { ...updated };
      },
    },
    subscription: {
      findUnique: async ({ where }: any) => {
        if (subscriptionReadsFail) throw new Error("connection reset");
        const row = subscriptions.get(where.hotelId);
        return row ? { ...row } : null;
      },
      update: async ({ where, data }: any) => {
        const row = subscriptions.get(where.hotelId);
        if (!row) throw new Error("Subscription not found");
        const updated = { ...row, ...data };
        subscriptions.set(where.hotelId, updated);
        return { ...updated };
      },
    },
    auditLog: {
      create: async ({ data }: any) => {
        if (auditWritesFail) throw new Error("audit table unavailable");
        auditRows.push(data);
        return { id: `audit-${auditRows.length}`, ...data };
      },
    },
  };
  client.$transaction = async (fn: any) => {
    const previousHotels = structuredClone(hotels);
    const previousSubscriptions = structuredClone(subscriptions);
    const previousAudits = structuredClone(auditRows);
    try {
      return await fn(client);
    } catch (error) {
      hotels = previousHotels;
      subscriptions = previousSubscriptions;
      auditRows = previousAudits;
      throw error;
    }
  };
  return client;
}

vi.doMock("@/lib/prisma", () => ({
  get prisma() {
    return mockPrisma;
  },
}));

// ---------------------------------------------------------------------------

const { normaliseBillingCurrency, priceForSubscription, SUBSCRIPTION_PLANS } = await import(
  "@/lib/plans"
);
const { recordAudit } = await import("@/lib/audit");
const settingsRoute = await import("@/app/api/hotel/settings/route");

function patch(body: unknown) {
  return settingsRoute.PATCH(
    new Request("http://localhost:3000/api/hotel/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );
}

const band = SUBSCRIPTION_PLANS["BAND_1_10"];

beforeEach(() => {
  resetState();
  mockPrisma = buildPrisma();
  mockTenant = { hotelId: "hotel-alpha", userId: "user-owner", role: "HOTEL_OWNER" };
});

describe("billing currency helpers", () => {
  it("maps every operation currency onto the two billed currencies", () => {
    expect(normaliseBillingCurrency("KES")).toBe("KES");
    expect(normaliseBillingCurrency("usd")).toBe("USD");
    expect(normaliseBillingCurrency("EUR")).toBe("KES");
    expect(normaliseBillingCurrency("GBP")).toBe("KES");
    expect(normaliseBillingCurrency(null)).toBe("KES");
  });

  it("prices a plan in the currency it is billed in, per interval", () => {
    expect(
      priceForSubscription({ planId: "BAND_1_10", currency: "KES", billingInterval: "MONTHLY" })
    ).toBe(band.monthlyPriceKES);
    expect(
      priceForSubscription({ planId: "band_1_10", currency: "USD", billingInterval: "MONTHLY" })
    ).toBe(band.monthlyPriceUSD);
    expect(
      priceForSubscription({ planId: "BAND_1_10", currency: "USD", billingInterval: "YEARLY" })
    ).toBe(band.yearlyPriceUSD);
    expect(
      priceForSubscription({ planId: "BAND_1_10", currency: "EUR", billingInterval: "MONTHLY" })
    ).toBe(band.monthlyPriceKES);
  });

  it("never invents a price for an unknown or custom-quote plan", () => {
    expect(priceForSubscription({ planId: "NOT_A_PLAN", currency: "KES" })).toBeNull();
    expect(priceForSubscription({ planId: "BAND_201_PLUS", currency: "USD" })).toBeNull();
  });
});

describe("PATCH /api/hotel/settings — billing consistency", () => {
  it("re-prices the subscription when the operation currency crosses KES/USD", async () => {
    const res = await patch({ currency: "USD" });
    expect(res.status).toBe(200);

    const sub = subscriptions.get("hotel-alpha")!;
    expect(sub.currency).toBe("USD");
    expect(sub.amount).toBe(band.monthlyPriceUSD);

    const data = await res.json();
    expect(data.subscriptionRepriced).toEqual({
      currency: "USD",
      amount: band.monthlyPriceUSD,
    });
  });

  it("updates the billing currency even when the numeric amounts happen to match", async () => {
    subscriptions.get("hotel-alpha")!.amount = band.monthlyPriceUSD;
    const res = await patch({ currency: "USD" });
    expect(res.status).toBe(200);
    expect(subscriptions.get("hotel-alpha")).toMatchObject({ currency: "USD", amount: band.monthlyPriceUSD });
  });

  it("leaves the subscription alone when the billed currency does not change", async () => {
    // alpha is billed in KES; switching operations to EUR must not re-denominate
    // the bill into a currency the price schedule does not publish.
    const res = await patch({ currency: "EUR" });
    expect(res.status).toBe(200);

    const sub = subscriptions.get("hotel-alpha")!;
    expect(sub.currency).toBe("KES");
    expect(sub.amount).toBe(3000);
    const data = await res.json();
    expect(data.subscriptionRepriced).toBeUndefined();
  });

  it("keeps the stored amount when it already matches the target currency", async () => {
    subscriptions.set("hotel-alpha", {
      ...subscriptions.get("hotel-alpha")!,
      currency: "USD",
      amount: band.monthlyPriceUSD,
    });
    hotels.get("hotel-alpha")!.currency = "USD";

    const res = await patch({ currency: "USD" });
    expect(res.status).toBe(200);
    expect((await res.json()).subscriptionRepriced).toBeUndefined();
  });

  it("writes a hotel-scoped audit row describing the change", async () => {
    await patch({ currency: "USD", name: "Alpha Grand" });

    expect(auditRows).toHaveLength(1);
    const row = auditRows[0];
    expect(row.hotelId).toBe("hotel-alpha");
    expect(row.userId).toBe("user-owner");
    expect(row.action).toBe("HOTEL_SETTINGS_UPDATED");
    expect(row.entity).toBe("HOTEL");
    expect(row.metadata.previousCurrency).toBe("KES");
    expect(row.metadata.newCurrency).toBe("USD");
    expect(row.metadata.fields).toEqual(expect.arrayContaining(["currency", "name"]));
    expect(row.metadata.subscriptionRepriced).toEqual({
      currency: "USD",
      amount: band.monthlyPriceUSD,
    });
  });

  it("does not change any billing state when the caller is not a hotel admin", async () => {
    mockTenant = { hotelId: "hotel-alpha", userId: "user-receptionist", role: "RECEPTIONIST" };
    const res = await patch({ currency: "USD" });
    expect(res.status).toBe(403);
    expect(hotels.get("hotel-alpha")!.currency).toBe("KES");
    expect(subscriptions.get("hotel-alpha")!.currency).toBe("KES");
    expect(auditRows).toHaveLength(0);
  });

  it("fails the request rather than silently diverging when the subscription cannot be read", async () => {
    subscriptionReadsFail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await patch({ currency: "USD" });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(hotels.get("hotel-alpha")!.currency).toBe("KES");
    expect((await res.json()).error).toMatch(/could not save/i);
  });

  it("rolls back the hotel and subscription changes when the audit write fails", async () => {
    auditWritesFail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await patch({ currency: "USD", name: "Alpha Grand" });
    expect(res.status).toBe(500);
    expect(hotels.get("hotel-alpha")).toMatchObject({ currency: "KES", name: "Alpha Resort" });
    expect(subscriptions.get("hotel-alpha")).toMatchObject({ currency: "KES", amount: 3000 });
    expect(auditRows).toHaveLength(0);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("recordAudit", () => {
  it("writes through the supplied transaction client", async () => {
    const wrote = await recordAudit(
      { hotelId: "hotel-alpha", userId: "u1", action: "TEST_ACTION", entity: "TEST" },
      mockPrisma
    );
    expect(wrote).toBe(true);
    expect(auditRows[0]).toMatchObject({ hotelId: "hotel-alpha", action: "TEST_ACTION" });
  });

  it("is a no-op for clients without an audit model", async () => {
    const wrote = await recordAudit(
      { hotelId: "hotel-alpha", userId: "u1", action: "TEST_ACTION", entity: "TEST" },
      { hotel: {} }
    );
    expect(wrote).toBe(false);
    expect(auditRows).toHaveLength(0);
  });

  it("never throws when the audit write fails", async () => {
    auditWritesFail = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordAudit(
        { hotelId: "hotel-alpha", userId: "u1", action: "TEST_ACTION", entity: "TEST" },
        mockPrisma
      )
    ).resolves.toBe(false);
    spy.mockRestore();
  });
});
