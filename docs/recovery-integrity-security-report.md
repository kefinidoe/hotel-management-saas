# Round 11 — recovery, integrity, security and operational readiness report

**Branch:** `arena/1e24e452-hotel-management-saas` (branched from `main` = `9cafa58`)
**Commits on this branch:** `3ff67c9` (integrity checker + runbook), `27aacc0` (billing currency + audit trail), plus the commit that adds this report.
**Date:** 2026-10-30 · **Environment:** isolated sandbox, disposable resources only. No connection to Supabase, to production, or to the live Axis Hotel system was made.

Every item below carries one of **PASS / FAIL / BLOCKED / NOT TESTED**, based on evidence produced in this environment. Nothing is marked PASS on the strength of code reading alone where a test could be run.

---

## 1. Executive summary

The application-level security and tenancy work from the previous rounds holds up under a fresh, clean install: **791 tests pass across 52 files with 0 failures** (`6` skipped are archive/rehearsal tests that need a database archive, not a code path), ESLint is clean, and the TypeScript error count is unchanged from baseline at 297 — every one of those is a downstream effect of the Prisma client not being generated in this sandbox, not a new defect.

Three things were added or fixed in this round:

1. **A read-only database integrity checker** (`scripts/db-integrity.mjs`, 48 checks) that answers "is the database I just restored actually sound?" — tables, tenant foreign keys, `hotelId` indexes, orphaned tenant rows, cross-hotel child rows, row counts — with 12 tests running its real SQL against the real migration chain.
2. **A production recovery runbook** (`docs/production-recovery.md`, all 16 required sections) that separates *application-PostgreSQL* recovery from *full Supabase platform* recovery, with exact commands.
3. **Two material defects fixed:**
   - a hotel could change its operation currency (KES → USD) and keep a subscription priced in the old currency, so screens quoted one currency while the ledger billed another;
   - privileged hotel-level mutations (staff role changes, staff removal/suspension, hotel settings) were not audited at all — only platform actions were.

