# Inventory replay and legacy membership handling

The `20261104120000_inventory_request_ledger` migration is additive and has
not been applied. Deploy it only through the existing reviewed migration process
on a verified SaaS target. Application code using it requires that migration.
It creates a tenant/operation/key unique replay ledger and initializes stock
versions to zero without changing stock or historic movements. It does not repair
existing incorrect stock or missing movement records. Review backups, ledger
adoption, deployment and rollback implications before any rollout. Never delete
replay rows while clients may retry. The ledger retains response data and request
fingerprints for the lifetime of the hotel; define retention and access policy.

Inventory creation, purchases, wastage, stock adjustments and expense creation require a stable
`Idempotency-Key` header (4–128 characters). Retries must use the same key and
identical payload; a changed payload conflicts. Keys are scoped by hotel and
operation and bound to the initiating user. Stocktakes also require the displayed
`expectedQuantity` and `expectedVersion`; reload if either is stale. POS and folio
payments use their existing independent replay systems. Inventory and expense forms
persist the exact request and key in browser localStorage, scoped by hotel and
actor; one unresolved request blocks new ones in that context. A recovery panel on
either page can retry the saved request or clear it only after explicit independent
reconciliation. Web Locks coordinate tabs; absent locks or storage, submission fails
closed. The server checks the expected hotel and actor as reject-only preconditions,
never as authorization. The payload can contain sensitive information, is not
encrypted by the app, and is accessible to scripts on that origin and others using
the same browser profile. Clearing browser data, switching devices, an old client,
or independently submitting from another actor/device can lose/bypass recovery.
Do not clear an uncertain record based solely on an HTTP rejection: authorization,
validation or entitlement changes may hide an earlier commit. The operator must
verify the original hotel's records before clearing. Existing folio recovery uses
sessionStorage, not the new shared mechanism; cross-tab/device recovery for folio
payments remains an outstanding limitation.

A suspended membership without reliable invitation history is **ambiguous**, not
necessarily an invitation. Direct administrative reactivation is denied for all
suspended memberships. An authorized hotel administrator can explicitly re-invite
it in place; a strict audit entry and the suspended state are committed together.
Only the account holder can accept within seven days of the latest invitation
creation event, and the staff quota still applies. Decline and revocation keep the
membership suspended and preserve its history. This handles ambiguous legacy rows
without guessing or automatically activating them. The staff toggle sends the
re-invitation instead of immediately restoring access. Equal event timestamps are
resolved conservatively in favor of a terminal event; a same-millisecond re-invite
can require another attempt.

This policy cannot discover or retroactively repair already-active legacy records
that were activated without consent. Review those separately with the hotel and
account holders; do not bulk activate, delete, or rewrite historical records.
Mock transaction tests do not establish PostgreSQL locking, isolation, migration
compatibility, or production readiness.
