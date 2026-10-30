# Final execution round — release candidate for owner acceptance testing

Date: 2026-10-30 · Branch `arena/c62d21c8-hotel-management-saas` · Base `main` = `2e4c4aa`

This round finished the product rather than describing it: two module-level defects that made listed
workflows impossible were found by driving the application in a browser and fixed, two missing features
(notifications, audit trail) were implemented, a complete two-hotel testing environment was built and
seeded, and the automated suite grew from 823 tests / 46 HTTP checks / 25 browser steps to **833 / 52 /
33** with everything green.

**Nothing was deployed.** Production deployment is prepared and gated on the owner's acceptance testing
and on two checks that cannot run in this environment.

---

## 1. Deliverables

| # | Deliverable | Where |
|---|---|---|
| 1 | Release-candidate branch and commit | `arena/c62d21c8-hotel-management-saas` (commits listed in §9) |
| 2 | Working test environment | Hosted preview + `node scripts/owner-test-env.mjs` (setup / app / reset) |
| 3 | Demo hotels, staff and roles | 2 hotels × 9 roles + platform admin; see §4 |
| 4 | Owner acceptance-testing guide | [OWNER-ACCEPTANCE-TESTING.md](OWNER-ACCEPTANCE-TESTING.md) |
| 5 | Genuine backup restore evidence **or** blocker | **BLOCKED** — archive absent; handoff in [handoff-production-verification.md](handoff-production-verification.md) §1 |
| 6 | Native engine evidence **or** blocker | **BLOCKED** — no binary source; `docs/evidence/round14/native-engine.json`, handoff §2 |
| 7 | Full automated test report | §5 below, evidence in `docs/evidence/round14/` |
| 8 | Browser test evidence | `docs/evidence/browser/` (33 PNGs) + `docs/evidence/browser-results.json` |
| 9 | Database integrity report | `docs/evidence/round14/db-integrity.json` — 49/49 |
| 10 | Production deployment checklist | [production-deployment-checklist.md](production-deployment-checklist.md) |
| 11 | Known limitations and outstanding defects | §7 |

---

## 2. Status of every requirement

| Phase | Requirement | Status |
|---|---|---|
| 1 | Start from latest `main`, preserve existing work, find genuine defects | **PASS** |
| 2A | Locate and restore the genuine backup | **BLOCKED** — the file is still not in this environment |
| 2B | Obtain, verify and load the native Prisma engine | **BLOCKED** — `binaries.prisma.sh` unreachable; no npm/GitHub source ships the pinned binary |
| 3 | Complete the application; every listed workflow can be completed | **PASS** with two defects fixed (§3) and two features added |
| 4 | Dedicated, isolated owner testing environment with realistic data | **PASS** |
| 5 | Full automated validation | **PASS** except native-engine verification (**BLOCKED**) |
| 6 | `docs/OWNER-ACCEPTANCE-TESTING.md` | **PASS** |
| 7 | Deployment readiness prepared but not executed | **PASS** (prepared); deployment itself **NOT STARTED** |
| 8 | Final deliverables classified | **PASS** — this document |

---

## 3. What this round changed

### 3.1 Two defects that made listed workflows impossible

Both were found by the browser suite, not by any server-side test, and both are in the Phase 3 list.

**a. Recipes could never be created.** `POST /api/recipes` nested the ingredient rows with an explicit
`hotelId`. That column is part of the child's composite foreign key to the parent recipe, so Prisma
rejects it as an unknown argument — every attempt returned `400 "That menu item already has a recipe, or
an ingredient is invalid."` The message named the wrong cause, which is why it survived review. Fixed by
letting the parent supply the tenant column; the tenant-isolation unit test now pins the correct shape
and asserts `hotelId` is absent from the nested create.

**b. Wastage could not be recorded against a staff member.** The wastage dialog fills its "person
accountable" list from `GET /api/staff`, whose `id` is the *membership* id, and submitted it as
`accountableUserId`; the API resolves that against the *user* id. Every attempt with a staff member
chosen — the primary path — returned `400 "Choose an active staff member from this hotel"`. Fixed by
submitting `userId`; the type now documents why.

### 3.2 Two features that were missing

The schema has carried `Notification` since the first migration and `AuditLog` since the membership
work, but nothing wrote notifications and no screen read the audit trail.

**Notifications** — `lib/notifications.ts` plus `GET/PATCH /api/notifications` and a bell in the top bar
showing an unread count, a dropdown of the active hotel's notifications, per-item and mark-all-read.
Wired to the events that need a human: a maintenance ticket is raised, stock falls to its reorder level
after a purchase, an adjustment, wastage or a restaurant sale. Stock alerts are idempotent — one unread
alert per item — so a busy service cannot flood the bell.

**Audit trail** — `GET /api/audit-logs` and `/dashboard/audit` list the active hotel's entries with the
actor, the entity and a readable summary, filterable by action, restricted to owner/admin. Payments and
check-outs now write audit rows (`PAYMENT_RECORDED`, `CHECK_OUT`, `CHECK_OUT_WITH_BALANCE`) from the
shared checkout service so every caller is covered, alongside the staff and settings entries that already
existed.

