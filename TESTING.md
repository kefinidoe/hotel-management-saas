# HMS Testing Documentation

> ## Current verification status (2026-10-30)
>
> The latest full Vitest run passed **768 tests across 50 files** (4 skipped), and `npm run lint` passed.
> `npx tsc --noEmit` currently reports 296 diagnostics, all of them consequences of the Prisma
> client not being generated in this sandbox (77 missing `@prisma/client` exports plus cascading
> inference errors); none are in the migration, adoption or rehearsal code. Prisma generation,
> schema validation and the Next.js production build could not run here because Prisma fetches its
> engines from `binaries.prisma.sh`, which this sandbox cannot reach.
>
> **73 tests remain illustrative placeholders**: 36 in `workflows/guest-lifecycle.test.ts` and
> 37 in `utilities/helpers.test.ts`. Their passing result is not evidence that the complete
> guest lifecycle or those utility functions work end-to-end.
>
> The migration work is additionally covered by a **real PostgreSQL 17.11 rehearsal**
> (`scripts/migration-rehearsal.mjs`, 8 scenarios, 83 assertions, all passing) that applies the
> committed migrations, adopts ledgerless databases and proves the fail-closed paths, and by the
> evidence tools `scripts/target-check.mjs` (read-only checkpoint/fingerprint) and
> `scripts/restore-rehearsal.mjs` (digest-enforced restore into a scratch database). Details in
> `docs/saas-migration-rehearsal.md`. The pinned 5.17.0 engine, the owner's archive and the live
> target are still not exercised here, because of the engine-availability and credential limitations
> above; production readiness is not claimed.

## Overview
The current suite has **772 tests in 50 files** (four skip without a live PostgreSQL server). It is green as a test suite, but mocked and
placeholder cases have limited reach. Relevant tenant and schema test groups include:

| Suite | Tests | What it checks |
|---|---:|---|
| `schema/migrations.test.ts` | 12 | Migration chain, schema parity, legacy conversion, tenant join-key prechecks, idempotency guards (disposable PGlite) |
| `schema/migration-adoption.test.ts` | 26 | Release manifest, checkpoint classification and ledgerless-adoption planning (pure, no database) |
| `schema/multi-tenant-schema.test.ts` | 9 | Tenant-scoped schema constraints |
| `schema/cross-tenant-integrity.test.ts` | 24 | Cross-tenant foreign-key and integrity rules |
| `tenant-isolation/affected-routes.test.ts` | 29 | Tenant isolation across route handlers with mocks |
| `platform/platform-administration.test.ts` | 23 | Platform administration behavior with in-memory mocks |
| `auth/tenant-auth.test.ts` | 19 | Tenant selection, role authorization, and hotel switching |
| `onboarding/hotel-onboarding.test.ts` | 13 | Registration/onboarding validation, mocked persistence, offline and uniqueness cases |
| `subscriptions/subscription-entitlements.test.ts` | 48 | Subscription and entitlement behavior with mocked storage |
| `scripts/cleanup-scope.test.ts` | 3 | Static guardrails against unscoped cleanup and non-transactional execution |
| `scripts/database-target-safety.test.ts` | 4 | Identifier validation and wiring for standalone backup/restore target checks |
| `scripts/migration-readiness.test.ts` | 9 | The three prerequisites are reported individually with the PASS / BLOCKED / FAIL vocabulary; approval is always PENDING APPROVAL; decision is the worst prerequisite |
| `scripts/prisma-engine-pin.test.ts` | 16 | Pinned Prisma 5.17.0 digests and commit: parser, match/mismatch/missing paths, and the `verify-pin` CLI refusals |
| `scripts/archive-toc.test.ts` | 46 | The `pg_restore --list` parser and the `--use-list` filter: Supabase-schema detection, extension/type exclusion, the `SCHEMA`-name regression that let `auth` survive filtering, dependency-aware exclusion of an excluded extension's or schema's `COMMENT`/`ACL` entries, multi-word TOC types (`ROW SECURITY`, `PUBLICATION TABLE`, `SEQUENCE OWNED BY`), a retained function signature that references an excluded schema, and the CLI's `--help`/`--dump`/`--toc` contract (pure, no database; the real-archive case needs `REHEARSAL_TEST_BASE_URL`) |
| `scripts/migration-evidence-tools.test.ts` | 23 | CLI-level refusals for `target-check.mjs` (no write path, target binding, pooler port) and `restore-rehearsal.mjs` (digest, missing archive, corrupt archive preflight, shared host, reserved names, unknown `--profile`, `--exclude-schema public`, plain-SQL `--toc`) — no database needed; the archive-reading cases skip when `psql`/`pg_restore` are not installed; three end-to-end restore tests run only when `REHEARSAL_TEST_BASE_URL` names a disposable server |
| `safety/offline-auth-routes.test.ts` | 3 | Offline 503 responses without importing Prisma-backed auth modules |

