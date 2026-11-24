# Audit event inventory and open decisions

Scope: static review of current application audit writers, not a complete security or regulatory audit. Append-only storage protects existing rows, not event completeness. Direct database writes and any uninstrumented workflow can still lack audit events. This inventory is not a policy approval.

## Already coupled to business transactions

- Manual subscription payment activation (`lib/activate-manual-subscription.ts`): subscription update and direct audit insert in one transaction. A failed insert rolls back the payment activation.
- Accommodation payment recording (`app/api/payments/route.ts`): new payments and `PAYMENT_RECORDED` audit events now commit together in the candidate branch. Replays do not create another event; audit metadata records the individual payment amount. Legacy events are not retroactively repaired. This change is not yet deployed.
- Platform hotel status and non-manual subscription administrative changes: direct inserts in the same Prisma transaction as the update.
- Reservation extension, repricing and deletion; expense review; meal, modular and dynamic pricing settings; branding settings: `recordAudit` uses the transaction client with strict failure. Invitation creation/resolution helpers request strict writes; review each caller's transaction boundary before treating the complete invitation workflow as atomic.
- Check-out now uses strict audit persistence within its existing transaction in the candidate branch; an audit failure rolls back folio closure, reservation status, room status and housekeeping creation. A priced reservation schedule or room change that requires rate review likewise requires its audit in the same transaction. Hotel settings and any associated subscription repricing, and legacy pricing settings, now require their audit in serializable transactions. These changes are not yet deployed.

## Follow-up required: audit is not guaranteed atomic

| Area | Current observation | Follow-up |
|---|---|---|
| Legacy room rates and pricing entities | Business mutation occurs before best-effort event. | Map helper transactions and design an atomic boundary without weakening existing validations or locks. |
| Staff create, change, suspend and remove | Best-effort audit follows business changes. | Review invitation and seat-limit flows and concurrent ownership rules before making audit strict. |
| Logo upload | Strict audit is separate from external storage; failure triggers attempted cleanup, which can itself fail. | Reconcile and monitor orphaned objects; database and object storage are not atomic. |

These follow-ups require targeted implementation and testing, not merely changing `{ strict: true }` outside a transaction. Existing best-effort behavior is explicitly a remaining risk. No retention period or privacy basis is established by this inventory.
