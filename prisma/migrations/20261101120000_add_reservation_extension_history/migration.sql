-- Auditable stay extensions.
--
-- Why a dedicated table instead of reusing "ReservationPriceChange":
--   ReservationPriceChange means "the price of the same stay was re-agreed",
--   with a previousTotal/newTotal for the whole booking and a version bump of
--   the frozen snapshot. An extension does not re-agree the stay: it leaves the
--   original agreement (snapshot version 1..N) untouched and adds a bounded
--   number of extra nights at an explicitly agreed rate. Recording that as a
--   price change would give the folio, the snapshot and the change row three
--   different stories, and would make the pricing history claim a reprice that
--   never happened. Extensions therefore get their own append-only row.
--
-- Additive and safe for existing data:
--   * one new table, no column is added to, rewritten in, or dropped from any
--     existing table;
--   * existing reservations simply have no extension rows;
--   * financial evidence is protected like the pricing rows: neither the
--     reservation nor the hotel can be deleted while an extension exists.

CREATE TABLE "ReservationExtension" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "reservationId" TEXT NOT NULL,
    "previousCheckOut" TIMESTAMP(3) NOT NULL,
    "newCheckOut" TIMESTAMP(3) NOT NULL,
    "additionalNights" INTEGER NOT NULL,
    "nightlyRate" DECIMAL(10,2) NOT NULL,
    "additionalCharge" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "rooms" JSONB NOT NULL,
    "folioId" TEXT NOT NULL,
    "folioItemIds" JSONB NOT NULL,
    "priceVersion" INTEGER,
    "note" TEXT,
    "approvedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReservationExtension_pkey" PRIMARY KEY ("id")
);

-- Shape guards: an extension must move the checkout forward by at least one
-- night and must describe a non-negative charge.
ALTER TABLE "ReservationExtension"
    ADD CONSTRAINT "ReservationExtension_nights_positive" CHECK ("additionalNights" >= 1),
    ADD CONSTRAINT "ReservationExtension_checkout_moves_forward" CHECK ("newCheckOut" > "previousCheckOut"),
    ADD CONSTRAINT "ReservationExtension_charge_non_negative" CHECK ("additionalCharge" >= 0),
    ADD CONSTRAINT "ReservationExtension_rate_non_negative" CHECK ("nightlyRate" >= 0);

-- A repeated or concurrent request that starts from the same checkout moment
-- can only be recorded once, so the same nights cannot be charged twice.
CREATE UNIQUE INDEX "ReservationExtension_reservationId_previousCheckOut_key"
    ON "ReservationExtension"("reservationId", "previousCheckOut");

CREATE INDEX "ReservationExtension_hotelId_reservationId_createdAt_idx"
    ON "ReservationExtension"("hotelId", "reservationId", "createdAt");

CREATE INDEX "ReservationExtension_hotelId_createdAt_idx"
    ON "ReservationExtension"("hotelId", "createdAt");

-- Tenant-scoped parents. RESTRICT (the PostgreSQL default for NO ACTION is
-- weaker in intent, so it is stated explicitly): deleting a hotel or a
-- reservation can never cascade away what a guest was charged for their
-- extension.
ALTER TABLE "ReservationExtension"
    ADD CONSTRAINT "ReservationExtension_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReservationExtension"
    ADD CONSTRAINT "ReservationExtension_reservationId_hotelId_fkey"
    FOREIGN KEY ("reservationId", "hotelId") REFERENCES "Reservation"("id", "hotelId")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReservationExtension"
    ADD CONSTRAINT "ReservationExtension_approvedById_fkey"
    FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Child-side index for the (reservationId, hotelId) composite foreign key.
CREATE INDEX "ReservationExtension_reservationId_hotelId_idx"
    ON "ReservationExtension"("reservationId", "hotelId");
