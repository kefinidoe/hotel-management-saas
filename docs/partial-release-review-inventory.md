# Partial tenant and release-review inventory

This is a **partial review**, not a security certification. The 41 model declarations and 65 route paths were enumerated. A targeted schema examination covered 17 tenant-owned models, one mixed-scope model (AuditLog), and two global/root models (Hotel and User). Relationship listings below are a mechanical inventory, not proof that every query enforces them. Fourteen route files received targeted examination across the hardening and release work; remaining route files are unreviewed in this inventory. Route examination is not a complete method-by-method audit. Server actions: no `use server` directive found by search; this is not proof no indirect actions exist. Jobs: no scheduler discovered by keyword search; scripts, deployment configuration and indirect jobs remain unreviewed.

## Model map

| Model | Tenant ownership / relations (schema-level) | Targeted schema examination |
|---|---|---|
| Hotel | global/root; no direct FK relation listed | targeted |
| Subscription | hotelId; hotel→Hotel | targeted |
| HotelMembership | hotelId; user→User, hotel→Hotel | targeted |
| User | global/root; reservationsCreated→Reservation, stayExtensionsApproved→ReservationExtension, paymentsCashiered→Payment, housekeepingTasks→HousekeepingTask, maintenanceTickets→MaintenanceTicket, expensesRequested→Expense, purchasesRecorded→Purchase, wastagesRecorded→Wastage, wastagesAccountable→Wastage, stockMovements→StockMovement | targeted |
| RoomType | hotelId; hotel→Hotel | not reviewed |
| Room | hotelId; hotel→Hotel, roomType→RoomType | not reviewed |
| Guest | hotelId; hotel→Hotel | not reviewed |
| Reservation | hotelId; hotel→Hotel, guest→Guest, createdBy→User | not reviewed |
| ReservationRoom | hotelId; reservation→Reservation, room→Room | not reviewed |
| Folio | hotelId; hotel→Hotel, guest→Guest, reservation→Reservation | targeted |
| FolioItem | inherited through Folio; folio→Folio | targeted |
| PaymentMethod | hotelId; hotel→Hotel | targeted |
| Payment | hotelId; hotel→Hotel, folio→Folio, paymentMethod→PaymentMethod, cashier→User | targeted |
| HousekeepingTask | hotelId; hotel→Hotel, room→Room, assignee→User | not reviewed |
| MaintenanceTicket | hotelId; hotel→Hotel, room→Room, assignee→User | not reviewed |
| MenuCategory | hotelId; hotel→Hotel | not reviewed |
| MenuItem | hotelId; hotel→Hotel, category→MenuCategory | not reviewed |
| Order | hotelId; hotel→Hotel, paymentMethod→PaymentMethod, folio→Folio | targeted |
| OrderItem | hotelId; order→Order, menuItem→MenuItem | targeted |
| InventoryRequest | hotelId; hotel→Hotel | targeted |
| InventoryItem | hotelId; hotel→Hotel | targeted |
| Recipe | hotelId; menuItem→MenuItem | targeted |
| RecipeIngredient | hotelId; recipe→Recipe, inventoryItem→InventoryItem | targeted |
| StockMovement | hotelId; hotel→Hotel, inventoryItem→InventoryItem, user→User | targeted |
| Purchase | hotelId; hotel→Hotel, inventoryItem→InventoryItem, createdBy→User | targeted |
| Wastage | hotelId; hotel→Hotel, inventoryItem→InventoryItem, recordedBy→User, accountableUser→User | targeted |
| Expense | hotelId; hotel→Hotel, requestedBy→User | targeted |
| Notification | hotelId; hotel→Hotel, user→User | targeted |
| AuditLog | mixed (nullable hotelId); hotel→Hotel, user→User | targeted |
| OccupancyType | hotelId; hotel→Hotel | not reviewed |
| RoomTypeOccupancy | hotelId; hotel→Hotel, roomType→RoomType, occupancyType→OccupancyType | not reviewed |
| MealPlanConfig | hotelId; hotel→Hotel | not reviewed |
| MealPlanRoomType | hotelId; hotel→Hotel, mealPlan→MealPlanConfig, roomType→RoomType | not reviewed |
| RateAdjustment | hotelId; hotel→Hotel, roomType→RoomType | not reviewed |
| ExtraBedRule | hotelId; hotel→Hotel, roomType→RoomType | not reviewed |
| ChildPricingRule | hotelId; hotel→Hotel | not reviewed |
| TaxRule | hotelId; hotel→Hotel | not reviewed |
| HotelPricingSettings | hotelId; hotel→Hotel | not reviewed |
| ReservationPriceSnapshot | hotelId; hotel→Hotel, reservation→Reservation | not reviewed |
| ReservationPriceChange | hotelId; hotel→Hotel, reservation→Reservation | not reviewed |
| ReservationExtension | hotelId; hotel→Hotel, reservation→Reservation, approvedBy→User | not reviewed |

## Routes

Targeted = relevant sections inspected, not complete assurance. Unreviewed = listed only.

