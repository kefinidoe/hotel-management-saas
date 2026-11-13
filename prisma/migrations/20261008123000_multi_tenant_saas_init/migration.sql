-- Convert the existing single-hotel schema into a tenant-scoped schema.
-- This migration intentionally alters and backfills the tables established by
-- the preceding migrations; it is not a second initial-schema snapshot.

-- New tenancy-specific enums. Application enums already created by the
-- single-hotel migrations (RoomStatus, MealPlan, etc.) are reused below.
CREATE TYPE "PlatformRole" AS ENUM ('PLATFORM_SUPER_ADMIN', 'PLATFORM_SUPPORT', 'PLATFORM_BILLING');
CREATE TYPE "HotelRole" AS ENUM ('HOTEL_OWNER', 'HOTEL_ADMIN', 'MANAGER', 'RECEPTIONIST', 'ACCOUNTANT', 'HOUSEKEEPER', 'WAITER', 'CASHIER', 'TECHNICIAN');
CREATE TYPE "HotelStatus" AS ENUM ('ACTIVE', 'TRIALING', 'SUSPENDED', 'CANCELLED');
CREATE TYPE "MembershipStatus" AS ENUM ('ACTIVE', 'SUSPENDED', 'INVITED');
CREATE TYPE "NotificationType" AS ENUM ('SYSTEM', 'RESERVATION', 'HOUSEKEEPING', 'MAINTENANCE', 'STOCK_ALERT', 'BILLING');

CREATE TABLE "Hotel" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "address" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "timezone" TEXT NOT NULL DEFAULT 'Africa/Nairobi',
    "settings" JSONB,
    "status" "HotelStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Hotel_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "HotelMembership" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "role" "HotelRole" NOT NULL,
    "status" "MembershipStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "HotelMembership_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Hotel_slug_key" ON "Hotel"("slug");
CREATE INDEX "Hotel_status_idx" ON "Hotel"("status");
CREATE UNIQUE INDEX "HotelMembership_userId_hotelId_key" ON "HotelMembership"("userId", "hotelId");
CREATE INDEX "HotelMembership_hotelId_role_idx" ON "HotelMembership"("hotelId", "role");
CREATE INDEX "HotelMembership_userId_status_idx" ON "HotelMembership"("userId", "status");

