-- Pricing version history and financial-record retention.
--
-- Additive and safe for existing data:
--   * existing snapshots become version 1 (the original agreement),
--   * existing price changes keep their totals and get null version links,
--   * no row is rewritten and no column is dropped.
--
-- It also makes the evidence durable:
--   * snapshots are append-only (a trigger rejects UPDATE),
--   * pricing rows are never removed by cascading from a reservation or a hotel
--     (RESTRICT instead of CASCADE), so removing a reservation or a hotel cannot
--     silently erase what a guest was charged.

-- 1. Versioned snapshots -----------------------------------------------------
ALTER TABLE "ReservationPriceSnapshot"
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "ReservationPriceSnapshot"
    ADD CONSTRAINT "ReservationPriceSnapshot_version_positive" CHECK ("version" >= 1);

-- The old "one snapshot per reservation" uniqueness is what made repricing
-- destructive; versions replace it.
DROP INDEX IF EXISTS "ReservationPriceSnapshot_reservationId_key";
DROP INDEX IF EXISTS "ReservationPriceSnapshot_reservationId_hotelId_key";

CREATE UNIQUE INDEX "ReservationPriceSnapshot_reservationId_version_key"
    ON "ReservationPriceSnapshot"("reservationId", "version");

CREATE INDEX "ReservationPriceSnapshot_reservationId_version_idx"
    ON "ReservationPriceSnapshot"("reservationId", "version" DESC);

-- 2. Link each price change to the versions it moved between ------------------
ALTER TABLE "ReservationPriceChange"
    ADD COLUMN "previousVersion" INTEGER,
    ADD COLUMN "newVersion" INTEGER;

-- 3. Retention: no cascading deletion of financial evidence -------------------
ALTER TABLE "ReservationPriceSnapshot"
    DROP CONSTRAINT IF EXISTS "ReservationPriceSnapshot_reservationId_hotelId_fkey";
ALTER TABLE "ReservationPriceSnapshot"
    ADD CONSTRAINT "ReservationPriceSnapshot_reservationId_hotelId_fkey"
    FOREIGN KEY ("reservationId", "hotelId") REFERENCES "Reservation"("id", "hotelId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReservationPriceSnapshot"
    DROP CONSTRAINT IF EXISTS "ReservationPriceSnapshot_hotelId_fkey";
ALTER TABLE "ReservationPriceSnapshot"
    ADD CONSTRAINT "ReservationPriceSnapshot_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReservationPriceChange"
    DROP CONSTRAINT IF EXISTS "ReservationPriceChange_reservationId_hotelId_fkey";
ALTER TABLE "ReservationPriceChange"
    ADD CONSTRAINT "ReservationPriceChange_reservationId_hotelId_fkey"
    FOREIGN KEY ("reservationId", "hotelId") REFERENCES "Reservation"("id", "hotelId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReservationPriceChange"
    DROP CONSTRAINT IF EXISTS "ReservationPriceChange_hotelId_fkey";
ALTER TABLE "ReservationPriceChange"
    ADD CONSTRAINT "ReservationPriceChange_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Immutability: an agreed price version is written once and never updated --
CREATE OR REPLACE FUNCTION "ReservationPriceSnapshot_immutable"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION
        'ReservationPriceSnapshot rows are immutable: append a new version instead of updating version %',
        OLD."version"
        USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "ReservationPriceSnapshot_immutable" ON "ReservationPriceSnapshot";
CREATE TRIGGER "ReservationPriceSnapshot_immutable"
    BEFORE UPDATE ON "ReservationPriceSnapshot"
    FOR EACH ROW EXECUTE FUNCTION "ReservationPriceSnapshot_immutable"();