- The formerly reviewed admin cleanup route has been removed.
- `app/api/audit-logs/route.ts` — unreviewed
- `app/api/auth/[...nextauth]/route.ts` — unreviewed
- `app/api/auth/invitations/[id]/route.ts` — targeted
- `app/api/auth/memberships/route.ts` — targeted
- `app/api/auth/register/route.ts` — unreviewed
- `app/api/auth/switch-hotel/route.ts` — unreviewed
- `app/api/check-in/route.ts` — unreviewed
- `app/api/check-out/route.ts` — unreviewed
- `app/api/expenses/[id]/route.ts` — targeted
- `app/api/expenses/route.ts` — targeted
- `app/api/folios/[id]/route.ts` — unreviewed
- `app/api/guests/[id]/route.ts` — unreviewed
- `app/api/guests/route.ts` — unreviewed
- `app/api/hotel/onboarding/route.ts` — unreviewed
- `app/api/hotel/settings/route.ts` — unreviewed
- `app/api/hotel/subscription/route.ts` — unreviewed
- `app/api/housekeeping/[id]/route.ts` — unreviewed
- `app/api/housekeeping/route.ts` — unreviewed
- `app/api/inventory/[id]/route.ts` — targeted
- `app/api/inventory/route.ts` — targeted
- `app/api/maintenance/[id]/route.ts` — unreviewed
- `app/api/maintenance/route.ts` — unreviewed
- `app/api/menu/categories/[id]/route.ts` — unreviewed
- `app/api/menu/categories/route.ts` — unreviewed
- `app/api/menu/items/[id]/route.ts` — unreviewed
- `app/api/menu/route.ts` — unreviewed
- `app/api/notifications/route.ts` — unreviewed
- `app/api/payment-methods/route.ts` — unreviewed
- `app/api/payments/route.ts` — targeted
- `app/api/platform/hotels/[id]/route.ts` — unreviewed
- `app/api/platform/hotels/[id]/status/route.ts` — unreviewed
- `app/api/platform/hotels/[id]/subscription/route.ts` — unreviewed
- `app/api/platform/hotels/route.ts` — unreviewed
- `app/api/platform/overview/route.ts` — unreviewed
- `app/api/platform/subscriptions/route.ts` — unreviewed
- `app/api/pricing/[entity]/route.ts` — unreviewed
- `app/api/pricing/room-rates/route.ts` — unreviewed
- `app/api/pricing/route.ts` — unreviewed
- `app/api/profile/password/route.ts` — unreviewed
- `app/api/purchases/route.ts` — targeted
- `app/api/recipes/[id]/route.ts` — unreviewed
- `app/api/recipes/route.ts` — unreviewed
- `app/api/reports/route.ts` — unreviewed
- `app/api/reservations/[id]/check-in/route.ts` — unreviewed
- `app/api/reservations/[id]/check-out/route.ts` — unreviewed
- `app/api/reservations/[id]/extend/route.ts` — unreviewed
- `app/api/reservations/[id]/reprice/route.ts` — unreviewed
- `app/api/reservations/[id]/route.ts` — unreviewed
- `app/api/reservations/quote/route.ts` — unreviewed
- `app/api/reservations/route.ts` — unreviewed
- `app/api/restaurant/activity/route.ts` — unreviewed
- `app/api/restaurant/charge-to-room/route.ts` — targeted
- `app/api/restaurant/open-folios/route.ts` — unreviewed
- `app/api/restaurant/pay-now/route.ts` — unreviewed
- `app/api/restaurant/payments/status/route.ts` — targeted
- `app/api/room-types/[id]/route.ts` — unreviewed
- `app/api/room-types/route.ts` — unreviewed
- `app/api/rooms/[id]/route.ts` — unreviewed
- `app/api/rooms/route.ts` — unreviewed
- `app/api/search/route.ts` — unreviewed
- `app/api/staff/[id]/route.ts` — targeted
- `app/api/staff/route.ts` — targeted
- `app/api/stock-movements/route.ts` — unreviewed
- `app/api/wastage/route.ts` — targeted

## Data access and operating paths

The following is the historical app/lib Prisma/transaction/raw-query inventory; the cleanup route has since been removed. Enumeration is not function-level review; most remain unreviewed. Cross-reference their route/page callers before release.

