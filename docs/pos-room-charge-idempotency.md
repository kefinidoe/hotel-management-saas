# Restaurant charge-to-room idempotency (Stage 1)

## Why the current schema is insufficient

`Payment` is the wrong idempotency record for a room charge: charging a folio creates an unpaid guest-balance item, not settled funds, and creating a `Payment` would misstate payment and revenue reporting. `Order` and `OrderItem` are the durable record of the restaurant sale, but before this change an `Order` had no request key, no canonical request fingerprint, and no database uniqueness guard. Application locks alone cannot make retries safe across processes or after a lost response.

## Smallest schema change proposed

Add nullable `idempotencyOperation`, `idempotencyKey`, and `requestFingerprint` fields to `Order`, plus a unique constraint on `(hotelId, idempotencyOperation, idempotencyKey)`. Nullable fields leave all historical and non-idempotent orders unchanged; the operation dimension scopes a key to `CHARGE_TO_ROOM`. Persist the Order in the same transaction as its order lines, folio items, inventory deductions, and stock movements. The unique database constraint is the cross-process final guard; the transaction lookup handles normal replay.

The draft migration is `prisma/migrations/20261029120000_add_pos_charge_to_room_idempotency/migration.sql`. It is for review only and has **not** been applied to any database.

## Request identity

The server computes SHA-256 over a versioned canonical object containing the operation namespace, hotel, folio destination, normalized table/note value, and sorted/merged menu-item IDs and quantities. Item names and prices from the browser are excluded because the server resolves authoritative menu prices and recipe inventory inside the transaction. The client stores the exact key and request payload before sending; ambiguous outcomes remain locked and retry the same payload. If neither local nor session storage accepts the initial attempt, no POST is sent and the cashier is told to restore storage before retrying. A room charge clears only after a response that validates the operation, key, fingerprint, Order, folio, guest, and total, or an explicit `NOT_COMMITTED` outcome.