Browser E2E, backup/restore against the real target, cleanup and seed against a real database were
**not run**. The PGlite suite proves that the current migration files execute against fresh
disposable in-memory databases and satisfy their fixtures. It is complemented by
`scripts/migration-rehearsal.mjs`, which was run against a real PostgreSQL 17.11 server and covers
the fresh chain, the legacy upgrade, ledgerless adoption, the fail-closed conflict path and re-run
idempotency. Neither establishes that `prisma migrate deploy` behaves identically, because the
pinned Prisma engines are unavailable here.

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
│   ├── migrations.test.ts             # REAL: migration/schema checks in PGlite (12 tests)
│   ├── migration-adoption.test.ts     # REAL: manifest + ledgerless adoption planning (26 tests)
│   └── migration-runner.ts            # PGlite chain runner used by the migration tests
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

### Node.js version

The project runs on **Node.js 24**. `.nvmrc` and `package.json`'s `engines.node` (`>=24.0.0`) both
say so, and CI installs 24 on both operating systems:

```bash
nvm use             # reads .nvmrc -> 24
node --version      # v24.x
```

`vitest@5` supports `^22.12.0 || ^24.0.0 || >=26.0.0`; Node 24 is the supported line this project
tests and deploys on. Node 22 still runs the suite locally, but `npm install` will warn with
`EBADENGINE`, and nothing in CI or the deployment checklist is verified on it.

### Windows checkouts

Migration checksums are byte-level: Prisma hashes the raw bytes of `migration.sql`. Git stores those
files as LF and `.gitattributes` pins them there, so a normal checkout is byte-identical on Windows
and Linux even with `core.autocrlf=true`. If an older clone (or an editor that rewrote line endings)
has reintroduced CRLF you will see:

```
npm run migration:verify-eol   # exits 1 and names the affected files
```

Recovery is a one-off, non-destructive re-checkout:

```bash
git config core.autocrlf false
rm -rf prisma/migrations
git checkout -- prisma/migrations
```

Manifest verification tolerates CRLF by comparing the LF bytes Git would deploy, and the migration
tests assert that behaviour; only `npm run migration:adopt` refuses outright, because that is the
command that writes digests into `_prisma_migrations`. See
[docs/migration-strategy.md §4.0](docs/migration-strategy.md).

### Continuous integration

`.github/workflows/ci.yml` runs the same checks on `ubuntu-latest` and `windows-latest` for every
push and pull request, on Node.js 24 with `npm ci`:

| Step | Command | Needs a database? |
|---|---|---|
| Prisma client verification | `npm run check:prisma-client` | no |
| Schema validation | `npx prisma validate` (placeholder URLs) | no — parses only, never connects |
| Migration bytes | `npm run migration:verify-eol` + `npm run migration:manifest` | no |
| TypeScript | `npx tsc --noEmit` | no |
| Lint | `npm run lint` | no |
| Tests | `npx vitest run` | no — PGlite is in-memory |
| Build | `npm run build` | no |

The Windows job additionally prints `core.autocrlf` and re-runs the CRLF detection tests, so the
line-ending protections are exercised where CRLF actually occurs. The checks that genuinely require
a PostgreSQL server — the restore rehearsal, `migration:rehearse`, `target-check`, the live
`db-integrity` run and adoption — are **not** in CI and are not simulated there; Vitest reports the
restore-rehearsal tests as *skipped* when `psql`/`pg_restore` or `REHEARSAL_TEST_BASE_URL` are
absent, which is the expected CI state.

## Test Results Summary

Latest full local run (Node 22.22.3 on Linux); CI runs the identical suite on Node 24 on
`ubuntu-latest` and `windows-latest` and reports the same counts:

```
Test Files  68 passed (68)
     Tests  1030 passed | 6 skipped (1036)
```

