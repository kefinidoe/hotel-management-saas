# SaaS PostgreSQL migration rehearsal plan

**Status: preparation only. No PostgreSQL server/container is installed in the current sandbox, and no real PostgreSQL rehearsal has run.** The PGlite tests are useful local SQL/schema checks but are not a substitute for PostgreSQL or `prisma migrate deploy` behavior.

## Safety gate

- Never point rehearsal commands at Supabase, the Axis Hotel system, a shared service, or any populated environment.
- Use a newly created disposable local PostgreSQL database. For target-history compatibility, only use a maintainer-provided, authorized backup restored locally or into an isolated disposable PostgreSQL service; do not connect to the source.
- Use an explicit local socket/loopback endpoint and a uniquely named rehearsal database. Do not source `.env` or reuse production credentials.
- Stop if the endpoint, database name, PostgreSQL version, migration history, or checksum is uncertain.
- Do not use `prisma migrate dev`, `db push`, `migrate resolve`, seed, reset, or cleanup scripts as a substitute for this rehearsal.

## Stage 1.8 — authorized evidence review (HOLD)

**Do not begin a migration rehearsal until the evidence below has been supplied and reviewed, the ledger/checksum and schema gates pass, and a trusted disposable PostgreSQL environment plus trusted Prisma tooling are available.** Evidence must come from an approved isolated restore, never from a connection to the populated source. Do not include credentials, connection strings, `.env` contents, customer rows, or unsanitized logs.

### Maintainer evidence template

Copy and complete this form using sanitized metadata and counts:

```text
Review date / maintainer role:
Approved isolated restore identifier (non-secret):
Backup restore verification (method, date, expected-vs-actual checks/counts):
PostgreSQL version:

Does public._prisma_migrations exist? [yes / no]
If yes, provide a sanitized table with:
  migration_name | checksum | started_at | finished_at | rolled_back_at |
  applied_steps_count | outcome (success / failed / rolled back / incomplete)
Include the recorded checksum and outcome for:
  20261008123000_multi_tenant_saas_init
Report any duplicate names, missing rows, incomplete or failed records:

Schema evidence: sanitized schema-only definitions/version identifier:
Unique-index evidence: name | table | columns | unique | ready | valid | definition
Include Payment_hotelId_idempotencyKey_key and, if present,
Order_hotelId_idempotencyOperation_idempotencyKey_key.
Foreign-key evidence: table | name | definition | validated
Include tenant-scoped and composite join FKs relevant to this release.

Integrity checks (counts only; state query version/scope and whether columns existed):
  duplicate Payment idempotency keys:
  duplicate Order operation/key tuples:
  orphan/cross-tenant ReservationRoom links:
  cross-tenant RecipeIngredient links:
  orphan/cross-tenant OrderItem menu links:
  operational user references without same-hotel membership (by relation):
Other failures / caveats:
```

If the ledger is absent, state that plainly; do not invent migration rows, mark anything applied, or infer application from the schema or migration directory. That condition requires an explicitly reviewed baseline strategy before proceeding.

### Archive metadata received (user-supplied)

The user reports that `hotel-management-saas-20261028-140823.dump` is 384,096 bytes with SHA-256 `F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7`. The already-captured archive TOC listing exited 0 and showed `Dumped from database version: 17.11` and `Dumped by pg_dump version: 17.11`. The TOC did not list `public._prisma_migrations` or its data, and listed `auth`, `storage`, `realtime`, `vault`, `graphql`, `graphql_public`, `extensions`, and `pgbouncer`. This is backup-time archive evidence only: it does not establish the current SaaS Supabase server version, whether the ledger was excluded or absent at dump time, or whether the dump was full/selective. Backup creation options and scope remain unverified.

### Source-side evidence received (user-supplied, read-only)

The user reports that the SaaS Supabase SQL Editor returned `server_version = 17.11`, `current_database() = postgres`, and `public._prisma_migrations` exists = `false`. This confirms the reported current target PostgreSQL version as 17.11, matching the archive header's reported source and `pg_dump` versions. The Prisma ledger is absent from `public` in the queried `postgres` database; whether migration history exists elsewhere or is managed by another arrangement remains unknown. No migration rows are available from this table. Backup creation options/scope remain unknown.