- `app/api/audit-logs/route.ts`
- `app/api/auth/invitations/[id]/route.ts`
- `app/api/auth/memberships/route.ts`
- `app/api/auth/register/route.ts`
- `app/api/auth/switch-hotel/route.ts`
- `app/api/expenses/[id]/route.ts`
- `app/api/expenses/route.ts`
- `app/api/folios/[id]/route.ts`
- `app/api/guests/[id]/route.ts`
- `app/api/guests/route.ts`
- `app/api/hotel/onboarding/route.ts`
- `app/api/hotel/settings/route.ts`
- `app/api/housekeeping/[id]/route.ts`
- `app/api/housekeeping/route.ts`
- `app/api/inventory/[id]/route.ts`
- `app/api/inventory/route.ts`
- `app/api/maintenance/[id]/route.ts`
- `app/api/maintenance/route.ts`
- `app/api/menu/categories/[id]/route.ts`
- `app/api/menu/categories/route.ts`
- `app/api/menu/items/[id]/route.ts`
- `app/api/menu/route.ts`
- `app/api/notifications/route.ts`
- `app/api/payments/route.ts`
- `app/api/platform/hotels/[id]/route.ts`
- `app/api/platform/hotels/[id]/status/route.ts`
- `app/api/platform/hotels/[id]/subscription/route.ts`
- `app/api/platform/hotels/route.ts`
- `app/api/platform/overview/route.ts`
- `app/api/platform/subscriptions/route.ts`
- `app/api/profile/password/route.ts`
- `app/api/purchases/route.ts`
- `app/api/recipes/[id]/route.ts`
- `app/api/recipes/route.ts`
- `app/api/reports/route.ts`
- `app/api/reservations/[id]/extend/route.ts`
- `app/api/reservations/[id]/reprice/route.ts`
- `app/api/reservations/[id]/route.ts`
- `app/api/reservations/quote/route.ts`
- `app/api/reservations/route.ts`
- `app/api/restaurant/charge-to-room/route.ts`
- `app/api/restaurant/pay-now/route.ts`
- `app/api/restaurant/payments/status/route.ts`
- `app/api/room-types/[id]/route.ts`
- `app/api/room-types/route.ts`
- `app/api/rooms/[id]/route.ts`
- `app/api/rooms/route.ts`
- `app/api/search/route.ts`
- `app/api/staff/[id]/route.ts`
- `app/api/staff/route.ts`
- `app/api/stock-movements/route.ts`
- `app/api/wastage/route.ts`
- `app/dashboard/expenses/page.tsx`
- `app/dashboard/front-desk/page.tsx`
- `app/dashboard/guests/page.tsx`
- `app/dashboard/housekeeping/page.tsx`
- `app/dashboard/inventory/page.tsx`
- `app/dashboard/maintenance/page.tsx`
- `app/dashboard/page.tsx`
- `app/dashboard/reservations/page.tsx`
- `app/dashboard/restaurant/page.tsx`
- `app/dashboard/rooms/page.tsx`
- `app/dashboard/settings/page.tsx`
- `app/dashboard/staff/page.tsx`
- `lib/auth.ts`
- `lib/db-safety-guard.ts`
- `lib/entitlements.ts`
- `lib/inventory-idempotency.ts`
- `lib/invitations.ts`
- `lib/notifications.ts`
- `lib/page-auth.ts`
- `lib/pricing/admin.ts`
- `lib/pricing/delegates.ts`
- `lib/pricing/errors.ts`
- `lib/prisma.ts`
- `lib/restaurant-dashboard.ts`
- `lib/stay-service.ts`
- `lib/tenant-context.ts`

Targeted flow links: inventory/expense routes → `lib/inventory-idempotency.ts` → InventoryRequest, InventoryItem, Purchase, Wastage, StockMovement and Expense; permissions and active membership → `lib/authz.ts` / `lib/tenant.ts` (session-derived); expense review → Expense and AuditLog in one transaction. Staff/invitations → HotelMembership, global User, AuditLog and `lib/invitations.ts`. Payments → Folio, FolioItem, PaymentMethod, Payment. Restaurant POS → Order, OrderItem, Folio, Payment and `lib/recipe-stock.ts` → Recipe, RecipeIngredient, InventoryItem, StockMovement. This map does not replace review of all code paths, background operations, global identity changes, financial exports, pricing, subscription limits and assignments.

## Additive migration review

`20261104120000_inventory_request_ledger/migration.sql` adds a non-null replay ledger with primary key, tenant/operation/request key unique index, required fingerprint, JSONB response and status, timestamp and Hotel FK with update/delete cascade. The unique index also supports hotel-prefix lookups; application-generated UUID supplies id. `stockVersion` is non-null integer default zero for existing inventory rows. No prior stock quantities, Decimal precision or history are changed. The hotel FK does not itself constrain operation/payload/actor (fingerprint and trusted route checks do); status and operation have no database check constraint. Stock version can eventually overflow; ledger growth and cascading hotel deletion need retention policy. The application requires the migration before use. Existing active requests, DB state, migration history, locks and deployment compatibility are not verified. The unique index starts empty; production lock/duration impact is unknown. The migration is unapplied. No automatic down migration was provided: rollback requires a reviewed maintenance plan, app compatibility and backup/reconciliation; dropping the ledger loses replay history and can duplicate later retries, so do not drop it while outstanding retries may exist.

## Blocking evidence and residual risks

No verified dedicated SaaS PostgreSQL test target or local PostgreSQL/Docker tools were available. There was no DB connection or migration execution. Mocks cannot establish transaction, lock, rollback, precision, isolation or migration behavior. The browser recovery record can be lost if storage is cleared, and does not coordinate separate devices or actors; see `docs/inventory-and-invitation-hardening.md`. Folio recovery remains sessionStorage-based, without cross-tab ownership. Restaurant room-charge replay reconstructs some response data from current related rows rather than storing an immutable original response. Do not mark release complete until the full surface audit and isolated real-PostgreSQL, migration/rollback and browser multi-tab tests are done.