-- The old application had one property and stored property-wide rows without
-- tenant IDs. Keep that data together under a deterministic, clearly named
-- legacy tenant so every existing row receives an explicit owner.
INSERT INTO "Hotel" ("id", "name", "slug", "currency", "timezone", "status", "createdAt", "updatedAt")
VALUES ('legacy-hotel', 'Legacy Hotel', 'legacy-hotel', 'KES', 'Africa/Nairobi', 'ACTIVE', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Move the old per-user role into the new tenant membership relation. Legacy
-- ADMIN users had the broadest property privileges and become hotel owners;
-- all other role labels map one-to-one to their tenant-scoped equivalents.
ALTER TABLE "User" ADD COLUMN "platformRole" "PlatformRole";
INSERT INTO "HotelMembership" ("id", "userId", "hotelId", "role", "status", "createdAt", "updatedAt")
SELECT
    'legacy-membership:' || "id",
    "id",
    'legacy-hotel',
    CASE "role"::TEXT
      WHEN 'ADMIN' THEN 'HOTEL_OWNER'::"HotelRole"
      WHEN 'MANAGER' THEN 'MANAGER'::"HotelRole"
      WHEN 'RECEPTIONIST' THEN 'RECEPTIONIST'::"HotelRole"
      WHEN 'HOUSEKEEPER' THEN 'HOUSEKEEPER'::"HotelRole"
      WHEN 'WAITER' THEN 'WAITER'::"HotelRole"
      WHEN 'CASHIER' THEN 'CASHIER'::"HotelRole"
      WHEN 'ACCOUNTANT' THEN 'ACCOUNTANT'::"HotelRole"
      WHEN 'TECHNICIAN' THEN 'TECHNICIAN'::"HotelRole"
    END,
    'ACTIVE', "createdAt", CURRENT_TIMESTAMP
FROM "User";
ALTER TABLE "User" DROP COLUMN "role";
DROP TYPE "RoleName";

-- Add tenant ownership before introducing tenant-scoped constraints. The
-- backfill is safe because this migration creates exactly one legacy tenant.
ALTER TABLE "RoomType" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "Room" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "Guest" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "Reservation" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "Folio" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "PaymentMethod" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "HousekeepingTask" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "MaintenanceTicket" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "MenuCategory" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "MenuItem" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "Order" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "InventoryItem" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "StockMovement" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "Purchase" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "Wastage" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "Expense" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "hotelId" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "hotelId" TEXT;

UPDATE "RoomType" SET "hotelId" = 'legacy-hotel';
UPDATE "Room" SET "hotelId" = 'legacy-hotel';
UPDATE "Guest" SET "hotelId" = 'legacy-hotel';
UPDATE "Reservation" SET "hotelId" = 'legacy-hotel';
UPDATE "Folio" SET "hotelId" = 'legacy-hotel';
UPDATE "PaymentMethod" SET "hotelId" = 'legacy-hotel';
UPDATE "Payment" SET "hotelId" = 'legacy-hotel';
UPDATE "HousekeepingTask" SET "hotelId" = 'legacy-hotel';
UPDATE "MaintenanceTicket" SET "hotelId" = 'legacy-hotel';
UPDATE "MenuCategory" SET "hotelId" = 'legacy-hotel';
UPDATE "MenuItem" SET "hotelId" = 'legacy-hotel';
UPDATE "Order" SET "hotelId" = 'legacy-hotel';
UPDATE "InventoryItem" SET "hotelId" = 'legacy-hotel';
UPDATE "StockMovement" SET "hotelId" = 'legacy-hotel';
UPDATE "Purchase" SET "hotelId" = 'legacy-hotel';
UPDATE "Wastage" SET "hotelId" = 'legacy-hotel';
UPDATE "Expense" SET "hotelId" = 'legacy-hotel';
UPDATE "Notification" SET "hotelId" = 'legacy-hotel';
UPDATE "AuditLog" SET "hotelId" = 'legacy-hotel';

ALTER TABLE "RoomType" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "Room" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "Guest" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "Reservation" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "Folio" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "PaymentMethod" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "Payment" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "HousekeepingTask" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "MaintenanceTicket" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "MenuCategory" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "MenuItem" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "Order" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "InventoryItem" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "StockMovement" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "Purchase" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "Wastage" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "Expense" ALTER COLUMN "hotelId" SET NOT NULL;
ALTER TABLE "Notification" ALTER COLUMN "hotelId" SET NOT NULL;

-- Redesign notifications and audit records without discarding their history.
ALTER TABLE "Notification" ADD COLUMN "userId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "type" "NotificationType" NOT NULL DEFAULT 'SYSTEM';
ALTER TABLE "Notification" RENAME COLUMN "body" TO "message";
UPDATE "Notification" SET "message" = '' WHERE "message" IS NULL;
ALTER TABLE "Notification" ALTER COLUMN "message" SET NOT NULL;

ALTER TABLE "AuditLog" ADD COLUMN "entity" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "metadata" JSONB;
ALTER TABLE "AuditLog" ADD COLUMN "ipAddress" TEXT;
UPDATE "AuditLog"
SET "entity" = COALESCE("entityType", 'System'),
    "metadata" = NULLIF(
      jsonb_strip_nulls(jsonb_build_object('before', "before", 'after', "after", 'reason', "reason")),
      '{}'::JSONB
    );
ALTER TABLE "AuditLog" ALTER COLUMN "entity" SET NOT NULL;
ALTER TABLE "AuditLog" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "AuditLog" DROP COLUMN "entityType";
ALTER TABLE "AuditLog" DROP COLUMN "before";
ALTER TABLE "AuditLog" DROP COLUMN "after";
ALTER TABLE "AuditLog" DROP COLUMN "reason";

-- A category can share a label with another tenant, but duplicate labels in
-- this one legacy tenant cannot satisfy the target tenant-scoped unique key.
WITH ranked_categories AS (
  SELECT "id", FIRST_VALUE("id") OVER (PARTITION BY "name" ORDER BY "id") AS "keepId",
         ROW_NUMBER() OVER (PARTITION BY "name" ORDER BY "id") AS "ordinal"
  FROM "MenuCategory"
)
UPDATE "MenuItem" AS item
SET "categoryId" = ranked_categories."keepId"
FROM ranked_categories
WHERE ranked_categories."ordinal" > 1 AND item."categoryId" = ranked_categories."id";
WITH ranked_categories AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "name" ORDER BY "id") AS "ordinal"
  FROM "MenuCategory"
)
DELETE FROM "MenuCategory" AS category
USING ranked_categories
WHERE category."id" = ranked_categories."id" AND ranked_categories."ordinal" > 1;