### Decision gates

1. **Ledger/checksums — PASS required.** Ledger rows, outcomes, ordering, and checksums must be complete and explained. Compare successful records to the exact reviewed migration artifacts. For `20261008123000_multi_tenant_saas_init`, resolve the recorded checksum against the changed worktree file and committed version; any unexplained mismatch, partial run, or ambiguous history is NO-GO. Do not repair with `migrate resolve`.
2. **Missing ledger — explicit baseline review required.** An absent Prisma ledger is not a pass. The maintainer and migration owner must approve a written baseline/reconciliation strategy based on the isolated restore; no marking migrations applied or replaying is allowed as a shortcut.
3. **Schema/chain compatibility — PASS required.** Actual schema, index definitions and validity, FK definitions/validation, and sanitized integrity counts must demonstrate that the intended chain is compatible with the restored state. Unexplained drift, duplicate keys, or orphan/cross-tenant relationships is NO-GO. Review migration 081's preconditions/destructive changes and the Axis-specific tariff rows as product intent; do not infer state from source files.
4. **Disposable PostgreSQL — PASS required.** A trusted, isolated, disposable PostgreSQL environment matching the target major version must be available, with a verified local-only endpoint and no production/shared credentials. No such environment is currently available in this sandbox.
5. **Trusted Prisma — PASS required before Prisma checks.** Use only the repository's pinned Prisma version and trusted locally available CLI/client/engine artifacts. Validate the schema, generate the client, run typecheck, then build in the approved isolated setup. Do not install/change versions or download unverified engines. Any validation, generation, typecheck, or build failure blocks rehearsal/release pending review.

Only after all gates pass may an authorized owner approve a separately scoped isolated rehearsal. Clean-chain SQL behavior and restored-ledger compatibility are distinct checks; neither is proof of the other. PGlite tests are local-only checks and do not satisfy the PostgreSQL or Prisma gates.

## Migration inventory and order

There are 19 migration directories in the worktree. Migration order is timestamp order. The first 16 directories below are tracked; the last three are **untracked proposals, not applied migrations**. The tracked `20261008123000_multi_tenant_saas_init/migration.sql` is modified in the worktree.

| Order | Migration | Dependency / effect / rehearsal concern | Worktree state |
|---:|---|---|---|
| 1 | `20260915161717_init` | Creates the original single-hotel schema, base enums, tables and ID-only FKs. | tracked |
| 2 | `20260919202946_add_guest_archive` | Requires `Guest`; adds archival flag. | tracked |
| 3 | `20260920051027_add_inventory_recipes_purchases_wastage` | Requires initial inventory/menu/user tables; adds stock, recipe, purchase and wastage tables and FKs. | tracked |
| 4 | `20260927141709_add_inventory_item_active` | Requires `InventoryItem`; additive boolean default. | tracked |
| 5 | `20260929182000_add_room_is_twin` | Requires `Room`; adds twin flag later dropped. | tracked |
| 6 | `20261001120000_add_wastage_accountability` | Requires `Wastage` and `User`; nullable accountability fields preserve old rows. | tracked |
| 7 | `20261001140000_normalize_restaurant_menu_categories` | Requires menu categories/items; relinks items and deletes duplicate normalized category rows. | tracked |
| 8 | `20261001160000_add_dashboard_query_indexes` | Adds single-tenant dashboard indexes; several are replaced by tenant-scoped indexes in order 13. | tracked |
| 9 | `20261001180000_add_room_active_status` | Requires `Room`; adds `isActive` with `true` default. | tracked |
| 10 | `20261002090000_remove_room_is_twin` | Drops `Room.isTwin`; old values are not retained. | tracked |
| 11 | `20261002090100_add_half_board_meal_plan` | Adds PostgreSQL enum value `HALF_BOARD`; intentionally precedes tariff use in a separate migration. | tracked |
| 12 | `20261002090200_add_half_board_tariffs` | Inserts fixed Half Board rate rows. The SQL describes Axis Hotel Nakuru-specific tariffs; confirm product intent for SaaS without accessing the separate pilot system. | tracked |
| 13 | `20261008123000_multi_tenant_saas_init` | Converts the single-hotel schema: creates `Hotel`/`HotelMembership`, maps legacy roles, backfills 19 `hotelId` columns to `legacy-hotel`, transforms notification/audit fields, merges duplicate menu categories, drops old indexes/columns/type and adds tenant indexes/FKs. Assumes the original schema and role set. It is destructive and must not be replayed or edited against a target until applied history and checksums are established. | **tracked, modified** |
| 14 | `20261012063000_add_payment_idempotency_key` | Requires tenant-scoped `Payment`; adds nullable key and unique `(hotelId,idempotencyKey)`. Null legacy keys are allowed; non-null duplicates must be checked. | tracked |
| 15 | `20261014020000_add_payment_request_fingerprint` | Requires `Payment`; adds nullable fingerprint. | tracked |
| 16 | `20261019000000_add_saas_subscription` | Requires `Hotel`; creates one subscription per hotel but does not insert historical subscription rows. Application bootstrap behavior/trial dates should be checked for each restored hotel. | tracked |
| 17 | `20261027100000_add_membership_department` | Requires `HotelMembership` and legacy `User.department`; copies only where a user has exactly one membership, leaving multi-hotel memberships null. | **untracked proposal — not applied** |
| 18 | `20261029120000_add_pos_charge_to_room_idempotency` | Requires tenant-scoped `Order`; adds nullable operation/key/fingerprint and tenant/operation/key unique index. Existing nulls are permitted. | **untracked proposal — not applied** |
| 19 | `20261029130000_add_tenant_composite_join_fks` | New forward-only proposal: fail-closed prechecks, parent-derived tenant backfills, then composite FKs for reservation rooms, recipes/ingredients and order items. | **untracked proposal — not applied** |