The six skips are environment gates, not disabled checks: five restore-rehearsal/archive-toc tests
require a real PostgreSQL server (`psql`/`pg_restore` plus `REHEARSAL_TEST_BASE_URL`), and one
requires only the PostgreSQL client binaries. See `docs/migration-strategy.md §4.0` and the
"Continuous integration" section above.

The PGlite schema/migration tests create disposable in-memory databases and close them after
use. They exercise the current migration files from a fresh schema and representative legacy
fixtures; they do not connect to an external database. The separate PostgreSQL rehearsal
(`REHEARSAL_BASE_URL=postgresql://postgres@127.0.0.1:<port> npm run migration:rehearse`) covers a
real server of the target major version and the ledgerless-adoption paths.

The two evidence tools are also exercised end to end outside Vitest, on a disposable loopback
PostgreSQL 17.11 server, in `docs/saas-migration-rehearsal.md` §9: a digest-verified restore of a
94 951-byte archive (28 tables, data intact, scratch database dropped), a read-only checkpoint and
fingerprint check against both a ledgerless copy and a 19-row ledger, and the refusal paths
(wrong digest, missing archive, shared host, existing database name, tampered ledger).

Beyond those two layers, `npm run migration:verify-engine` drives Prisma's own migrate implementation
(`@prisma/migrate` + the official WebAssembly schema engine) against disposable PostgreSQL 17.11
databases: 6 scenarios, 37 assertions covering deploy, `migrate resolve --applied`,
`migrate resolve --rolled-back`, drift detection and adoption-tool interop. It runs out of process
with a verification-only tool stack and is not part of the vitest suite; see
[docs/migration-strategy.md §7](docs/migration-strategy.md). The pinned 5.17.0 engine and the real
Supabase target are still not exercised by any of these layers.

### Coverage notes

- Tenant authorization, platform administration, subscriptions, reservations, folios, staff,
  and affected API routes have mock-backed test groups. A passing mock test is not live-database
  integration evidence.
- Registration/onboarding tests exercise mocked persistence and now cover invalid IANA time
  zones, uniqueness races, and blank-database responses.
- Static maintenance-script tests guard cleanup scoping and database-target identifier checks.
  Cleanup, reset-password, and seed scripts were not executed against any DB.
- `backup-db.mjs` and `restore-rehearsal.mjs` were executed against a disposable local PostgreSQL
  17.11 server (never the target); `target-check.mjs` was executed read-only against local copies only.
- `migration-readiness.mjs` was run with no inputs, with a digest-matching archive, with a deliberately
  non-matching archive, with configured-but-uncontacted credentials, and with `--check-target` against a
  disposable local database (archive PASS, credentials PASS, engine BLOCKED, decision BLOCKED).
- `prisma-engine-pin.mjs` was executed against deliberately wrong and missing files (both refused) and
  in its `--help`/no-argument forms. Its positive path needs the genuine 5.17.0 artifacts, which no
  reachable host serves, so it has not been run against a real engine.
- `workflows/guest-lifecycle.test.ts` (36 tests) and `utilities/helpers.test.ts` (37 tests) are
  illustrative placeholders. They do not call application routes or the real utility functions.
- Middleware matcher tests check route matching, not a full browser session or live middleware
  behavior.

### Checks and limits

- Prisma 5.17.0 client generation and schema validation passed with the pinned Linux engines.
- Full TypeScript, lint, and production build checks passed.
- Browser E2E was not run. Migration rehearsals did run, but only against disposable local
  PostgreSQL 17.11 databases: the 8-scenario psql rehearsal, the 6-scenario real-engine run, and
  digest-verified backup/restore cycles on archives built here. No Supabase or shared database was
  contacted, the live target's checkpoint has not been observed, the owner's archive has not been
  restored, and the pinned 5.17.0 engine has not run (its artifacts and acceptance steps are
  recorded in `docs/migration-strategy.md` §7.1.1–7.1.3).
- The PGlite migration runner checks SQL behavior on fresh disposable in-memory databases only.
  It does not validate the target's migration ledger/checksums or Prisma deploy recovery semantics.

Before any non-test database operation, independently verify the exact project/host, the
`_prisma_migrations` history and checksums, and that the target is an approved isolated SaaS
instance. Identifier matching alone is not proof of safety. Never use Axis production credentials
or records for these tests.
