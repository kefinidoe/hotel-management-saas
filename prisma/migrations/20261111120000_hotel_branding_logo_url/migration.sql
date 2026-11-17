-- Keep the legacy logo column and copy existing values without altering them.
ALTER TABLE "Hotel" ADD COLUMN "logoUrl" TEXT;
UPDATE "Hotel" SET "logoUrl" = "logo" WHERE "logo" IS NOT NULL;