### Preconditions and unknowns

Before a target rehearsal, establish the exact target migration ledger and recorded checksums, PostgreSQL major version, schema shape, and whether any migration was applied outside Prisma. Do not infer application from the directory list. The changed historical migration's checksum may differ from the target's recorded checksum; a mismatch is a hard stop, not a reason to mark it resolved or replay it.

For the old-schema conversion, validate the intended pre-migration state, every legacy `User.role` value and role mapping, collisions with `legacy-hotel`/`legacy-membership:*`, existing row counts and orphan/cross-table links, and data moved before dropped columns. Precheck duplicate names/keys before creating scoped unique indexes. Review the category merge, `Room.isTwin` removal, audit JSON conversion, and Axis-specific tariff seed with a data owner. Confirm no partially applied/manual tenant conversion exists.

For the join-key proposal, existing parent FKs prove IDs exist for `ReservationRoom` and `RecipeIngredient`, but not that both parents share a tenant. `OrderItem.menuItemId` has no existing FK and must be checked for missing as well as cross-tenant menu items. The proposal deliberately aborts on these conflicts; it does not silently repair them. A maintainer must inspect and resolve any affected data before rehearsal. Deployment should coordinate application writes because the backfills add non-null tenant columns. Before approval, review whether child-side indexes are needed for the new references: the proposal currently has no `(roomId, hotelId)`, `(inventoryItemId, hotelId)`, or `(menuItemId, hotelId)` indexes, so FK checks/deletes may scan join rows as data grows. The existing `(reservationId, roomId)`, `(recipeId, inventoryItemId)`, and `OrderItem(orderId)` indexes help some parent lookups but are not a substitute for every FK-leading child index.

The proposed Order idempotency columns are nullable and the unique index permits partially populated tuples; the API writes all three fields together, but the database does not enforce that invariant. The migration owner should decide whether an all-null-or-all-present `CHECK` and operation/fingerprint validation are required before approval.

The SQL files do not include explicit `BEGIN`/`COMMIT`. The PGlite helper wraps them transactionally, which does not prove Prisma deploy failure atomicity. The real migration runner's behavior and recovery from a mid-file failure must be established on trusted disposable PostgreSQL with the pinned Prisma engine. Migration 081 is especially destructive; its history must remain unchanged and any recovery plan must rely on verified backups/restore, not replay or hand-edits.

