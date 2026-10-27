# Phase 4 Implementation Execution Checklist: Multi-Tenant SaaS Conversion

## 1. Architecture & Security Invariant Model

Phase 4 finalizes the migration of the Hotel Management System from a single-tenant property tool into a multi-tenant SaaS platform.

### Core Security Invariants
1. **Dynamic Tenant Context Resolution:** Every request to a protected route (API or Dashboard Server Component) authoritatively resolves `TenantContext` using `getTenantContext()` / `getTenantFromRoute()`.
2. **Authoritative State Verification:** Never trust client cookies blindly. `active_hotel_id` cookie is validated against PostgreSQL on every request for:
   - User account active state (`User.isActive === true`)
   - Hotel workspace status (`Hotel.status IN ['ACTIVE', 'TRIALING']`)
   - Membership status (`HotelMembership.status === 'ACTIVE'`)
3. **Fail-Closed Ambiguity Policy:**
   - If user has 0 active memberships &rarr; `NO_ACTIVE_MEMBERSHIP` (redirect `/onboarding` or 403).
   - If user has 1 active membership & no cookie &rarr; safely auto-select that hotel.
   - If user has >1 active memberships & no cookie &rarr; `HOTEL_SELECTION_REQUIRED` (redirect `/select-hotel` or 403).
   - If cookie points to non-existent or unjoined hotel &rarr; clear cookie & throw `INVALID_HOTEL_SELECTION`.
4. **Complete Legacy Role Eradication:**
   - Single-tenant `User.role` is completely eliminated.
   - Platform administration uses `User.platformRole` (`PlatformRole`: `SUPER_ADMIN`, `SUPPORT`).
   - Hotel property operations strictly use `HotelMembership.role` (`HotelRole`).
   - NextAuth JWT and Session tokens hold zero static roles (`id`, `name`, `email` only).
5. **Absolute Tenant Isolation (IDOR Defense):**
   - Every read (`findMany`, `findFirst`, `findUnique`, `count`, `aggregate`) is scoped to `where: { hotelId }`.
   - Every write (`create`, `update`, `delete`, `upsert`) sets or checks `hotelId`.
   - All relational entities without direct `hotelId` (e.g. `FolioItem`, `OrderItem`) must be resolved through their parent entity's `hotelId`.

---

## 2. Complete Inventory & Guard Mapping: API Routes (`app/api/**/route.ts`)

