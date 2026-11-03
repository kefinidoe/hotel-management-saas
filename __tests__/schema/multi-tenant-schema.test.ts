// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { PGLITE_MIGRATION_TIMEOUT_MS, applyPendingMigrations } from "./migration-runner";

// This suite applies the entire migration chain to an in-memory PGlite database:
// a WASM Postgres working through ~22 migration files. That is legitimately slow
// and markedly slower on Windows (roughly 5-7s against ~2s on Linux), which the
// default 5s per-test/per-hook budget does not cover. Raise the budget for this
// file only — where that work actually happens — so a real hang elsewhere still
// fails fast instead of hiding behind a global timeout.
vi.setConfig({ testTimeout: PGLITE_MIGRATION_TIMEOUT_MS, hookTimeout: PGLITE_MIGRATION_TIMEOUT_MS });


describe("Phase 3 Multi-Tenant Schema & Isolation Verification", () => {
  let db: PGlite;

  beforeAll(async () => {
    db = new PGlite();
    // Tenant-isolation assertions use the actual chronological schema, not an
    // isolated execution of the SaaS migration against an empty database.
    await applyPendingMigrations(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  it("builds the complete migration history before exercising the multi-tenant schema", async () => {
    const res = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`
    );
    const tableNames = res.rows.map((r) => r.table_name);

    // Verify key new multi-tenant tables exist
    expect(tableNames).toContain("Hotel");
    expect(tableNames).toContain("HotelMembership");
    expect(tableNames).toContain("User");
    expect(tableNames).toContain("Room");
    expect(tableNames).toContain("Reservation");
    expect(tableNames).toContain("Notification");
    expect(tableNames).toContain("AuditLog");
  });

  it("verifies hotelId column is present on all tenant-scoped tables", async () => {
    const tenantScopedTables = [
      "RoomType",
      "Room",
      "Guest",
      "Reservation",
      "Folio",
      "PaymentMethod",
      "Payment",
      "HousekeepingTask",
      "MaintenanceTicket",
      "MenuCategory",
      "MenuItem",
      "Order",
      "InventoryItem",
      "StockMovement",
      "Purchase",
      "Wastage",
      "Expense",
      "Notification",
    ];

    for (const table of tenantScopedTables) {
      const res = await db.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'hotelId'`,
        [table]
      );
      expect(res.rows.length, `Table ${table} must have hotelId column`).toBe(1);
    }
  });

  it("allows identical room numbers (Room 101) to coexist across different hotels", async () => {
    // 1. Create Hotel Alpha
    const alphaHotel = await db.query<{ id: string }>(
      `INSERT INTO "Hotel" (id, name, slug, currency, timezone, status, "updatedAt")
       VALUES ('hotel-alpha-id', 'Demo Hotel Alpha', 'demo-hotel-alpha', 'USD', 'America/New_York', 'ACTIVE', NOW())
       RETURNING id`
    );
    const alphaId = alphaHotel.rows[0].id;

    // 2. Create Hotel Beta
    const betaHotel = await db.query<{ id: string }>(
      `INSERT INTO "Hotel" (id, name, slug, currency, timezone, status, "updatedAt")
       VALUES ('hotel-beta-id', 'Demo Hotel Beta', 'demo-hotel-beta', 'EUR', 'Europe/Paris', 'ACTIVE', NOW())
       RETURNING id`
    );
    const betaId = betaHotel.rows[0].id;

    // 3. Create RoomTypes
    const alphaType = await db.query<{ id: string }>(
      `INSERT INTO "RoomType" (id, "hotelId", name, "baseRate", capacity, "updatedAt")
       VALUES ('type-alpha-id', $1, 'Deluxe King', 150.00, 2, NOW()) RETURNING id`,
      [alphaId]
    );
    const betaType = await db.query<{ id: string }>(
      `INSERT INTO "RoomType" (id, "hotelId", name, "baseRate", capacity, "updatedAt")
       VALUES ('type-beta-id', $1, 'Executive Suite', 200.00, 2, NOW()) RETURNING id`,
      [betaId]
    );

    // 4. Insert Room 101 in Hotel Alpha
    await db.query(
      `INSERT INTO "Room" (id, "hotelId", number, "roomTypeId", status, "updatedAt")
       VALUES ('room-alpha-101', $1, '101', $2, 'AVAILABLE', NOW())`,
      [alphaId, alphaType.rows[0].id]
    );

    // 5. Insert Room 101 in Hotel Beta — Must SUCCEED because number is tenant-scoped
    await db.query(
      `INSERT INTO "Room" (id, "hotelId", number, "roomTypeId", status, "updatedAt")
       VALUES ('room-beta-101', $1, '101', $2, 'AVAILABLE', NOW())`,
      [betaId, betaType.rows[0].id]
    );

    // Verify both rooms exist in database
    const roomCheck = await db.query<{ id: string; hotelId: string; number: string }>(
      `SELECT id, "hotelId", number FROM "Room" WHERE number = '101' ORDER BY "hotelId"`
    );
    expect(roomCheck.rows.length).toBe(2);
    expect(roomCheck.rows[0].hotelId).toBe(alphaId);
    expect(roomCheck.rows[1].hotelId).toBe(betaId);
  });

  it("strictly rejects duplicate room numbers within the SAME hotel", async () => {
    // Attempt to insert another Room 101 inside Hotel Alpha
    await expect(
      db.query(
        `INSERT INTO "Room" (id, "hotelId", number, "roomTypeId", status, "updatedAt")
         VALUES ('room-alpha-101-dup', 'hotel-alpha-id', '101', 'type-alpha-id', 'AVAILABLE', NOW())`
      )
    ).rejects.toThrow(/unique constraint|Room_hotelId_number_key/i);
  });

  it("allows identical SKUs across hotels but enforces tenant-scoped uniqueness", async () => {
    // Insert SKU 'ING-COFFEE-01' in Hotel Alpha
    await db.query(
      `INSERT INTO "InventoryItem" (id, "hotelId", sku, name, category, unit, "updatedAt")
       VALUES ('inv-alpha-1', 'hotel-alpha-id', 'ING-COFFEE-01', 'House Blend', 'Beverages', 'g', NOW())`
    );

    // Insert identical SKU 'ING-COFFEE-01' in Hotel Beta — Must succeed!
    await db.query(
      `INSERT INTO "InventoryItem" (id, "hotelId", sku, name, category, unit, "updatedAt")
       VALUES ('inv-beta-1', 'hotel-beta-id', 'ING-COFFEE-01', 'Dark Roast', 'Beverages', 'g', NOW())`
    );

    const skuCheck = await db.query(
      `SELECT id, "hotelId", sku FROM "InventoryItem" WHERE sku = 'ING-COFFEE-01'`
    );
    expect(skuCheck.rows.length).toBe(2);

    // Duplicate SKU in Hotel Alpha must fail
    await expect(
      db.query(
        `INSERT INTO "InventoryItem" (id, "hotelId", sku, name, category, unit, "updatedAt")
         VALUES ('inv-alpha-2', 'hotel-alpha-id', 'ING-COFFEE-01', 'Espresso Blend', 'Beverages', 'g', NOW())`
      )
    ).rejects.toThrow(/unique constraint|InventoryItem_hotelId_sku_key/i);
  });

  it("rejects cross-hotel references even when both referenced records exist", async () => {
    await db.query(`
      INSERT INTO "User" (id, name, email, "passwordHash", "updatedAt")
      VALUES ('tenant-constraint-user', 'Tenant Test', 'tenant-test@example.com', 'hash', NOW())
    `);
    await db.query(`
      INSERT INTO "Guest" (id, "hotelId", "fullName", "updatedAt") VALUES
        ('tenant-guest-alpha', 'hotel-alpha-id', 'Alpha Guest', NOW()),
        ('tenant-guest-beta', 'hotel-beta-id', 'Beta Guest', NOW())
    `);

    await expect(db.query(`
      INSERT INTO "Reservation" (id, "hotelId", code, "guestId", "checkInDate", "checkOutDate", "createdById", "updatedAt")
      VALUES ('cross-hotel-reservation', 'hotel-alpha-id', 'CROSS-001', 'tenant-guest-beta', NOW(), NOW() + INTERVAL '1 day', 'tenant-constraint-user', NOW())
    `)).rejects.toThrow(/Reservation_guestId_hotelId_fkey|foreign key/i);

    await expect(db.query(`
      INSERT INTO "StockMovement" (id, "hotelId", "inventoryItemId", type, quantity, "beforeQty", "afterQty")
      VALUES ('cross-hotel-movement', 'hotel-alpha-id', 'inv-beta-1', 'ADJUSTMENT', 1, 0, 1)
    `)).rejects.toThrow(/StockMovement_inventoryItemId_hotelId_fkey|foreign key/i);
  });

  it("verifies global User uniqueness on email while role is scoped to HotelMembership", async () => {
    // 1. Create global User
    await db.query(
      `INSERT INTO "User" (id, name, email, "passwordHash", "updatedAt")
       VALUES ('user-alice', 'Alice', 'alice@example.com', 'hash123', NOW())`
    );

    // Duplicate user email must fail globally
    await expect(
      db.query(
        `INSERT INTO "User" (id, name, email, "passwordHash", "updatedAt")
         VALUES ('user-alice-2', 'Alice Fake', 'alice@example.com', 'hash456', NOW())`
      )
    ).rejects.toThrow(/unique constraint|User_email_key/i);

    // 2. Alice can be HOTEL_OWNER in Hotel Alpha
    await db.query(
      `INSERT INTO "HotelMembership" (id, "userId", "hotelId", role, status, "updatedAt")
       VALUES ('mem-alpha', 'user-alice', 'hotel-alpha-id', 'HOTEL_OWNER', 'ACTIVE', NOW())`
    );

    // 3. Alice can also be MANAGER in Hotel Beta
    await db.query(
      `INSERT INTO "HotelMembership" (id, "userId", "hotelId", role, status, "updatedAt")
       VALUES ('mem-beta', 'user-alice', 'hotel-beta-id', 'MANAGER', 'ACTIVE', NOW())`
    );

    // Duplicate membership for same user in same hotel must fail
    await expect(
      db.query(
        `INSERT INTO "HotelMembership" (id, "userId", "hotelId", role, status, "updatedAt")
         VALUES ('mem-alpha-dup', 'user-alice', 'hotel-alpha-id', 'RECEPTIONIST', 'ACTIVE', NOW())`
      )
    ).rejects.toThrow(/unique constraint|HotelMembership_userId_hotelId_key/i);
  });

  it("verifies redesigned Notification supports both targeted and hotel-wide broadcasts", async () => {
    // Broadcast notification (userId is null)
    await db.query(
      `INSERT INTO "Notification" (id, "hotelId", "userId", type, title, message)
       VALUES ('notif-1', 'hotel-alpha-id', NULL, 'SYSTEM', 'Hotel Maintenance Alert', 'Water maintenance at 2 PM')`
    );

    // Targeted notification (userId is populated)
    await db.query(
      `INSERT INTO "Notification" (id, "hotelId", "userId", type, title, message)
       VALUES ('notif-2', 'hotel-alpha-id', 'user-alice', 'RESERVATION', 'VIP Arrival', 'Mr. Smith has arrived')`
    );

    const notifs = await db.query<{ id: string; userId: string | null }>(
      `SELECT id, "userId" FROM "Notification" WHERE "hotelId" = 'hotel-alpha-id' ORDER BY id`
    );
    expect(notifs.rows.length).toBe(2);
    expect(notifs.rows[0].userId).toBeNull();
    expect(notifs.rows[1].userId).toBe("user-alice");
  });

  it("verifies redesigned AuditLog supports both platform-level and hotel-level audit events", async () => {
    // Hotel-level audit event (hotelId is populated)
    await db.query(
      `INSERT INTO "AuditLog" (id, "hotelId", "userId", action, entity, "entityId", metadata)
       VALUES ('audit-1', 'hotel-alpha-id', 'user-alice', 'ROOM_RATE_CHANGED', 'RoomType', 'type-alpha-id', '{"newRate": 160}'::jsonb)`
    );

    // Platform-level audit event (hotelId is null)
    await db.query(
      `INSERT INTO "AuditLog" (id, "hotelId", "userId", action, entity, "entityId", metadata)
       VALUES ('audit-2', NULL, 'user-alice', 'PLAN_TIER_UPDATED', 'Subscription', NULL, '{"tier": "PRO"}'::jsonb)`
    );

    const audits = await db.query<{ id: string; hotelId: string | null }>(
      `SELECT id, "hotelId" FROM "AuditLog" ORDER BY id`
    );
    expect(audits.rows.length).toBe(2);
    expect(audits.rows[0].hotelId).toBe("hotel-alpha-id");
    expect(audits.rows[1].hotelId).toBeNull();
  });
});
