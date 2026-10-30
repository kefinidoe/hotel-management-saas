# PostgreSQL migration rehearsal — record and evidence

**Status: rehearsal executed 2026-10-30 against PostgreSQL 17.11. 8/8 psql scenarios, 83 assertions;
then executed again by the real Prisma migration engine (6.19.0): 6/6 scenarios, 37 assertions.
Backup restoration rehearsed on a synthetic archive. No failures.** The strategy and the runbook live in [migration-strategy.md](migration-strategy.md);
this document is the evidence record: what was run, on what, and what it does *not* prove.

This file supersedes the earlier "preparation only / NO-GO" notes, which were accurate when no
PostgreSQL server existed in the sandbox. See [§7](#7-history-of-this-record) for why the status
changed.

---

## 1. Safety gate (unchanged, applies to every rehearsal and deploy)

* Never point rehearsal or deployment commands at a shared service, the legacy Axis Hotel system,
  or any populated environment that is not the approved target.
* Rehearsals run only in disposable databases on a **loopback** PostgreSQL endpoint. The rehearsal
  script refuses any non-loopback host and refuses connection strings containing a password.
* Rehearsal and adoption tooling never read `.env`, `DATABASE_URL` or `DIRECT_URL` implicitly; the
  rehearsal requires an explicit `REHEARSAL_BASE_URL`, and adoption goes through
  `assertDatabaseTarget` (`SAAS_ENVIRONMENT=saas`, `SAAS_DATABASE_IDENTIFIER`, explicit URL).
* Do not use `prisma migrate dev`, `db push`, `migrate reset`, `migrate resolve --rolled-back` as a
  substitute for the documented procedure, and never edit an applied migration.
* A target-history change (a ledger appearing where this document says there is none) is a stop
  signal, not an inconvenience.

### Evidence template still required from the owner

```text
Review date / maintainer role:
Approved isolated restore identifier (non-secret):
Backup restore verification (method, date, expected-vs-actual checks/counts):
PostgreSQL version:
Does public._prisma_migrations exist? [yes / no]
Schema/checkpoint observed by `npm run migration:adopt` (dry run output, sanitised):
Integrity checks (counts only):
  duplicate Payment idempotency keys:
  duplicate Order operation/key tuples:
  orphan/cross-tenant ReservationRoom links:
  cross-tenant RecipeIngredient links:
  orphan/cross-tenant OrderItem menu links:
Other failures / caveats:
```

---

## 2. Target evidence on record

### 2.1 Source-side observation (owner-supplied, read-only, 2026-10-28)

The Supabase SQL editor returned `server_version = 17.11`, `current_database() = postgres`, and
`public._prisma_migrations` **absent**. No ledger rows exist to compare checksums against, which is
why the strategy in [migration-strategy.md](migration-strategy.md) is *adoption*, not replay.

### 2.2 Archive metadata (owner-supplied)

`hotel-management-saas-20261028-140823.dump`, 384,096 bytes, SHA-256
`F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7`. The captured TOC listing
exited 0 and reported `Dumped from database version: 17.11` / `Dumped by pg_dump version: 17.11`.
The TOC lists `auth`, `storage`, `realtime`, `vault`, `graphql`, `graphql_public`, `extensions`,
`pgbouncer` and no `_prisma_migrations`.

This is backup-time archive evidence only. It does not establish that the dump restores cleanly,
what its exact scope was, or the current server state. **A verified restore of this archive is still
required before deployment** (§7) — the procedure is rehearsed, the file has not been supplied.

### 2.3 What this means

The server major version (17) that this rehearsal used matches the target exactly, so SQL behaviour
differences between the rehearsal and the target are not a concern. The *history* is: adoption must
classify the live schema first, read-only.

---

## 3. Environment used

| Component | Value |
|---|---|
| Server | PostgreSQL 17.11 (`x86_64-pc-linux-gnu`), disposable cluster, loopback + Unix socket |
| Client | `psql (PostgreSQL) 17.11` |
| Binaries source | `postgresql-binaries==17.11.0` wheel (official PostgreSQL 17.11 build), extracted locally |
| Node | 22.22.3 |
| Prisma | `prisma`/`@prisma/client` pinned 5.17.0 — **schema engine unavailable**, see §5 |
| Migration files | 19, pinned by `prisma/migration-release-manifest.json` |

The cluster was created with `initdb -A trust` on a loopback-only socket, `fsync=off` and
`full_page_writes=off` (disposable durability), and destroyed after the run. No credentials were
used, stored or printed.

---

## 4. Executed rehearsal

### 4.1 Command

```bash
REHEARSAL_BASE_URL=postgresql://postgres@127.0.0.1:55432 \
PSQL_BIN=$PGBIN/psql \
node scripts/migration-rehearsal.mjs
```

### 4.2 Result

```text
PostgreSQL rehearsal (scripts/migration-rehearsal.mjs)
  server : 17.11 at 127.0.0.1/32
  client : psql (PostgreSQL) 17.11
  files  : 19 reviewed migrations

PASS  fresh-chain — All reviewed migrations apply cleanly to an empty database and match the approved schema
PASS  legacy-upgrade — Single-hotel database with data converts to the SaaS schema without losing ownership
PASS  unmanaged-saas — SaaS schema through migration 17 with no ledger adopts and deploys only the missing migrations
PASS  unmanaged-current — Fully current schema with no ledger records history and deploys nothing
PASS  conflict-guard — A cross-tenant join row aborts migration 19 without schema changes, then converges after repair
PASS  empty-adopt — An empty database is adopted and every migration is applied through the ledger
PASS  checkpoint-ladder — Every intermediate schema state is classified correctly by the checkpoints
PASS  partial-rerun — The two newest migrations can be re-applied without error after an interrupted deploy

REHEARSAL PASSED: 8/8 scenarios, 83 assertions
```

| Scenario | Assertions | What passed |
|---|---:|---|
| `fresh-chain` | 15 | 19/19 migrations apply in order; the database matches `saas_current` exactly; raw SQL leaves no ledger; a dry run writes nothing; baselining records 19 rows with checksums equal to the reviewed file hashes and `applied_steps_count = 1`; the second run is a no-op |
| `legacy-upgrade` | 18 | 12 migrations + synthetic legacy data → detected `legacy_single_hotel_through_11`; 11 baselined, 8 deployed (migration 12 is a data-only idempotent insert and is always deployed, never baselined); role `ADMIN → HOTEL_OWNER`, legacy department copied to the membership, Half Board room retained, duplicate menu category merge preserved, all four join rows assigned `legacy-hotel`, notification type/body converted, audit `before`/`after`/`reason` folded into `metadata`, no join row disagrees with its parent |
| `unmanaged-saas` | 7 | `saas_through_17` detected; exactly migrations 18 and 19 pending; after deploy the schema is `saas_current` with no unfinished ledger rows |
| `unmanaged-current` | 5 | `saas_current` detected; 19 migrations baselined; nothing pending; schema untouched |
| `conflict-guard` | 9 | Cross-tenant `ReservationRoom` link aborts migration 19; the failure names `ReservationRoom`; migration 18 is recorded and 19 is not; no `hotelId` column was added; the conflicting row is untouched; after deleting the row the same command converges to `saas_current` |
| `empty-adopt` | 6 | `empty` detected; nothing baselined; all 19 applied through the ledger; final schema `saas_current` |
| `checkpoint-ladder` | 21 | Starting from an empty database, the migrations are applied one at a time and the detected checkpoint is asserted after each of the 20 states: `empty`, then unrecognised through migration 10, `legacy_single_hotel_through_11` at 11 and 12, then `saas_through_081`, `saas_through_14`, `saas_through_15`, `saas_through_16`, `saas_through_17`, `saas_through_18`, `saas_current` |
| `partial-rerun` | 2 | Re-applying migrations 18 and 19 after a complete run raises no error and leaves the approved schema |

### 4.3 Supporting checks

```bash
npx vitest run __tests__/schema/     # 4 files, 71 tests: chain, schema parity, adoption logic, cross-tenant
npm run migration:manifest           # release manifest matches all 19 files
```

Schema parity is asserted two ways: `__tests__/schema/migrations.test.ts` compares every model,
column, enum label and index name in `schema.prisma` against a migrated database, and the rehearsal
asserts the same end-state through the checkpoint feature probes on real PostgreSQL 17.11.

### 4.4 Leaving no residue

Each scenario created a database named `hotel_saas_rehearsal_<run-id>_<scenario>`; all were dropped
afterwards (`--keep` retains them for inspection). Nothing was written to any pre-existing database.

---

## 5. What the rehearsal does not prove

1. **The pinned 5.17.0 engine has not run.** §6 runs the real Prisma migration engine, but from the
   6.19.0 tool stack: the 5.17.0 binaries are only published to `binaries.prisma.sh`, which this
   sandbox cannot reach, and Prisma published no 5.x WebAssembly schema engine. Same command set,
   same ledger format, same checksum algorithm — different engine generation. One run with
   `PRISMA_SCHEMA_ENGINE_BINARY` pointing at the pinned binary, against a **restored copy**, closes it.
2. **Atomicity beyond PostgreSQL's implicit transaction** is untested. §6 shows the engine sends each
   migration as one multi-statement statement and that a failure rolls the file back, but an
   interrupted connection mid-file is a different failure mode. Migrations 18 and 19 stay written to
   be re-runnable, and `partial-rerun` verifies that property.
3. **The live target's checkpoint is inferred, not observed.** The detection code is read-only and
   cannot damage anything; run it before any write.
4. **Backup/restore fidelity of the target** is unverified (§2.2). §7 proves the *procedure* on a
   synthetic archive; the owner's archive has not been restored because it is not in this workspace.
5. **Application behaviour under the new constraints** (POS retry, multi-room reservations, recipe
   editing) is covered by the mocked/PGlite test suite, not by this rehearsal.

---

## 6. Engine verification — the real Prisma migration engine

`scripts/migration-rehearsal.mjs` (§4) runs the SQL with `psql`. `scripts/prisma-engine-verify.mjs`
runs the same files through Prisma's own migrate implementation and asserts on the ledger it writes.
Setup, rationale and the two documented deviations (adapter `executeScript`, adapter OID 19) are in
[migration-strategy.md §7](migration-strategy.md).

```bash
VERIFY_BASE_URL=postgresql://postgres@127.0.0.1:55432 \
VERIFY_MODULES=/tmp/prisma-engine-verify/node_modules \
VERIFY_PSQL=/tmp/pgx/postgresql-17.11.0-x86_64-unknown-linux-gnu/bin/psql \
npm run migration:verify-engine
```

```
Prisma engine verification
  @prisma/migrate     : 6.19.0
  prisma (tool stack) : 6.19.0
  wasm schema engine  : febbb50ef48a4e577b6d3652841166fac47eb129e63f727f9c9401f3d4b84bf1
  migrations          : 19
  scenarios           : fresh, legacy, saas18, interop, conflict, failure
== fresh — the engine applies every migration to an empty database
PASS  engine reported success — 140 ms, 19 script(s) executed
PASS  engine executed the migration files verbatim
PASS  engine applied all migrations in directory order — 19/19
PASS  ledger contains one row per migration — rows=19
PASS  every row is finished and none is rolled back
PASS  engine-recorded checksums equal the release manifest — 19/19 identical
PASS  applied_steps_count is recorded per migration
PASS  schema fingerprint is saas_current — saas_current
PASS  migration-ledger.mjs ledger DDL matches the engine ledger exactly — 8 columns compared
== legacy — single-hotel database (migrations 1-11, no ledger)
PASS  starting database has no migration ledger
PASS  engine recorded 11 baselines — rows=11
PASS  baselines are finished with applied_steps_count = 0
PASS  engine deployed exactly the pending migrations — 8 applied
PASS  baselines and deployments match the release manifest
PASS  schema fingerprint is saas_current — saas_current
PASS  a second deploy is a no-op — 0 applied
== saas18 — database created after migrations 18 and 19 were authored
PASS  engine deployed only the last migration — ["20261029130000_add_tenant_composite_join_fks"]
PASS  schema fingerprint is saas_current — saas_current
== interop — ledger written by scripts/migrate-adopt.mjs, read back by the engine
PASS  migrate-adopt --execute exit 0
PASS  adoption tool reports saas_current after its run
PASS  engine sees nothing left to deploy — []
PASS  engine finds a migrations table
PASS  engine reports no edited migrations — []
PASS  engine reports no failed migrations — []
PASS  tool-written checksums match the release manifest
PASS  schema fingerprint is saas_current — saas_current
== conflict — a migration changed after it was applied
PASS  engine flags the edited migration — ["20261029130000_add_tenant_composite_join_fks"]
PASS  adoption tool refuses to proceed — exit 1
PASS  adoption tool names the mismatching migration
== failure — migration 19 aborts on a cross-tenant row, then recovers
PASS  engine aborts the deploy — external connector error
PASS  the rejected statement is the migration-19 tenant precheck — Tenant-integrity precheck failed: ReservationRoom has 1 row(s) whose reservation and room belong to different
PASS  the last successful migration is recorded — 18 finished
PASS  the failed migration is recorded as failed — {"finished_at":null}
PASS  the failed migration keeps the engine error in logs — external connector error
PASS  the aborted script left no partial schema change — 3 constraints
PASS  engine redeploys the recovered migration — ["20261029130000_add_tenant_composite_join_fks"]
PASS  schema fingerprint is saas_current after recovery — saas_current

ENGINE VERIFICATION PASSED: 37/37 assertions
```

Recorded facts from that run:

* `_prisma_migrations` as created by the engine is column-for-column identical to
  `PRISMA_LEDGER_DDL` in `scripts/migration-ledger.mjs` (8 columns, same types, nullability and
  defaults), so the ledger `migrate-adopt` builds is the ledger Prisma builds.
* The engine's checksums for all 19 files equal `prisma/migration-release-manifest.json`.
* `migrate resolve --applied` writes `applied_steps_count = 0` with a `finished_at`; a deployed
  migration writes `applied_steps_count = 1`.
* A failed migration leaves `finished_at IS NULL`, the error id in `logs`, blocks the next deploy
  until `migrate resolve --rolled-back`, and leaves no partial schema change behind.

---

## 7. Backup restoration rehearsal (synthetic archive)

The owner's archive is not in this workspace (see §2.2 and the gates in §8), so the *procedure* was
rehearsed against an archive produced here. Source database: migrations 1-11 applied with `psql`, the
`pre-saas-conversion` fixture, and 500 generated guests (501 guests, 25 tables, no ledger).

```bash
# 1. archive (custom format, verified by the tool itself)
SAAS_ENVIRONMENT=saas SAAS_DATABASE_IDENTIFIER=backup_src \
  node scripts/backup-db.mjs --url "postgresql://postgres@127.0.0.1:55432/backup_src" \
  --out /tmp/verify-backups --keep 2
# 2. restore into a scratch database
SAAS_ENVIRONMENT=saas SAAS_DATABASE_IDENTIFIER=backup_restored \
  node scripts/restore-db.mjs --file /tmp/verify-backups/hms-2026-10-30T11-20-44.dump \
  --target "postgresql://postgres@127.0.0.1:55432/backup_restored" \
  --confirm-target "postgres@127.0.0.1:55432/backup_restored"
# 3. read-only fingerprint of the restored copy
SAAS_ENVIRONMENT=saas SAAS_DATABASE_IDENTIFIER=backup_restored \
  node scripts/migrate-adopt.mjs --url "postgresql://postgres@127.0.0.1:55432/backup_restored" \
  --psql "$PGBIN/psql"
```

Result:

| Step | Observed |
|---|---|
| `backup-db.mjs` | 57 KB, 136 objects, "verified OK"; SHA-256 `8cc94822eeef89cb92e58a8fed9da3adf6edbbbd40f3276434791bc726e3140e` |
| `restore-db.mjs` | "Restore finished with no errors" |
| Restored content | 25 public tables, `Guest` 501, `User` 1, `_prisma_migrations` absent — equal to the source |
| `migrate-adopt` dry run | `Detected checkpoint: legacy_single_hotel_through_11`, ledger ABSENT, 0 recorded, 11 to baseline, 8 pending, exit 0 (read-only) |

What this proves: the archive/restore chain works with the same tools the runbook prescribes, the
restored copy is complete, and the read-only checkpoint detection classifies a restored legacy
database correctly.

What it does not prove: that *the owner's* archive restores. That needs the file:

```bash
sha256sum hotel-management-saas-20261028-140823.dump     # expect F81566E9…24A7
# then steps 2 and 3 above with --file pointing at it
```

---

## 8. Remaining gates before deploying to the target

| Gate | State |
|---|---|
| Release artifacts committed and checksum-pinned | **PASS** (19 migrations, manifest, tests) |
| Fresh PostgreSQL 17.11 chain rehearsal | **PASS** |
| Legacy upgrade rehearsal with data | **PASS** |
| Ledgerless adoption rehearsal (all 20 intermediate shapes) | **PASS** |
| Fail-closed conflict behaviour and recovery | **PASS** |
| Real Prisma migration engine executed against disposable databases | **PASS** (6 scenarios, 37 assertions, §6) |
| Adoption tooling accepted by the real engine (ledger interop, drift detection) | **PASS** (§6) |
| Failure and recovery path through the real engine | **PASS** (§6) |
| Backup/restore + post-restore fingerprint procedure | **PASS** on a synthetic archive (§7) |
| Verified restore of **the owner's** archive | **NOT DONE** — archive not supplied (§7) |
| Read-only checkpoint detection against the live target | **NOT DONE** — needs `DIRECT_URL`; one dry run |
| `prisma migrate deploy` with the **pinned 5.17.0** engine | **NOT DONE** — engine binary unreachable here (§5.1) |
| Owner approval for the deployment window | **NOT DONE** |

---

## 9. History of this record

* **Before 2026-10-30 — preparation only.** No `psql`, `postgres`, `initdb`, Docker or Podman
  existed in the sandbox, so the documented procedure was written but not executed, and the status
  was NO-GO. That conclusion was correct for the environment at the time.
* **2026-10-30 — blocker removed.** PostgreSQL 17.11 binaries (exactly the target major version)
  became available through the `postgresql-binaries` wheel, so a real server, client, `pg_dump` and
  `pg_restore` are now usable inside the sandbox. Rehearsal and adoption tooling
  (`scripts/migration-rehearsal.mjs`, `scripts/migrate-adopt.mjs`, `scripts/migration-ledger.mjs`)
  were built on top of them, and the two missing migrations were reconstructed, hardened and
  committed.
* **2026-10-30 — rehearsal executed.** 8/8 scenarios, 83 assertions, no failures (§4).
* **2026-10-30 — real engine executed.** The official Prisma schema engine (6.19.0, WebAssembly build,
  SHA-256 `febbb50e…`) applied, baselined, diagnosed and rolled back the migration set through
  `@prisma/migrate`'s own command implementations: 6 scenarios, 37 assertions (§6). The pinned 5.17.0
  engine remains unavailable for the reasons in §5.1 and
  [migration-strategy.md §7.1](migration-strategy.md).
* **2026-10-30 — restoration procedure rehearsed** on a synthetic archive; the owner's archive is
  still missing (§7).

The earlier record's inventory of "untracked proposals" is obsolete: all 19 migrations are tracked
and checksum-pinned, and the stale `PROPOSAL ONLY` header was removed from
`20261027100000_add_membership_department` before the manifest was generated.
