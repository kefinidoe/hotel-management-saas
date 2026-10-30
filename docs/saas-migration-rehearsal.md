# PostgreSQL migration rehearsal — record and evidence

**Status: rehearsal executed 2026-10-30 against PostgreSQL 17.11. 8/8 psql scenarios, 83 assertions;
then executed again by the real Prisma migration engine (6.19.0): 6/6 scenarios, 37 assertions.
Backup restoration rehearsed on a synthetic archive, and the procedure automated as a digest-enforced
command (§9). Three external inputs are still missing — the owner's archive, the target credentials and
a reachable Prisma 5.17.0 engine — so production readiness is not claimed. No failures in what was run.** The strategy and the runbook live in [migration-strategy.md](migration-strategy.md);
this document is the evidence record: what was run, on what, and what it does *not* prove.

This file supersedes the earlier "preparation only / NO-GO" notes, which were accurate when no
PostgreSQL server existed in the sandbox. See [§12](#12-history-of-this-record) for why the status
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
| Backup/restore + post-restore fingerprint procedure | **PASS** on a synthetic archive (§7) and on a full-schema archive (§9) |
| Digest-enforced restore rehearsal tool (`npm run migration:restore-rehearsal`) | **PASS** — refuses mismatched digests before connecting, drops its scratch database (§9) |
| Read-only checkpoint/fingerprint tool (`npm run migration:target-check`) | **PASS** against local targets; read-only enforced by the server (§9) |
| Verified restore of **the owner's** archive | **NOT DONE** — owner reports the file recovered, but its bytes are not in this environment (§11.1); the harness, preflight and chain are ready (§11.3–11.4) |
| Read-only checkpoint detection against the live target | **NOT DONE** — needs `DIRECT_URL`; `npm run migration:target-check` is the command |
| `prisma migrate deploy` with the **pinned 5.17.0** engine | **NOT DONE** — `binaries.prisma.sh` unreachable; recovery and acceptance steps recorded in [migration-strategy.md §7.1.1–7.1.3](migration-strategy.md) |
| Schema validated by the **pinned 5.17.0** parser | **PASS** — `@prisma/internals@5.17.0` WASM parser: 28 models, 19 enums, 0 P1012 errors ([§7.5](migration-strategy.md)) |
| Readiness reporting distinguishes PASS / BLOCKED / FAIL / PENDING APPROVAL | **PASS** — demonstrated in §10.3 |
| Owner approval for the deployment window | **NOT DONE** |

---

## 9. Evidence-gap closure pass (2026-10-30)

The remaining gaps from §8 were attacked with two new tools rather than with more prose. Both are
deliberately narrow: one can only read, the other can only restore into a database it created itself.

| Tool | Property that makes it evidence |
|---|---|
| `scripts/target-check.mjs` (`npm run migration:target-check`) | No write path exists. Every statement runs on a session whose `default_transaction_read_only` is `on`, set through `PGOPTIONS`, and the report is refused if the server did not apply it. Prints the checkpoint, ledger-vs-manifest comparison, and an md5 fingerprint of tables/columns/indexes/constraints/functions |
| `scripts/restore-rehearsal.mjs` (`npm run migration:restore-rehearsal`) | Refuses to restore unless the archive's SHA-256 equals `--expect-sha256`; refuses an existing database name; creates and drops its own scratch database; insists on an expected digest or explicit `--allow-unverified` |

### 9.1 What was actually run here

Local PostgreSQL 17.11, loopback only. Source database: all 19 migrations applied with `psql`, plus
two hotels, one user and three guests (fictional data, no ledger).

| Step | Observed |
|---|---|
| `backup-db.mjs` on that source | 94 951 bytes, 239 objects, "verified OK", SHA-256 `3b95d707dccde8118da50aa3168493147a235ba3b24956939819024f5bb807d8` |
| `restore-rehearsal.mjs`, digest supplied | **PASS** — restore finished with no errors; 28 public tables; `User`=1, `Hotel`=2, `Guest`=3; ledger absent; checkpoint `saas_current`; inspection ran read-only (`transaction_read_only=on`); scratch database dropped |
| `restore-rehearsal.mjs --keep --json` | **PASS** — database kept, `ok: true`, `digestVerified: true`; the kept copy answered `select count(*) from "Guest"` = 3 before being dropped |
| `restore-rehearsal.mjs` with a wrong digest | exit 1 — "Archive digest does not match the recorded value; nothing was restored" |
| `restore-rehearsal.mjs` with no digest | exit 1 — refuses until `--expect-sha256` is supplied |
| `restore-rehearsal.mjs` with a missing archive | exit 1 — "No such archive … never creates one to stand in for a missing backup" |
| `restore-rehearsal.mjs` with a non-loopback `--base-url` | exit 1 — will not create/drop databases on a shared host without `--allow-remote-target` |
| `restore-rehearsal.mjs --database backup_src` | exit 1 — "already exists; refusing to restore into it" |
| `target-check.mjs` on the ledgerless full-schema copy | **PASS** — ledger ABSENT, checkpoint `saas_current`, fingerprint `cd13215577c5b085e071c9a131c30790` (28 tables, 107 indexes, 84 constraints, 219 objects), `default_transaction_read_only=on` |
| `target-check.mjs` on a database with a real 19-row ledger | **PASS** — ledger present, 19 applied, 0 unfinished, 0 checksum mismatches, same fingerprint digest, adoption plan 0/0 |
| Same fingerprint on both copies | The digest excludes `_prisma_migrations`, so a target and its restored copy are directly comparable |
| `target-check.mjs` after tampering with one ledger checksum | exit 1 — "1 mismatch(es)"; the tamper is named with ledger and expected digests |
| `target-check.mjs` on an empty database | **PASS** with `--expect-checkpoint empty`; adoption plan 0 to baseline, 19 to deploy |
| `target-check.mjs --expect-checkpoint legacy_single_hotel_through_11` on a current schema | exit 1 — "expected legacy_single_hotel_through_11, detected saas_current" |
| `target-check.mjs` without `SAAS_ENVIRONMENT` / with a remote rehearsal binding / on port 6543 | exit 1 each — target binding refused before any connection |
| `target-check.mjs --execute` | exit 2 — "Unknown option"; the tool has no write flag to misuse |

Both tools are covered by `__tests__/scripts/migration-evidence-tools.test.ts` (15 tests, no database
or `psql` required), because the important behaviour is refusal. Full suite after this pass:
**693 tests in 47 files**, `npm run lint` clean.

### 9.2 Gap status after this pass

| # | Gap | Status | What is precisely missing |
|---|---|---|---|
| 1 | Recover and verify `hotel-management-saas-20261028-140823.dump`, then rehearse it | **BLOCKED — file absent.** Searched the whole filesystem (`*.dump`, `*140823*`); the only archive present is one built here. The recorded identity to check against is 384 096 bytes / `F81566E9…24A7`; the rehearsal is now one command (`--expect-sha256`) that cannot silently restore the wrong file | the archive itself |
| 2 | Read-only fingerprint and checkpoint against the configured Supabase target | **BLOCKED — credentials absent.** No `DIRECT_URL`, `DATABASE_URL`, `.env`, or Supabase token exists in this workspace; connecting without them would mean inventing a target. The read-only tool is built and proven against local targets | `DIRECT_URL` + `SAAS_DATABASE_IDENTIFIER` (and the owner's authorisation to connect read-only) |
| 3 | Obtain the official Prisma 5.17.0 engine and verify it against a restored disposable database | **BLOCKED — the artifact has no reachable distributor; the verification half is built.** Probed 2026-10-30: `binaries.prisma.sh` still TLS-resets (the legacy `prisma-builds.s3-eu-west-1.amazonaws.com` and plain HTTP do too), while `github.com`/`codeload`/`api.github.com` now answer 200. Using that access: all four official digests were confirmed against `Jolg42/prisma-engines-artifacts` (§9.3), and code/registry searches show the binaries are not mirrored anywhere reachable — no repo commits them (`filename:libquery_engine-debian-openssl-3.0.x.so.node` → 0 hits; the one `schema-engine-debian-openssl-3.0.x` hit is a 34-byte placeholder), `prisma/prisma-engines` has no release assets, and no npm or PyPI package ships the native 5.17.0 engines. Building from source is also out: no Rust toolchain and `crates.io`/`static.crates.io`/`index.crates.io` all return 000. `npm run migration:verify-pin` now checks a supplied pair against the pinned digests and commit, so acceptance is one command once the artifact exists | the two artifacts themselves (commit `393aa359…`, platform `debian-openssl-3.0.x`), from `binaries.prisma.sh` or a mirror |
| 4 | Fix what the pass found, document actual results | **DONE** — three real defects found and fixed while building the tools: `pg_restore` needed `--clean --if-exists` for the pre-existing `public` schema; the row-count query aliased a column `rows` inside `FROM (…) rows`, so `row_to_json` bound to the bigint column; the scratch database was not dropped when inspection failed after setting the read-only default | — |
| 5 | Keep the work committed and pushed | Committed to `main` with the tests passing | — |

No synthetic result stands in for a missing input: where a file or credential is absent, the row above
says so and the tool that would consume it is built, tested and waiting.

### 9.3 Pinned-engine verification pass (this round)

Gap 3 needed two things: the binaries, and a way to prove that whatever is supplied *is* the release. The
second half is now code rather than prose.

| Piece | Detail |
|---|---|
| `scripts/prisma-engine-pins.mjs` | Records `prisma 5.17.0`, engine commit `393aa359c9ad4a4bb28630fb5613f9c281cde053`, platform `debian-openssl-3.0.x`, and the four official SHA-256 values (`schema-engine` `0a52943c…956e`, its archive `98ad433f…9a41`, `libquery_engine.so.node` `077e8682…7f9f`, its archive `125d7573…b1bd`) |
| Independent confirmation | The third and fourth values — including the plain `libquery_engine.so.node` digest the live CDN probe never reached — were read from the public `Jolg42/prisma-engines-artifacts` archive, whose paths are `artifacts/all_commits/393aa359…/debian-openssl-3.0.x/*.sha256`. They agree with what the CDN sidecars returned before it became unreachable |
| `scripts/prisma-engine-pin.mjs` (`npm run migration:verify-pin`) | Hashes each supplied artifact, compares it with the pin, runs `schema-engine --version` and requires commit `393aa359…`, and optionally runs `prisma -v` with the two `PRISMA_*` variables exported to confirm the CLI resolves `5.17.0` + the same commit. It never executes a binary whose digest failed, downloads nothing, and has no digest-skipping flag |
| Behaviour observed | With no arguments: exit 2, listing the variables and artifacts. With a 1 KB file in place of `schema-engine`: exit 1, `MISMATCH`, both digests printed, `--version` explicitly **not run**. With a nonexistent path: exit 1, "No such file". `--skip-digest`: exit 2, "Unknown option" |
| Readiness reporting | `npm run migration:readiness` prints the three prerequisites as separate lines with the exact next command for each, and `ready: false` while one is absent. Run in this environment it reports: archive **MISSING** (no `--dump`/`$BACKUP_ARCHIVE`), credentials **MISSING** (`SAAS_ENVIRONMENT=saas`, `SAAS_DATABASE_IDENTIFIER`, `DIRECT_URL`), engine **MISSING** (`PRISMA_SCHEMA_ENGINE_BINARY`/`PRISMA_QUERY_ENGINE_LIBRARY`). It cannot and does not mark approval as granted |
| Tests | `__tests__/scripts/prisma-engine-pin.test.ts` — 16 tests: pin table shape, commit parsing (including a short hash being rejected), digest match/mismatch/missing/unsupplied paths, and the CLI refusals. The positive CLI path needs the genuine artifact, so it is **not** faked |

What this changes: gap 3 is no longer "we hope the right file is used". The bytes are pinned, the commit
is pinned, and the check fails closed. What it does not change: the pinned engine still has not run,
because no reachable host serves it.

---

---

## 10. Safety audit and readiness vocabulary (2026-10-30)

A full pass over the migration workflow — not just the scripts — looking for ways it could do the wrong
thing quietly. Two real defects were found and fixed; the rest of the workflow held.

### 10.1 Defects found and fixed

| Defect | Why it mattered | Fix | Proof |
|---|---|---|---|
| A scratch database could survive an unexpected failure in `restore-rehearsal` | Cleanup ran only on the normal path. An fs error or a bug after `CREATE DATABASE` would leave a database behind on the server — the exact "disposable" failure the tool exists to prevent | A module-level `scratchToClean` record plus a drop in the top-level error handler; the normal path clears it | A temporary copy of the script with an injected throw immediately after `CREATE DATABASE` printed `Dropped scratch database rehearsal_restore_20261030_120151 after the failure.` and `select count(*) from pg_database where datname like 'rehearsal_restore%'` returned **0**. The copy was deleted; no test hook ships |
| A `.dump` file at the repository root was **not** ignored | The owner's archive contains real guest data; only `backups/` was ignored, so an archive copied next to the scripts could be committed | `*.dump` and `*.dump.gz` added to `.gitignore` | `git check-ignore -v hotel-management-saas-20261028-140823.dump` → `.gitignore:51:*.dump` |

### 10.2 What the audit confirmed (by reading and by running)

| Property | How it holds |
|---|---|
| No connection to the legacy Axis Hotel database | No script accepts a host it has not been given; rehearsal tooling refuses non-loopback; the adoption tool binds to `SAAS_DATABASE_IDENTIFIER` before connecting |
| No replay of an existing schema | `buildAdoptionPlan` refuses to baseline unless the schema matches exactly one checkpoint; migration 1 is never re-run against live tables (proved by the `unmanaged-*` and `conflict-guard` scenarios) |
| No cross-tenant corruption | Migration 19's tenant precheck aborts the deploy and rolls back (`conflict-guard`, `failure`), verified again in this pass by the 8/8 rehearsal |
| No unsafe ledger adoption | Baseline rows are written in one transaction that re-verifies the checkpoint predicate inside it; checksums come from the reviewed manifest |
| No checksum bypass | `migrate-adopt` exits 1 on a mismatched ledger checksum; `verify-pin` has no flag that skips the digest comparison; `restore-rehearsal` refuses a mismatch before connecting |
| No destructive operation on an unverified database | `restore-db` requires `--confirm-target` and refuses the live target without `--force`; `restore-rehearsal` refuses existing names and never drops a database it did not create |
| Credentials never logged | Scripts print host/database, never the URL; `prisma-engine-verify` masks the password; `.env*` is ignored |
| Fail-safe with missing prerequisites | Every tool exits non-zero with the exact missing input; `migration:readiness` reports BLOCKED rather than implying success |
| Explicit owner approval required | `migrate-adopt --execute` requires `--approved-by` and `--confirm-database`; readiness always reports `PENDING APPROVAL` |

Known, accepted limitation: connection strings are passed to `psql`/`pg_restore` as an argument, so they
are visible to `ps` on the same host for the lifetime of that process — the same exposure as running
`psql '<url>'` by hand. This is documented rather than fixed, because moving to `PGPASSWORD`/`~/.pgpass`
changes how every operator runs the tools.

### 10.3 Readiness vocabulary and what this pass demonstrated

`npm run migration:readiness` now reports exactly four states — **PASS**, **BLOCKED**, **FAIL**,
**PENDING APPROVAL** — and its decision is the worst of the three prerequisites. A passing test suite
never produces PASS.

Observed in this pass (local PostgreSQL 17.11, disposable database):

```
archive     : PASS — /tmp/audit-backups/hms-2026-10-30T12-01-41.dump (sha256 matches 37fe67ac…)
credentials : PASS — target-check passed read-only; checkpoint saas_current; ledger ABSENT
engine      : BLOCKED — no artifacts supplied (…); pinned commit 393aa359c9ad…
approval    : PENDING APPROVAL — owner sign-off for the deployment window
Decision     : BLOCKED — 1 of 3 prerequisites are not demonstrated: engine
```

With no inputs (the state of this environment) all three read BLOCKED. With a non-matching archive the
decision is FAIL, not BLOCKED, because that is a check that ran and failed.

### 10.4 Verification run in this pass

| Check | Result |
|---|---|
| `npm run migration:rehearse` (psql, PostgreSQL 17.11) | **8/8 scenarios, 83 assertions** |
| `migration:restore-rehearsal` on a locally built archive (digest-verified) | **PASS** — 28 tables, checkpoint `saas_current`, inspection read-only, scratch database dropped; 0 `rehearsal_restore%` databases left afterwards |
| `migration:target-check` on the ledgerless full-schema copy | **PASS** — fingerprint `cd13215577c5b085e071c9a131c30790`, ledger ABSENT, checkpoint `saas_current` |
| `migration:readiness` (with archive + credentials, `--check-target`) | archive PASS, credentials PASS, engine BLOCKED, decision BLOCKED |
| Prisma 5.17.0 schema validation (`@prisma/internals@5.17.0` WASM parser) | **28 models, 19 enums, datasource postgresql, 0 P1012 errors** ([migration-strategy §7.5](migration-strategy.md)) |
| `vitest run` | **718/718 in 49 files** |
| `eslint` | clean |
| `migration:manifest` | 19/19 files match |
| `prisma validate` / `prisma generate` | blocked — fetch `libquery_engine…sha256` from `binaries.prisma.sh` (§7.1.1) |
| `tsc --noEmit` | 297 diagnostics, all from `@prisma/client` not being generated (same cause); none in migration/adoption/rehearsal code |

---

## 11. Owner archive status and preflight hardening (2026-10-30, later pass)

### 11.1 The archive was reported recovered, but its bytes are not in this environment

The owner states that `hotel-management-saas-20261028-140823.dump` (384,096 bytes, SHA-256 `F81566E9…24A7`)
has been recovered and attached. It is **not present in the agent's sandbox**, so the genuine restore has
not been run. Searched, after the message:

| Search | Result |
|---|---|
| `find / -name '*140823*'` | no match |
| `find / -type f -size 384096c` (exact size) | no match |
| `find / -type f -size +300k -size -500k` (excluding `node_modules`, `/usr`) | only `package-lock.json` and a dpkg symbols file |
| `grep -rl '^PGDMP'` across `/home`, `/tmp`, `/var/tmp`, `/mnt`, `/media`, `/srv`, `/opt` | no match — no PostgreSQL custom-format archive exists anywhere readable |
| `/tmp/arena-workspace` (attachment staging directory) | empty |

No stand-in is reported as the owner's backup. The recorded identity remains the only thing that can
confirm it, and the harness refuses to restore anything else.

### 11.2 The end-to-end chain was verified with a locally built archive of the same format

To make sure the owner's run cannot fail for a tooling reason, the full sequence was executed on
2026-10-30 against a custom-format archive produced by `scripts/backup-db.mjs` from a database with all 19
migrations applied and three guests (93 KB, 239 TOC entries, SHA-256 `9c8fb450…3413`):

| Step | Observed |
|---|---|
| `migration:restore-rehearsal --keep` | PASS — restore with no errors, 28 public tables, checkpoint `saas_current`, inspection read-only, database kept at request |
| `migration:adopt` (dry run, read-only) against the restored copy | exit 0 — ledger ABSENT, checkpoint `saas_current`, **19 to baseline, 0 to deploy** |
| `migration:target-check` against the restored copy | PASS — ledger ABSENT, fingerprint `cd13215577c5b085e071c9a131c30790` |
| Manual drop + `pg_database` check | `0` databases matching `rehearsal_restore%` / `chain_rehearsal%` |

That is the same sequence §4.2–4.6 prescribes, with the same tools, minus the owner's bytes.

### 11.3 Preflight: the archive is parsed before a database is created

`restore-rehearsal` now runs `pg_restore --list` on custom/directory archives **before** creating the
scratch database, and reports the table-of-contents entry count. Consequences:

* A truncated or corrupt archive fails with `The archive could not be read by pg_restore; nothing was
  restored and no database was created.` — previously the database was created first and the failure
  surfaced inside the restore.
* The owner's archive gets a cheap, side-effect-free structural check as part of the rehearsal.
* Verified both ways: a good archive reported `239 entries, parsed by pg_restore` and restored; a
  5,000-byte truncation of it exited 1 with the message above and `0` databases created.

### 11.4 What is still required

```bash
# 1. confirm identity + structure (no database, no connection)
npm run migration:readiness -- --dump /path/to/hotel-management-saas-20261028-140823.dump \
  --expect-sha256 F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7

# 2. the genuine rehearsal (creates and drops its own database)
npm run migration:restore-rehearsal -- \
  --dump /path/to/hotel-management-saas-20261028-140823.dump \
  --expect-sha256 F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7 \
  --base-url "postgresql://postgres@127.0.0.1:55432" \
  --expect-checkpoint saas_current --json > restore-evidence.json
```

`--json > restore-evidence.json` keeps the full report (digest, TOC count, checkpoint, row counts,
cleanup) without committing anything. The archive itself stays outside the repository; `*.dump` is
ignored, so it cannot be committed by accident.

---

## 12. History of this record

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
* **2026-10-30 — safety audit and readiness vocabulary.** Two defects fixed (scratch-database cleanup on
  unexpected failure, proved with an injected fault; `.dump` not ignored by git), the readiness report
  moved to four explicit states, and the schema validated by Prisma 5.17.0's own WASM parser (§10).
* **2026-10-30 — evidence-gap pass.** `scripts/restore-rehearsal.mjs` and `scripts/target-check.mjs`
  were added with 15 CLI tests: the first enforces the archive digest before connecting and cleans up
  its scratch database in every path, the second has no write path at all and proves the session is
  read-only before reporting. Both were exercised end to end on local PostgreSQL 17.11 (14 runs,
  including the refusal paths and a tampered-ledger detection). The owner's archive, the target
  credentials and a reachable 5.17.0 engine are still absent; §10 records exactly what each is.

The earlier record's inventory of "untracked proposals" is obsolete: all 19 migrations are tracked
and checksum-pinned, and the stale `PROPOSAL ONLY` header was removed from
`20261027100000_add_membership_department` before the manifest was generated.
