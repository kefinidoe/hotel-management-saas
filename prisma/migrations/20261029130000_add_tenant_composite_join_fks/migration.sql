-- Tenant-scoped composite join keys.
--
-- ReservationRoom, Recipe, RecipeIngredient and OrderItem are join/dependent
-- rows whose tenant was previously implied by their parent. Single-column
-- foreign keys prove the parent exists but not that both parents agree on the
-- tenant, so a cross-tenant link could be created even though every individual
-- reference was valid. This migration copies the tenant key from the
-- authoritative parent and then replaces the single-column foreign keys with
-- composite (id, hotelId) foreign keys so PostgreSQL rejects such links.
--
-- Fail-closed by design: every data precondition runs BEFORE the first DDL
-- statement. A conflicted database is left untouched and the deploy aborts
-- with an actionable message instead of the migration silently "repairing"
-- data.
--
-- Re-runnable: columns, indexes, constraints and foreign keys are guarded, and
-- the backfills are idempotent. If a deploy is interrupted half-way, fixing the
-- reported problem and re-running this file converges on the same schema. The
-- guards do not weaken the prechecks: a conflicting row still aborts the run.
--
-- Deployment note: the added tenant columns are NOT NULL, so application writers
-- must be paused (or already be the version that supplies hotelId) across the
-- deploy. See docs/migration-strategy.md.

-- ---------------------------------------------------------------------------
-- Prechecks
-- ---------------------------------------------------------------------------

DO $reservation_room_precheck$
DECLARE
  cross_tenant bigint;
  orphaned bigint;
BEGIN
  SELECT count(*) INTO cross_tenant
  FROM "ReservationRoom" rr
  JOIN "Reservation" r ON r."id" = rr."reservationId"
  JOIN "Room" rm ON rm."id" = rr."roomId"
  WHERE r."hotelId" <> rm."hotelId";

  IF cross_tenant > 0 THEN
    RAISE EXCEPTION 'Tenant-integrity precheck failed: ReservationRoom has % row(s) whose reservation and room belong to different hotels', cross_tenant
      USING HINT = 'Resolve or remove each conflicting link with owner approval, then re-run this migration. Nothing was changed.';
  END IF;

  SELECT count(*) INTO orphaned
  FROM "ReservationRoom" rr
  LEFT JOIN "Reservation" r ON r."id" = rr."reservationId"
  LEFT JOIN "Room" rm ON rm."id" = rr."roomId"
  WHERE r."id" IS NULL OR rm."id" IS NULL;

  IF orphaned > 0 THEN
    RAISE EXCEPTION 'Tenant-integrity precheck failed: ReservationRoom has % row(s) with a missing reservation or room', orphaned
      USING HINT = 'Nothing was changed. Restore the referenced rows or delete the orphaned links first.';
  END IF;
END
$reservation_room_precheck$;

DO $recipe_ingredient_precheck$
DECLARE
  cross_tenant bigint;
  orphaned bigint;
BEGIN
  SELECT count(*) INTO cross_tenant
  FROM "RecipeIngredient" ri
  JOIN "Recipe" rec ON rec."id" = ri."recipeId"
  JOIN "MenuItem" mi ON mi."id" = rec."menuItemId"
  JOIN "InventoryItem" ii ON ii."id" = ri."inventoryItemId"
  WHERE mi."hotelId" <> ii."hotelId";

  IF cross_tenant > 0 THEN
    RAISE EXCEPTION 'Tenant-integrity precheck failed: RecipeIngredient has % row(s) whose recipe and inventory item belong to different hotels', cross_tenant
      USING HINT = 'Resolve or remove each conflicting ingredient with owner approval, then re-run this migration. Nothing was changed.';
  END IF;

  SELECT count(*) INTO orphaned
  FROM "RecipeIngredient" ri
  LEFT JOIN "Recipe" rec ON rec."id" = ri."recipeId"
  LEFT JOIN "MenuItem" mi ON mi."id" = rec."menuItemId"
  LEFT JOIN "InventoryItem" ii ON ii."id" = ri."inventoryItemId"
  WHERE rec."id" IS NULL OR mi."id" IS NULL OR ii."id" IS NULL;

  IF orphaned > 0 THEN
    RAISE EXCEPTION 'Tenant-integrity precheck failed: RecipeIngredient has % row(s) with a missing recipe, menu item or inventory item', orphaned
      USING HINT = 'Nothing was changed. Restore the referenced rows or delete the orphaned ingredients first.';
  END IF;
