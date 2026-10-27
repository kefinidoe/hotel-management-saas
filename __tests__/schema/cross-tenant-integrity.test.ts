// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import path from "node:path";

describe("Phase 3 Cross-Tenant Referential Integrity Test Suite", () => {
  let db: PGlite;

  let alphaHotelId = "hotel-alpha";
  let betaHotelId = "hotel-beta";

  let alphaUserId = "user-alpha-receptionist";
  let betaUserId = "user-beta-receptionist";

  let alphaGuestId = "guest-alpha-1";
  let betaGuestId = "guest-beta-1";

  let alphaRoomTypeId = "roomtype-alpha-1";
  let betaRoomTypeId = "roomtype-beta-1";

  let alphaRoomId = "room-alpha-101";
  let betaRoomId = "room-beta-101";

  let alphaReservationId = "res-alpha-1";
  let betaReservationId = "res-beta-1";

  let alphaFolioId = "folio-alpha-1";
  let betaFolioId = "folio-beta-1";

  let alphaPayMethodId = "pm-alpha-cash";
  let betaPayMethodId = "pm-beta-cash";

  let alphaInventoryId = "inv-alpha-coffee";
  let betaInventoryId = "inv-beta-coffee";

  let alphaMenuCatId = "cat-alpha-bev";
  let betaMenuCatId = "cat-beta-bev";

  let alphaMenuItemId = "item-alpha-latte";
  let betaMenuItemId = "item-beta-latte";

  beforeAll(async () => {
    db = new PGlite();
    const migrationPath = path.join(
      process.cwd(),
      "prisma/migrations/20261008123000_multi_tenant_saas_init/migration.sql"
    );
    const sql = fs.readFileSync(migrationPath, "utf8");
    await db.exec(sql);

    // 1. Seed Hotel Alpha & Hotel Beta
    await db.query(
      `INSERT INTO "Hotel" (id, name, slug, status, "updatedAt") VALUES
       ($1, 'Demo Hotel Alpha', 'demo-alpha', 'ACTIVE', NOW()),
       ($2, 'Demo Hotel Beta', 'demo-beta', 'ACTIVE', NOW())`,
      [alphaHotelId, betaHotelId]
    );

    // 2. Seed Users
    await db.query(
      `INSERT INTO "User" (id, name, email, "passwordHash", "updatedAt") VALUES
       ($1, 'Alpha Staff', 'alpha@example.com', 'hash', NOW()),
       ($2, 'Beta Staff', 'beta@example.com', 'hash', NOW())`,
      [alphaUserId, betaUserId]
    );

    // 3. Seed Memberships
    await db.query(
      `INSERT INTO "HotelMembership" (id, "userId", "hotelId", role, status, "updatedAt") VALUES
       ('mem-alpha-1', $1, $2, 'RECEPTIONIST', 'ACTIVE', NOW()),
       ('mem-beta-1', $3, $4, 'RECEPTIONIST', 'ACTIVE', NOW())`,
      [alphaUserId, alphaHotelId, betaUserId, betaHotelId]
    );

    // 4. Seed Guests
    await db.query(
      `INSERT INTO "Guest" (id, "hotelId", "fullName", "updatedAt") VALUES
       ($1, $2, 'Alpha Guest', NOW()),
       ($3, $4, 'Beta Guest', NOW())`,
      [alphaGuestId, alphaHotelId, betaGuestId, betaHotelId]
    );

    // 5. Seed Room Types
    await db.query(
      `INSERT INTO "RoomType" (id, "hotelId", name, "baseRate", capacity, "updatedAt") VALUES
       ($1, $2, 'Alpha Suite', 100, 2, NOW()),
       ($3, $4, 'Beta Suite', 100, 2, NOW())`,
      [alphaRoomTypeId, alphaHotelId, betaRoomTypeId, betaHotelId]
    );

    // 6. Seed Rooms (both numbered 101)
    await db.query(
      `INSERT INTO "Room" (id, "hotelId", number, "roomTypeId", "updatedAt") VALUES
       ($1, $2, '101', $3, NOW()),
       ($4, $5, '101', $6, NOW())`,
      [alphaRoomId, alphaHotelId, alphaRoomTypeId, betaRoomId, betaHotelId, betaRoomTypeId]
    );

    // 7. Seed Reservations
    await db.query(
      `INSERT INTO "Reservation" (id, "hotelId", code, "guestId", "createdById", "checkInDate", "checkOutDate", "updatedAt") VALUES
       ($1, $2, 'RES-A-01', $3, $4, NOW(), NOW() + interval '1 day', NOW()),
       ($5, $6, 'RES-B-01', $7, $8, NOW(), NOW() + interval '1 day', NOW())`,
      [alphaReservationId, alphaHotelId, alphaGuestId, alphaUserId,
       betaReservationId, betaHotelId, betaGuestId, betaUserId]
    );

    // 8. Seed Folios
    await db.query(
      `INSERT INTO "Folio" (id, "hotelId", "guestId", "reservationId", "updatedAt") VALUES
       ($1, $2, $3, $4, NOW()),
       ($5, $6, $7, $8, NOW())`,
      [alphaFolioId, alphaHotelId, alphaGuestId, alphaReservationId,
       betaFolioId, betaHotelId, betaGuestId, betaReservationId]
    );

    // 9. Seed Payment Methods
    await db.query(
      `INSERT INTO "PaymentMethod" (id, "hotelId", name) VALUES
       ($1, $2, 'Cash'),
       ($3, $4, 'Cash')`,
      [alphaPayMethodId, alphaHotelId, betaPayMethodId, betaHotelId]
    );

    // 10. Seed Menu Categories and Items
    await db.query(
      `INSERT INTO "MenuCategory" (id, "hotelId", name) VALUES
       ($1, $2, 'Beverages'),
       ($3, $4, 'Beverages')`,
      [alphaMenuCatId, alphaHotelId, betaMenuCatId, betaHotelId]
    );

    await db.query(
      `INSERT INTO "MenuItem" (id, "hotelId", "categoryId", name, price) VALUES
       ($1, $2, $3, 'Coffee', 5.00),
       ($4, $5, $6, 'Coffee', 5.00)`,
      [alphaMenuItemId, alphaHotelId, alphaMenuCatId, betaMenuItemId, betaHotelId, betaMenuCatId]
    );

    // 11. Seed Inventory Items
    await db.query(
      `INSERT INTO "InventoryItem" (id, "hotelId", sku, name, category, unit, "updatedAt") VALUES
       ($1, $2, 'SKU-001', 'Coffee Beans', 'Raw', 'g', NOW()),
       ($3, $4, 'SKU-001', 'Coffee Beans', 'Raw', 'g', NOW())`,
      [alphaInventoryId, alphaHotelId, betaInventoryId, betaHotelId]
    );
  });

  afterAll(async () => {
    await db?.close();
  });

  // -------------------------------------------------------------------------
  // RESERVATION CROSS-TENANT TESTS
  // -------------------------------------------------------------------------
  describe("Reservation Cross-Tenant Integrity", () => {
    it("DATABASE REJECTS: Alpha Reservation referencing Beta Guest on CREATE", async () => {
      await expect(
        db.query(
          `INSERT INTO "Reservation" (id, "hotelId", code, "guestId", "createdById", "checkInDate", "checkOutDate", "updatedAt")
           VALUES ('res-malicious-1', $1, 'RES-MAL-1', $2, $3, NOW(), NOW() + interval '1 day', NOW())`,
          [alphaHotelId, betaGuestId, alphaUserId]
        )
      ).rejects.toThrow(/Reservation_guestId_hotelId_fkey|foreign key/i);
    });

    it("DATABASE REJECTS: Updating Alpha Reservation to reference Beta Guest", async () => {
      await expect(
        db.query(
          `UPDATE "Reservation" SET "guestId" = $1 WHERE id = $2`,
          [betaGuestId, alphaReservationId]
        )
      ).rejects.toThrow(/Reservation_guestId_hotelId_fkey|foreign key/i);
    });

    it("APPLICATION INVARIANT: Validates that Room in ReservationRoom belongs to the same hotel as Reservation", async () => {
      // Service layer validation function pattern:
      const validateReservationRoom = async (resId: string, roomId: string) => {
        const res = await db.query<{ hotelId: string }>(`SELECT "hotelId" FROM "Reservation" WHERE id = $1`, [resId]);
        const room = await db.query<{ hotelId: string }>(`SELECT "hotelId" FROM "Room" WHERE id = $1`, [roomId]);
        if (!res.rows[0] || !room.rows[0] || res.rows[0].hotelId !== room.rows[0].hotelId) {
          throw new Error("Cross-tenant reservation room link forbidden: Reservation and Room hotels do not match");
        }
      };

      // Attempting to link Alpha reservation to Beta room must be rejected by service invariant:
      await expect(validateReservationRoom(alphaReservationId, betaRoomId)).rejects.toThrow(
        "Cross-tenant reservation room link forbidden"
      );

      // Linking Alpha reservation to Alpha room must be allowed:
      let allowed = false;
      try {
        await validateReservationRoom(alphaReservationId, alphaRoomId);
        allowed = true;
      } catch {
        allowed = false;
      }
      expect(allowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // FOLIO CROSS-TENANT TESTS
  // -------------------------------------------------------------------------
  describe("Folio Cross-Tenant Integrity", () => {
    it("DATABASE REJECTS: Alpha Folio referencing Beta Guest on CREATE", async () => {
      await expect(
        db.query(
          `INSERT INTO "Folio" (id, "hotelId", "guestId", "updatedAt") VALUES ('folio-mal-1', $1, $2, NOW())`,
          [alphaHotelId, betaGuestId]
        )
      ).rejects.toThrow(/Folio_guestId_hotelId_fkey|foreign key/i);
    });

    it("DATABASE REJECTS: Alpha Folio referencing Beta Reservation on CREATE", async () => {
      await expect(
        db.query(
          `INSERT INTO "Folio" (id, "hotelId", "guestId", "reservationId", "updatedAt") VALUES ('folio-mal-2', $1, $2, $3, NOW())`,
          [alphaHotelId, alphaGuestId, betaReservationId]
        )
      ).rejects.toThrow(/Folio_reservationId_hotelId_fkey|foreign key/i);
    });

    it("DATABASE REJECTS: Updating Alpha Folio to reference Beta Reservation", async () => {
      await expect(
        db.query(`UPDATE "Folio" SET "reservationId" = $1 WHERE id = $2`, [betaReservationId, alphaFolioId])
      ).rejects.toThrow(/Folio_reservationId_hotelId_fkey|foreign key/i);
    });
  });

  // -------------------------------------------------------------------------
  // PAYMENT CROSS-TENANT TESTS
  // -------------------------------------------------------------------------
  describe("Payment Cross-Tenant Integrity", () => {
    it("DATABASE REJECTS: Alpha Payment referencing Beta Folio on CREATE", async () => {
      await expect(
        db.query(
          `INSERT INTO "Payment" (id, "hotelId", "folioId", "paymentMethodId", "cashierId", amount)
           VALUES ('pay-mal-1', $1, $2, $3, $4, 100.00)`,
          [alphaHotelId, betaFolioId, alphaPayMethodId, alphaUserId]
        )
      ).rejects.toThrow(/Payment_folioId_hotelId_fkey|foreign key/i);
    });

    it("DATABASE REJECTS: Alpha Payment referencing Beta PaymentMethod on CREATE", async () => {
      await expect(
        db.query(
          `INSERT INTO "Payment" (id, "hotelId", "folioId", "paymentMethodId", "cashierId", amount)
           VALUES ('pay-mal-2', $1, $2, $3, $4, 100.00)`,
          [alphaHotelId, alphaFolioId, betaPayMethodId, alphaUserId]
        )
      ).rejects.toThrow(/Payment_paymentMethodId_hotelId_fkey|foreign key/i);
    });

    it("DATABASE REJECTS: Updating Alpha Payment to reference Beta Folio", async () => {
      // First insert valid Alpha payment
      await db.query(
        `INSERT INTO "Payment" (id, "hotelId", "folioId", "paymentMethodId", "cashierId", amount)
         VALUES ('pay-alpha-valid', $1, $2, $3, $4, 50.00)`,
        [alphaHotelId, alphaFolioId, alphaPayMethodId, alphaUserId]
      );

      // Attempt update to Beta folio
      await expect(
        db.query(`UPDATE "Payment" SET "folioId" = $1 WHERE id = 'pay-alpha-valid'`, [betaFolioId])
      ).rejects.toThrow(/Payment_folioId_hotelId_fkey|foreign key/i);
    });
  });

  // -------------------------------------------------------------------------
  // ORDER & RESTAURANT CROSS-TENANT TESTS
  // -------------------------------------------------------------------------
  describe("Order & Restaurant Cross-Tenant Integrity", () => {
    it("DATABASE REJECTS: Alpha Order referencing Beta Folio on CREATE", async () => {
      await expect(
        db.query(
          `INSERT INTO "Order" (id, "hotelId", "folioId", total) VALUES ('ord-mal-1', $1, $2, 25.00)`,
          [alphaHotelId, betaFolioId]
        )
      ).rejects.toThrow(/Order_folioId_hotelId_fkey|foreign key/i);
    });

    it("DATABASE REJECTS: Alpha Order referencing Beta PaymentMethod on CREATE", async () => {
      await expect(
        db.query(
          `INSERT INTO "Order" (id, "hotelId", "paymentMethodId", total) VALUES ('ord-mal-2', $1, $2, 25.00)`,
          [alphaHotelId, betaPayMethodId]
        )
      ).rejects.toThrow(/Order_paymentMethodId_hotelId_fkey|foreign key/i);
    });

    it("DATABASE REJECTS: Alpha MenuItem referencing Beta MenuCategory on CREATE", async () => {
      await expect(
        db.query(
          `INSERT INTO "MenuItem" (id, "hotelId", "categoryId", name, price) VALUES ('item-mal-1', $1, $2, 'FraudItem', 10.00)`,
          [alphaHotelId, betaMenuCatId]
        )
      ).rejects.toThrow(/MenuItem_categoryId_hotelId_fkey|foreign key/i);
    });

    it("APPLICATION INVARIANT: Validates that OrderItem in Order references MenuItem from same hotel", async () => {
      const validateOrderItem = async (orderId: string, menuItemId: string) => {
        const order = await db.query<{ hotelId: string }>(`SELECT "hotelId" FROM "Order" WHERE id = $1`, [orderId]);
        const item = await db.query<{ hotelId: string }>(`SELECT "hotelId" FROM "MenuItem" WHERE id = $1`, [menuItemId]);
        if (!order.rows[0] || !item.rows[0] || order.rows[0].hotelId !== item.rows[0].hotelId) {
          throw new Error("Cross-tenant order item link forbidden: Order and MenuItem hotels do not match");
        }
      };

      // Valid order in Alpha
      await db.query(`INSERT INTO "Order" (id, "hotelId", total) VALUES ('ord-alpha-valid', $1, 15.00)`, [alphaHotelId]);

      // Adding Beta menu item to Alpha order must be rejected by service invariant:
      await expect(validateOrderItem("ord-alpha-valid", betaMenuItemId)).rejects.toThrow(
        "Cross-tenant order item link forbidden"
      );

      // Adding Alpha menu item to Alpha order must succeed:
      let orderAllowed = false;
      try {
        await validateOrderItem("ord-alpha-valid", alphaMenuItemId);
        orderAllowed = true;
      } catch {
        orderAllowed = false;
      }
      expect(orderAllowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // RECIPE & INVENTORY CROSS-TENANT TESTS
  // -------------------------------------------------------------------------
  describe("Recipe & Inventory Cross-Tenant Integrity", () => {
    it("DATABASE REJECTS: Alpha StockMovement referencing Beta InventoryItem on CREATE", async () => {
      await expect(
        db.query(
          `INSERT INTO "StockMovement" (id, "hotelId", "inventoryItemId", type, quantity, "beforeQty", "afterQty")
           VALUES ('sm-mal-1', $1, $2, 'ADJUSTMENT', 10, 0, 10)`,
          [alphaHotelId, betaInventoryId]
        )
      ).rejects.toThrow(/StockMovement_inventoryItemId_hotelId_fkey|foreign key/i);
    });

    it("DATABASE REJECTS: Alpha Purchase referencing Beta InventoryItem on CREATE", async () => {
      await expect(
        db.query(
          `INSERT INTO "Purchase" (id, "hotelId", "inventoryItemId", supplier, quantity, "unitCost", "totalCost", "createdById")
           VALUES ('pur-mal-1', $1, $2, 'Supplier X', 10, 1.0, 10.0, $3)`,
          [alphaHotelId, betaInventoryId, alphaUserId]
        )
      ).rejects.toThrow(/Purchase_inventoryItemId_hotelId_fkey|foreign key/i);
    });

    it("DATABASE REJECTS: Alpha Wastage referencing Beta InventoryItem on CREATE", async () => {
      await expect(
        db.query(
          `INSERT INTO "Wastage" (id, "hotelId", "inventoryItemId", quantity, reason, "recordedById")
           VALUES ('was-mal-1', $1, $2, 5, 'EXPIRED', $3)`,
          [alphaHotelId, betaInventoryId, alphaUserId]
        )
      ).rejects.toThrow(/Wastage_inventoryItemId_hotelId_fkey|foreign key/i);
    });

    it("APPLICATION INVARIANT: Validates that RecipeIngredient references InventoryItem from same hotel", async () => {
      const validateRecipeIngredient = async (menuItemId: string, inventoryItemId: string) => {
        const item = await db.query<{ hotelId: string }>(`SELECT "hotelId" FROM "MenuItem" WHERE id = $1`, [menuItemId]);
        const inv = await db.query<{ hotelId: string }>(`SELECT "hotelId" FROM "InventoryItem" WHERE id = $1`, [inventoryItemId]);
        if (!item.rows[0] || !inv.rows[0] || item.rows[0].hotelId !== inv.rows[0].hotelId) {
          throw new Error("Cross-tenant recipe ingredient link forbidden: MenuItem and InventoryItem hotels do not match");
        }
      };

      // Linking Alpha menu item recipe to Beta inventory must fail:
      await expect(validateRecipeIngredient(alphaMenuItemId, betaInventoryId)).rejects.toThrow(
        "Cross-tenant recipe ingredient link forbidden"
      );

      // Linking Alpha menu item recipe to Alpha inventory must succeed:
      let recipeAllowed = false;
      try {
        await validateRecipeIngredient(alphaMenuItemId, alphaInventoryId);
        recipeAllowed = true;
      } catch {
        recipeAllowed = false;
      }
      expect(recipeAllowed).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // OPERATIONS (HOUSEKEEPING & MAINTENANCE) CROSS-TENANT TESTS
  // -------------------------------------------------------------------------
  describe("Housekeeping & Maintenance Cross-Tenant Integrity", () => {
    it("DATABASE REJECTS: Alpha HousekeepingTask referencing Beta Room on CREATE", async () => {
      await expect(
        db.query(
          `INSERT INTO "HousekeepingTask" (id, "hotelId", "roomId", "updatedAt") VALUES ('hk-mal-1', $1, $2, NOW())`,
          [alphaHotelId, betaRoomId]
        )
      ).rejects.toThrow(/HousekeepingTask_roomId_hotelId_fkey|foreign key/i);
    });

    it("DATABASE REJECTS: Updating Alpha HousekeepingTask to reference Beta Room", async () => {
      await db.query(
        `INSERT INTO "HousekeepingTask" (id, "hotelId", "roomId", "updatedAt") VALUES ('hk-alpha-valid', $1, $2, NOW())`,
        [alphaHotelId, alphaRoomId]
      );

      await expect(
        db.query(`UPDATE "HousekeepingTask" SET "roomId" = $1 WHERE id = 'hk-alpha-valid'`, [betaRoomId])
      ).rejects.toThrow(/HousekeepingTask_roomId_hotelId_fkey|foreign key/i);
    });

    it("DATABASE REJECTS: Alpha MaintenanceTicket referencing Beta Room on CREATE", async () => {
      await expect(
        db.query(
          `INSERT INTO "MaintenanceTicket" (id, "hotelId", "roomId", title, "updatedAt") VALUES ('maint-mal-1', $1, $2, 'Broken AC', NOW())`,
          [alphaHotelId, betaRoomId]
        )
      ).rejects.toThrow(/MaintenanceTicket_roomId_hotelId_fkey|foreign key/i);
    });

    it("DATABASE REJECTS: Updating Alpha MaintenanceTicket to reference Beta Room", async () => {
      await db.query(
        `INSERT INTO "MaintenanceTicket" (id, "hotelId", "roomId", title, "updatedAt") VALUES ('maint-alpha-valid', $1, $2, 'Leaky faucet', NOW())`,
        [alphaHotelId, alphaRoomId]
      );

      await expect(
        db.query(`UPDATE "MaintenanceTicket" SET "roomId" = $1 WHERE id = 'maint-alpha-valid'`, [betaRoomId])
      ).rejects.toThrow(/MaintenanceTicket_roomId_hotelId_fkey|foreign key/i);
    });
  });
});