### 3.3 Repository hygiene

`lib/request-origin.ts` gained a third acceptance path for hosts that strip fetch metadata (some proxies
drop `Sec-Fetch-Site`; a cross-site browser POST always carries `Origin`, so requiring `Host` to match the
configured host is still safe). Ten unit tests pin it.

---

## 4. The owner testing environment

`scripts/owner-test-env.mjs` creates a **separate** PostgreSQL 17.11 server inside `.owner-test/`
(downloaded from PyPI on first use, initialised, migrated, seeded) and never reads `.env.local` or the
verification cluster. `scripts/owner-test/seed-demo.ts` refuses to run against anything but a loopback
database named `hotel_saas_demo_*` with `SAAS_ENVIRONMENT=local`.

| | Riverside Grand Hotel (Nakuru) | Lakeview Lodge (Naivasha) |
|---|---|---|
| Plan | GROWTH (legacy tier, 50-room band) | STARTER (legacy tier, 15-room band) |
| Rooms | 8 (Single/Double/Twin × meal plans) | 6 |
| Staff accounts | 9 — owner, admin, manager, receptionist, accountant, waiter, cashier, housekeeper, technician | 9, different people |
| Live data | in-house guest with an outstanding balance, arrival today, future booking, cancelled booking, checked-out stay with history | own guests, menu, stock |
| Operations | housekeeping tasks, a high-priority maintenance ticket, expenses, a POS sale, low-stock alerts | same shape |

Rooms, tariffs, menu, inventory, recipes, stock movements, folios, payments, notifications and audit
entries are all seeded, so every screen has something real on it. Credentials are generated per run and
written to `.owner-test/credentials.json` and `CREDENTIALS.md` (mode 600, Git-ignored) — never to a
committed file. `reset` drops only that database and re-seeds it; the code is never touched.

The environment is reachable two ways: the hosted preview (`https://3100-…e2b.app`) while this workspace
runs, or locally with the four commands in the guide.

---

## 5. Automated validation

All run against the seeded demo database on a disposable server; no production, Supabase or Axis Hotel
system was contacted.

| Gate | Result | Evidence |
|---|---|---|
| `npx prisma validate` | **PASS** — "The schema at prisma/schema.prisma is valid" | requires the local engine stub; the CLI otherwise tries to download engines |
| Prisma client generation | **PASS** — v5.17.0 | generated through `scripts/wasm-runtime-shim.mjs` (test aid, not deployable) |
| `npx tsc --noEmit` | **PASS** — 0 errors | no suppression, no relaxed config |
| `npm run lint` | **PASS** — 0 findings | |
| `npx next build` | **PASS** | 41 route entries |
| Unit + integration (vitest) | **PASS** — 55 files, **833 tests**, 0 failures | 10 new tests this round |
| HTTP end-to-end | **PASS** — **52/52** | `docs/evidence/round14/http-e2e.json` (6 new checks) |
| Browser end-to-end | **PASS** — **33/33** (93 s) | `docs/evidence/browser/` + `browser-results.json` (8 new steps) |
| Database integrity | **PASS** — 49 checks, 0 failures | `docs/evidence/round14/db-integrity.json` |
| Migrations | **PASS** — 19/19 apply from empty → 28 tables; release manifest matches 19 files | `npm run migration:manifest` |
| Native engine verification | **BLOCKED** | `docs/evidence/round14/native-engine.json` (verdict `BLOCKED`, exit 2) |
| Genuine restore | **BLOCKED** | handoff §1 |

Baseline preserved and extended: 823 → **833** vitest, 46 → **52** HTTP, 25 → **33** browser, 49
integrity, 0 TypeScript, 0 ESLint, build PASS, 19/19 migrations. No test was removed, skipped or
weakened; one assertion was corrected because it had pinned a payload that could not work.

### Browser steps (33)

`hotel-a-register`, `hotel-a-dashboard`, `rooms-create-type`, `rooms-create-room`,
`staff-add-new-account`, `hotel-b-register`, `tenant-isolation-a`, `invitation-sent`,
`invitation-not-yet-access`, `invitation-accepted`, `hotel-switch`, `role-sign-in`, `role-navigation`,
`role-direct-url-denied`, `reservation-create`, `reservation-create-future`, `reservation-cancel`,
`check-in`, `folio-payment-checkout`, `housekeeping-task`, `maintenance-ticket`, `inventory-item`,
`pos-sale`, `inventory-recipe`, `staff-suspend-and-reactivate`, `notifications-bell`, `audit-trail`,
`inventory-purchase-and-movement`, `inventory-wastage`, `reports-render`, `subscription-render`,
`tenant-isolation-b`, `sign-out`.

Eight are new this round: future booking, cancellation, recipe creation, staff suspend-and-reactivate,
notifications, audit trail, purchase with stock movement, wastage with accountability.

---

## 6. Phase 3 module review — what was verified working

Every workflow below was exercised end to end (UI + API + database assertion), not merely inspected.

