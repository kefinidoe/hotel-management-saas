import { beforeEach, describe, expect, it, vi } from "vitest";
import Decimal from "decimal.js";

const mocks = vi.hoisted(() => ({
  getTenantFromRoute: vi.fn(),
  requireRole: vi.fn(() => null),
  requireModule: vi.fn(async () => null),
  getPlatformAdminFromRoute: vi.fn(),
  validateRoomStayMutation: vi.fn(),
  recordAudit: vi.fn(async () => undefined),
  hotelFindMany: vi.fn(),
  reservationFindUnique: vi.fn(),
  reservationExtensionFindFirst: vi.fn(async () => null),
  reservationExtensionCreate: vi.fn(),
  reservationRoomFindFirst: vi.fn(async () => null),
  reservationPriceSnapshotFindFirst: vi.fn(async () => null),
  reservationUpdate: vi.fn(async () => undefined),
  roomFindUnique: vi.fn(),
  roomUpdate: vi.fn(async () => undefined),
  housekeepingTaskCreate: vi.fn(async () => undefined),
  paymentMethodFindFirst: vi.fn(),
  paymentCreate: vi.fn(),
  folioCreate: vi.fn(),
  folioUpdate: vi.fn(async () => undefined),
  folioItemCreate: vi.fn(),
  createdFolioItems: [] as Array<Record<string, unknown>>,
  createdPayments: [] as Array<Record<string, unknown>>,
  createdExtensions: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/authz", () => ({
  getTenantFromRoute: mocks.getTenantFromRoute,
  requireRole: mocks.requireRole,
  requireModule: mocks.requireModule,
  getPlatformAdminFromRoute: mocks.getPlatformAdminFromRoute,
  ROLE_GROUPS: {
    GUEST_STAYS: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER", "RECEPTIONIST"],
    MANAGEMENT: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER"],
  },
}));

vi.mock("@/lib/room-stay-mutation-validation", () => ({
  validateRoomStayMutation: mocks.validateRoomStayMutation,
}));

vi.mock("@/lib/audit", () => ({
  AuditPersistenceError: class AuditPersistenceError extends Error {},
  recordAudit: mocks.recordAudit,
}));

vi.mock("@/lib/prisma", () => {
  const tx = {
    $queryRaw: vi.fn(async () => [{ locked: "1" }]),
    reservation: {
      findUnique: mocks.reservationFindUnique,
      update: mocks.reservationUpdate,
    },
    reservationExtension: {
      findFirst: mocks.reservationExtensionFindFirst,
      create: mocks.reservationExtensionCreate,
    },
    reservationRoom: {
      findFirst: mocks.reservationRoomFindFirst,
      findMany: vi.fn(async () => []),
      update: vi.fn(async () => undefined),
    },
    reservationPriceSnapshot: {
      findFirst: mocks.reservationPriceSnapshotFindFirst,
    },
    room: {
      findUnique: mocks.roomFindUnique,
      update: mocks.roomUpdate,
    },
    housekeepingTask: {
      create: mocks.housekeepingTaskCreate,
    },
    paymentMethod: {
      findFirst: mocks.paymentMethodFindFirst,
    },
    payment: {
      create: mocks.paymentCreate,
    },
    folio: {
      create: mocks.folioCreate,
      update: mocks.folioUpdate,
    },
    folioItem: {
      create: mocks.folioItemCreate,
    },
  };

  return {
    prisma: {
      ...tx,
      hotel: {
        findMany: mocks.hotelFindMany,
      },
      $transaction: vi.fn(async (callback: (client: typeof tx) => Promise<unknown>) => callback(tx)),
    },
  };
});

import { executeCheckIn, executeCheckOut, CheckOutError } from "@/lib/stay-service";
import { POST as extendStay } from "@/app/api/reservations/[id]/extend/route";
import { GET as getPlatformSubscriptions } from "@/app/api/platform/subscriptions/route";

