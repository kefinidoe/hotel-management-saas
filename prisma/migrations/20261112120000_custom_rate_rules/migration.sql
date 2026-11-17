-- These rules are opt-in and do not change pricing for existing properties.
ALTER TABLE "Hotel" ADD COLUMN "useCustomRateRules" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "MealPlanRate" (
  "id" TEXT NOT NULL, "hotelId" TEXT NOT NULL, "code" TEXT NOT NULL,
  "name" TEXT NOT NULL, "pricePerNight" DOUBLE PRECISION NOT NULL,
  "perGuest" BOOLEAN NOT NULL DEFAULT true, "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "MealPlanRate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MealPlanRate_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MealPlanRate_price_check" CHECK ("pricePerNight" >= 0 AND "pricePerNight" <= 99999999.99)
);
CREATE UNIQUE INDEX "MealPlanRate_hotelId_code_key" ON "MealPlanRate"("hotelId", "code");
CREATE INDEX "MealPlanRate_hotelId_isActive_idx" ON "MealPlanRate"("hotelId", "isActive");
CREATE TABLE "OccupancyRateRule" (
  "id" TEXT NOT NULL, "hotelId" TEXT NOT NULL, "occupancyType" TEXT NOT NULL, "label" TEXT NOT NULL,
  "includedAdults" INTEGER NOT NULL, "surchargeAmount" DOUBLE PRECISION NOT NULL, "extraAdultRate" DOUBLE PRECISION NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "OccupancyRateRule_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OccupancyRateRule_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "OccupancyRateRule_includedAdults_check" CHECK ("includedAdults" >= 1),
  CONSTRAINT "OccupancyRateRule_amounts_check" CHECK ("surchargeAmount" >= 0 AND "surchargeAmount" <= 99999999.99 AND "extraAdultRate" >= 0 AND "extraAdultRate" <= 99999999.99)
);
CREATE UNIQUE INDEX "OccupancyRateRule_hotelId_occupancyType_key" ON "OccupancyRateRule"("hotelId", "occupancyType");
CREATE INDEX "OccupancyRateRule_hotelId_isActive_idx" ON "OccupancyRateRule"("hotelId", "isActive");

-- Snapshots identify this formula so unsupported repricing and extensions fail closed.
ALTER TYPE "PricingModel" ADD VALUE 'CUSTOM_RATE_RULES';
