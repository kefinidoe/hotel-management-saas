-- Restaurant charge-to-room idempotency.
--
-- A room charge settles no money: it creates an OPEN order, a folio item and a
-- guest balance, so it must never be recorded as a Payment. `Order` is the
-- durable record of the sale, therefore the retry identity lives on `Order`.
--
-- The three columns stay nullable so every historical order and every
-- non-idempotent order stays valid. PostgreSQL treats NULLs as distinct in a
-- unique index, so rows without a key never collide.
--
-- Safe on a populated table: the columns are new, so no backfill, rewrite or
-- duplicate check is required before the unique index is created.
--
-- Re-runnable: every statement is guarded with IF NOT EXISTS or an explicit
-- catalog check, so a deploy that dies half-way can be retried without manual
-- repair. Nothing here deletes or rewrites existing rows.

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "idempotencyOperation" TEXT,
  ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT,
  ADD COLUMN IF NOT EXISTS "requestFingerprint" TEXT;

-- Prisma: @@unique([hotelId, idempotencyOperation, idempotencyKey])
-- Operations are namespaced per hotel, so the same client key can be reused by
-- another hotel or another operation without colliding.
CREATE UNIQUE INDEX IF NOT EXISTS "Order_hotelId_idempotencyOperation_idempotencyKey_key"
  ON "Order"("hotelId", "idempotencyOperation", "idempotencyKey");

-- The API always writes the triple together (see
-- app/api/restaurant/charge-to-room/route.ts). Enforce that invariant in the
-- database rather than trusting every future writer: a partially populated
-- tuple would silently weaken the unique guard because NULLs are distinct.
-- Prisma does not model CHECK constraints, so this is invisible to the
-- generated client but is still enforced by PostgreSQL.
DO $order_idempotency_check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'Order_idempotency_triple_check'
      AND conrelid = '"Order"'::regclass
  ) THEN
    ALTER TABLE "Order"
      ADD CONSTRAINT "Order_idempotency_triple_check" CHECK (
        (
          "idempotencyOperation" IS NULL
          AND "idempotencyKey" IS NULL
          AND "requestFingerprint" IS NULL
        )
        OR (
          "idempotencyOperation" IS NOT NULL
          AND "idempotencyKey" IS NOT NULL
          AND "requestFingerprint" IS NOT NULL
          AND btrim("idempotencyOperation") <> ''
          AND btrim("idempotencyKey") <> ''
          AND btrim("requestFingerprint") <> ''
        )
      );
  END IF;
END
$order_idempotency_check$;