-- Remove the former global uniqueness and non-tenant dashboard indexes. The
-- tenant-scoped replacements below retain the uniqueness guarantees.
DROP INDEX "Room_number_key";
DROP INDEX "Reservation_code_key";
DROP INDEX "PaymentMethod_name_key";
DROP INDEX "InventoryItem_sku_key";
DROP INDEX "Reservation_status_checkInDate_idx";
DROP INDEX "Reservation_status_checkOutDate_idx";
DROP INDEX "Folio_isClosed_idx";
DROP INDEX "Folio_reservationId_idx";
DROP INDEX "MenuItem_categoryId_isActive_idx";

-- Composite target keys allow tenant ID to participate in cross-table FKs.
CREATE UNIQUE INDEX "RoomType_id_hotelId_key" ON "RoomType"("id", "hotelId");
CREATE UNIQUE INDEX "Room_id_hotelId_key" ON "Room"("id", "hotelId");
CREATE UNIQUE INDEX "Room_hotelId_number_key" ON "Room"("hotelId", "number");
CREATE UNIQUE INDEX "Guest_id_hotelId_key" ON "Guest"("id", "hotelId");
CREATE UNIQUE INDEX "Reservation_hotelId_code_key" ON "Reservation"("hotelId", "code");
CREATE UNIQUE INDEX "Reservation_id_hotelId_key" ON "Reservation"("id", "hotelId");
CREATE UNIQUE INDEX "Folio_id_hotelId_key" ON "Folio"("id", "hotelId");
CREATE UNIQUE INDEX "PaymentMethod_hotelId_name_key" ON "PaymentMethod"("hotelId", "name");
CREATE UNIQUE INDEX "PaymentMethod_id_hotelId_key" ON "PaymentMethod"("id", "hotelId");
CREATE UNIQUE INDEX "Payment_id_hotelId_key" ON "Payment"("id", "hotelId");
CREATE UNIQUE INDEX "MenuCategory_hotelId_name_key" ON "MenuCategory"("hotelId", "name");
CREATE UNIQUE INDEX "MenuCategory_id_hotelId_key" ON "MenuCategory"("id", "hotelId");
CREATE UNIQUE INDEX "MenuItem_id_hotelId_key" ON "MenuItem"("id", "hotelId");
CREATE UNIQUE INDEX "Order_id_hotelId_key" ON "Order"("id", "hotelId");
CREATE UNIQUE INDEX "InventoryItem_hotelId_sku_key" ON "InventoryItem"("hotelId", "sku");
CREATE UNIQUE INDEX "InventoryItem_id_hotelId_key" ON "InventoryItem"("id", "hotelId");