## Real PostgreSQL rehearsal procedure (not executed)

**Missing prerequisites in this sandbox:** `psql`, `postgres`, `initdb`, `pg_ctl`, `pg_ctlcluster`, `pg_lsclusters`, Docker, and Podman are absent, so no real PostgreSQL rehearsal can be run here. The exact Prisma 5.17.0 CLI/client and verified `debian-openssl-3.0.x` engine binaries are installed locally, and the generated Prisma Client is available. Tooling checks/builds used only dummy loopback URLs at `127.0.0.1:1`; no Supabase or Axis URL was read or used, and no database was contacted. The normal lifecycle install used the repository's pinned dependency versions; no Prisma or Next.js version upgrade was made.

**This procedure is not authorization to rehearse.** Any automatic directory glob would include all three untracked proposals; do not use one for rehearsal. Before any future rehearsal, an owner-approved release manifest must list the exact reviewed migration files; exclude every unapproved proposal, and keep a test of the tracked historical chain distinct from a candidate chain containing approved proposals. For a read-only repository inventory only, run `node scripts/migration-manifest.mjs`; its database application status is explicitly unknown.

When a trusted local PostgreSQL installation becomes available:

1. Select a PostgreSQL major version matching the intended SaaS target. Start an isolated local cluster using an approved local socket/loopback only. Confirm its version and that the selected endpoint is local before creating anything.
2. In a fresh shell that has **not** sourced `.env`, set `PGHOST` to the local Unix socket (or loopback), set `PGDATABASE` to a unique name such as `hotel_saas_rehearsal_20261029`, then run `createdb --template=template0 "$PGDATABASE"`. Verify with `psql -X -v ON_ERROR_STOP=1 -d "$PGDATABASE" -c 'SELECT current_database(), inet_server_addr(), version();'`; stop unless the database name is the rehearsal name and the server is local (socket connections should report a null server address). Keep production credentials and `.env` out of the process.
3. Run a **clean-chain SQL rehearsal** against only that database using an explicit `REVIEWED_MIGRATION_FILES` array prepared from the owner-approved release manifest—never a directory glob. Apply each listed file with `psql -X -v ON_ERROR_STOP=1 -d "$PGDATABASE" -f "$f"`, stop on the first failure, and discard the disposable database rather than repairing it in place. Check resulting tables, enum labels, unique indexes, and FK definitions against `prisma/schema.prisma`. This checks PostgreSQL SQL behavior, but not Prisma ledger/checksum behavior.
4. Run a separate **legacy conversion rehearsal** in another fresh disposable database: apply migrations 1–12 (up through `20261002090200_add_half_board_tariffs`) in order, run `psql -X -v ON_ERROR_STOP=1 -d "$PGDATABASE" -f __tests__/schema/fixtures/pre-saas-conversion.sql`, then apply only the exact owner-approved files from the reviewed manifest. The three untracked proposals must not be included unless separately approved. Verify row counts, `legacy-hotel` ownership, preserved/transformed audit data, category relinking, join-table backfills, and every added constraint. This fixture is synthetic only; never use live customer data.
5. Run a **Prisma ledger rehearsal** only after the trusted matching Prisma CLI/client/engine artifacts are locally available: point `prisma migrate deploy` at a newly created disposable local database with no `.env` inheritance. Separately, test a locally restored authorized clone that preserves `_prisma_migrations` exactly. Compare recorded migration checksums before deployment; stop on a mismatch, especially for `20261008123000_multi_tenant_saas_init`.
6. For the new join-key draft, test valid backfills, cross-tenant and orphaned `OrderItem.menuItemId` precheck failures, and each composite FK on actual PostgreSQL. Repeat on a freshly restored local clone after data prechecks; confirm no production/shared endpoint is involved.
7. Capture output/schema evidence without credentials. Destroy only the local cluster/database created for the rehearsal after retaining the approved test report. Do not delete or alter any pre-existing service or data.

The current PGlite migration runner wraps SQL files in transactions and applies the complete chain to an in-memory database. Its tests are useful and pass, but they are not evidence that the above PostgreSQL/Prisma rehearsal has occurred.

