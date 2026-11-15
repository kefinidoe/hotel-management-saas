-- Flexible multi-tenant pricing engine.
--
-- Additive only: every statement creates new objects. Nothing existing is
-- dropped, renamed or rewritten, so existing room types, reservations, folios and
-- reports keep their current data and behaviour. Hotels that do not configure the
-- new tables stay on RoomType.baseRate (pricingModel = LEGACY_BASE_RATE).
--
-- Tenant isolation is enforced structurally: every pricing table carries hotelId,
-- references to sibling pricing tables are COMPOSITE (id, hotelId) foreign keys,
-- and uniqueness is scoped per hotel.

-- Enums ---------------------------------------------------------------------
CREATE TYPE "MealPlanPricingBasis" AS ENUM ('PER_PERSON_PER_NIGHT', 'PER_ROOM_PER_NIGHT', 'PER_PERSON_PER_STAY', 'PER_ROOM_PER_STAY');
CREATE TYPE "RateAdjustmentKind" AS ENUM ('SEASONAL', 'WEEKEND');
CREATE TYPE "RateAdjustmentType" AS ENUM ('PERCENT', 'FIXED_PER_NIGHT', 'SET_RATE');
CREATE TYPE "ChildChargeType" AS ENUM ('FIXED_PER_NIGHT', 'PERCENT_OF_ADULT');
CREATE TYPE "TaxBasis" AS ENUM ('PERCENT', 'FIXED');
CREATE TYPE "TaxAppliesTo" AS ENUM ('ROOM', 'MEALS', 'ALL');
CREATE TYPE "TaxChargeBasis" AS ENUM ('PER_NIGHT', 'PER_STAY', 'PER_PERSON_PER_NIGHT');
CREATE TYPE "PricingModel" AS ENUM ('ROOM_TYPE_OCCUPANCY', 'LEGACY_BASE_RATE');

-- Occupancy options ---------------------------------------------------------
CREATE TABLE "OccupancyType" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "minAdults" INTEGER NOT NULL DEFAULT 1,
    "maxAdults" INTEGER NOT NULL DEFAULT 4,
    "maxChildren" INTEGER NOT NULL DEFAULT 0,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OccupancyType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OccupancyType_id_hotelId_key" ON "OccupancyType"("id", "hotelId");
CREATE UNIQUE INDEX "OccupancyType_hotelId_name_key" ON "OccupancyType"("hotelId", "name");
CREATE INDEX "OccupancyType_hotelId_isActive_idx" ON "OccupancyType"("hotelId", "isActive");

ALTER TABLE "OccupancyType" ADD CONSTRAINT "OccupancyType_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Per-occupancy room rates --------------------------------------------------
CREATE TABLE "RoomTypeOccupancy" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "occupancyTypeId" TEXT NOT NULL,
    "nightlyRate" DECIMAL(10,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RoomTypeOccupancy_pkey" PRIMARY KEY ("id"),
    -- A rate can never be negative; zero is rejected by the API where a positive
    -- rate is required, but is allowed here for "included" occupancies.
    CONSTRAINT "RoomTypeOccupancy_nightlyRate_nonnegative" CHECK ("nightlyRate" >= 0)
);

CREATE UNIQUE INDEX "RoomTypeOccupancy_roomTypeId_occupancyTypeId_key" ON "RoomTypeOccupancy"("roomTypeId", "occupancyTypeId");
CREATE INDEX "RoomTypeOccupancy_hotelId_roomTypeId_idx" ON "RoomTypeOccupancy"("hotelId", "roomTypeId");
CREATE INDEX "RoomTypeOccupancy_occupancyTypeId_hotelId_idx" ON "RoomTypeOccupancy"("occupancyTypeId", "hotelId");