The genuine archive restore remains **BLOCKED** in this environment (the archive is not present on disk here; the owner's own round-5/9/10 rehearsal evidence stands as prior evidence, not as a result produced now). `npm run build` remains **BLOCKED** by an unreachable Prisma engine host. Browser E2E is **NOT TESTED** — no browser automation exists in the repository and the app cannot boot without a generated Prisma client.

**Production-readiness verdict: not ready to declare "production ready" from this environment.** The application code is in materially better shape than the average of its class, and the tenancy/authorisation/financial controls are tested rather than merely asserted — but the two blockers above (no demonstrated build, no demonstrated genuine restore *here*) are precisely the two things a go-live gate exists to prevent.

## 2. Initial findings

| ID | Finding | Status at the start of this round | Now |
|---|---|---|---|
| A | Hotel admin could reset an existing user's global password (account takeover across hotels) | Fixed in the staff routes by a `newPassword` → 403 guard; needed re-verification | **PASS** — verified by reading both handlers and by the existing assertion that the hash is unchanged |
| B | Subscription entitlements must be enforced on APIs and pages, not just hidden in the UI | Largely present; needed to be counted, not assumed | **PASS** — 42 of 57 API routes call `requireModule`; the 15 that do not are auth, platform, billing-recovery and profile routes that must stay reachable when a plan lapses |
| C | `/api/hotel/subscription` must require membership and an admin role | Already guarded | **PASS** — `getBillingTenantFromRoute()` (validates an ACTIVE membership and an active user) + `requireRole(..., STAFF_ADMIN)` |
| D | Financial data restricted to authorised roles, including `FINANCIAL_REPORTS` | Report page and report API already guarded | **PASS** — same role group on page and API; dashboard KPI cards gated by `hasRole` |
| E | Maintenance/housekeeping/wastage assignees must be active members of the same hotel | Partially: display filtered, writes unvalidated when the round began | **PASS** — both PATCH handlers call `findActiveHotelStaff(hotelId, assigneeId, tx)`; tasks are only auto-created at check-out with `hotelId` from the session and no assignee |
| F | Other material issues | Unknown | **2 fixed, 1 documented as residual risk** (see §6) |

## 3. Work completed

| Work | Where | Evidence |
|---|---|---|
| Database integrity checker, 48 checks | `scripts/db-integrity.mjs` | `npm run db:integrity`; 12 tests in `__tests__/scripts/db-integrity.test.ts` |
| Production recovery runbook, 16 sections | `docs/production-recovery.md` | all commands cross-checked against each script's own `--help` / source |
| Billing currency integrity | `app/api/hotel/settings/route.ts`, `app/api/hotel/subscription/route.ts`, `lib/plans.ts` | 13 new tests in `__tests__/settings/settings-billing-audit.test.ts` |
| Hotel-scoped audit trail | `lib/audit.ts` + staff and settings routes | same test file; existing 69 staff/settings/subscription tests still pass |
| Verification sweep of A–E | route/page inventory, 57 API routes, 14 dashboard pages | §6 |

## 4. Files and modules changed

Added:
- `scripts/db-integrity.mjs`
- `__tests__/scripts/db-integrity.test.ts` (12 tests)
- `__tests__/settings/settings-billing-audit.test.ts` (13 tests)
- `lib/audit.ts`
- `docs/production-recovery.md`
- `docs/recovery-integrity-security-report.md` (this file)

Modified:
- `app/api/hotel/settings/route.ts` — re-prices the subscription when the billed currency changes; writes `HOTEL_SETTINGS_UPDATED`
- `app/api/hotel/subscription/route.ts` — quotes prices in the billed currency; adds `matchesHotelCurrency`
- `app/api/staff/route.ts`, `app/api/staff/[id]/route.ts` — audit rows for staff add / update / suspend / remove
- `lib/plans.ts` — `normaliseBillingCurrency`, `priceForSubscription`
- `package.json` — `db:integrity` script

## 5. Database and migration changes

**None.** No migration was added or edited, no model changed, and `prisma/migrations/` is byte-identical to `main`. The round's database work is read-only tooling and documentation. `prisma validate` and the migration manifest are unchanged from round 10 (19/19 migrations, checksums pinned).

`scripts/db-integrity.mjs` verifies, without writing:

| Check family | Count | What it proves |
|---|---|---|
| `tables.present` | 1 | all 28 application tables exist |
| `hotel.orphans` | 1 | no tenant row references a missing hotel (union across 24 hotel-owned tables) |
| `hotel.null:<table>` | 24 | every hotel-owned row carries a `hotelId` |
| `tenant.mismatch:<child>.<col>` | 20 | a child row never belongs to a different hotel from its parent |
| `constraints.tenant-fk` | 1 | every tenant relation is backed by a real foreign key |
| `indexes.hotelId` | 1 | every hotel-scoped table has an index that covers `hotelId` |
| `row.counts` | 29 | per-table row counts for the post-restore checklist |

## 6. Security findings and fixes

### F-1 (fixed) — billing currency desynchronisation

**Root cause.** `PATCH /api/hotel/settings` let a hotel admin change `Hotel.currency` freely. `Subscription.currency` and `Subscription.amount` were set once at bootstrap and never revisited. After a KES → USD change the billing page quoted the USD price schedule while the stored subscription still billed KES; platform MRR grouped the hotel by `sub.currency`, so revenue reporting and the customer's own screen disagreed.
**Fix.** In the same transaction as the settings update, when the operation currency crosses the KES/USD boundary the stored subscription is re-priced with `priceForSubscription()` (single source of truth, from `lib/plans.ts`) and both `currency` and `amount` are updated. Non-KES/USD currencies (EUR, GBP, …) do not re-denominate the bill, because the price schedule does not publish those currencies. The response reports `subscriptionRepriced`. `GET /api/hotel/subscription` now quotes options in the billed currency and states whether it matches the hotel's operation currency.
**Tests.** `re-prices … when the operation currency crosses KES/USD`, `leaves the subscription alone when the billed currency does not change`, `keeps the stored amount when it already matches`, `fails the request rather than silently diverging`.
**Residual risk.** Historical folios and payments are not converted; changing currency reinterprets past amounts. This is now audited and visible, not silently accepted.

### F-2 (fixed) — no hotel-side audit trail for privileged mutations

**Root cause.** `AuditLog` was written only by platform endpoints (hotel status, subscription changes). A hotel owner could change another member's role, suspend them, or remove them with no record beyond application logs.
**Fix.** `lib/audit.ts` + audit rows for `STAFF_MEMBER_ADDED`, `STAFF_MEMBERSHIP_UPDATED` (previous and next role/status/department), `STAFF_MEMBERSHIP_SUSPENDED`, `STAFF_MEMBERSHIP_REMOVED`, `HOTEL_SETTINGS_UPDATED` (fields, previous/new currency, re-price result). Actor and target ids are recorded; a failed write is logged to the server console and never blocks the mutation.
**Tests.** `writes a hotel-scoped audit row describing the change`, `recordAudit` unit tests (writes, no-op, never throws).

### F-3 (documented, not changed) — a hotel admin can add an existing account to their hotel

`POST /api/staff` adds an existing global user to the caller's hotel with the requested role, without that user's consent. It cannot change their credentials (verified: the existing-account branch touches only `HotelMembership`), so it is not an account takeover — it is unsolicited membership. Concluding this needs a consent/invitation flow, which is a product decision, not a bug fix; it is recorded as **residual risk** rather than silently "fixed" by removing a legitimate multi-hotel feature.

### Re-verified controls (A–E)

| Control | Evidence |
|---|---|
| A — no admin password reset | `app/api/staff/[id]/route.ts` rejects `newPassword` with 403 before any write; `__tests__/staff/multi-tenant-staff.test.ts` asserts 403 **and** that `passwordHash` is unchanged. Password writes exist in exactly three places: self-service change (requires the current password), new-user creation, and the break-glass CLI |
| B — entitlements on APIs and pages | 42/57 routes call `requireModule`; 14 dashboard pages call `requirePageRole(role, module)`; the 15 routes without it are auth, platform, billing-recovery, profile and the disabled cleanup endpoint. `__tests__/subscriptions/subscription-entitlements.test.ts` — 48 tests |
| C — subscription endpoint authorisation | `getBillingTenantFromRoute()` → `getTenantContext()` (ACTIVE membership + active user) then `requireRole(…, STAFF_ADMIN)` |
| D — financial reporting restricted | `app/api/reports/route.ts` and `app/dashboard/reports/page.tsx` both use `ROLE_GROUPS.FINANCIAL_REPORTS`; dashboard KPIs gated with `hasRole`. Front-desk folio balances remain visible to front desk by design (operational need), which is a deliberate boundary, not an oversight |
| E — assignees must be same-hotel active members | `findActiveHotelStaff(hotelId, assigneeId, tx)` inside the update transaction in both `housekeeping/[id]` and `maintenance/[id]`; check-out creates tasks with no assignee |
| No mass assignment | no `...body` spread anywhere in `app/` or `lib/` |
| No unscoped id lookups | every tenant-model lookup in `app/api` scopes by `hotelId` or the composite `id_hotelId`; the only bare `where: { id }` calls are `Hotel` by its own id, platform endpoints, and the token's own user |
| No uploads / unsafe file handling | no `FormData`, `writeFile` or upload handler exists in the app |
| Dangerous admin endpoint | `/api/admin/clean-test-data` returns 403 in production or without `ALLOW_TEST_DATA_CLEANUP=true`, and is hotel-scoped |

## 7. Tenant isolation results

**PASS.** 99 tenant-isolation assertions across five suites, all against realistic two-hotel fixtures:

| Suite | Tests | Covers |
|---|---|---|
| `__tests__/tenant-isolation/affected-routes.test.ts` | 29 | every affected API route: Hotel A reads, writes, updates and deletes Hotel B data and is refused |
| `__tests__/tenant-isolation/affected-pages.test.tsx` | 7 | the same at page level |
| `__tests__/schema/cross-tenant-integrity.test.ts` | 24 | composite foreign keys reject cross-hotel rows at the database level; no orphan tenant rows |
| `__tests__/folios/folio-payment-isolation.test.ts` | 21 | folios, folio items and payments cannot cross hotels |
| `__tests__/reservations/reservation-isolation.test.ts` | 18 | reservation read/modify/room-assignment isolation |

Database-level enforcement was re-demonstrated in this round by the new checker tests: a row pointing at a missing hotel is rejected by the FK, and when the FK is bypassed (`session_replication_role = replica`) the checker finds it.

## 8. Restore and recovery results

| Requirement | Result | Evidence |
|---|---|---|
| Backup/restore/rehearsal tooling present and self-consistent | **PASS** | `backup-db.mjs`, `restore-db.mjs`, `restore-rehearsal.mjs`, `archive-toc.mjs`, `target-check.mjs`; every flag quoted in the runbook was checked against the source |
| Post-restore data integrity verification | **PASS** | `scripts/db-integrity.mjs`, 12 tests against the real migration chain in PGlite (real PostgreSQL 17 semantics) |
| CLI path of the checker executed against a live server here | **NOT TESTED** | no `psql`/`pg_restore` binaries in this sandbox and Prisma engine downloads are blocked; the SQL itself is exercised by the PGlite tests |
| Genuine archive restore in this environment | **BLOCKED** | `hotel-management-saas-20261028-140823.dump` (sha `F81566E9…`) is not present on disk; nothing was fabricated in its place |
| Prior genuine rehearsal evidence (owner-supplied) | **PASS (not reproduced here)** | round 10: PG 17.11, 28/28 tables, checkpoint `saas_through_17`, Supabase-managed schemas excluded |
| Recovery documentation, 16 sections | **PASS** | `docs/production-recovery.md` |

## 9. End-to-end operational results

Browser-driven E2E is **NOT TESTED**: the repository has no browser automation dependency, and the application cannot boot without a generated Prisma client.

What *is* exercised, at the integration level, with two-hotel fixtures:

| Workflow | Suite(s) | Tests |
|---|---|---|
| Guest lifecycle, check-in/out, room assignment, cancellation | `workflows/guest-lifecycle`, `frontend/reservations-hardening` | 53 |
| Billing: folios, items, payments, partial payment, balances, duplicate payment prevention | `folios/folio-payment-isolation`, `frontend/room-charge-recovery` | 38 |
| Restaurant/POS: cart, lifecycle, idempotency, interrupted-transaction recovery | `restaurant/*` | 77 |
| Inventory, stock movements, recipes, wastage, procurement | `inventory/stock` | 27 |
| Housekeeping, maintenance, assignments | `assignments/tenant-membership-assignments`, `rooms/room-status` | 21 |
| Reports and financial KPIs | `reports/excel-export`, `dashboard/financial-kpis` | 11 |
| Onboarding, staff, subscriptions | `onboarding/hotel-onboarding`, `staff/multi-tenant-staff`, `settings/*`, `subscriptions/subscription-entitlements` | 95 |

## 10. Build, lint, typecheck results

| Gate | Result | Detail |
|---|---|---|
| `npm ci --ignore-scripts` | **PASS** | 538 packages |
| Test suite | **PASS** | 52 files, **791 passed, 6 skipped, 0 failed** (baseline at the start of the round: 766 passed / 6 skipped) |
| `next lint` | **PASS** | no warnings, no errors |
| `tsc --noEmit` | **PASS (no regression)** | 297 errors, unchanged from baseline; all are consequences of `@prisma/client` not being generated in this sandbox |
| `npm run build` | **BLOCKED** | `prisma generate` → `binaries.prisma.sh` TLS reset (`request to https://binaries.prisma.sh/…/libquery_engine.so.node.gz.sha256 failed`) |

## 11. Limitations

- The Prisma client cannot be generated here (engine host unreachable), so nothing that needs a generated client was executed: production build, `next start`, browser E2E, `prisma migrate` against a live database.
- No PostgreSQL server or client binaries exist in this sandbox; database behaviour is verified through PGlite (the real PostgreSQL engine compiled to WASM) running the repository's own migration chain.
- The genuine backup archive is absent, so the genuine restore was not attempted.
- Supabase platform state (auth, storage, realtime, vault) is out of scope for the application backup by design; the runbook states this explicitly.

## 12. Blockers

| Blocker | Exact requirement to clear it |
|---|---|
| `npm run build` | network access to `binaries.prisma.sh` (or a pre-seeded Prisma engine cache) so `prisma generate` can complete |
| Genuine restore validation | the archive `hotel-management-saas-20261028-140823.dump` (sha256 `F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7`) plus PostgreSQL 17 client tools, on an isolated host |
| Browser E2E | a browser automation dependency (Playwright/Cypress) and a runnable build |

## 13. Deployment readiness

| Area | Verdict |
|---|---|
| Tenant isolation | PASS |
| AuthN / AuthZ | PASS |
| Subscription entitlement enforcement | PASS |
| Financial permissions | PASS |
| Staff assignment validation | PASS |
| Audit trail | PASS (hotel privileged actions + platform actions) |
| Database integrity tooling | PASS |
| Recovery documentation | PASS |
| Production build | BLOCKED |
| Demonstrated genuine restore (this environment) | BLOCKED |

## 14. Branch and commits

- Branch: `arena/1e24e452-hotel-management-saas`
- Based on `main` = `9cafa588f2d89f879501e24b9d129998de16647e`
- Commits: `3ff67c9`, `27aacc0`, and the commit adding this report — all on this branch, pushed to `origin/arena/1e24e452-hotel-management-saas`, PR opened from this branch.

## 15. Next steps

1. On a host with network access, run `npm ci && npm run build && npm start`, then a browser smoke pass over the checklist in `docs/production-recovery.md` §11.
2. Run `node scripts/db-integrity.mjs --url "$DIRECT_URL"` against a freshly restored copy and attach the `--json` output as the go-live artefact.
3. Decide the product question in F-3 (consent flow for adding an existing account to a hotel).
4. Add Playwright coverage for the front-desk → folio → payment → check-out path, which is currently covered only at the integration level.
5. Consider encrypting backup archives at rest and shipping them off-host automatically (gaps 3 and 5 in the runbook).
