# Audit event inventory and open decisions

Scope: static review of current application audit writers, not a complete security or regulatory audit. Append-only storage protects existing rows, not event completeness. Direct database writes and any uninstrumented workflow can still lack audit events. This inventory is not a policy approval.

## Already coupled to business transactions

- Manual subscription payment activation (`lib/activate-manual-subscription.ts`): subscription update and direct audit insert in one transaction. A failed insert rolls back the payment activation.
- Accommodation payment recording (`app/api/payments/route.ts`): new payments and `PAYMENT_RECORDED` audit events now commit together in the candidate branch. Replays do not create another event; audit metadata records the individual payment amount. Legacy events are not retroactively repaired. This change is not yet deployed.
- Platform hotel status and non-manual subscription administrative changes: direct inserts in the same Prisma transaction as the update.
- Reservation extension, repricing and deletion; expense review; meal, modular and dynamic pricing settings; branding settings: `recordAudit` uses the transaction client with strict failure. Invitation creation/resolution helpers request strict writes; review each caller's transaction boundary before treating the complete invitation workflow as atomic.

## Follow-up required: audit is not guaranteed atomic

| Area | Current observation | Follow-up |
|---|---|---|
| Legacy pricing settings, room rates and pricing entities | Business mutation occurs before best-effort event. | Map helper transactions and design an atomic boundary without weakening existing validations or locks. |
| Hotel settings | Best-effort event uses a transaction client when subscription may change; another path uses the global client. | Review both paths and make an explicit atomicity decision. |
| Staff create, change, suspend and remove | Best-effort audit follows business changes. | Review invitation and seat-limit flows and concurrent ownership rules before making audit strict. |
| Reservation schedule/room change requiring rate review | Event uses transaction client but is best effort. | Decide whether audit failure must abort the change, with rollback tests. |
| Check-out | Event uses transaction client but is best effort. | Review availability implications, especially check-out with outstanding balance; add rollback tests if strict. |
| Logo upload | Strict audit is separate from external storage; failure triggers attempted cleanup, which can itself fail. | Reconcile and monitor orphaned objects; database and object storage are not atomic. |

These follow-ups require targeted implementation and testing, not merely changing `{ strict: true }` outside a transaction. Existing best-effort behavior is explicitly a remaining risk. No retention period or privacy basis is established by this inventory.
