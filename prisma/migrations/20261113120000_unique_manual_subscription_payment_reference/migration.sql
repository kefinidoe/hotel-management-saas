-- Review existing manual payment logs for duplicate normalized references before
-- deployment. Duplicate rows intentionally cause this migration to fail closed.
-- This constraint complements, rather than replaces, the transaction-level lock.
CREATE UNIQUE INDEX "AuditLog_manual_payment_reference_unique"
ON "AuditLog" (UPPER(BTRIM("metadata"->>'referenceCode')))
WHERE "action" = 'PLATFORM_MANUAL_PAYMENT_ACTIVATED'
  AND "entity" = 'Subscription'
  AND "metadata"->>'referenceCode' IS NOT NULL;

-- AuditLog remains mutable. Strict append-only audit protection also requires a
-- carefully reviewed UPDATE/DELETE-rejecting trigger and restricted database
-- privileges; that separate operational policy is not installed by this index.