| Module | Verified |
|---|---|
| Hotel registration and onboarding | register → onboarding → dashboard; slug uniqueness; trial subscription created |
| Hotel profile and settings | settings persist; currency switch; password change |
| Multiple hotels, switching, membership | two workspaces, `/select-hotel`, switching, membership listing |
| Staff invitations and acceptance | 202 invitation, pending state, no access before acceptance, acceptance, switch after |
| Staff suspension and removal | suspend blocks sign-in; reactivate restores; removal deletes access |
| Role permissions | menu, page redirect and API 403 for every role group |
| Guests, room types, rooms, meal plans and tariffs | CRUD; tariff matching by occupancy + meal plan; per-hotel room-number uniqueness |
| Reservations, allocation, availability | create, conflict rejection, reschedule, cancel, future booking |
| Check-in, check-out, cancellation | check-in with partial payment; balance gate; manager override; checkout creates housekeeping |
| Folios, folio items, payments, partial payments, balances | room + restaurant items; partial settlement; over-payment refused; balance visible |
| Currency settings, financial reports, audit trails | KES/USD; revenue and collection reports; Excel export; hotel-scoped audit trail |
| Menu categories, items, orders, order items, payments | menu management, pay-now, charge-to-room, duplicate protection, interrupted-transaction recovery (idempotency keys) |
| Inventory, purchases, stock movements, recipes, recipe ingredients, wastage | item creation, purchase → stock movement, recipe from stock, wastage with accountability, low-stock alerts |
| Housekeeping, maintenance | task lifecycle, ticket lifecycle, room out of service, notifications |
| Subscriptions, trials, expiry, room and staff limits, entitlements, upgrade/downgrade | plan limits enforced; suspension blocks writes and recovers; plan changes via the platform console |
| Account and membership security | password hashing, reset refusal, membership suspension, cross-tenant switch refusal |

---

## 7. Known limitations and outstanding defects

| # | Item | Status | Notes |
|---|---|---|---|
| 1 | Genuine production archive has never been restored here | **BLOCKED** | The bytes are absent from the filesystem, every remote branch, releases and prior patches. Four-command handoff in the verification document |
| 2 | Native Prisma engine never loaded here | **BLOCKED** | `binaries.prisma.sh` unreachable; `@prisma/engines` is a downloader; no npm or GitHub source ships the pinned 5.17.0 binary. `npm run native-engine:verify` gives a PASS/FAIL/BLOCKED answer on the target |
| 3 | Subscription plan changes are platform-admin only | By design | A hotel owner sees their plan, limits and renewal but cannot self-serve an upgrade; billing changes are made in the platform console. A self-serve purchase flow is a product decision, not a bug |
| 4 | Invoices are folio-based | By design | Folio + items + payments is the billing record; there is no sequential tax-invoice number. Confirm with the owner whether the Kenya Revenue Authority needs one |
| 5 | Local test runs use a WASM Prisma client | Accepted | `scripts/wasm-runtime-shim.mjs` patches `node_modules` only; it is a test aid and must never be deployed |
| 6 | Browser suite uses the Lambda build of Chromium | Accepted | Same Blink/DevTools protocol; no Lambda-specific behaviour is relied on |
| 7 | Notifications are in-app only | Accepted | No email/SMS transport is configured; the model supports targeted users when one is added |
| 8 | Rate limiting is not implemented in the app | Open | Recommend edge rate limits on `/api/auth/*` before go-live (checklist §4) |
| 9 | No load or penetration testing | **NOT TESTED** | Neither was in scope; both are recommended before a public launch |
| 10 | Owner acceptance testing | **NOT STARTED** | The environment is ready; this is the next step |

---

## 8. Deployment readiness

Prepared but **not executed**: [production-deployment-checklist.md](production-deployment-checklist.md)
covers environment variables, database roles and migration, Prisma engine verification, authentication
and cookie configuration, domain/TLS/headers, subscription configuration, backups and restore, monitoring,
rollback, a security review and the go-live sequence.

The gate is unchanged and still closed: genuine restore PASS, native engine PASS on the target, owner
acceptance complete, owner approval recorded, fresh backup taken.

---

## 9. Commits and how this was verified

The round is committed in logical pieces on `arena/c62d21c8-hotel-management-saas` (see `git log`): the
two module fixes, the notification and audit-trail features, the same-origin fallback, the expanded
browser and HTTP suites with their evidence, the owner-test environment and seeds, and the documentation.

Reproduce everything:

```bash
node scripts/owner-test-env.mjs reset          # demo database: 19 migrations + seed
npx tsc --noEmit && npm run lint
env -u DATABASE_URL -u SAAS_ENVIRONMENT -u SAAS_DATABASE_IDENTIFIER -u DIRECT_URL npx vitest run
npx next build
node scripts/owner-test-env.mjs app            # or next start against the demo database
node scripts/e2e-smoke.mjs --base http://127.0.0.1:3000 --json out.json
npm run test:browser -- --base http://127.0.0.1:3000 --out docs/evidence/browser --json docs/evidence/browser-results.json
npm run db:integrity -- --json
npm run native-engine:verify -- --json
```