CREATE INDEX "RoomType_hotelId_idx" ON "RoomType"("hotelId");
CREATE INDEX "Room_hotelId_status_idx" ON "Room"("hotelId", "status");
CREATE INDEX "Room_hotelId_isActive_idx" ON "Room"("hotelId", "isActive");
CREATE INDEX "Guest_hotelId_fullName_idx" ON "Guest"("hotelId", "fullName");
CREATE INDEX "Guest_hotelId_isArchived_idx" ON "Guest"("hotelId", "isArchived");
CREATE INDEX "Reservation_hotelId_checkInDate_idx" ON "Reservation"("hotelId", "checkInDate");
CREATE INDEX "Reservation_hotelId_checkOutDate_idx" ON "Reservation"("hotelId", "checkOutDate");
CREATE INDEX "Reservation_hotelId_status_idx" ON "Reservation"("hotelId", "status");
CREATE INDEX "Folio_hotelId_isClosed_idx" ON "Folio"("hotelId", "isClosed");
CREATE INDEX "Folio_hotelId_reservationId_idx" ON "Folio"("hotelId", "reservationId");
CREATE INDEX "FolioItem_folioId_type_idx" ON "FolioItem"("folioId", "type");
CREATE INDEX "PaymentMethod_hotelId_isActive_idx" ON "PaymentMethod"("hotelId", "isActive");
CREATE INDEX "Payment_hotelId_createdAt_idx" ON "Payment"("hotelId", "createdAt");
CREATE INDEX "Payment_hotelId_folioId_idx" ON "Payment"("hotelId", "folioId");
CREATE INDEX "HousekeepingTask_hotelId_status_idx" ON "HousekeepingTask"("hotelId", "status");
CREATE INDEX "HousekeepingTask_hotelId_roomId_idx" ON "HousekeepingTask"("hotelId", "roomId");
CREATE INDEX "MaintenanceTicket_hotelId_status_idx" ON "MaintenanceTicket"("hotelId", "status");
CREATE INDEX "MaintenanceTicket_hotelId_roomId_idx" ON "MaintenanceTicket"("hotelId", "roomId");
CREATE INDEX "MenuCategory_hotelId_idx" ON "MenuCategory"("hotelId");
CREATE INDEX "MenuItem_hotelId_categoryId_isActive_idx" ON "MenuItem"("hotelId", "categoryId", "isActive");
CREATE INDEX "MenuItem_hotelId_isActive_idx" ON "MenuItem"("hotelId", "isActive");
CREATE INDEX "Order_hotelId_createdAt_idx" ON "Order"("hotelId", "createdAt");
CREATE INDEX "Order_hotelId_folioId_idx" ON "Order"("hotelId", "folioId");
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");
CREATE INDEX "InventoryItem_hotelId_category_idx" ON "InventoryItem"("hotelId", "category");
CREATE INDEX "InventoryItem_hotelId_isActive_idx" ON "InventoryItem"("hotelId", "isActive");
CREATE INDEX "StockMovement_hotelId_createdAt_idx" ON "StockMovement"("hotelId", "createdAt");
CREATE INDEX "StockMovement_hotelId_inventoryItemId_idx" ON "StockMovement"("hotelId", "inventoryItemId");
CREATE INDEX "Purchase_hotelId_purchaseDate_idx" ON "Purchase"("hotelId", "purchaseDate");
CREATE INDEX "Purchase_hotelId_inventoryItemId_idx" ON "Purchase"("hotelId", "inventoryItemId");
CREATE INDEX "Wastage_hotelId_createdAt_idx" ON "Wastage"("hotelId", "createdAt");
CREATE INDEX "Wastage_hotelId_inventoryItemId_idx" ON "Wastage"("hotelId", "inventoryItemId");
CREATE INDEX "Expense_hotelId_createdAt_idx" ON "Expense"("hotelId", "createdAt");
CREATE INDEX "Expense_hotelId_status_idx" ON "Expense"("hotelId", "status");
CREATE INDEX "Notification_hotelId_isRead_idx" ON "Notification"("hotelId", "isRead");
CREATE INDEX "Notification_hotelId_userId_isRead_idx" ON "Notification"("hotelId", "userId", "isRead");
CREATE INDEX "Notification_hotelId_createdAt_idx" ON "Notification"("hotelId", "createdAt");
CREATE INDEX "AuditLog_hotelId_createdAt_idx" ON "AuditLog"("hotelId", "createdAt");
CREATE INDEX "AuditLog_hotelId_entity_entityId_idx" ON "AuditLog"("hotelId", "entity", "entityId");

-- Replace foreign keys whose target now includes tenant ownership. Existing
-- user-only relations (creator, cashier, assignee, etc.) remain intact.
ALTER TABLE "Room" DROP CONSTRAINT "Room_roomTypeId_fkey";
ALTER TABLE "Room" ADD CONSTRAINT "Room_roomTypeId_hotelId_fkey"
  FOREIGN KEY ("roomTypeId", "hotelId") REFERENCES "RoomType"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Reservation" DROP CONSTRAINT "Reservation_guestId_fkey";
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_guestId_hotelId_fkey"
  FOREIGN KEY ("guestId", "hotelId") REFERENCES "Guest"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReservationRoom" DROP CONSTRAINT "ReservationRoom_reservationId_fkey";
