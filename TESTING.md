# HMS Testing Documentation

> ## Current verification status (2026-10-30)
>
> The latest full Vitest run passed **647/647 tests across 45 files**. `npm run lint`,
> `npx tsc --noEmit`, Prisma Client generation, Prisma schema validation, and the Next.js
> production build also passed. The test suite uses mocks and disposable in-memory PGlite
> databases; it does not verify a deployed migration history or substitute for a real
> PostgreSQL rehearsal.
>
> **73 tests remain illustrative placeholders**: 36 in `workflows/guest-lifecycle.test.ts` and
> 37 in `utilities/helpers.test.ts`. Their passing result is not evidence that the complete
> guest lifecycle or those utility functions work end-to-end.
>
> Tooling checks/builds used only dummy URLs at `127.0.0.1:1`; no database was contacted and
> no migration, seed, restore, reset, or database write was run. Vite emits an existing,
> non-blocking config-loader warning during tests.

## Overview
The current suite has **647 tests in 45 files**. It is green as a test suite, but mocked and
placeholder cases have limited reach. Relevant tenant and schema test groups include:

| Suite | Tests | What it checks |
|---|---:|---|
| `schema/migrations.test.ts` | 7 | Migration chain, legacy conversion, and proposal checks using disposable PGlite instances |
| `schema/multi-tenant-schema.test.ts` | 9 | Tenant-scoped schema constraints |
| `schema/cross-tenant-integrity.test.ts` | 24 | Cross-tenant foreign-key and integrity rules |
| `tenant-isolation/affected-routes.test.ts` | 29 | Tenant isolation across route handlers with mocks |
| `platform/platform-administration.test.ts` | 23 | Platform administration behavior with in-memory mocks |
| `auth/tenant-auth.test.ts` | 19 | Tenant selection, role authorization, and hotel switching |
| `onboarding/hotel-onboarding.test.ts` | 13 | Registration/onboarding validation, mocked persistence, offline and uniqueness cases |
| `subscriptions/subscription-entitlements.test.ts` | 48 | Subscription and entitlement behavior with mocked storage |
| `scripts/cleanup-scope.test.ts` | 3 | Static guardrails against unscoped cleanup and non-transactional execution |
| `scripts/database-target-safety.test.ts` | 4 | Identifier validation and wiring for standalone backup/restore target checks |
| `safety/offline-auth-routes.test.ts` | 3 | Offline 503 responses without importing Prisma-backed auth modules |

Real database integration, deployed migration-history comparison, browser E2E, backup/restore,
cleanup, and seed against a real database were **not run**. The migration suite proves only that
the current migration files execute against fresh disposable in-memory databases and satisfy its
fixtures; it cannot establish that rewriting an older migration is safe for a deployed target.

## Test Framework
- **Vitest** - Modern, fast test runner with Vue/React support
- **@testing-library/react** - Component testing utilities
- **jsdom** - DOM simulation environment
- **@testing-library/jest-dom** - Extended matchers

## Project Structure

```
__tests__/
├── seed/
│   ├── seed.test.ts                   # REAL: runs prisma/seed.ts (8 tests)
│   └── cleanup-guard.test.ts          # REAL: destructive-cleanup rules (24 tests)
├── schema/
│   └── migrations.test.ts             # REAL: migration/schema checks in PGlite (7 tests)
├── middleware/
│   └── matcher.test.ts                # REAL: verifies middleware.ts matcher (4 tests)
├── rooms/
│   ├── room-status.test.ts            # REAL: floor-board rules (13 tests)
│   └── tariffs.test.ts                # REAL: tariff matching (12 tests)
├── restaurant/
│   └── cart.test.ts                   # REAL: POS cart boundary + arithmetic (23 tests)
├── inventory/
│   └── stock.test.ts                  # REAL: availability + stock status (21 tests)
├── reports/
│   └── excel-export.test.ts           # REAL: workbook structure (8 tests)
├── auth/
│   └── session-revocation.test.ts     # REAL: session invalidation (7 tests)
├── workflows/
│   └── guest-lifecycle.test.ts        # PLACEHOLDER: workflow spec (36 tests)
├── api/
│   └── endpoints.test.ts              # REAL: guest route handler behavior (10 tests)
├── utilities/
│   ├── helpers.test.ts                # PLACEHOLDER: 37 tests, imports nothing real
│   └── dates.test.ts                  # REAL: timezone-pinned date display (8 tests)
├── fixtures/
│   └── mock-data.ts                   # Mock data for tests
└── test-utils.tsx                     # Testing utilities & render helpers
```

## Test Coverage

### 1. Guest Lifecycle Specification (`guest-lifecycle.test.ts`)
The 36 assertions below are placeholders: they describe desired coverage but do not invoke the
application or its API routes. They are not end-to-end tests yet. The planned workflow is:

