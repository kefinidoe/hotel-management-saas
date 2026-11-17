-- Existing hotels remain on their current pricing model; existing price snapshots
-- are unchanged. This flag is not exposed until modular integration is ready.
ALTER TABLE "Hotel" ADD COLUMN "useModularPricing" BOOLEAN NOT NULL DEFAULT false;
