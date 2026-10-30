# PostgreSQL migration rehearsal — record and evidence

**Status: rehearsal executed 2026-10-30 against PostgreSQL 17.11. 8/8 scenarios, 83 assertions, no
failures.** The strategy and the runbook live in [migration-strategy.md](migration-strategy.md);
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
what its exact scope was, or the current server state. **A verified restore is still required before
deployment** (§6).

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

1. **`prisma migrate deploy` itself never ran.** Prisma 5.17.0 fetches its schema engine from
   `binaries.prisma.sh`, which this sandbox cannot reach; the client cannot even be generated here.
   The SQL, ordering, checksum values and ledger rows are proven against PostgreSQL 17.11, and the
   ledger table definition matches Prisma's own, but the runner's behaviour must still be exercised
   once on a machine with the pinned engines — against a **restored copy** of the target first.
2. **Atomicity of Prisma's per-migration transaction** is untested for the same reason. Mitigation:
   migrations 18 and 19 are written to be re-runnable, and `partial-rerun` verifies that property.
3. **The live target's checkpoint is inferred, not observed.** The detection code is read-only and
   cannot damage anything; run it before any write.
4. **Backup/restore fidelity of the target** is unverified (§2.2).
5. **Application behaviour under the new constraints** (POS retry, multi-room reservations, recipe
   editing) is covered by the mocked/PGlite test suite, not by this rehearsal.

---

## 6. Remaining gates before deploying to the target

| Gate | State |
|---|---|
| Release artifacts committed and checksum-pinned | **PASS** (19 migrations, manifest, tests) |
| Fresh PostgreSQL 17.11 chain rehearsal | **PASS** |
| Legacy upgrade rehearsal with data | **PASS** |
| Ledgerless adoption rehearsal (all 20 intermediate shapes) | **PASS** |
| Fail-closed conflict behaviour and recovery | **PASS** |
| Verified restore of the target backup | **NOT DONE** — owner action |
| Read-only checkpoint detection against the live target | **NOT DONE** — `npm run migration:adopt` dry run |
| Real `prisma migrate deploy` against a restored copy | **NOT DONE** — needs pinned Prisma engines |
| Owner approval for the deployment window | **NOT DONE** |

---

## 7. History of this record

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

The earlier record's inventory of "untracked proposals" is obsolete: all 19 migrations are tracked
and checksum-pinned, and the stale `PROPOSAL ONLY` header was removed from
`20261027100000_add_membership_department` before the manifest was generated.
