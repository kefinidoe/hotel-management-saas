-- Additive foundation only; existing pricing remains authoritative.
CREATE TYPE "MealPlanCode" AS ENUM ('ROOM_ONLY', 'BED_BREAKFAST', 'HALF_BOARD', 'FULL_BOARD', 'ALL_INCLUSIVE');

ALTER TABLE "RoomType"
  ADD COLUMN "maxAdults" INTEGER NOT NULL DEFAULT 2,
  ADD COLUMN "maxChildren" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "extraAdultFee" DECIMAL(10,2) NOT NULL DEFAULT 0;
-- Preserve each existing type's adult capacity; legacy capacity remains unchanged.
UPDATE "RoomType" SET "maxAdults" = "capacity";

CREATE TABLE "HotelMealPricing" (
  "id" TEXT NOT NULL,
  "hotelId" TEXT NOT NULL,
  "mealPlan" "MealPlanCode" NOT NULL,
  "adultSurcharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "childSurcharge" DECIMAL(10,2) NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "HotelMealPricing_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HotelMealPricing_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "HotelMealPricing_nonnegative" CHECK ("adultSurcharge" >= 0 AND "childSurcharge" >= 0)
);
CREATE UNIQUE INDEX "HotelMealPricing_hotelId_mealPlan_key" ON "HotelMealPricing"("hotelId", "mealPlan");