## Tenant-integrity findings

The schema already has composite tenant FKs for key resource edges including room-to-room-type, reservation-to-guest, folio-to-guest/reservation, payment-to-folio/payment-method, housekeeping/maintenance-to-room, menu-item-to-category, order-to-folio/payment-method and inventory movement/purchase/wastage-to-inventory.

The composite-FK proposal is intended to close three confirmed source-level gaps; none of these proposed constraints is established in an actual target database by this draft:

- `ReservationRoom` has ID-only FKs to `Reservation` and `Room`. Both parents expose unique `(id,hotelId)` keys; if approved and applied, the proposal would backfill `hotelId` from the reservation and add composite references. Reservation creation/update routes scope room lookup by tenant; create passes the tenant ID explicitly.
- `RecipeIngredient` has ID-only FKs to `Recipe` and `InventoryItem`, while `Recipe` has no tenant column in the tracked chain. `MenuItem` and `InventoryItem` expose `(id,hotelId)` keys; if approved and applied, the proposal would derive recipe ownership from its menu item, propagate it to ingredients, and add composite references. Recipe routes validate the menu item and ingredient set within the active hotel; writes pass the tenant ID explicitly.
- `OrderItem` references `Order` by ID only and stores `menuItemId` as a scalar without a tracked FK. If approved and applied, the proposal would derive its tenant from `Order` and add composite FKs to `Order` and optional `MenuItem`. POS resolves menu items within the tenant; room-charge writes pass the tenant ID. Menu items are soft-deactivated by the API, so the proposed menu-item FK uses `RESTRICT` to preserve order history.

Other direct `User` FKs on operational rows (creator/cashier/assignee/accountability/requester/notification) remain ID-only. The routes generally derive actors from the active session or validate staff membership via the tenant, but database-level membership constraints are not present. `AuditLog.userId` is intentionally global because platform operators may author platform-wide audit entries. Do not convert those links to membership FKs until actor semantics and all historical records are audited.

## Stage 2.6 — repository evidence and proposed baseline (HOLD; not approved)

### Backup provenance and restore scope

- The current repository backup script `scripts/backup-db.mjs` uses custom format, `--schema=public`, `--no-owner`, and `--no-privileges`; the nightly wrapper writes under the checkout's `backups` directory. This describes repository script behavior, not the provenance of the user-supplied file.
- The supplied archive TOC reportedly lists several non-public Supabase-managed schemas. That is inconsistent with the repository script's explicit public-only selection, so the script cannot be treated as proof that this exact archive was produced by it. No matching run manifest/log or other artifact-specific provenance was found in the repository.
- The Prisma datasource uses PostgreSQL without multi-schema configuration. The inspected schema and migration SQL use the default schema; no explicit references to Supabase-managed schemas or `CREATE EXTENSION` statements were found. This makes public-only a plausible candidate for the app's modeled objects, but does **not** prove it is sufficient for this backup: untracked database objects, extension-owned functions/types, triggers, policies, and archive dependencies remain unverified. Do not restore the full archive or select public-only until the backup operator confirms the intended scope and dependencies.
- Required from the backup operator: the run record for the exact SHA-256 recorded above, including tool/version, custom/plain/directory format, schema/data mode, all include/exclude options, intended source database/snapshot time, and the included/excluded object scope. Confirm explicitly whether `_prisma_migrations` was excluded or absent at dump time. If the original command is unavailable, document that fact and provide an artifact-specific scope/dependency assessment; do not infer a full dump from the schema list.

### Repository migration-history evidence

- No `.github` workflow/deployment manifest or artifact-specific deployment record was found. `package.json` exposes `prisma:migrate` as `prisma migrate dev`; generic setup instructions mentioning `migrate deploy` do not show it was run against SaaS.
- Worktree SHA-256 for `20261008123000_multi_tenant_saas_init/migration.sql` is `1699ad5263e6870210b92292bfde03aa10fb173f3ca4d39a59036a00f602663a`; the file at `HEAD` is `8766f4714acc1ed65b5ce11983e4e95df1e81bbb98e397a8207b297b1b263942`. Neither hash is established as the source database's expected checksum because the source ledger is absent. Preserve the historical file unchanged.
- `20261027100000_add_membership_department`, `20261029120000_add_pos_charge_to_room_idempotency`, and `20261029130000_add_tenant_composite_join_fks` are untracked proposals, not deployment evidence. No source history for them was found.