- **Guest Registration (3 tests)**
  - Create guest with valid information
  - Validate required fields
  - Prevent duplicate registration

- **Room Availability Check (4 tests)**
  - Check room availability for date range
  - Calculate room rate for stay duration
  - Handle unavailable rooms
  - Validate room status

- **Reservation Creation (4 tests)**
  - Create reservation with valid details
  - Generate unique reservation code
  - Set reservation status
  - Validate check-out date logic

- **Check-in Process (4 tests)**
  - Perform guest check-in
  - Create folio during check-in
  - Update room status to OCCUPIED
  - Update reservation status

- **Folio Management (5 tests)**
  - Add room charges
  - Add restaurant charges
  - Add room service charges
  - Calculate folio totals
  - Handle multiple charge types

- **Payment Processing (5 tests)**
  - Process full payment
  - Handle partial payments
  - Accept multiple payment methods
  - Generate payment receipts
  - Handle payment failures

- **Check-out Process (5 tests)**
  - Close folio on check-out
  - Update reservation status
  - Return room to AVAILABLE
  - Create housekeeping task
  - Generate checkout summary

- **Error Handling & Edge Cases (3 tests)**
  - Handle same-day check-in/out
  - Handle long-stay bookings
  - Prevent double booking

- **Performance & Data Integrity (3 tests)**
  - Maintain data consistency
  - Handle concurrent operations
  - Audit all transactions

### 2. Guest API Route Tests (`endpoints.test.ts`)
Ten tests invoke the actual guest route handlers with mocked tenant and Prisma boundaries:

- Hotel-scoped guest listing and nested reservation queries
- Trimmed case-insensitive search and archived-guest filtering
- Authentication and role checks before database access
- Compound `(guestId, hotelId)` lookups, folio totals, and cross-tenant not-found behavior
- Preventing archive of checked-in guests and scoping archive writes to the active hotel

Other areas in the old endpoint suite were object-literal placeholders and were removed; they
need new route tests before their behavior can be considered covered.

### 3. Utility & Helper Tests (`helpers.test.ts`)
37 tests for critical utility functions:

- **Date Utilities (9 tests)**
  - Night calculation
  - Date range overlaps
  - Date formatting
  - Day of week detection

- **Price Calculations (8 tests)**
  - Room charges for multiple nights
  - Discount calculations
  - Rack vs negotiated rates
  - Tax calculations
  - Service charges
  - Payment schedules

- **String Utilities (7 tests)**
  - Reservation code generation
  - Email validation
  - Phone formatting
  - Status display formatting

- **Collection Utilities (5 tests)**
  - Sorting (by date, by room number)
  - Filtering (available rooms, by type)
  - Grouping (by status)

- **Validation Utilities (3 tests)**
  - Guest data validation
  - Reservation date validation
  - Required field checks

## Running Tests

### Run all tests
```bash
npm run test:run
```

### Run tests in watch mode (interactive)
```bash
npm test
```

### Run tests with UI dashboard
```bash
npm run test:ui
```

### Run tests with coverage report
```bash
npm run test:coverage
```

## Test Results Summary

Latest full run on the worktree:

```
Test Files  45 passed (45)
     Tests  647 passed (647)
```

The PGlite schema/migration tests create disposable in-memory databases and close them after
use. They exercise the current migration files from a fresh schema and representative legacy
fixtures. They do not connect to an external database, validate PostgreSQL/Supabase version
compatibility, or establish whether an older migration has already been applied elsewhere.

### Coverage notes

- Tenant authorization, platform administration, subscriptions, reservations, folios, staff,
  and affected API routes have mock-backed test groups. A passing mock test is not live-database
  integration evidence.
- Registration/onboarding tests exercise mocked persistence and now cover invalid IANA time
  zones, uniqueness races, and blank-database responses.
- Static maintenance-script tests guard cleanup scoping and database-target identifier checks.
  Cleanup, backup, restore, reset-password, and seed scripts were not executed against any DB.
- `workflows/guest-lifecycle.test.ts` (36 tests) and `utilities/helpers.test.ts` (37 tests) are
  illustrative placeholders. They do not call application routes or the real utility functions.
- Middleware matcher tests check route matching, not a full browser session or live middleware
  behavior.

### Checks and limits

- Prisma 5.17.0 client generation and schema validation passed with the pinned Linux engines.
- Full TypeScript, lint, and production build checks passed.
- Browser E2E was not run. PostgreSQL/Supabase migration application/history and backup/restore
  rehearsals were not run; no database was contacted.
- The PGlite migration runner checks SQL behavior on fresh disposable in-memory databases only.
  It does not validate the target's migration ledger/checksums or Prisma deploy recovery semantics.

Before any non-test database operation, independently verify the exact project/host, the
`_prisma_migrations` history and checksums, and that the target is an approved isolated SaaS
instance. Identifier matching alone is not proof of safety. Never use Axis production credentials
or records for these tests.