const tenant = {
  hotelId: "hotel-1",
  userId: "user-1",
  role: "MANAGER",
  hotel: {
    id: "hotel-1",
    name: "Decimal Lodge",
    slug: "decimal-lodge",
    currency: "USD",
    timezone: "UTC",
    status: "ACTIVE",
  },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createdFolioItems.length = 0;
  mocks.createdPayments.length = 0;
  mocks.createdExtensions.length = 0;

  mocks.getTenantFromRoute.mockResolvedValue(tenant);
  mocks.getPlatformAdminFromRoute.mockResolvedValue({ userId: "platform-1", platformRole: "PLATFORM_SUPER_ADMIN" });
  mocks.folioCreate.mockResolvedValue({ id: "folio-1" });
  mocks.folioItemCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const id = `item-${mocks.createdFolioItems.length + 1}`;
    mocks.createdFolioItems.push({ id, ...data });
    return { id, ...data };
  });
  mocks.paymentCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    mocks.createdPayments.push(data);
    return { id: `pay-${mocks.createdPayments.length}`, ...data };
  });
  mocks.reservationExtensionCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    const record = { id: "ext-1", ...data };
    mocks.createdExtensions.push(record);
    return record;
  });
  mocks.roomFindUnique.mockResolvedValue({ id: "room-1", number: "101", status: "AVAILABLE", isActive: true });
  mocks.paymentMethodFindFirst.mockResolvedValue({ id: "pm-1", name: "M-Pesa", isActive: true });
});

