-- Additive only: retain original amounts, statuses and references, including
-- historic duplicate references. Duplicate groups remain unnormalised for review.
ALTER TABLE "Payment" ADD COLUMN "normalizedReference" TEXT;
ALTER TABLE "Payment" ADD COLUMN "reversalOfId" TEXT;
ALTER TABLE "Payment" ADD COLUMN "reversalReason" TEXT;

WITH unique_references AS (
  SELECT "hotelId", NULLIF(translate(translate(reference, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13), ''), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '') AS normalized
  FROM "Payment"
  WHERE NULLIF(translate(translate(reference, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13), ''), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '') IS NOT NULL
  GROUP BY "hotelId", NULLIF(translate(translate(reference, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13), ''), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '')
  HAVING count(*) = 1
)
UPDATE "Payment" p SET "normalizedReference" = u.normalized
FROM unique_references u
WHERE p."hotelId" = u."hotelId" AND NULLIF(translate(translate(p.reference, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13), ''), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '') = u.normalized;

CREATE UNIQUE INDEX "Payment_hotel_normalized_reference_unique"
  ON "Payment" ("hotelId", "normalizedReference") WHERE "normalizedReference" IS NOT NULL;
CREATE UNIQUE INDEX "Payment_reversalOfId_key" ON "Payment" ("reversalOfId");
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_reversal_original_fkey"
  FOREIGN KEY ("reversalOfId", "hotelId") REFERENCES "Payment" (id, "hotelId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- The application lock coordinates new business writes. This trigger covers
-- every database writer and refuses a new use of an unresolved legacy duplicate.
-- The unique index arbitrates concurrent new references.
CREATE FUNCTION "payment_reference_normalize"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."normalizedReference" := NULLIF(translate(translate(NEW.reference, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13), ''), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '');
  IF NEW."normalizedReference" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Payment" p WHERE p."hotelId" = NEW."hotelId"
      AND p."normalizedReference" IS NULL
      AND NULLIF(translate(translate(p.reference, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13), ''), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '') = NEW."normalizedReference"
      AND p.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'Payment reference is already used by this hotel'
      USING ERRCODE = '23505', CONSTRAINT = 'Payment_hotel_normalized_reference_unique';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Payment_reference_normalize" BEFORE INSERT OR UPDATE OF reference, "hotelId", "normalizedReference"
  ON "Payment" FOR EACH ROW EXECUTE FUNCTION "payment_reference_normalize"();
