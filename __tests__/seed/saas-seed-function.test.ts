
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fakePrisma, records, resetRecords } = vi.hoisted(() => {
  const records: Record<string, Record<string, unknown>[]> = {};
  let nextId = 1;

  const modelNames = [
    "user",
    "hotel",
    "hotelMembership",
    "roomType",
    "room",
    "guest",
    "reservation",
    "folio",
    "folioItem",
    "paymentMethod",
    "payment",
    "inventoryItem",
  ];

  function modelApi(model: string) {
    return {
      async upsert(args: {
        where: Record<string, unknown>;
        create: Record<string, unknown>;
        update: Record<string, unknown>;
      }) {
        const rows = (records[model] ??= []);
        const existing = rows.find((row) =>
          Object.entries(args.where).every(([key, value]) => {
            const expected =
              value && typeof value === "object" && !Array.isArray(value)
                ? value
                : { [key]: value };

            if (key.includes("_")) {
              return Object.entries(expected as Record<string, unknown>).every(
                ([nestedKey, nestedValue]) => row[nestedKey] === nestedValue,
              );
            }

            return row[key] === value;
          }),
        );

        if (existing) {
          Object.assign(existing, args.update);
          return existing;
        }

        const row = { id: `fake-${nextId++}`, ...args.create };
        rows.push(row);
        return row;
      },

      async create(args: { data: Record<string, unknown> }) {
        const row = { id: `fake-${nextId++}`, ...args.data };
        (records[model] ??= []).push(row);
        return row;
      },
    };
  }

  const fakePrisma = new Proxy(
    {},
    {
      get(_target, property: string | symbol) {
        if (typeof property !== "string") return undefined;
        return modelApi(property);
      },
    },
  );

  function resetRecords() {
    for (const key of Object.keys(records)) delete records[key];
    nextId = 1;
  }

  // Make every model available before the seed runs.
  for (const model of modelNames) records[model] = [];

  return { fakePrisma, records, resetRecords };
});

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor() {
      return fakePrisma;
    }
  },
  HotelRole: {
    HOTEL_OWNER: "HOTEL_OWNER",
    RECEPTIONIST: "RECEPTIONIST",
  },
  PlatformRole: {
    PLATFORM_SUPER_ADMIN: "PLATFORM_SUPER_ADMIN",
  },
  RoomStatus: {
    RESERVED: "RESERVED",
    AVAILABLE: "AVAILABLE",
  },
  ReservationStatus: {
    CONFIRMED: "CONFIRMED",
  },
  BookingSource: {
    WALK_IN: "WALK_IN",
    OTA: "OTA",
  },
  FolioItemType: {
    ROOM_CHARGE: "ROOM_CHARGE",
  },
  PaymentStatus: {
    COMPLETED: "COMPLETED",
  },
}));

vi.mock("bcryptjs", () => ({
  default: {
    hash: vi.fn(async () => "fictional-test-password-hash"),
  },
  hash: vi.fn(async () => "fictional-test-password-hash"),
}));

describe("SaaS fictional seed function", () => {
  beforeEach(() => {
    resetRecords();
  });

  it("creates two fictional hotels and tenant-scoped operational records", async () => {
    const { seedMultiTenantData } = await import("../../prisma/seed");

    await seedMultiTenantData(fakePrisma as never);

    expect(records.hotel).toHaveLength(2);
    expect(records.hotel.map((hotel) => hotel.slug)).toEqual([
      "demo-hotel-alpha",
      "demo-hotel-beta",
    ]);

    expect(records.user).toHaveLength(5);
    expect(records.hotelMembership).toHaveLength(4);
    expect(records.roomType).toHaveLength(2);
    expect(records.room).toHaveLength(4);
    expect(records.guest).toHaveLength(2);
    expect(records.reservation).toHaveLength(2);
    expect(records.folio).toHaveLength(2);
    expect(records.folioItem).toHaveLength(2);
    expect(records.paymentMethod).toHaveLength(2);
    expect(records.payment).toHaveLength(2);
    expect(records.inventoryItem).toHaveLength(2);
  });

  it("allows identical room numbers and inventory SKUs across different hotels", async () => {
    const { seedMultiTenantData } = await import("../../prisma/seed");

    await seedMultiTenantData(fakePrisma as never);

    for (const number of ["101", "102"]) {
      const matchingRooms = records.room.filter(
        (room) => room.number === number,
      );
      expect(matchingRooms).toHaveLength(2);
      expect(new Set(matchingRooms.map((room) => room.hotelId)).size).toBe(2);
    }

    const matchingInventory = records.inventoryItem.filter(
      (item) => item.sku === "ING-COFFEE-01",
    );
    expect(matchingInventory).toHaveLength(2);
    expect(
      new Set(matchingInventory.map((item) => item.hotelId)).size,
    ).toBe(2);
  });

  it("assigns memberships and reservations to the correct hotel", async () => {
    const { seedMultiTenantData } = await import("../../prisma/seed");

    await seedMultiTenantData(fakePrisma as never);

    const alpha = records.hotel.find(
      (hotel) => hotel.slug === "demo-hotel-alpha",
    )!;
    const beta = records.hotel.find(
      (hotel) => hotel.slug === "demo-hotel-beta",
    )!;

    expect(
      records.hotelMembership.filter((membership) => membership.hotelId === alpha.id),
    ).toHaveLength(2);
    expect(
      records.hotelMembership.filter((membership) => membership.hotelId === beta.id),
    ).toHaveLength(2);

    expect(
      records.reservation.find((reservation) => reservation.code === "RES-ALPHA-101")?.hotelId,
    ).toBe(alpha.id);
    expect(
      records.reservation.find((reservation) => reservation.code === "RES-BETA-101")?.hotelId,
    ).toBe(beta.id);
  });
});
