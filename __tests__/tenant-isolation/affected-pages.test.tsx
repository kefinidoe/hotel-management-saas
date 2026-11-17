import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const groups = {
    ALL_STAFF: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER", "RECEPTIONIST", "ACCOUNTANT", "HOUSEKEEPER", "WAITER", "CASHIER", "TECHNICIAN"],
    GUEST_STAYS: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER", "RECEPTIONIST"],
    FRONT_DESK: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER", "RECEPTIONIST", "CASHIER"],
    MANAGEMENT: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER"],
    FINANCIAL_REPORTS: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER", "ACCOUNTANT"],
  };
  return {
    groups,
    // requirePageRole returns a full TenantContext in the app; the pages now read
    // the active hotel's currency from it, so the mock must supply it too.
    tenant: {
      hotelId: "hotel-a",
      userId: "user-a",
      role: "HOTEL_ADMIN",
      hotel: { id: "hotel-a", name: "Hotel A", slug: "hotel-a", currency: "KES", timezone: "Africa/Nairobi", status: "ACTIVE" },
    },
    requirePageRole: vi.fn(),
    expenseFindMany: vi.fn(),
    guestFindMany: vi.fn(),
    reservationFindMany: vi.fn(),
    roomFindMany: vi.fn(),
    roomTypeFindMany: vi.fn(),
    inventoryItemFindMany: vi.fn(),
    stockMovementFindMany: vi.fn(),
    purchaseFindMany: vi.fn(),
  };
});

vi.mock("@/lib/page-auth", () => ({ requirePageRole: mocks.requirePageRole }));
vi.mock("@/lib/permissions", () => ({
  ROLE_GROUPS: mocks.groups,
  hasRole: (role: string, allowed: string[]) => allowed.includes(role),
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    expense: { findMany: mocks.expenseFindMany },
    guest: { findMany: mocks.guestFindMany },
    reservation: { findMany: mocks.reservationFindMany },
    room: { findMany: mocks.roomFindMany },
    roomType: { findMany: mocks.roomTypeFindMany },
    inventoryItem: { findMany: mocks.inventoryItemFindMany },
    stockMovement: { findMany: mocks.stockMovementFindMany },
    purchase: { findMany: mocks.purchaseFindMany },
  },
}));
vi.mock("@/components/expenses/ExpensesClient", () => ({ default: () => null }));
vi.mock("@/components/guests/GuestsClient", () => ({ default: () => null }));
vi.mock("@/components/frontdesk/FrontDeskClient", () => ({ default: () => null }));
vi.mock("@/components/inventory/InventoryClient", () => ({ default: () => null }));
vi.mock("@/components/rooms/RoomsClient", () => ({ default: () => null }));
vi.mock("@/components/reservations/ReservationsClient", () => ({ default: () => null }));
vi.mock("@/lib/room-status", () => ({ isBookableToday: () => true }));
vi.mock("@/lib/billing", () => ({
  accommodationRequired: () => 100,
  folioTotals: () => ({ required: 100, paid: 0, balance: 100 }),
  roundMoney: (value: number) => value,
  stayNights: () => 1,
}));
vi.mock("@/lib/inventory", () => ({ getStockStatus: () => "IN_STOCK" }));

import ExpensesPage from "@/app/dashboard/expenses/page";
import GuestsPage from "@/app/dashboard/guests/page";
import FrontDeskPage from "@/app/dashboard/front-desk/page";
import InventoryPage from "@/app/dashboard/inventory/page";
import RoomsPage from "@/app/dashboard/rooms/page";
import ReservationsPage from "@/app/dashboard/reservations/page";

function byHotel<T extends { hotelId: string }>(rows: T[], args: any): T[] {
  const hotelId = args?.where?.hotelId;
  return hotelId ? rows.filter((row) => row.hotelId === hotelId) : rows;
}