END
$recipe_ingredient_precheck$;

-- OrderItem.menuItemId has no foreign key before this migration, so this is the
-- only guard against dangling as well as cross-tenant menu references.
DO $order_item_precheck$
DECLARE
  missing_menu_items bigint;
  cross_tenant bigint;
  orphaned_orders bigint;
BEGIN
  SELECT count(*) INTO orphaned_orders
  FROM "OrderItem" oi
  LEFT JOIN "Order" o ON o."id" = oi."orderId"
  WHERE o."id" IS NULL;

  IF orphaned_orders > 0 THEN
    RAISE EXCEPTION 'Tenant-integrity precheck failed: OrderItem has % row(s) with a missing order', orphaned_orders
      USING HINT = 'Nothing was changed. Restore the referenced order or delete the orphaned lines first.';
  END IF;

  SELECT
    count(*) FILTER (WHERE mi."id" IS NULL),
    count(*) FILTER (WHERE mi."id" IS NOT NULL AND mi."hotelId" <> o."hotelId")
  INTO missing_menu_items, cross_tenant
  FROM "OrderItem" oi
  JOIN "Order" o ON o."id" = oi."orderId"
  LEFT JOIN "MenuItem" mi ON mi."id" = oi."menuItemId"
  WHERE oi."menuItemId" IS NOT NULL;

  IF missing_menu_items > 0 THEN
    RAISE EXCEPTION 'Tenant-integrity precheck failed: OrderItem has % row(s) referencing a menu item that no longer exists', missing_menu_items
      USING HINT = 'Nothing was changed. Restore the menu item or clear the reference before re-running.';
  END IF;

  IF cross_tenant > 0 THEN
    RAISE EXCEPTION 'Tenant-integrity precheck failed: OrderItem has % row(s) referencing another hotel''s menu item', cross_tenant
      USING HINT = 'Resolve or remove each conflicting line with owner approval, then re-run this migration. Nothing was changed.';
  END IF;
END
$order_item_precheck$;

-- ---------------------------------------------------------------------------
-- ReservationRoom: tenant inherited from Reservation
-- ---------------------------------------------------------------------------

ALTER TABLE "ReservationRoom" ADD COLUMN IF NOT EXISTS "hotelId" TEXT;

-- Idempotent backfill: rows already carrying the correct tenant are untouched,
-- and a row can never be moved to a different tenant by re-running this file.
UPDATE "ReservationRoom" rr
SET "hotelId" = r."hotelId"
FROM "Reservation" r
WHERE r."id" = rr."reservationId"
  AND rr."hotelId" IS DISTINCT FROM r."hotelId";

ALTER TABLE "ReservationRoom" ALTER COLUMN "hotelId" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "ReservationRoom_hotelId_idx" ON "ReservationRoom"("hotelId");
-- Child-side index for the (roomId, hotelId) reference: without it every parent
-- Room delete/update scans the whole join table for dependent rows.
CREATE INDEX IF NOT EXISTS "ReservationRoom_roomId_hotelId_idx" ON "ReservationRoom"("roomId", "hotelId");