ALTER TABLE "RoomTypeOccupancy" ADD CONSTRAINT "RoomTypeOccupancy_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomTypeOccupancy" ADD CONSTRAINT "RoomTypeOccupancy_roomTypeId_hotelId_fkey"
    FOREIGN KEY ("roomTypeId", "hotelId") REFERENCES "RoomType"("id", "hotelId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RoomTypeOccupancy" ADD CONSTRAINT "RoomTypeOccupancy_occupancyTypeId_hotelId_fkey"
    FOREIGN KEY ("occupancyTypeId", "hotelId") REFERENCES "OccupancyType"("id", "hotelId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Meal plans ----------------------------------------------------------------
CREATE TABLE "MealPlanConfig" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "includedItems" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pricingBasis" "MealPlanPricingBasis" NOT NULL DEFAULT 'PER_PERSON_PER_NIGHT',
    "charge" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveTo" TIMESTAMP(3),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MealPlanConfig_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MealPlanConfig_charge_nonnegative" CHECK ("charge" >= 0),
    CONSTRAINT "MealPlanConfig_effective_dates" CHECK (
        "effectiveFrom" IS NULL OR "effectiveTo" IS NULL OR "effectiveFrom" < "effectiveTo"
    )
);

CREATE UNIQUE INDEX "MealPlanConfig_id_hotelId_key" ON "MealPlanConfig"("id", "hotelId");
CREATE UNIQUE INDEX "MealPlanConfig_hotelId_name_key" ON "MealPlanConfig"("hotelId", "name");
CREATE INDEX "MealPlanConfig_hotelId_isActive_idx" ON "MealPlanConfig"("hotelId", "isActive");

ALTER TABLE "MealPlanConfig" ADD CONSTRAINT "MealPlanConfig_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "MealPlanRoomType" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "mealPlanId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    CONSTRAINT "MealPlanRoomType_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MealPlanRoomType_mealPlanId_roomTypeId_key" ON "MealPlanRoomType"("mealPlanId", "roomTypeId");
CREATE INDEX "MealPlanRoomType_hotelId_roomTypeId_idx" ON "MealPlanRoomType"("hotelId", "roomTypeId");

ALTER TABLE "MealPlanRoomType" ADD CONSTRAINT "MealPlanRoomType_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MealPlanRoomType" ADD CONSTRAINT "MealPlanRoomType_mealPlanId_hotelId_fkey"
    FOREIGN KEY ("mealPlanId", "hotelId") REFERENCES "MealPlanConfig"("id", "hotelId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MealPlanRoomType" ADD CONSTRAINT "MealPlanRoomType_roomTypeId_hotelId_fkey"
    FOREIGN KEY ("roomTypeId", "hotelId") REFERENCES "RoomType"("id", "hotelId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seasonal / weekend adjustments -------------------------------------------
CREATE TABLE "RateAdjustment" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "roomTypeId" TEXT,
    "name" TEXT NOT NULL,
    "kind" "RateAdjustmentKind" NOT NULL,
    "adjustmentType" "RateAdjustmentType" NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "daysOfWeek" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
    "startDate" TIMESTAMP(3),
    "endDate" TIMESTAMP(3),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RateAdjustment_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "RateAdjustment_date_range" CHECK (
        "startDate" IS NULL OR "endDate" IS NULL OR "startDate" <= "endDate"
    ),
    CONSTRAINT "RateAdjustment_days_of_week" CHECK (
        "daysOfWeek" <@ ARRAY[0,1,2,3,4,5,6]::INTEGER[]
    )
);

CREATE UNIQUE INDEX "RateAdjustment_id_hotelId_key" ON "RateAdjustment"("id", "hotelId");
CREATE INDEX "RateAdjustment_hotelId_kind_isActive_idx" ON "RateAdjustment"("hotelId", "kind", "isActive");
CREATE INDEX "RateAdjustment_hotelId_roomTypeId_idx" ON "RateAdjustment"("hotelId", "roomTypeId");

ALTER TABLE "RateAdjustment" ADD CONSTRAINT "RateAdjustment_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RateAdjustment" ADD CONSTRAINT "RateAdjustment_roomTypeId_hotelId_fkey"
    FOREIGN KEY ("roomTypeId", "hotelId") REFERENCES "RoomType"("id", "hotelId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Extra beds ----------------------------------------------------------------
CREATE TABLE "ExtraBedRule" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "roomTypeId" TEXT,
    "name" TEXT NOT NULL,
    "nightlyRate" DECIMAL(10,2) NOT NULL,
    "childRate" DECIMAL(10,2),
    "maxPerRoom" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ExtraBedRule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ExtraBedRule_nightlyRate_nonnegative" CHECK ("nightlyRate" >= 0),
    CONSTRAINT "ExtraBedRule_maxPerRoom_positive" CHECK ("maxPerRoom" > 0)
);

CREATE UNIQUE INDEX "ExtraBedRule_id_hotelId_key" ON "ExtraBedRule"("id", "hotelId");
CREATE INDEX "ExtraBedRule_hotelId_isActive_idx" ON "ExtraBedRule"("hotelId", "isActive");

ALTER TABLE "ExtraBedRule" ADD CONSTRAINT "ExtraBedRule_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExtraBedRule" ADD CONSTRAINT "ExtraBedRule_roomTypeId_hotelId_fkey"
    FOREIGN KEY ("roomTypeId", "hotelId") REFERENCES "RoomType"("id", "hotelId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Child pricing -------------------------------------------------------------
CREATE TABLE "ChildPricingRule" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "minAge" INTEGER NOT NULL DEFAULT 0,
    "maxAge" INTEGER NOT NULL DEFAULT 12,
    "chargeType" "ChildChargeType" NOT NULL DEFAULT 'FIXED_PER_NIGHT',
    "amount" DECIMAL(10,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ChildPricingRule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ChildPricingRule_age_band" CHECK ("minAge" >= 0 AND "maxAge" >= "minAge"),
    CONSTRAINT "ChildPricingRule_amount_nonnegative" CHECK ("amount" >= 0)
);

CREATE UNIQUE INDEX "ChildPricingRule_id_hotelId_key" ON "ChildPricingRule"("id", "hotelId");
CREATE INDEX "ChildPricingRule_hotelId_isActive_idx" ON "ChildPricingRule"("hotelId", "isActive");

ALTER TABLE "ChildPricingRule" ADD CONSTRAINT "ChildPricingRule_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Taxes and service charges ------------------------------------------------
CREATE TABLE "TaxRule" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "basis" "TaxBasis" NOT NULL DEFAULT 'PERCENT',
    "amount" DECIMAL(10,2) NOT NULL,
    "appliesTo" "TaxAppliesTo" NOT NULL DEFAULT 'ALL',
    "chargeBasis" "TaxChargeBasis" NOT NULL DEFAULT 'PER_STAY',
    "isInclusive" BOOLEAN NOT NULL DEFAULT false,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TaxRule_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "TaxRule_amount_nonnegative" CHECK ("amount" >= 0)
);

CREATE UNIQUE INDEX "TaxRule_id_hotelId_key" ON "TaxRule"("id", "hotelId");
CREATE INDEX "TaxRule_hotelId_isActive_idx" ON "TaxRule"("hotelId", "isActive");

ALTER TABLE "TaxRule" ADD CONSTRAINT "TaxRule_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Feature switches ----------------------------------------------------------
CREATE TABLE "HotelPricingSettings" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "pricingModel" "PricingModel" NOT NULL DEFAULT 'LEGACY_BASE_RATE',
    "useOccupancyRates" BOOLEAN NOT NULL DEFAULT false,
    "useMealPlans" BOOLEAN NOT NULL DEFAULT false,
    "useSeasonalPricing" BOOLEAN NOT NULL DEFAULT false,
    "useWeekendPricing" BOOLEAN NOT NULL DEFAULT false,
    "useChildPricing" BOOLEAN NOT NULL DEFAULT false,
    "useExtraBeds" BOOLEAN NOT NULL DEFAULT false,
    "useTaxes" BOOLEAN NOT NULL DEFAULT false,
    "pricesIncludeTax" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "HotelPricingSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HotelPricingSettings_hotelId_key" ON "HotelPricingSettings"("hotelId");

ALTER TABLE "HotelPricingSettings" ADD CONSTRAINT "HotelPricingSettings_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Reservation price snapshots ----------------------------------------------
CREATE TABLE "ReservationPriceSnapshot" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "pricingModel" "PricingModel" NOT NULL,
    "currency" TEXT NOT NULL,
    "occupancyName" TEXT,
    "mealPlanName" TEXT,
    "mealPlanBasis" "MealPlanPricingBasis",
    "nightlyRate" DECIMAL(10,2) NOT NULL,
    "nights" INTEGER NOT NULL,
    "adults" INTEGER NOT NULL DEFAULT 1,
    "children" INTEGER NOT NULL DEFAULT 0,
    "extraBeds" INTEGER NOT NULL DEFAULT 0,
    "roomTotal" DECIMAL(10,2) NOT NULL,
    "mealsTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "extrasTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "adjustmentsTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "discountTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "grandTotal" DECIMAL(10,2) NOT NULL,
    "breakdown" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReservationPriceSnapshot_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ReservationPriceSnapshot_nights_positive" CHECK ("nights" > 0),
    CONSTRAINT "ReservationPriceSnapshot_grandTotal_nonnegative" CHECK ("grandTotal" >= 0)
);

CREATE UNIQUE INDEX "ReservationPriceSnapshot_reservationId_key" ON "ReservationPriceSnapshot"("reservationId");
CREATE UNIQUE INDEX "ReservationPriceSnapshot_reservationId_hotelId_key" ON "ReservationPriceSnapshot"("reservationId", "hotelId");
CREATE INDEX "ReservationPriceSnapshot_hotelId_createdAt_idx" ON "ReservationPriceSnapshot"("hotelId", "createdAt");

ALTER TABLE "ReservationPriceSnapshot" ADD CONSTRAINT "ReservationPriceSnapshot_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReservationPriceSnapshot" ADD CONSTRAINT "ReservationPriceSnapshot_reservationId_hotelId_fkey"
    FOREIGN KEY ("reservationId", "hotelId") REFERENCES "Reservation"("id", "hotelId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ReservationPriceChange" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "previousTotal" DECIMAL(10,2) NOT NULL,
    "newTotal" DECIMAL(10,2) NOT NULL,
    "reason" TEXT,
    "breakdown" JSONB NOT NULL,
    "changedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReservationPriceChange_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReservationPriceChange_hotelId_reservationId_createdAt_idx" ON "ReservationPriceChange"("hotelId", "reservationId", "createdAt");

ALTER TABLE "ReservationPriceChange" ADD CONSTRAINT "ReservationPriceChange_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ReservationPriceChange" ADD CONSTRAINT "ReservationPriceChange_reservationId_hotelId_fkey"
    FOREIGN KEY ("reservationId", "hotelId") REFERENCES "Reservation"("id", "hotelId") ON DELETE CASCADE ON UPDATE CASCADE;