| Route Path | Method(s) | Domain / Resource | Authentication Guard | Tenant Authorization Guard | Tenant Scoping & Isolation Enforcement | IDOR Prevention Mechanism |
|---|---|---|---|---|---|---|
| `/api/auth/[...nextauth]` | `GET`, `POST` | NextAuth Core | Public / Credentials | None (Auth Provider) | Verifies `User.isActive`; populates JWT with `id` only; verifies bcrypt password hash | N/A |
| `/api/auth/switch-hotel` | `POST` | Tenant Workspace Switching | Active Session (`authOptions`) | None (Any active member can switch to joined hotel) | Verifies Origin header matches `NEXTAUTH_URL`. Validates `HotelMembership` (`ACTIVE`) and `Hotel` (`ACTIVE`/`TRIALING`). Sets HttpOnly `active_hotel_id` cookie | Direct database check of `(userId, targetHotelId)` join |
| `/api/auth/memberships` | `GET` | User Tenant Directory | Active Session (`authOptions`) | None (Self-membership listing) | Scoped strictly to `where: { userId: session.user.id, status: ACTIVE, hotel: { status: { in: [ACTIVE, TRIALING] } } }` | Cannot view memberships of other users |
| `/api/profile/password` | `POST` | User Security | Active Session (`authOptions`) | None (Self account) | Scoped to `where: { id: session.user.id, isActive: true }`; bcrypt comparison of current password | Scoped strictly to session user ID |
| `/api/rooms` | `GET` | Rooms Directory | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.ALL_STAFF)` | `where: { hotelId: tenant.hotelId, isActive: true }`, include `roomType` | Filtered by `tenant.hotelId` |
| `/api/rooms` | `POST` | Room Creation | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` | `data: { hotelId: tenant.hotelId, roomTypeId, number, floor }`. Validate `roomTypeId` belongs to `tenant.hotelId` | Verifies `roomTypeId` belongs to same `tenant.hotelId` |
| `/api/rooms/[id]` | `PATCH`, `DELETE` | Room Update & Retirement | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` | `where: { id: params.id, hotelId: tenant.hotelId }` | Composite lookup with `hotelId: tenant.hotelId` |
| `/api/room-types` | `GET` | Room Categories / Tariffs | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.ALL_STAFF)` | `where: { hotelId: tenant.hotelId }` | Filtered by `tenant.hotelId` |
| `/api/room-types` | `POST` | Room Type Creation | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` | `data: { hotelId: tenant.hotelId, name, baseRate, capacity, mealPlan }` | Bounded to `tenant.hotelId` |
| `/api/room-types/[id]` | `PATCH`, `DELETE` | Room Type Management | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` | `where: { id: params.id, hotelId: tenant.hotelId }` | Composite lookup with `hotelId: tenant.hotelId` |
| `/api/reservations` | `GET` | Bookings Directory | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.GUEST_STAYS)` | `where: { hotelId: tenant.hotelId }`, include `guest`, `rooms.room` | Filtered by `tenant.hotelId` |
| `/api/reservations` | `POST` | Booking Creation | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.GUEST_STAYS)` | Verifies `guestId` belongs to `tenant.hotelId` and all `roomIds` belong to `tenant.hotelId`. `data: { hotelId: tenant.hotelId, createdById: tenant.userId }` | Cross-tenant reference rejection |
| `/api/reservations/[id]` | `GET`, `PATCH` | Booking Details & Cancellation | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.GUEST_STAYS)` | `where: { id: params.id, hotelId: tenant.hotelId }` | Composite lookup with `hotelId: tenant.hotelId` |
| `/api/reservations/[id]/extend` | `POST` | Stay Extension | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.GUEST_STAYS)` | `where: { id: params.id, hotelId: tenant.hotelId }`. Validates date overlaps against rooms in `tenant.hotelId` | Composite lookup with `hotelId: tenant.hotelId` |
| `/api/check-in` | `POST` | Front Desk Arrival Check-in | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.GUEST_STAYS)` | Transaction scopes: reservation lookup with `hotelId: tenant.hotelId`, room update with `hotelId: tenant.hotelId`, Folio creation with `hotelId: tenant.hotelId` | Verifies reservation & target room belong to `tenant.hotelId` |
| `/api/check-out` | `POST` | Front Desk Departure Check-out | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.GUEST_STAYS)` | Transaction scopes: reservation & folio lookup with `hotelId: tenant.hotelId`, room flip to `DIRTY` with `hotelId: tenant.hotelId`, Housekeeping task creation with `hotelId: tenant.hotelId` | Verified against `tenant.hotelId` |
| `/api/guests` | `GET` | Guests Directory | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.GUEST_STAYS)` | `where: { hotelId: tenant.hotelId, isArchived: false }` | Filtered by `tenant.hotelId` |
| `/api/guests` | `POST` | Guest Registration | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.GUEST_STAYS)` | `data: { hotelId: tenant.hotelId, fullName, phone, email, ... }` | Bounded to `tenant.hotelId` |
| `/api/guests/[id]` | `GET`, `PATCH` | Guest Stay Profile & History | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.GUEST_STAYS)` | `where: { id: params.id, hotelId: tenant.hotelId }`, folios & reservations filtered by `hotelId: tenant.hotelId` | Composite lookup with `hotelId: tenant.hotelId` |
| `/api/folios/[id]` | `GET`, `PATCH` | Billing Folio Management | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.FRONT_DESK)` | `where: { id: params.id, hotelId: tenant.hotelId }`, items & payments scoped | Composite lookup with `hotelId: tenant.hotelId` |
| `/api/payments` | `POST` | Record Folio Payment | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.PAYMENT_OPERATIONS)` | Verifies `folioId` belongs to `tenant.hotelId`, `paymentMethodId` belongs to `tenant.hotelId`, records `cashierId: tenant.userId`, `hotelId: tenant.hotelId` | Cross-tenant folio or payment method injection prevented |
| `/api/payment-methods` | `GET`, `POST` | Settlement Methods | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` (POST) / `ROLE_GROUPS.ALL_STAFF` (GET) | `where: { hotelId: tenant.hotelId, isActive: true }`, creation sets `hotelId: tenant.hotelId` | Scoped to `tenant.hotelId` |
| `/api/housekeeping` | `GET`, `POST` | Housekeeping Task Board | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.HOUSEKEEPING)` | `where: { hotelId: tenant.hotelId }`, verifies assigned room and staff belong to `tenant.hotelId` | Bounded to `tenant.hotelId` |
| `/api/housekeeping/[id]` | `PATCH` | Housekeeping Status Update | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.HOUSEKEEPING)` | `where: { id: params.id, hotelId: tenant.hotelId }`, room status sync scoped to `tenant.hotelId` | Composite lookup with `hotelId: tenant.hotelId` |
| `/api/maintenance` | `GET`, `POST` | Maintenance Tickets | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MAINTENANCE)` | `where: { hotelId: tenant.hotelId }`, verifies room belongs to `tenant.hotelId` | Bounded to `tenant.hotelId` |
| `/api/maintenance/[id]` | `PATCH` | Maintenance Ticket Resolution | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MAINTENANCE)` | `where: { id: params.id, hotelId: tenant.hotelId }`, room status update scoped to `tenant.hotelId` | Composite lookup with `hotelId: tenant.hotelId` |
| `/api/menu` | `GET` | Restaurant Menu | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.ALL_STAFF)` | `where: { hotelId: tenant.hotelId }`, categories & items scoped | Filtered by `tenant.hotelId` |
| `/api/menu/categories` | `GET`, `POST` | Menu Categories | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` (POST) / `ROLE_GROUPS.ALL_STAFF` (GET) | `where: { hotelId: tenant.hotelId }`, creation sets `hotelId: tenant.hotelId` | Bounded to `tenant.hotelId` |
| `/api/menu/categories/[id]` | `PATCH`, `DELETE` | Menu Category Update | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` | `where: { id: params.id, hotelId: tenant.hotelId }` | Composite lookup with `hotelId: tenant.hotelId` |
| `/api/menu/items/[id]` | `PATCH`, `DELETE` | Menu Item Management | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` | `where: { id: params.id, hotelId: tenant.hotelId }` | Composite lookup with `hotelId: tenant.hotelId` |
| `/api/recipes` | `GET`, `POST` | Menu Item Recipes | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` | `where: { hotelId: tenant.hotelId }`, validates ingredients belong to `tenant.hotelId` | Bounded to `tenant.hotelId` |
| `/api/recipes/[id]` | `PATCH`, `DELETE` | Recipe Formulation | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` | `where: { id: params.id, hotelId: tenant.hotelId }` | Composite lookup with `hotelId: tenant.hotelId` |
| `/api/restaurant/open-folios` | `GET` | Restaurant Active Guest Folios | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.RESTAURANT_POS)` | `where: { hotelId: tenant.hotelId, isClosed: false }`, includes checked-in reservations in `tenant.hotelId` | Filtered by `tenant.hotelId` |
| `/api/restaurant/charge-to-room` | `POST` | POS Room Bill Charge | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.RESTAURANT_POS)` | Scopes `folioId` to `tenant.hotelId`, checks stock consumption for items belonging to `tenant.hotelId` | Cross-tenant folio charge prevented |
| `/api/restaurant/pay-now` | `POST` | Walk-in Restaurant Settlement | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.RESTAURANT_POS)` | Creates guest & closed folio scoped to `tenant.hotelId`, cashier = `tenant.userId`, checks stock in `tenant.hotelId` | Bounded to `tenant.hotelId` |
| `/api/restaurant/activity` | `GET` | Restaurant Sales Activity | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.RESTAURANT_POS)` | FolioItems of type `RESTAURANT` where `folio.hotelId === tenant.hotelId` | Filtered by `tenant.hotelId` |
| `/api/inventory` | `GET`, `POST` | Stock Items Directory | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` | `where: { hotelId: tenant.hotelId, isArchived: false }`, creation sets `hotelId: tenant.hotelId` | Filtered by `tenant.hotelId` |
| `/api/inventory/[id]` | `PATCH`, `DELETE` | Stock Item Management | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` | `where: { id: params.id, hotelId: tenant.hotelId }` | Composite lookup with `hotelId: tenant.hotelId` |
| `/api/stock-movements` | `POST` | Stock Adjustment Audit | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` | Verifies item belongs to `tenant.hotelId`, creates movement with `hotelId: tenant.hotelId, userId: tenant.userId` | Cross-tenant inventory manipulation rejected |
| `/api/purchases` | `GET`, `POST` | Supplier Stock Purchases | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` | `where: { hotelId: tenant.hotelId }`, creation sets `hotelId: tenant.hotelId, createdById: tenant.userId` | Bounded to `tenant.hotelId` |
| `/api/wastage` | `GET`, `POST` | Kitchen & Bar Spoilage | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` | `where: { hotelId: tenant.hotelId }`, creation sets `hotelId: tenant.hotelId, recordedById: tenant.userId` | Bounded to `tenant.hotelId` |
| `/api/expenses` | `GET`, `POST` | Operational Expenses | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.ALL_STAFF)` (GET/POST request) | `where: { hotelId: tenant.hotelId }`, creation sets `hotelId: tenant.hotelId, requestedById: tenant.userId` | Bounded to `tenant.hotelId` |
| `/api/expenses/[id]` | `PATCH` | Expense Approval / Rejection | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.MANAGEMENT)` | `where: { id: params.id, hotelId: tenant.hotelId }` | Composite lookup with `hotelId: tenant.hotelId` |
| `/api/reports` | `GET` | Financial & Occupancy BI | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.FINANCIAL_REPORTS)` | Aggregations on payments, folios, rooms, inventory scoped strictly to `where: { hotelId: tenant.hotelId }` | Cross-tenant revenue leakage prevented |
| `/api/staff` | `GET` | Property Staff Roster | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.STAFF_VIEW)` | Queries `HotelMembership` where `hotelId: tenant.hotelId`, returns member users and their property `HotelRole` | Only returns staff members of the active hotel |
| `/api/staff` | `POST` | Invite / Add Property Staff | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.STAFF_ADMIN)` | Creates or looks up `User`, creates `HotelMembership` with `hotelId: tenant.hotelId, role: body.role` | Bounded to `tenant.hotelId` |
| `/api/staff/[id]` | `PATCH`, `DELETE` | Staff Membership & Role Update | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.STAFF_ADMIN)` | Mutates `HotelMembership` where `userId: params.id, hotelId: tenant.hotelId`. Cannot demote last `HOTEL_OWNER` | Composite lookup with `hotelId: tenant.hotelId` |
| `/api/search` | `GET` | Omnisearch Bar | `getTenantFromRoute()` | `requireHotelRole(ROLE_GROUPS.ALL_STAFF)` | Searches guests, rooms, reservations where `hotelId === tenant.hotelId` | Bounded to `tenant.hotelId` |
| `/api/admin/clean-test-data` | `POST` | Test Data Purge | `getTenantFromRoute()` | `requireHotelRole([HotelRole.HOTEL_OWNER, HotelRole.HOTEL_ADMIN])` | Every `deleteMany` explicitly scoped with `where: { hotelId: tenant.hotelId }`. Preserves user accounts and other hotels | Zero cross-tenant data purge |

---

## 3. Complete Inventory & Guard Mapping: Dashboard Server Components (`app/dashboard/**`)

| Page Route Path | Component File | Guard Helper | Allowed Role Group | Tenant Scoped Database Operations | Context & Props Mapping |
|---|---|---|---|---|---|
| `/dashboard` | `app/dashboard/page.tsx` | `requirePageRole(ROLE_GROUPS.ALL_STAFF)` | `ROLE_GROUPS.ALL_STAFF` | Counts & aggregates (`room.count`, `reservation.count`, `payment.aggregate`, `folioItem.aggregate`) scoped with `where: { hotelId: context.hotelId }` | Passes `context.role`, `context.userId`, `hotelName: context.hotel.name` |
| `/dashboard/front-desk` | `app/dashboard/front-desk/page.tsx` | `requirePageRole(ROLE_GROUPS.FRONT_DESK)` | `ROLE_GROUPS.FRONT_DESK` | `reservation.findMany`, `room.findMany`, `paymentMethod.findMany` where `hotelId: context.hotelId` | Passes `currentUserRole: context.role`, `currentUserId: context.userId` |
| `/dashboard/reservations` | `app/dashboard/reservations/page.tsx` | `requirePageRole(ROLE_GROUPS.GUEST_STAYS)` | `ROLE_GROUPS.GUEST_STAYS` | `room.findMany({ where: { hotelId: context.hotelId, isActive: true } })` | Passes `currentUserRole: context.role` |
| `/dashboard/guests` | `app/dashboard/guests/page.tsx` | `requirePageRole(ROLE_GROUPS.GUEST_STAYS)` | `ROLE_GROUPS.GUEST_STAYS` | `guest.findMany({ where: { hotelId: context.hotelId, isArchived: false } })` | Passes `currentUserRole: context.role` |
| `/dashboard/rooms` | `app/dashboard/rooms/page.tsx` | `requirePageRole(ROLE_GROUPS.ALL_STAFF)` | `ROLE_GROUPS.ALL_STAFF` | `room.findMany({ where: { hotelId: context.hotelId, isActive: true } })`, `roomType.findMany({ where: { hotelId: context.hotelId } })` | `canManage: hasRole(context.role, ROLE_GROUPS.MANAGEMENT)` |
| `/dashboard/housekeeping` | `app/dashboard/housekeeping/page.tsx` | `requirePageRole(ROLE_GROUPS.HOUSEKEEPING)` | `ROLE_GROUPS.HOUSEKEEPING` | `housekeepingTask.findMany({ where: { hotelId: context.hotelId } })`, `room.findMany({ where: { hotelId: context.hotelId } })` | Passes `currentUserRole: context.role` |
| `/dashboard/maintenance` | `app/dashboard/maintenance/page.tsx` | `requirePageRole(ROLE_GROUPS.MAINTENANCE)` | `ROLE_GROUPS.MAINTENANCE` | `maintenanceTicket.findMany({ where: { hotelId: context.hotelId } })`, `room.findMany({ where: { hotelId: context.hotelId } })` | Passes `currentUserRole: context.role` |
| `/dashboard/restaurant` | `app/dashboard/restaurant/page.tsx` | `requirePageRole(ROLE_GROUPS.RESTAURANT_POS)` | `ROLE_GROUPS.RESTAURANT_POS` | `menuCategory.findMany({ where: { hotelId: context.hotelId } })`, `menuItem.findMany({ where: { hotelId: context.hotelId } })` | Passes `currentUserRole: context.role` |
| `/dashboard/inventory` | `app/dashboard/inventory/page.tsx` | `requirePageRole(ROLE_GROUPS.MANAGEMENT)` | `ROLE_GROUPS.MANAGEMENT` | `inventoryItem.findMany({ where: { hotelId: context.hotelId, isArchived: false } })` | Passes `currentUserRole: context.role` |
| `/dashboard/expenses` | `app/dashboard/expenses/page.tsx` | `requirePageRole(ROLE_GROUPS.ALL_STAFF)` | `ROLE_GROUPS.ALL_STAFF` | `expense.findMany({ where: { hotelId: context.hotelId } })` | Passes `currentUserRole: context.role`, `currentUserId: context.userId` |
| `/dashboard/reports` | `app/dashboard/reports/page.tsx` | `requirePageRole(ROLE_GROUPS.FINANCIAL_REPORTS)` | `ROLE_GROUPS.FINANCIAL_REPORTS` | All financial metrics & occupancy metrics scoped to `hotelId: context.hotelId` | Passes `currentUserRole: context.role` |
| `/dashboard/staff` | `app/dashboard/staff/page.tsx` | `requirePageRole(ROLE_GROUPS.STAFF_VIEW)` | `ROLE_GROUPS.STAFF_VIEW` | `hotelMembership.findMany({ where: { hotelId: context.hotelId }, include: { user: true } })` | Passes `currentUserRole: context.role`, `currentUserId: context.userId` |
| Layout Shell | `app/dashboard/layout.tsx` | `getTenantContext()` | All authenticated active members | Layout wrapper validating active tenant context and injecting context into Topbar & Sidebar | Passes `userRole: context.role`, `userName: context.hotel.name` |

---

## 4. Security Verification Criteria

### 4.1 Hotel Switching Verification Criteria
- [ ] **CSRF & Origin Header Strict Verification:**
  - POST requests to `/api/auth/switch-hotel` without an `Origin` header are rejected with `403 CSRF_ORIGIN_INVALID`.
  - Origin headers that do not match `process.env.NEXTAUTH_URL` (protocol, hostname, port) are rejected immediately.
- [ ] **Active Authentication Enforcement:**
  - Unauthenticated requests to `/api/auth/switch-hotel` receive `401 UNAUTHENTICATED`.
- [ ] **Authoritative Membership Verification:**
  - Verifies `HotelMembership` exists for `(session.user.id, targetHotelId)`.
  - Membership with `status !== ACTIVE` (e.g. `SUSPENDED`) returns `403 NO_ACTIVE_MEMBERSHIP`.
  - Non-existent membership returns `403 NO_ACTIVE_MEMBERSHIP`.
- [ ] **Hotel Workspace Operational Verification:**
  - If `Hotel.status` is `SUSPENDED`, `CANCELLED`, or `DELETED`, switch is rejected with `403 HOTEL_SUSPENDED`.
  - Only `ACTIVE` and `TRIALING` hotels permit successful activation.
- [ ] **Tamper-Resistant Cookie Configuration:**
  - Upon successful switch, `active_hotel_id` cookie is emitted with:
    - `httpOnly: true` (inaccessible to JavaScript `document.cookie`)
    - `sameSite: "lax"` (CSRF protection)
    - `secure: true` in production (`process.env.NODE_ENV === "production"`)
    - `path: "/"`
    - `maxAge: 2592000` (30 days)
- [ ] **State Preservation on Failure:**
  - When switch validation fails, the existing `active_hotel_id` cookie is untouched (not corrupted or set to invalid ID).
- [ ] **Immediate Cross-Context Switch Propagation:**
  - When switching from Hotel A to Hotel B, subsequent Server Component renders and API calls immediately resolve Hotel B's data with zero session re-login requirement.

### 4.2 Resource Isolation & IDOR Verification Criteria
- [ ] **In-Memory IDOR Rejection:**
  - An authenticated user in Hotel A attempting to read `/api/guests/[id]` where `[id]` belongs to Hotel B receives `404 Guest not found` or `403`.
  - An authenticated user in Hotel A attempting to modify `/api/rooms/[id]` where `[id]` belongs to Hotel B receives `404 Room not found` or `403`.
- [ ] **Cross-Tenant Foreign Key Injection Prevention:**
  - Creating a reservation in Hotel A with a `guestId` belonging to Hotel B is blocked inside the transaction.
  - Adding a payment in Hotel A referencing a `folioId` belonging to Hotel B is blocked inside the transaction.
  - Moving a guest to a `newRoomId` in check-in verifies the target room has `hotelId === tenant.hotelId`.
- [ ] **Aggregation & Summary Isolation:**
  - KPI cards in `/dashboard` (Revenue, Occupancy, Outstanding Balance) calculate strictly from `tenant.hotelId`.
  - Financial reports in `/api/reports` aggregate zero numbers from other hotel tenants.
- [ ] **Bulk Deletions & Cleanups Scoping:**
  - `/api/admin/clean-test-data` wipes test folios, reservations, and tasks ONLY where `hotelId === tenant.hotelId`.
  - All other tenant databases remain 100% intact with zero deleted records.

### 4.3 Legacy Role Removal Verification Criteria
- [ ] **Zero Database Dependency on `User.role`:**
  - `User` table in `prisma/schema.prisma` contains no `role` column.
  - Platform administrator privileges use `User.platformRole` (`PlatformRole` enum: `SUPER_ADMIN`, `SUPPORT`).
  - Hotel workspace privileges use `HotelMembership.role` (`HotelRole` enum).
- [ ] **NextAuth Token Hygiene:**
  - `session.user` contains only `{ id, name, email }`.
  - JWT callback stores only `{ id }`.
  - No static role is cached inside NextAuth session or JWT token.
- [ ] **Server & Client Components Purity:**
  - No component or route handler attempts to access `session.user.role`.
  - UI permissions derive dynamically from `context.role` passed by Server Components or resolved via `getTenantContext()`.
- [ ] **TypeScript Type Safety:**
  - `types/next-auth.d.ts` declares `Session.user` without `role`.
  - TypeScript build (`npx tsc --noEmit`) passes with zero references to missing `User.role`.

---

## 5. Phase 4 Implementation Execution Checklist

### Workstream 1: Core Guards & Helper Hardening
- [x] **1.1** Implement `getTenantContext()` in `lib/tenant-context.ts` with authoritative database checks for active user, membership status, and hotel status.
- [x] **1.2** Implement `requireHotelRole(allowedRoles)` in `lib/tenant-context.ts` supporting `HotelRole` enum values.
- [x] **1.3** Implement `requirePlatformRole(allowedRoles)` in `lib/tenant-context.ts` for SaaS platform super-admins.
- [x] **1.4** Implement `requirePageRole(allowedRoles)` in `lib/page-auth.ts` with error handling and proper redirection (`/login`, `/select-hotel`, `/onboarding`).
- [x] **1.5** Implement `getTenantFromRoute()` in `lib/authz.ts` with standardized JSON error responses and cookie clearing on invalid tenant selection.
- [x] **1.6** Implement `/api/auth/switch-hotel` endpoint with CSRF Origin validation, membership status checks, and HttpOnly cookie management.
- [x] **1.7** Implement `/api/auth/memberships` endpoint returning all active hotel workspaces for the current user.
- [x] **1.8** Update `middleware.ts` to protect `/dashboard/:path*` and `/api/:path*`.

### Workstream 2: API Route Tenant Scoping (All 34+ Endpoints)
- [x] **2.1** Update `/api/admin/clean-test-data/route.ts` to enforce `getTenantFromRoute()` and scope all deletions strictly to `where: { hotelId: tenant.hotelId }`.
- [ ] **2.2** Update Room Endpoints (`/api/rooms`, `/api/rooms/[id]`, `/api/room-types`, `/api/room-types/[id]`) with `getTenantFromRoute()` and `hotelId` scoping.
- [ ] **2.3** Update Guest & Booking Endpoints (`/api/guests`, `/api/guests/[id]`, `/api/reservations`, `/api/reservations/[id]`, `/api/reservations/[id]/extend`) with `getTenantFromRoute()` and `hotelId` scoping.
- [ ] **2.4** Update Front Desk & Billing Endpoints (`/api/check-in`, `/api/check-out`, `/api/folios/[id]`, `/api/payments`, `/api/payment-methods`) with `getTenantFromRoute()` and transaction-level `hotelId` validation.
- [ ] **2.5** Update Operations Endpoints (`/api/housekeeping`, `/api/housekeeping/[id]`, `/api/maintenance`, `/api/maintenance/[id]`) with `getTenantFromRoute()` and `hotelId` scoping.
- [ ] **2.6** Update Restaurant POS & Menu Endpoints (`/api/menu`, `/api/menu/categories`, `/api/menu/items/[id]`, `/api/recipes`, `/api/restaurant/*`) with `getTenantFromRoute()` and `hotelId` scoping.
- [ ] **2.7** Update Inventory & Purchasing Endpoints (`/api/inventory`, `/api/inventory/[id]`, `/api/stock-movements`, `/api/purchases`, `/api/wastage`) with `getTenantFromRoute()` and `hotelId` scoping.
- [ ] **2.8** Update Financial & Administration Endpoints (`/api/expenses`, `/api/expenses/[id]`, `/api/reports`, `/api/staff`, `/api/staff/[id]`, `/api/search`) with `getTenantFromRoute()` and `hotelId` scoping.

### Workstream 3: Dashboard Server Components Alignment
- [x] **3.1** Update `app/dashboard/layout.tsx` to resolve `getTenantContext()` and pass `userRole: context.role` and `userName: context.hotel.name`.
- [ ] **3.2** Update `app/dashboard/page.tsx` with `requirePageRole(ROLE_GROUPS.ALL_STAFF)` and scope KPI counts/aggregates to `context.hotelId`.
- [ ] **3.3** Update `app/dashboard/front-desk/page.tsx` with `requirePageRole(ROLE_GROUPS.FRONT_DESK)` and scope all queries to `context.hotelId`.
- [ ] **3.4** Update `app/dashboard/reservations/page.tsx` with `requirePageRole(ROLE_GROUPS.GUEST_STAYS)` and pass `currentUserRole: session.role`.
- [ ] **3.5** Update `app/dashboard/guests/page.tsx` with `requirePageRole(ROLE_GROUPS.GUEST_STAYS)` and scope guest queries to `context.hotelId`.
- [ ] **3.6** Update `app/dashboard/rooms/page.tsx` with `requirePageRole(ROLE_GROUPS.ALL_STAFF)` and scope room/roomType queries to `context.hotelId`.
- [ ] **3.7** Update `app/dashboard/housekeeping/page.tsx` with `requirePageRole(ROLE_GROUPS.HOUSEKEEPING)` and scope task queries to `context.hotelId`.
- [ ] **3.8** Update `app/dashboard/maintenance/page.tsx` with `requirePageRole(ROLE_GROUPS.MAINTENANCE)` and scope ticket queries to `context.hotelId`.
- [ ] **3.9** Update `app/dashboard/restaurant/page.tsx` with `requirePageRole(ROLE_GROUPS.RESTAURANT_POS)` and scope menu queries to `context.hotelId`.
- [ ] **3.10** Update `app/dashboard/inventory/page.tsx` with `requirePageRole(ROLE_GROUPS.MANAGEMENT)` and scope item queries to `context.hotelId`.
- [ ] **3.11** Update `app/dashboard/expenses/page.tsx` with `requirePageRole(ROLE_GROUPS.ALL_STAFF)` and scope expense queries to `context.hotelId`.
- [ ] **3.12** Update `app/dashboard/reports/page.tsx` with `requirePageRole(ROLE_GROUPS.FINANCIAL_REPORTS)` and scope analytics queries to `context.hotelId`.
- [ ] **3.13** Update `app/dashboard/staff/page.tsx` with `requirePageRole(ROLE_GROUPS.STAFF_VIEW)` to query `hotelMembership` where `hotelId: context.hotelId` and eliminate references to legacy `user.role`.

### Workstream 4: Automated Verification & Test Coverage
- [x] **4.1** Automated unit test suite `__tests__/auth/tenant-auth.test.ts` verifying:
  - Account inactive rejection
  - Missing membership rejection
  - Suspended membership rejection
  - Suspended hotel workspace rejection
  - Cookie auto-selection vs explicit validation
  - Cookie clearing on invalid hotel selection
- [ ] **4.2** Integration test suite `__tests__/auth/switch-hotel.test.ts` verifying CSRF Origin check, membership check, and cookie header generation.
- [ ] **4.3** Cross-tenant isolation test suite `__tests__/safety/cross-tenant-isolation.test.ts` verifying IDOR resistance across room, reservation, guest, and folio endpoints.
- [ ] **4.4** Compilation and linting pass with `compile_applet`.
