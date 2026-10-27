-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "idempotencyKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_hotelId_idempotencyKey_key" ON "Payment"("hotelId", "idempotencyKey");