describe("Phase A2: Decimal precision across stay check-in, check-out, extension & MRR", () => {
  it("checks in a historical reservation without snapshot using exact Decimal room charges & discounts", async () => {
    mocks.reservationFindUnique.mockResolvedValue({
      id: "res-hist",
      hotelId: "hotel-1",
      guestId: "guest-1",
      status: "CONFIRMED",
      checkInDate: new Date("2026-11-10T00:00:00.000Z"),
      checkOutDate: new Date("2026-11-13T00:00:00.000Z"),
      discount: "5.55",
      paymentMode: null,
      rooms: [{ id: "rr-1", roomId: "room-1", rate: "19.99", room: { id: "room-1", number: "101" } }],
      folios: [],
      priceSnapshots: [],
    });

    const result = await executeCheckIn(tenant, {
      reservationId: "res-hist",
      amountPaid: 0.12,
      paymentMethodId: "pm-1",
    });

    expect(result).toEqual({
      folioId: "folio-1",
      required: 54.42,
      paid: 0.12,
      balance: 54.3,
    });
    expect(mocks.createdFolioItems).toHaveLength(2);
    expect(mocks.createdFolioItems[0].total).toBe(59.97);
    expect(mocks.createdFolioItems[1].total).toBe(-5.55);
  });

  it("checks in a reservation with a frozen fractional snapshot cleanly", async () => {
    mocks.reservationFindUnique.mockResolvedValue({
      id: "res-snap",
      hotelId: "hotel-1",
      guestId: "guest-1",
      status: "CONFIRMED",
      checkInDate: new Date("2026-11-10T00:00:00.000Z"),
      checkOutDate: new Date("2026-11-12T00:00:00.000Z"),
      discount: "0",
      paymentMode: null,
      rooms: [{ id: "rr-1", roomId: "room-1", rate: "33.33", room: { id: "room-1", number: "101" } }],
      folios: [],
      priceSnapshots: [
        {
          id: "snap-1",
          version: 1,
          roomTotal: "66.66",
          adjustmentsTotal: "10.04",
          discountTotal: "5.00",
          grandTotal: "100.35",
          breakdown: {
            lines: [
              { kind: "ROOM", label: "Room 101", amount: 66.66, quantity: 2, unitPrice: 33.33 },
              { kind: "MEAL", label: "Breakfast", amount: 20.05, quantity: 2, unitPrice: 10.025 },
              { kind: "TAX", label: "Tourism VAT", amount: 8.6, quantity: 1, unitPrice: 8.6 },
              { kind: "TAX", label: "City Levy (included)", amount: 1.5, quantity: 1, unitPrice: 1.5 },
            ],
          },
        },
      ],
    });

    const result = await executeCheckIn(tenant, {
      reservationId: "res-snap",
      amountPaid: 33.45,
      paymentMethodId: "pm-1",
    });

    expect(result).toEqual({
      folioId: "folio-1",
      required: 100.35,
      paid: 33.45,
      balance: 66.9,
    });
  });

  it("avoids binary float balance drift at check-out (0.10 + 0.20 vs 0.30)", async () => {
    mocks.reservationFindUnique.mockResolvedValue({
      id: "res-out",
      hotelId: "hotel-1",
      status: "CHECKED_IN",
      rooms: [{ roomId: "room-1" }],
      folios: [
        {
          id: "folio-1",
          isClosed: false,
          items: [{ total: "0.10" }, { total: "0.20" }],
          payments: [{ amount: "0.30" }],
        },
      ],
    });

    const result = await executeCheckOut(tenant, { reservationId: "res-out" });
    expect(result).toEqual({
      folioId: "folio-1",
      required: 0.3,
      paid: 0.3,
      balance: 0,
    });

    mocks.reservationFindUnique.mockResolvedValueOnce({
      id: "res-out-due",
      hotelId: "hotel-1",
      status: "CHECKED_IN",
      rooms: [{ roomId: "room-1" }],
      folios: [
        {
          id: "folio-1",
          isClosed: false,
          items: [{ total: "0.10" }, { total: "0.20" }],
          payments: [{ amount: "0.29" }],
        },
      ],
    });

    await expect(executeCheckOut(tenant, { reservationId: "res-out-due" })).rejects.toThrow(CheckOutError);
  });

  it("extends a stay with fractional nightly rates and existing folio pennies without drift", async () => {
    mocks.validateRoomStayMutation.mockResolvedValue({
      response: null,
      data: { checkOutDate: "2026-11-16T00:00:00.000Z", note: "Extended stay" },
    });
    mocks.reservationFindUnique.mockResolvedValue({
      id: "res-ext",
      hotelId: "hotel-1",
      status: "CHECKED_IN",
      checkInDate: new Date("2026-11-10T00:00:00.000Z"),
      checkOutDate: new Date("2026-11-13T00:00:00.000Z"),
      rooms: [
        {
          roomId: "room-1",
          rate: new Decimal("19.99"),
          room: { id: "room-1", number: "101", roomTypeId: "rt-1" },
        },
      ],
      folios: [
        {
          id: "folio-1",
          items: [{ total: "0.10" }, { total: "0.20" }],
          payments: [{ amount: "0.07" }],
        },
      ],
    });

    const res = await extendStay(
      new Request("http://localhost/api/reservations/res-ext/extend", { method: "POST" }),
      { params: Promise.resolve({ id: "res-ext" }) }
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.additionalNights).toBe(3);
    expect(data.additionalCharge).toBe(59.97);
    expect(data.required).toBe(60.27);
    expect(data.paid).toBe(0.07);
    expect(data.balance).toBe(60.2);
  });

  it("sums platform yearly subscriptions into exact Decimal MRR before rounding (280/12 + 280/12 = 46.67)", async () => {
    const periodEnd = new Date("2027-06-01T00:00:00.000Z");
    const periodStart = new Date("2026-06-01T00:00:00.000Z");

    mocks.hotelFindMany.mockResolvedValue([
      {
        id: "h-1",
        name: "Hotel One",
        slug: "hotel-one",
        status: "ACTIVE",
        currency: "USD",
        createdAt: periodStart,
        _count: { rooms: 5, memberships: 2 },
        subscription: {
          id: "sub-1",
          planId: "BAND_1_10",
          status: "ACTIVE",
          trialStartsAt: periodStart,
          trialEndsAt: periodEnd,
          currentPeriodStartsAt: periodStart,
          currentPeriodEndsAt: periodEnd,
          cancelAtPeriodEnd: false,
          billingInterval: "YEARLY",
          amount: "280",
          currency: "USD",
          suspensionReason: null,
        },
      },
      {
        id: "h-2",
        name: "Hotel Two",
        slug: "hotel-two",
        status: "ACTIVE",
        currency: "USD",
        createdAt: periodStart,
        _count: { rooms: 8, memberships: 3 },
        subscription: {
          id: "sub-2",
          planId: "BAND_1_10",
          status: "ACTIVE",
          trialStartsAt: periodStart,
          trialEndsAt: periodEnd,
          currentPeriodStartsAt: periodStart,
          currentPeriodEndsAt: periodEnd,
          cancelAtPeriodEnd: false,
          billingInterval: "YEARLY",
          amount: "280",
          currency: "USD",
          suspensionReason: null,
        },
      },
    ]);

    const res = await getPlatformSubscriptions(new Request("http://localhost/api/platform/subscriptions"));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.summary.mrrByCurrency.USD).toBe(46.67);
    expect(data.summary.arrByCurrency.USD).toBe(560);
  });
});
