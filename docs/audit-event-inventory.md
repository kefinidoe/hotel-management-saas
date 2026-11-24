# Audit event inventory and open decisions

Scope: static review of current application audit writers, not a complete security or regulatory audit. Append-only storage protects existing rows, not event completeness. Direct database writes and any uninstrumented workflow can still lack audit events. This inventory is not a policy approval.

## Already coupled to business transactions

- Manual subscription payment activation (`lib/activate-manual-subscription.ts`): subscription update and direct audit insert in one transaction. A failed insert rolls back the payment activation.
- Accommodation payment recording (`app/api/payments/route.ts`): new payments and `PAYMENT_RECORDED` audit events now commit together in the candidate branch. Replays do not create another event; audit metadata records the individual payment amount. Legacy events are not retroactively repaired. This change is not yet deployed.
- Platform hotel status and non-manual subscription administrative changes: direct inserts in the same Prisma transaction as the update.
- Reservation extension, repricing and deletion; expense review; meal, modular and dynamic pricing settings; branding settings: `recordAudit` uses the transaction client with strict failure. Invitation creation, reinvitation, revocation, acceptance and decline pass their transaction client to strict audit helpers.
- Check-out now uses strict audit persistence within its existing transaction in the candidate branch; an audit failure rolls back folio closure, reservation status, room status and housekeeping creation. A priced reservation schedule or room change that requires rate review likewise requires its audit in the same transaction. Hotel settings and any associated subscription repricing, legacy pricing settings, room rates and pricing entity writes now require their audit in serializable transactions. New staff creation uses the quota-locked transaction; staff updates, suspensions and removals use strict audit within their transaction and recheck the target and owner count. These changes are not yet deployed. Real PostgreSQL tests exercise audit-denial rollback and successful retries; concurrent last-owner mutation and every pricing entity subtype have not been exhaustively tested.

## Follow-up required: audit is not guaranteed atomic

| Area | Current observation | Follow-up |
|---|---|---|
| Staff ownership concurrency | Owner count is rechecked inside serializable update/removal transactions; conflicting writes can fail and require retry. | Add dedicated concurrent last-owner tests and verify mixed-version deployments cannot bypass the invariant. |
| Logo upload | Strict audit is separate from external storage; failure triggers attempted cleanup, which can itself fail. | Reconcile and monitor orphaned objects; database and object storage are not atomic. |

These follow-ups require targeted implementation and testing, not merely changing `{ strict: true }` outside a transaction. Existing best-effort behavior is explicitly a remaining risk. No retention period or privacy basis is established by this inventory.