### Proposed snapshot-baseline/reconciliation plan (requires written owner approval)

**Candidate baseline point:** the exact supplied archive identified by SHA-256 `F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7`, reported as database `postgres` from PostgreSQL 17.11. This is only a snapshot anchor, not a named migration boundary; backup scope and provenance are still unresolved, so it is not yet an approved baseline.

1. The backup operator confirms the artifact's scope and the owner confirms it is an authorized snapshot for rehearsal.
2. After that evidence and a written inspection-plan approval, restore only the approved objects to a **new, disposable** database on the reported local PostgreSQL 17.11 server at `127.0.0.1:55432`. Do not use `scripts/restore-db.mjs`: it reads repository `.env` and performs a full `--clean` restore; it has not been approved for this artifact. Capture a schema/object inventory, extension/function/trigger/policy dependencies, row counts, indexes and validity, FK definitions/validation, and the documented tenant-integrity checks. The source ledger is known absent in `public` for queried database `postgres`; verify the restored snapshot independently without inventing history.
3. The authorized maintainer supplies deployment/release records or other migration-history evidence. Compare those records to the restored schema/data and the exact migration files. Resolve migration 081's checksum/history discrepancy before naming any baseline. If evidence cannot identify a unique contiguous migration boundary, stop: do not create a synthetic ledger or treat every repository migration as applied.
4. The project owner and migration owner must then approve in writing the exact baseline point, migration names/checksums to reconcile (if any), rationale, treatment of any non-Prisma/manual changes, and risks. The three proposal migrations remain excluded unless separately approved. No `migrate resolve`/ledger insertion is authorized by this proposal.
5. Recovery for rehearsal only: preserve the hash-verified original archive; use a fresh clone for each restore/reconciliation attempt; on any error or partial migration, discard only that disposable local database and recreate it from the verified archive. Never attempt recovery by replaying migration 081, editing history, or changing either production system.

### Migration-command isolation gate

The local Windows server is user-reported as loopback-only on `127.0.0.1:55432`; the Linux checkout cannot independently inspect that Windows host. Before any future migration command, use a clean process that does not load `.env`, explicitly set both `DATABASE_URL` and `DIRECT_URL` to the same dedicated local rehearsal database, and enforce host/network egress restrictions so the process cannot reach Supabase or Axis. Verify from that process that the database name is the unique rehearsal name, `inet_server_addr()` is `127.0.0.1`, the port is `55432`, and `server_version` is 17.11; stop on any mismatch. Do not treat the standalone backup/restore target guard as a guard for direct Prisma CLI commands. Use an explicit owner-approved migration file list, never a directory glob, and exclude proposals until approved.

## Local verification record

