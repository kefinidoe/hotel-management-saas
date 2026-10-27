// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

function countValue(result: { rows: unknown[] }): number {
  return Number((result.rows[0] as { c: number | string }).c);
}

describe("Phase 3 Multi-Tenant Fictional Seed Verification", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    const migrationPath = path.join(
      process.cwd(),
      "prisma/migrations/20261008123000_multi_tenant_saas_init/migration.sql"
    );
    const sql = fs.readFileSync(migrationPath, "utf8");
    await db.exec(sql);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("seeds Demo Hotel Alpha and Demo Hotel Beta with complete operational records", async () => {
    const passwordHash = "$2a$10$MockPasswordHashForFictionalTestingOnly1234567890123456";

    // Platform Super Admin
    await db.query(
      `INSERT INTO "User" (id, name, email, "passwordHash", "platformRole", "updatedAt")
       VALUES ('admin-1', 'Platform Admin', 'platform-admin@example.com', $1, 'PLATFORM_SUPER_ADMIN', NOW())`,
      [passwordHash]
    );

    // Hotel Alpha
    await db.query(
      `INSERT INTO "Hotel" (id, name, slug, currency, timezone, status, "updatedAt")
       VALUES ('hotel-a', 'Demo Hotel Alpha', 'demo-hotel-alpha', 'USD', 'America/New_York', 'ACTIVE', NOW())`
    );
    // Hotel Beta
    await db.query(
      `INSERT INTO "Hotel" (id, name, slug, currency, timezone, status, "updatedAt")
       VALUES ('hotel-b', 'Demo Hotel Beta', 'demo-hotel-beta', 'EUR', 'Europe/Paris', 'ACTIVE', NOW())`
    );

    // Alpha & Beta Users
    await db.query(
      `INSERT INTO "User" (id, name, email, "passwordHash", "updatedAt") VALUES
       ('user-a-owner', 'Alice Owner', 'alpha-owner@example.com', $1, NOW()),
       ('user-a-rec', 'Alex Rec', 'alpha-receptionist@example.com', $1, NOW()),
       ('user-b-owner', 'Bernard Owner', 'beta-owner@example.com', $1, NOW()),
       ('user-b-rec', 'Brigitte Rec', 'beta-receptionist@example.com', $1, NOW())`,
      [passwordHash]
    );

    // Memberships
    await db.query(
      `INSERT INTO "HotelMembership" (id, "userId", "hotelId", role, status, "updatedAt") VALUES
       ('mem-a-1', 'user-a-owner', 'hotel-a', 'HOTEL_OWNER', 'ACTIVE', NOW()),
       ('mem-a-2', 'user-a-rec', 'hotel-a', 'RECEPTIONIST', 'ACTIVE', NOW()),
       ('mem-b-1', 'user-b-owner', 'hotel-b', 'HOTEL_OWNER', 'ACTIVE', NOW()),
       ('mem-b-2', 'user-b-rec', 'hotel-b', 'RECEPTIONIST', 'ACTIVE', NOW())`
    );

    // Room Types
    await db.query(
      `INSERT INTO "RoomType" (id, "hotelId", name, "baseRate", capacity, "updatedAt") VALUES
       ('type-a-1', 'hotel-a', 'Deluxe King', 150.00, 2, NOW()),
       ('type-b-1', 'hotel-b', 'Executive Suite', 220.00, 3, NOW())`
    );

    // Rooms (Identical numbers 101 and 102 coexisting)
    await db.query(
      `INSERT INTO "Room" (id, "hotelId", number, "roomTypeId", status, "updatedAt") VALUES
       ('room-a-101', 'hotel-a', '101', 'type-a-1', 'RESERVED', NOW()),
       ('room-a-102', 'hotel-a', '102', 'type-a-1', 'AVAILABLE', NOW()),
       ('room-b-101', 'hotel-b', '101', 'type-b-1', 'RESERVED', NOW()),
       ('room-b-102', 'hotel-b', '102', 'type-b-1', 'AVAILABLE', NOW())`
    );

    // Guests
    await db.query(
      `INSERT INTO "Guest" (id, "hotelId", "fullName", email, "updatedAt") VALUES
       ('guest-a-1', 'hotel-a', 'John Doe', 'john.doe@example.com', NOW()),
       ('guest-b-1', 'hotel-b', 'Jane Smith', 'jane.smith@example.com', NOW())`
    );

    // Reservations
    await db.query(
      `INSERT INTO "Reservation" (id, "hotelId", code, "guestId", "createdById", "checkInDate", "checkOutDate", status, "updatedAt") VALUES
       ('res-a-1', 'hotel-a', 'RES-ALPHA-101', 'guest-a-1', 'user-a-rec', NOW(), NOW() + interval '1 day', 'CONFIRMED', NOW()),
       ('res-b-1', 'hotel-b', 'RES-BETA-101', 'guest-b-1', 'user-b-rec', NOW(), NOW() + interval '1 day', 'CONFIRMED', NOW())`
    );

    // Folios
    await db.query(
      `INSERT INTO "Folio" (id, "hotelId", "guestId", "reservationId", "updatedAt") VALUES
       ('folio-a-1', 'hotel-a', 'guest-a-1', 'res-a-1', NOW()),
       ('folio-b-1', 'hotel-b', 'guest-b-1', 'res-b-1', NOW())`
    );

    // Payment Methods
    await db.query(
      `INSERT INTO "PaymentMethod" (id, "hotelId", name) VALUES
       ('pm-a-cash', 'hotel-a', 'Cash'),
       ('pm-b-cash', 'hotel-b', 'Cash')`
    );

    // Payments
    await db.query(
      `INSERT INTO "Payment" (id, "hotelId", "folioId", "paymentMethodId", "cashierId", amount, status) VALUES
       ('pay-a-1', 'hotel-a', 'folio-a-1', 'pm-a-cash', 'user-a-rec', 150.00, 'COMPLETED'),
       ('pay-b-1', 'hotel-b', 'folio-b-1', 'pm-b-cash', 'user-b-rec', 220.00, 'COMPLETED')`
    );

    // Menu Categories & Items
    await db.query(
      `INSERT INTO "MenuCategory" (id, "hotelId", name) VALUES
       ('cat-a-1', 'hotel-a', 'Beverages'),
       ('cat-b-1', 'hotel-b', 'Beverages')`
    );

    await db.query(
      `INSERT INTO "MenuItem" (id, "hotelId", "categoryId", name, price) VALUES
       ('item-a-1', 'hotel-a', 'cat-a-1', 'Coffee', 5.00),
       ('item-b-1', 'hotel-b', 'cat-b-1', 'Espresso', 4.50)`
    );

    // Inventory Items (Identical SKU ING-COFFEE-01 coexisting)
    await db.query(
      `INSERT INTO "InventoryItem" (id, "hotelId", sku, name, category, unit, "currentStock", "reorderLevel", "costPerUnit", "updatedAt") VALUES
       ('inv-a-1', 'hotel-a', 'ING-COFFEE-01', 'House Blend Coffee Beans', 'Beverages', 'g', 5000, 1000, 0.05, NOW()),
       ('inv-b-1', 'hotel-b', 'ING-COFFEE-01', 'Artisan Dark Roast Beans', 'Beverages', 'g', 3000, 500, 0.08, NOW())`
    );

    // Verify record counts
    const hotels = await db.query(`SELECT count(*) as c FROM "Hotel"`);
    expect(countValue(hotels)).toBe(2);

    const users = await db.query(`SELECT count(*) as c FROM "User"`);
    expect(countValue(users)).toBe(5); // 1 super admin + 2 alpha + 2 beta

    const rooms = await db.query(`SELECT count(*) as c FROM "Room"`);
    expect(countValue(rooms)).toBe(4); // 2 in alpha + 2 in beta

    const guests = await db.query(`SELECT count(*) as c FROM "Guest"`);
    expect(countValue(guests)).toBe(2);

    const reservations = await db.query(`SELECT count(*) as c FROM "Reservation"`);
    expect(countValue(reservations)).toBe(2);

    const folios = await db.query(`SELECT count(*) as c FROM "Folio"`);
    expect(countValue(folios)).toBe(2);

    const payments = await db.query(`SELECT count(*) as c FROM "Payment"`);
    expect(countValue(payments)).toBe(2);

    const menuItems = await db.query(`SELECT count(*) as c FROM "MenuItem"`);
    expect(countValue(menuItems)).toBe(2);

    const inventoryItems = await db.query(`SELECT count(*) as c FROM "InventoryItem"`);
    expect(countValue(inventoryItems)).toBe(2);
  });
});