ALTER TABLE "ReservationRoom" ADD CONSTRAINT "ReservationRoom_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "Reservation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Folio" DROP CONSTRAINT "Folio_guestId_fkey";
ALTER TABLE "Folio" DROP CONSTRAINT "Folio_reservationId_fkey";
ALTER TABLE "Folio" ADD CONSTRAINT "Folio_guestId_hotelId_fkey"
  FOREIGN KEY ("guestId", "hotelId") REFERENCES "Guest"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Folio" ADD CONSTRAINT "Folio_reservationId_hotelId_fkey"
  FOREIGN KEY ("reservationId", "hotelId") REFERENCES "Reservation"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "FolioItem" DROP CONSTRAINT "FolioItem_folioId_fkey";
ALTER TABLE "FolioItem" ADD CONSTRAINT "FolioItem_folioId_fkey"
  FOREIGN KEY ("folioId") REFERENCES "Folio"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Payment" DROP CONSTRAINT "Payment_folioId_fkey";
ALTER TABLE "Payment" DROP CONSTRAINT "Payment_paymentMethodId_fkey";
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_folioId_hotelId_fkey"
  FOREIGN KEY ("folioId", "hotelId") REFERENCES "Folio"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_paymentMethodId_hotelId_fkey"
  FOREIGN KEY ("paymentMethodId", "hotelId") REFERENCES "PaymentMethod"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "HousekeepingTask" DROP CONSTRAINT "HousekeepingTask_roomId_fkey";
ALTER TABLE "HousekeepingTask" ADD CONSTRAINT "HousekeepingTask_roomId_hotelId_fkey"
  FOREIGN KEY ("roomId", "hotelId") REFERENCES "Room"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaintenanceTicket" DROP CONSTRAINT "MaintenanceTicket_roomId_fkey";
ALTER TABLE "MaintenanceTicket" ADD CONSTRAINT "MaintenanceTicket_roomId_hotelId_fkey"
  FOREIGN KEY ("roomId", "hotelId") REFERENCES "Room"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MenuItem" DROP CONSTRAINT "MenuItem_categoryId_fkey";
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_categoryId_hotelId_fkey"
  FOREIGN KEY ("categoryId", "hotelId") REFERENCES "MenuCategory"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Order" DROP CONSTRAINT "Order_paymentMethodId_fkey";
ALTER TABLE "Order" DROP CONSTRAINT "Order_folioId_fkey";
ALTER TABLE "Order" ADD CONSTRAINT "Order_paymentMethodId_hotelId_fkey"
  FOREIGN KEY ("paymentMethodId", "hotelId") REFERENCES "PaymentMethod"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_folioId_hotelId_fkey"
  FOREIGN KEY ("folioId", "hotelId") REFERENCES "Folio"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "OrderItem" DROP CONSTRAINT "OrderItem_orderId_fkey";
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StockMovement" DROP CONSTRAINT "StockMovement_inventoryItemId_fkey";
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_inventoryItemId_hotelId_fkey"
  FOREIGN KEY ("inventoryItemId", "hotelId") REFERENCES "InventoryItem"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Purchase" DROP CONSTRAINT "Purchase_inventoryItemId_fkey";
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_inventoryItemId_hotelId_fkey"
  FOREIGN KEY ("inventoryItemId", "hotelId") REFERENCES "InventoryItem"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Wastage" DROP CONSTRAINT "Wastage_inventoryItemId_fkey";
ALTER TABLE "Wastage" ADD CONSTRAINT "Wastage_inventoryItemId_hotelId_fkey"
  FOREIGN KEY ("inventoryItemId", "hotelId") REFERENCES "InventoryItem"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_userId_fkey";
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Tenant ownership FKs. All required tenant columns were backfilled above.
ALTER TABLE "HotelMembership" ADD CONSTRAINT "HotelMembership_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HotelMembership" ADD CONSTRAINT "HotelMembership_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomType" ADD CONSTRAINT "RoomType_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Room" ADD CONSTRAINT "Room_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Guest" ADD CONSTRAINT "Guest_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Reservation" ADD CONSTRAINT "Reservation_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Folio" ADD CONSTRAINT "Folio_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "HousekeepingTask" ADD CONSTRAINT "HousekeepingTask_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MaintenanceTicket" ADD CONSTRAINT "MaintenanceTicket_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MenuCategory" ADD CONSTRAINT "MenuCategory_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Order" ADD CONSTRAINT "Order_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "InventoryItem" ADD CONSTRAINT "InventoryItem_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Wastage" ADD CONSTRAINT "Wastage_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_hotelId_fkey"
  FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