function reservation(hotelId: string, id: string, roomHotelId = hotelId) {
  return {
    id,
    hotelId,
    code: id,
    status: "CHECKED_IN",
    checkInDate: new Date("2026-10-01T12:00:00.000Z"),
    checkOutDate: new Date("2027-10-02T12:00:00.000Z"),
    discount: null,
    guest: { fullName: `${hotelId} guest` },
    rooms: [
      {
        roomId: `${roomHotelId}-room`,
        rate: 100,
        room: {
          id: `${roomHotelId}-room`,
          hotelId: roomHotelId,
          number: roomHotelId === "hotel-a" ? "A-1" : "B-1",
          floor: "1",
          status: "OCCUPIED",
          roomType: { name: `${roomHotelId} type`, baseRate: 100 },
        },
      },
    ],
    folios: [
      { id: `${hotelId}-folio`, hotelId, isClosed: false, items: [], payments: [] },
      { id: "foreign-folio", hotelId: "hotel-b", isClosed: false, items: [], payments: [] },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant = {
    hotelId: "hotel-a",
    userId: "user-a",
    role: "HOTEL_ADMIN",
    hotel: { id: "hotel-a", name: "Hotel A", slug: "hotel-a", currency: "KES", timezone: "Africa/Nairobi", status: "ACTIVE" },
  };
  mocks.requirePageRole.mockImplementation(async (allowed: string[]) => {
    if (!allowed.includes(mocks.tenant.role)) throw new Error("page authorization denied");
    return mocks.tenant;
  });
});

describe("affected server pages (Prisma mocked; page functions executed)", () => {
  it("scopes expenses and requester identity to the active hotel", async () => {
    const rows = [
      { id: "expense-a", hotelId: "hotel-a", category: "A", description: "A expense", amount: 10, paymentMethod: "Cash", supplier: null, reference: null, status: "APPROVED", createdAt: new Date(), requestedBy: { name: "A requester", memberships: [{ id: "membership-a", hotelId: "hotel-a" }] } },
      { id: "expense-a-old-user", hotelId: "hotel-a", category: "A", description: "A former request", amount: 5, paymentMethod: "Cash", supplier: null, reference: null, status: "APPROVED", createdAt: new Date(), requestedBy: { name: "B secret requester", memberships: [{ id: "membership-b", hotelId: "hotel-b" }] } },
      { id: "expense-b", hotelId: "hotel-b", category: "B", description: "B secret expense", amount: 99, paymentMethod: "Cash", supplier: null, reference: null, status: "APPROVED", createdAt: new Date(), requestedBy: { name: "B requester", memberships: [{ id: "membership-b", hotelId: "hotel-b" }] } },
    ];
    mocks.expenseFindMany.mockImplementation(async (args) => {
      const membershipsHotelId = args.include.requestedBy.select.memberships.where.hotelId;
      return byHotel(rows, args).map((expense: any) => ({
        ...expense,
        requestedBy: {
          ...expense.requestedBy,
          memberships: expense.requestedBy.memberships.filter((membership: any) => membership.hotelId === membershipsHotelId),
        },
      }));
    });

    const wrapper = (await ExpensesPage()) as any;
    expect(wrapper.props.hotelId).toBe("hotel-a");
    expect(wrapper.props.actorId).toBe("user-a");
    const element = wrapper.props.children;

    expect(mocks.requirePageRole).toHaveBeenCalledWith(mocks.groups.ALL_STAFF, "EXPENSES");
    expect(mocks.expenseFindMany.mock.calls[0][0].where).toEqual({ hotelId: "hotel-a" });
    expect(element.props.initialExpenses.map((item: any) => item.id)).toEqual(["expense-a", "expense-a-old-user"]);
    expect(element.props.initialExpenses[1].requestedByName).toBe("Former staff");
    expect(JSON.stringify(element.props)).not.toContain("B secret");
  });

  it("scopes guests, nested reservations, and nested room links", async () => {
    const guestA = {
      id: "guest-a", hotelId: "hotel-a", fullName: "Guest A", phone: null, email: null,
      isArchived: false, createdAt: new Date(), reservations: [
        { ...reservation("hotel-a", "stay-a"), rooms: [{ room: { hotelId: "hotel-a", number: "A-1" } }] },
        { ...reservation("hotel-b", "stay-b"), rooms: [{ room: { hotelId: "hotel-b", number: "B-1" } }] },
      ],
    };
    const guestB = { ...guestA, id: "guest-b", hotelId: "hotel-b", fullName: "Guest B" };
    mocks.guestFindMany.mockImplementation(async (args) => {
      const rows = byHotel([guestA, guestB], args);
      const nestedHotelId = args?.include?.reservations?.where?.hotelId;
      const roomHotelId = args?.include?.reservations?.include?.rooms?.where?.room?.is?.hotelId;
      return rows.map((guest) => ({
        ...guest,
        reservations: guest.reservations
          .filter((stay: any) => !nestedHotelId || stay.hotelId === nestedHotelId)
          .map((stay: any) => ({
            ...stay,
            rooms: stay.rooms.filter((link: any) => !roomHotelId || link.room.hotelId === roomHotelId),
          })),
      }));
    });

    const element = (await GuestsPage()) as any;

    const query = mocks.guestFindMany.mock.calls[0][0];
    expect(query.where.hotelId).toBe("hotel-a");
    expect(query.include.reservations.where).toEqual({ hotelId: "hotel-a" });
    expect(query.include.reservations.include.rooms.where).toEqual({ room: { is: { hotelId: "hotel-a" } } });
    expect(element.props.initialGuests.map((guest: any) => guest.id)).toEqual(["guest-a"]);
    expect(element.props.initialGuests[0].currentRoom).toBe("A-1");
  });

  it("scopes front-desk reservations, related rooms/folios, and room inventory", async () => {
    const rows = [reservation("hotel-a", "stay-a", "hotel-b"), reservation("hotel-b", "stay-b")];
    mocks.reservationFindMany.mockImplementation(async (args) => {
      const selected = byHotel(rows, args);
      const relationHotelId = args?.include?.rooms?.where?.room?.is?.hotelId;
      const folioHotelId = args?.include?.folios?.where?.hotelId;
      return selected.map((stay: any) => ({
        ...stay,
        rooms: stay.rooms.filter((link: any) => !relationHotelId || link.room.hotelId === relationHotelId),
        folios: stay.folios.filter((folio: any) => !folioHotelId || folio.hotelId === folioHotelId),
      }));
    });
    const roomRows = [
      { id: "room-a", hotelId: "hotel-a", number: "A-1", floor: "1", status: "AVAILABLE", roomType: { name: "A type", baseRate: 100 } },
      { id: "room-b", hotelId: "hotel-b", number: "B-1", floor: "1", status: "AVAILABLE", roomType: { name: "B type", baseRate: 100 } },
    ];
    const roomTypes = [
      { id: "type-a", hotelId: "hotel-a", name: "A type", baseRate: 100, mealPlan: "BED_ONLY" },
      { id: "type-b", hotelId: "hotel-b", name: "B secret type", baseRate: 900, mealPlan: "FULL_BOARD" },
    ];
    mocks.roomFindMany.mockImplementation(async (args) => byHotel(roomRows, args));
    mocks.roomTypeFindMany.mockImplementation(async (args) => byHotel(roomTypes, args));

    const element = (await FrontDeskPage()) as any;
    const reservationQuery = mocks.reservationFindMany.mock.calls[0][0];
    expect(element.props.activeTenantId).toBe("hotel-a");
    expect(reservationQuery.where.hotelId).toBe("hotel-a");
    expect(reservationQuery.include.rooms.where.room.is.hotelId).toBe("hotel-a");
    expect(reservationQuery.include.folios.where).toEqual({ hotelId: "hotel-a" });
    expect(reservationQuery.include.priceSnapshots).toEqual({ where: { hotelId: "hotel-a" }, orderBy: { version: "desc" }, take: 1 });
    expect(mocks.roomFindMany.mock.calls[0][0].where.hotelId).toBe("hotel-a");
    expect(mocks.roomTypeFindMany.mock.calls[0][0].where.hotelId).toBe("hotel-a");
    expect(element.props.inHouse.map((stay: any) => stay.id)).toEqual(["stay-a"]);
    expect(element.props.rooms.map((room: any) => room.number)).toEqual(["A-1"]);
    expect(element.props.roomTypes.map((type: any) => type.id)).toEqual(["type-a"]);
    expect(JSON.stringify(element.props)).not.toContain("B-1");
    expect(JSON.stringify(element.props)).not.toContain("B secret type");
  });

  it("serializes the latest frozen full price and breakdown for arrivals", async () => {
    const now = new Date();
    const row = {
      ...reservation("hotel-a", "stay-a"), status: "CONFIRMED", checkInDate: now,
      checkOutDate: new Date(now.getTime() + 86400000), folios: [],
      priceSnapshots: [{ grandTotal: 5500, breakdown: { lines: [
        { label: "Room 192", amount: 3500 },
        { label: "Bed & Breakfast", amount: 1500 },
        { label: "Child (3–12 yrs) (age 3) × 1 night", amount: 500 },
      ] } }],
    };
    mocks.reservationFindMany.mockResolvedValue([row]);
    mocks.roomFindMany.mockResolvedValue([]);
    mocks.roomTypeFindMany.mockResolvedValue([]);
    const page = (await FrontDeskPage()) as any;
    expect(page.props.arrivals[0]).toMatchObject({ requiredAmount: 5500, paidAmount: 0, balance: 5500,
      hasFolio: false, pricingLines: row.priceSnapshots[0].breakdown.lines });
  });

  it("scopes inventory, movement-to-item relations, and purchasing records", async () => {
    const items = [
      { id: "item-a", hotelId: "hotel-a", sku: "A", name: "A item", category: "Food", unit: "pcs", currentStock: 5, reorderLevel: 1, costPerUnit: 2, supplier: null },
      { id: "item-b", hotelId: "hotel-b", sku: "B", name: "B secret item", category: "Food", unit: "pcs", currentStock: 9, reorderLevel: 1, costPerUnit: 4, supplier: null },
    ];
    const movements = [
      { id: "movement-a", hotelId: "hotel-a", inventoryItem: { hotelId: "hotel-a", costPerUnit: 2 }, quantity: -1 },
      { id: "movement-malformed", hotelId: "hotel-a", inventoryItem: { hotelId: "hotel-b", costPerUnit: 99 }, quantity: -1 },
      { id: "movement-b", hotelId: "hotel-b", inventoryItem: { hotelId: "hotel-b", costPerUnit: 4 }, quantity: -1 },
    ];
    const purchases = [
      { id: "purchase-a", hotelId: "hotel-a", inventoryItem: { hotelId: "hotel-a" }, totalCost: 20 },
      { id: "purchase-malformed", hotelId: "hotel-a", inventoryItem: { hotelId: "hotel-b" }, totalCost: 900 },
      { id: "purchase-b", hotelId: "hotel-b", inventoryItem: { hotelId: "hotel-b" }, totalCost: 90 },
    ];
    mocks.inventoryItemFindMany.mockImplementation(async (args) => byHotel(items, args));
    mocks.stockMovementFindMany.mockImplementation(async (args) => byHotel(movements, args)
      .filter((movement: any) => movement.inventoryItem.hotelId === args.where.inventoryItem.is.hotelId));
    mocks.purchaseFindMany.mockImplementation(async (args) => byHotel(purchases, args)
      .filter((purchase: any) => purchase.inventoryItem.hotelId === args.where.inventoryItem.is.hotelId));

    const wrapper = (await InventoryPage()) as any;
    expect(wrapper.props.hotelId).toBe("hotel-a");
    expect(wrapper.props.actorId).toBe("user-a");
    const element = wrapper.props.children;

    expect(mocks.requirePageRole).toHaveBeenCalledWith(mocks.groups.MANAGEMENT, "INVENTORY");
    expect(mocks.inventoryItemFindMany.mock.calls[0][0].where).toEqual({ hotelId: "hotel-a" });
    expect(mocks.stockMovementFindMany.mock.calls[0][0].where.hotelId).toBe("hotel-a");
    expect(mocks.stockMovementFindMany.mock.calls[0][0].where.inventoryItem.is.hotelId).toBe("hotel-a");
    expect(mocks.purchaseFindMany.mock.calls[0][0].where.hotelId).toBe("hotel-a");
    expect(element.props.initialItems.map((item: any) => item.id)).toEqual(["item-a"]);
    expect(element.props.kpis.todaysPurchases).toBe(20);
    expect(JSON.stringify(element.props)).not.toContain("B secret item");
  });

  it("scopes both active room and room-type queries", async () => {
    const rooms = [
      { id: "room-a", hotelId: "hotel-a", number: "A-1", floor: "1", status: "AVAILABLE", notes: null, roomTypeId: "type-a", roomType: { name: "A type" } },
      { id: "room-b", hotelId: "hotel-b", number: "B-1", floor: "1", status: "AVAILABLE", notes: null, roomTypeId: "type-b", roomType: { name: "B type" } },
    ];
    const types = [
      { id: "type-a", hotelId: "hotel-a", name: "A type", description: null, baseRate: 10, capacity: 2 },
      { id: "type-b", hotelId: "hotel-b", name: "B secret type", description: null, baseRate: 99, capacity: 2 },
    ];
    mocks.roomFindMany.mockImplementation(async (args) => byHotel(rooms, args));
    mocks.roomTypeFindMany.mockImplementation(async (args) => byHotel(types, args));

    const element = (await RoomsPage()) as any;

    expect(mocks.roomFindMany.mock.calls[0][0].where.hotelId).toBe("hotel-a");
    expect(mocks.roomTypeFindMany.mock.calls[0][0].where.hotelId).toBe("hotel-a");
    expect(element.props.initialRooms.map((room: any) => room.id)).toEqual(["room-a"]);
    expect(element.props.initialRoomTypes.map((type: any) => type.id)).toEqual(["type-a"]);
    expect(JSON.stringify(element.props)).not.toContain("B secret type");
  });

  it("scopes reservation-calendar room choices to the active hotel", async () => {
    const rooms = [
      { id: "room-a", hotelId: "hotel-a", number: "A-1", status: "AVAILABLE", roomType: { name: "A type", baseRate: 10 } },
      { id: "room-b", hotelId: "hotel-b", number: "B-1", status: "AVAILABLE", roomType: { name: "B secret type", baseRate: 99 } },
    ];
    const types = [
      { id: "type-a", hotelId: "hotel-a", name: "A type", baseRate: 10, mealPlan: "BED_ONLY" },
      { id: "type-b", hotelId: "hotel-b", name: "B secret type", baseRate: 99, mealPlan: "FULL_BOARD" },
    ];
    mocks.roomFindMany.mockImplementation(async (args) => byHotel(rooms, args));
    mocks.roomTypeFindMany.mockImplementation(async (args) => byHotel(types, args));

    const element = (await ReservationsPage()) as any;

    expect(mocks.requirePageRole).toHaveBeenCalledWith(mocks.groups.GUEST_STAYS, "RESERVATIONS");
    expect(mocks.roomFindMany.mock.calls[0][0].where.hotelId).toBe("hotel-a");
    expect(mocks.roomTypeFindMany.mock.calls[0][0].where.hotelId).toBe("hotel-a");
    expect(element.props.rooms.map((room: any) => room.id)).toEqual(["room-a"]);
    expect(element.props.roomTypes.map((type: any) => type.id)).toEqual(["type-a"]);
    // The hotel's own currency is what the form must show, never a hardcoded KSh.
    expect(element.props.currency).toBe("KES");
    expect(JSON.stringify(element.props)).not.toContain("B secret type");
  });

  it("does not query page data when the page authorization helper rejects", async () => {
    mocks.requirePageRole.mockRejectedValueOnce(new Error("redirect"));

    await expect(ExpensesPage()).rejects.toThrow("redirect");
    expect(mocks.expenseFindMany).not.toHaveBeenCalled();
  });
});
