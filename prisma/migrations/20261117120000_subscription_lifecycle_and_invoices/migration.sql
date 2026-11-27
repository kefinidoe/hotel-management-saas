-- Additive migration for SaaS subscription lifecycle stages (RESTRICTED, READ_ONLY)
-- and tenant-isolated manual subscription billing invoices.

ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'RESTRICTED' BEFORE 'SUSPENDED';
ALTER TYPE "SubscriptionStatus" ADD VALUE IF NOT EXISTS 'READ_ONLY' BEFORE 'SUSPENDED';

CREATE TYPE "SubscriptionInvoiceStatus" AS ENUM ('ISSUED', 'PAID', 'PAST_DUE', 'VOID');

CREATE TABLE "SubscriptionInvoice" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "status" "SubscriptionInvoiceStatus" NOT NULL DEFAULT 'ISSUED',
    "planId" TEXT NOT NULL,
    "planName" TEXT NOT NULL,
    "billingInterval" "BillingInterval" NOT NULL DEFAULT 'MONTHLY',
    "currency" TEXT NOT NULL DEFAULT 'KES',
    "subtotal" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "taxAmount" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "amount" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "amountPaid" DECIMAL(10,2) NOT NULL DEFAULT 0.00,
    "periodStartsAt" TIMESTAMP(3) NOT NULL,
    "periodEndsAt" TIMESTAMP(3) NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "paymentMethod" TEXT,
    "paymentReference" TEXT,
    "recordedByUserId" TEXT,
    "notes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SubscriptionInvoice_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "SubscriptionInvoice_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SubscriptionInvoice_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "SubscriptionInvoice_recordedByUserId_fkey" FOREIGN KEY ("recordedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "SubscriptionInvoice_amounts_nonnegative" CHECK ("subtotal" >= 0 AND "taxAmount" >= 0 AND "amount" >= 0 AND "amountPaid" >= 0)
);

CREATE UNIQUE INDEX "SubscriptionInvoice_invoiceNumber_key" ON "SubscriptionInvoice"("invoiceNumber");
CREATE UNIQUE INDEX "SubscriptionInvoice_paymentReference_key" ON "SubscriptionInvoice"("paymentReference");
CREATE INDEX "SubscriptionInvoice_hotelId_issuedAt_idx" ON "SubscriptionInvoice"("hotelId", "issuedAt");
CREATE INDEX "SubscriptionInvoice_subscriptionId_issuedAt_idx" ON "SubscriptionInvoice"("subscriptionId", "issuedAt");
CREATE INDEX "SubscriptionInvoice_status_idx" ON "SubscriptionInvoice"("status");