ALTER TABLE "ReservationRoom" DROP CONSTRAINT IF EXISTS "ReservationRoom_reservationId_fkey";
ALTER TABLE "ReservationRoom" DROP CONSTRAINT IF EXISTS "ReservationRoom_roomId_fkey";
ALTER TABLE "ReservationRoom" DROP CONSTRAINT IF EXISTS "ReservationRoom_reservationId_hotelId_fkey";
ALTER TABLE "ReservationRoom" DROP CONSTRAINT IF EXISTS "ReservationRoom_roomId_hotelId_fkey";
ALTER TABLE "ReservationRoom" ADD CONSTRAINT "ReservationRoom_reservationId_hotelId_fkey"
  FOREIGN KEY ("reservationId", "hotelId") REFERENCES "Reservation"("id", "hotelId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReservationRoom" ADD CONSTRAINT "ReservationRoom_roomId_hotelId_fkey"
  FOREIGN KEY ("roomId", "hotelId") REFERENCES "Room"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Recipe: tenant inherited from MenuItem
-- ---------------------------------------------------------------------------

ALTER TABLE "Recipe" ADD COLUMN IF NOT EXISTS "hotelId" TEXT;

UPDATE "Recipe" rec
SET "hotelId" = mi."hotelId"
FROM "MenuItem" mi
WHERE mi."id" = rec."menuItemId"
  AND rec."hotelId" IS DISTINCT FROM mi."hotelId";

ALTER TABLE "Recipe" ALTER COLUMN "hotelId" SET NOT NULL;

-- Referenced by the RecipeIngredient composite foreign key below.
CREATE UNIQUE INDEX IF NOT EXISTS "Recipe_id_hotelId_key" ON "Recipe"("id", "hotelId");
CREATE UNIQUE INDEX IF NOT EXISTS "Recipe_menuItemId_hotelId_key" ON "Recipe"("menuItemId", "hotelId");

ALTER TABLE "Recipe" DROP CONSTRAINT IF EXISTS "Recipe_menuItemId_fkey";
ALTER TABLE "Recipe" DROP CONSTRAINT IF EXISTS "Recipe_menuItemId_hotelId_fkey";
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_menuItemId_hotelId_fkey"
  FOREIGN KEY ("menuItemId", "hotelId") REFERENCES "MenuItem"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- RecipeIngredient: tenant inherited from Recipe
-- ---------------------------------------------------------------------------

ALTER TABLE "RecipeIngredient" ADD COLUMN IF NOT EXISTS "hotelId" TEXT;

UPDATE "RecipeIngredient" ri
SET "hotelId" = rec."hotelId"
FROM "Recipe" rec
WHERE rec."id" = ri."recipeId"
  AND ri."hotelId" IS DISTINCT FROM rec."hotelId";

ALTER TABLE "RecipeIngredient" ALTER COLUMN "hotelId" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "RecipeIngredient_inventoryItemId_hotelId_idx"
  ON "RecipeIngredient"("inventoryItemId", "hotelId");

ALTER TABLE "RecipeIngredient" DROP CONSTRAINT IF EXISTS "RecipeIngredient_recipeId_fkey";
ALTER TABLE "RecipeIngredient" DROP CONSTRAINT IF EXISTS "RecipeIngredient_inventoryItemId_fkey";
ALTER TABLE "RecipeIngredient" DROP CONSTRAINT IF EXISTS "RecipeIngredient_recipeId_hotelId_fkey";
ALTER TABLE "RecipeIngredient" DROP CONSTRAINT IF EXISTS "RecipeIngredient_inventoryItemId_hotelId_fkey";
ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_recipeId_hotelId_fkey"
  FOREIGN KEY ("recipeId", "hotelId") REFERENCES "Recipe"("id", "hotelId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecipeIngredient" ADD CONSTRAINT "RecipeIngredient_inventoryItemId_hotelId_fkey"
  FOREIGN KEY ("inventoryItemId", "hotelId") REFERENCES "InventoryItem"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- OrderItem: tenant inherited from Order
-- ---------------------------------------------------------------------------

ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "hotelId" TEXT;

UPDATE "OrderItem" oi
SET "hotelId" = o."hotelId"
FROM "Order" o
WHERE o."id" = oi."orderId"
  AND oi."hotelId" IS DISTINCT FROM o."hotelId";

ALTER TABLE "OrderItem" ALTER COLUMN "hotelId" SET NOT NULL;

-- menuItemId is nullable, so this index is only useful for rows that carry one.
CREATE INDEX IF NOT EXISTS "OrderItem_menuItemId_hotelId_idx" ON "OrderItem"("menuItemId", "hotelId");

ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS "OrderItem_orderId_fkey";
ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS "OrderItem_orderId_hotelId_fkey";
ALTER TABLE "OrderItem" DROP CONSTRAINT IF EXISTS "OrderItem_menuItemId_hotelId_fkey";
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_hotelId_fkey"
  FOREIGN KEY ("orderId", "hotelId") REFERENCES "Order"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_menuItemId_hotelId_fkey"
  FOREIGN KEY ("menuItemId", "hotelId") REFERENCES "MenuItem"("id", "hotelId") ON DELETE RESTRICT ON UPDATE CASCADE;
