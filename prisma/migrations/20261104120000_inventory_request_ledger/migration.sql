-- Additive replay ledger. Existing stock and transaction history is untouched.
CREATE TABLE "InventoryRequest" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InventoryRequest_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "InventoryRequest_hotelId_operation_requestKey_key" ON "InventoryRequest"("hotelId", "operation", "requestKey");
ALTER TABLE "InventoryRequest" ADD CONSTRAINT "InventoryRequest_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Monotonic stocktake version, initialized without changing existing balances.
ALTER TABLE "InventoryItem" ADD COLUMN "stockVersion" INTEGER NOT NULL DEFAULT 0;