- Historical results from earlier worktree stages: a focused PGlite/schema run was recorded as passing 31 tests; a full Vitest run was recorded as 44 files / 636 tests, with lint and `git diff --check` passing at that time. Stage 1.7 separately recorded a focused 62-test run. These are not Stage 1.9 verification and are not PostgreSQL or Prisma rehearsal evidence.
- The PGlite migration runner executes SQL against in-memory databases and explicitly wraps each migration plus its test ledger row in `BEGIN`/`COMMIT`, rolling back on errors. This name-only test ledger does not validate Prisma checksums, failure/recovery semantics, or actual `migrate deploy` behavior. In particular, it cannot establish the real migration runner's partial-failure/atomicity behavior.
- Stage 1.9 ran only the mocked POS idempotency unit test (31/31 passed), `git diff --check`, and source inspection; no SQL-backed/PGlite tests, Prisma commands, lint, typecheck, or build were run.
- Prisma tooling diagnosis (2026-10-30): `prisma`, `@prisma/client`, `@prisma/engines`, and `@prisma/fetch-engine` are all pinned at 5.17.0; the engine commit is `393aa359c9ad4a4bb28630fb5613f9c281cde053`. Debian 12 x86_64/OpenSSL 3.0.20 correctly detects Prisma target `debian-openssl-3.0.x`; there is no `binaryTargets` override or platform mismatch. The npm `@prisma/engines@5.17.0` tarball is JavaScript only (22.5 kB, no native engines). Its postinstall fetches the query engine and schema engine from `https://binaries.prisma.sh`, a host outside this sandbox's permitted egress. The GitHub release API has no matching 5.17.0 release assets, and Rust/Cargo are not installed for a source build. `npm ci --ignore-scripts` skipped both engine installation and the project's `postinstall: prisma generate`; no credentials or database are needed for generation, but the official engine artifacts are.
- Exact Prisma verification attempts: `npm run prisma:generate`, `npx prisma validate`, and `npm run build` were run with dummy loopback database URLs and `PRISMA_ENGINES_MIRROR` pinned to a refused loopback port, so no database or external engine host could be contacted. All stopped when fetching the pinned `debian-openssl-3.0.x` engine/checksum was refused. The production build therefore failed before `next build` began. No fake client, placeholder engine, or skipped validation was used.
- Stage 3 source hardening (2026-10-30): removed the fixed demo-seed password; the seed now requires explicit local-only opt-in, matching loopback `DATABASE_URL`/`DIRECT_URL`, and a uniquely named `hotel_saas_demo_<suffix>` database. A 16–200 character initial password must come from the local process environment and is never printed. `SETUP.md` now documents the gate and no longer advertises default credentials. Existing staff PATCH remains membership-only and rejects administrator-selected password changes; the account-holder password route checks the current password.
- Stage 3 verification: `npm ci --ignore-scripts --no-audit --no-fund` installed 538 packages without running install scripts or generating Prisma engines. With all PostgreSQL URL variables unset, the full Vitest suite passed: 45 files, 647 tests. This is unit/mock/PGlite coverage, not a real PostgreSQL rehearsal. `npm run lint` passed. A standalone strict TypeScript check of the new seed-target guard and tests passed. The guard's 11 focused tests include case-insensitive `host`, `hostaddr`, `service`, `port`, and `dbname` URL-override rejection. Changed-file whitespace checks passed.
- Full project `npx tsc --noEmit` was attempted with the generated client absent: 296 diagnostics (77 missing Prisma exports plus cascading implicit-any/property/narrowing diagnostics); the seed guard and its test had no diagnostics under a separate strict TypeScript check. This is not a passing project typecheck. Prisma generation and validation plus `npm run build` were attempted as recorded above and failed at the engine fetch; Next production compilation did not start.
- Next.js 15.5.28's installed CLI explicitly warns that `next lint` is deprecated and recommends ESLint CLI. Updated only the `lint` script to invoke ESLint directly across JS/TS source, tests, and configs; one test variable named `module` was renamed to `moduleName` after the broader lint found Next's `no-assign-module-variable` rule. `npm run lint` now passes without the deprecation warning; no Next.js or ESLint dependency upgrade was made.
- Other build/deployment/runtime inspection: no CI workflow, Dockerfile, or platform deployment manifest was present; only `.env.example` was found at the project root (its contents were not inspected). Source imports no `zod`, so its removal from the existing package dependency set does not currently break module resolution. Vitest passes but emits a non-blocking Vite 8 config-loader warning for `vitest.config.ts`; this does not affect the Next production build. No other build result can be established until trusted Prisma engines are available.
- Exact external acquisition procedure if the owner can reach Prisma's official host: retrieve only these Linux artifacts over HTTPS from `https://binaries.prisma.sh/all_commits/393aa359c9ad4a4bb28630fb5613f9c281cde053/debian-openssl-3.0.x/`: `libquery_engine.so.node.gz`, `libquery_engine.so.node.gz.sha256`, `schema-engine.gz`, and `schema-engine.gz.sha256`. The expected SHA-256 values are not available in this sandbox and must not be guessed. On the downloading machine, compare each compressed file's SHA-256 with the first field in its official `.gz.sha256` sidecar; transfer the verified Linux gzip files, sidecars, and a manifest containing commit/version/target. Do not transfer a Windows engine.
- To install reproducibly after transfer, verify those gzip checksums again on Linux, place the four files under `all_commits/<commit>/debian-openssl-3.0.x/` in a temporary local mirror root, and serve that root only on `127.0.0.1` (for example `python3 -m http.server 8765 --bind 127.0.0.1 --directory <mirror-root>`). With that server active, set `PRISMA_ENGINES_MIRROR=http://127.0.0.1:8765` and dummy loopback-only `DATABASE_URL`/`DIRECT_URL`, then run normal `npm ci --no-audit --no-fund` with lifecycle scripts enabled. The pinned Prisma fetcher will verify official sidecars and the engine commit; do not set any checksum-bypass variable. Then explicitly run `npx prisma -v`, `npx prisma generate`, `npx prisma validate`, `npx tsc --noEmit`, `npm run lint`, `npm run test:run`, and `npm run build`.
- No host-provided artifact-transfer service or matching local Prisma engine cache was found; no GitHub check runs or release assets exist for that commit. If the Windows owner cannot download the files, the precise external action is to allow the project’s approved build environment HTTPS access to `binaries.prisma.sh` (including its redirects), or provide a trusted internal mirror with those exact files and official sidecars. No Supabase or Axis database was contacted, no archive was restored, and no migration or database write was executed. Migration readiness remains **NO-GO**.
- **Superseding Prisma recovery and application verification (2026-10-30):** the seven uploaded text parts were concatenated in filename order with no separators and decoded. The resulting ZIP SHA-256 matched the required `3F79A50590CB4CDC7EEFA01B8B66642011E410634D6BD6A0CC5D379F75A7EC86`. The two compressed Linux engine hashes matched the supplied sidecars: `libquery_engine.so.node.gz` = `125d75739bd7fcdb8eabb5428355b5be00f540043e6bc1f5b30268947afab1bd`; `schema-engine.gz` = `98ad433fd64da2ea1eb6d565553a9a4339ecf30f1c211b28b69690f591269a41`. Both decompressed ELF64 x86-64 engines were verified for Prisma commit `393aa359c9ad4a4bb28630fb5613f9c281cde053` and the `debian-openssl-3.0.x` target. To meet Prisma's separate raw-engine checksum requests, raw checksums were derived from these verified compressed artifacts and checksum checks remained enabled.
- With the temporary local mirror and dummy loopback-only URLs, normal lifecycle-enabled `npm ci --no-audit --no-fund` succeeded and generated Prisma Client 5.17.0. `npx prisma -v` confirmed CLI/client 5.17.0, target `debian-openssl-3.0.x`, and the expected engine commit. `npm run prisma:generate` and `npx prisma validate` succeeded. The earlier missing-engine diagnosis and failed-fetch attempts above describe the pre-recovery state and are superseded by this entry.
- Schema validation exposed a missing `@@unique([menuItemId, hotelId])` on `Recipe`, required by its tenant-scoped relation; the schema and the untracked `20261029130000_add_tenant_composite_join_fks` proposal were updated together. No migration was applied. Generated Prisma types also showed nested `ReservationRoom` create inputs exclude redundant `hotelId` because the parent reservation supplies tenant ownership. The route and seed inputs now omit it; the reservation-isolation test mock models that inheritance and asserts both the absence of an explicit nested tenant field and the persisted child tenant matching its parent.
- Final local checks passed: `npx tsc --noEmit`; `npm run lint`; `npm run test:run` (45 files, 647 tests); and `npm run build` (Next.js 15.5.28 production build, including Prisma generation and static page generation). The build used a dummy database URL at `127.0.0.1:1` and the matching safety identifier; the initial build attempt without `SAAS_ENVIRONMENT` correctly failed closed during route data collection, then the build passed with the explicit dummy-only configuration. The focused reservation-isolation test passed 18/18. Vite emitted its existing non-blocking config-loader warning in tests.
- No database was contacted; there was no `migrate`, `db push`, seed, restore, reset, migration change, or database write. PostgreSQL rehearsal and migration readiness remain **NO-GO** pending the evidence, approval, and disposable-PostgreSQL gates documented above. The temporary artifact mirror is session-local and must be stopped after verification.
