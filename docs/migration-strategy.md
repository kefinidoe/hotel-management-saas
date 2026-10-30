# Database migration strategy (decision record)

**Status: adopted 2026-10-30. Rehearsed against PostgreSQL 17.11 (8 psql scenarios) and executed by the
real Prisma migration engine (6 scenarios, 37 assertions).**
**Still required before touching the deployed database:** owner approval, a verified backup of the
target, and the remaining gates in [§8](#8-what-is-still-unproven).**

This document is the authoritative answer to three questions that blocked the SaaS release:

1. Why does the deployed Supabase database have no `_prisma_migrations` ledger, and what does that
   mean for deployment?
2. Which version of the historical `20261008123000_multi_tenant_saas_init` migration is real, given
   that it was rewritten after the fact?
3. What happened to the two "proposed" migrations that `schema.prisma`, the test suite and the docs
   all referenced but that were never committed?

It records the decisions, the reasoning, the runbook, and the evidence produced by the rehearsal in
[docs/saas-migration-rehearsal.md](saas-migration-rehearsal.md).

---

## 1. What was actually wrong

### 1.1 The deployed database has no Prisma ledger

Verified by the project owner through the Supabase SQL editor (recorded in
[saas-migration-rehearsal.md](saas-migration-rehearsal.md)):

```
server_version             = 17.11
current_database()         = postgres
public._prisma_migrations  = does not exist
```

A `pg_dump` TOC of the same database also lists no `_prisma_migrations`. The schema was therefore
created out of band — most plausibly with `prisma db push`, which writes no history.

`prisma migrate deploy` on such a database is not "safe but noisy": it starts at migration 1,
executes `CREATE TABLE "User" ...` against a populated schema, fails, and records a **failed**
migration row. Every later deploy then reports the history as broken. Nothing about the database
before that first attempt tells Prisma which of the 19 migrations are already represented.

Baseline-by-guess is equally wrong in the other direction: writing "applied" rows for migrations
whose effects are missing makes the ledger lie, and the next `migrate deploy` will never apply them.

### 1.2 The historical tenancy migration was rewritten after it was authored

`20261008123000_multi_tenant_saas_init` was originally a full-snapshot migration: it began with
`CREATE TYPE "PlatformRole"`, `CREATE TYPE "RoomStatus"`, `CREATE TABLE "Hotel"`, and then 17 more
`CREATE TABLE` statements for `User`, `Room`, `Reservation`, `Order` and friends. That cannot
possibly run after migrations 1–12, which already created those tables and enums. As committed, the
migration chain was broken at position 13.

The previous session rewrote it into what it must be — a *conversion* migration that adds
`Hotel`/`HotelMembership`, backfills 19 `hotelId` columns to `legacy-hotel`, maps legacy roles,
transforms notification/audit columns and replaces the single-tenant indexes and foreign keys.
That rewrite is why the file shows as "modified" in older notes.

Two questions follow, and both have a clean answer:

* **Does the rewrite violate a recorded checksum?** No. A checksum can only conflict with a ledger
  row, and no ledger exists — on the deployed target or anywhere else. There is no history to
  rewrite, only a history to *establish*.
* **Which version is correct going forward?** The conversion form. It is the only form that can
  follow migrations 1–12, it applies cleanly to an empty database and to a populated legacy
  database (rehearsed), and it is the form referenced by every schema decision made since.

The file is now **frozen**. `prisma/migration-release-manifest.json` pins its SHA-256, and
`scripts/migrate-adopt.mjs` refuses to baseline any migration whose bytes no longer match, so an
accidental future edit is caught before it can corrupt a ledger.

### 1.3 The two "proposed" migrations were never committed

`schema.prisma`, `__tests__/schema/*`, and `docs/pos-room-charge-idempotency.md` all referenced:

* `20261029120000_add_pos_charge_to_room_idempotency`
* `20261029130000_add_tenant_composite_join_fks`

Neither directory existed in the repository. The schema was ahead of the migration chain, so:

* `__tests__/schema/migrations.test.ts` compared `schema.prisma` against the migrated database and
  reported 11 mismatches (`Order.idempotency*`, `ReservationRoom.hotelId`, `Recipe.hotelId`,
  `RecipeIngredient.hotelId`, `OrderItem.hotelId`, plus four indexes);
* the two join-key migration tests and three cross-tenant integrity tests failed — 8 failing tests
  in total, with no way to make them pass from the committed chain.

They are now committed as real, released migrations (§3).

---

## 2. Decisions

**D1 — The release chain is the 19 committed migrations, in timestamp order, and it is frozen.**
Any further schema change is a new migration with a new timestamp. Historical files are never
edited again; the release manifest makes that mechanically checkable.

**D2 — The rewritten `20261008123000_multi_tenant_saas_init` is canonical.** Rationale in §1.2.

**D3 — The two proposals are promoted, and hardened beyond the original drafts.**
Both are fail-closed, re-runnable and self-documenting:

* `20261029120000_add_pos_charge_to_room_idempotency` adds nullable `idempotencyOperation`,
  `idempotencyKey` and `requestFingerprint` to `Order`, a unique
  `(hotelId, idempotencyOperation, idempotencyKey)` index, and a
  `Order_idempotency_triple_check` constraint. The CHECK was the open question in the previous
  review — it is now enforced: the API always writes the triple together, and a partially
  populated tuple would silently weaken the unique guard because PostgreSQL treats NULLs as
  distinct. Operation values must be non-empty when present.
* `20261029130000_add_tenant_composite_join_fks` copies `hotelId` from the authoritative parent
  into `ReservationRoom`, `Recipe`, `RecipeIngredient` and `OrderItem`, then replaces the
  single-column foreign keys with composite `(id, hotelId)` keys. Every data precondition runs
  **before** the first DDL statement and raises on cross-tenant or orphaned rows, so a conflicted
  database is left byte-identical instead of being silently "repaired".
* Both files use `IF NOT EXISTS` / `DROP CONSTRAINT IF EXISTS` and idempotent backfills, so an
  interrupted deploy can be re-run instead of needing manual repair. The rehearsal proves this
  (`partial-rerun` scenario), which matters because the atomicity of Prisma's per-migration
  transaction cannot be demonstrated in this environment (§7).
* Four child-side indexes were added that the original drafts lacked:
  `ReservationRoom(roomId, hotelId)`, `RecipeIngredient(inventoryItemId, hotelId)`,
  `OrderItem(menuItemId, hotelId)` and `ReservationRoom(hotelId)`. Without a leading-column index,
  every parent `Room`/`InventoryItem`/`Reservation` delete or update has to scan the join table.
  `schema.prisma` declares them so the schema and the database stay identical.

**D4 — A checked-in release manifest pins every migration's SHA-256.**
`prisma/migration-release-manifest.json` is generated by
`node scripts/migration-ledger.mjs manifest --write` and verified by `npm run migration:manifest`
(also asserted by a unit test). Adoption and rehearsal both refuse to proceed on a mismatch.

**D5 — A ledgerless database is adopted, never replayed.**
`scripts/migrate-adopt.mjs` fingerprints the live schema against explicit checkpoints, requires
exactly one match, validates any existing ledger, and only then records the migrations whose
effects are demonstrably present. On a machine with the pinned Prisma engines the operator runs the
printed `prisma migrate resolve --applied` commands (the officially supported equivalent); the tool
can also write byte-compatible ledger rows itself for rehearsal and recovery.

**D6 — Unknown schema states are a hard stop.** No prefix inference, no "close enough", no
`migrate resolve` for anything the checkpoints do not prove.

**D7 — Deployment is `migrate deploy` only.** No `migrate dev`, `db push`, `migrate reset`, seed or
cleanup script against the deployed database. `prisma migrate dev` remains a local-development
convenience (`npm run prisma:migrate`) and is explicitly not part of this runbook.

---

## 3. Recognised schema checkpoints

A checkpoint is a schema end-state expressed only in durable features (tables, columns, indexes,
enum labels, constraint names) — never in row counts, which operators legitimately change.
`scripts/migration-ledger.mjs` holds them; `npm run migration:checkpoints` prints them.

| Checkpoint | Meaning | Migrations treated as applied | Pending |
|---|---|---|---|
| `empty` | No application tables | — | 19 |
| `legacy_single_hotel_through_11` | Original single-hotel schema, tenancy conversion never ran | 1–11 | 8 |
| `saas_through_081` | Tenancy conversion applied, SaaS follow-ups missing | 1–13 | 6 |
| `saas_through_14` | + payment idempotency key | 1–14 | 5 |
| `saas_through_15` | + payment request fingerprint | 1–15 | 4 |
| `saas_through_16` | + SaaS subscriptions | 1–16 | 3 |
| `saas_through_17` | + membership department | 1–17 | 2 |
| `saas_through_18` | + charge-to-room idempotency, join keys missing | 1–18 | 1 |
| `saas_current` | Everything applied | 1–19 | 0 |

Every intermediate state between migrations 13 and 19 is recognised individually, because a
`prisma db push` could have landed at any point in that range. States 1–10 and 12 are deliberately
*not* recognised (see the notes) — adoption refuses to guess there.

Notes:

* **The legacy checkpoint stops at migration 11 on purpose.** Migration 12 only inserts three Half
  Board tariff rows (`ON CONFLICT DO NOTHING`) and those rows are legitimate for an operator to
  delete, so row presence can never be used as schema evidence. Migration 12 is therefore always
  deferred to the deploy step instead of being baselined; re-running it is harmless and idempotent.
* Migration 5 (`add_room_is_twin`) is deliberately *forbidden* rather than required: migration 10
  drops that column, so it cannot be used as evidence of progress. A database at states 5–9 is
  therefore unrecognised rather than misclassified.
* Migration 8's dashboard indexes are dropped by migration 081, so the legacy checkpoint is
  recognised through columns and enum labels instead of those index names.
* If a target matches no checkpoint, or more than one, the tool exits non-zero and prints the
  feature map. Investigate with `prisma migrate diff` on that same database; do not baseline.
* The `checkpoint-ladder` rehearsal scenario applies the migrations one at a time and asserts the
  classification of all 20 states (empty plus each prefix), so the table above is tested, not
  asserted.

---

## 4. Runbook: deploying to the ledgerless target

The target is expected to be `saas_through_17` (or `saas_current` if the schema was pushed after
the two proposals were written; `saas_through_16` is also plausible if the last push predates the
membership-department migration). All are handled by the same steps — only the baseline list
changes.

### 4.1 Pre-flight (owner, read-only)

1. Take a fresh backup and verify it restores into a disposable local PostgreSQL 17 database.
   Record the restore check counts. Do not proceed without a restore that has been *verified*, not
   merely taken.
2. Confirm the target history one more time:
   ```sql
   SELECT to_regclass('public._prisma_migrations') AS ledger;
   ```
   `NULL` means adoption is required. If it suddenly returns a table, stop — someone has deployed
   migrations since this document was written, and the ledger must be reviewed before anything else.
3. Confirm the target build is the one this document applies to:
   ```bash
   npm run migration:manifest      # release manifest must match the files
   npm run test:run                # schema + adoption logic
   ```

### 4.2 Dry run (no writes)

```bash
SAAS_ENVIRONMENT=saas \
SAAS_DATABASE_IDENTIFIER=<project-ref-or-db-name> \
DIRECT_URL='postgresql://...:5432/postgres' \
npm run migration:adopt
```

The tool prints the connected database, server version, whether a ledger exists, the detected
checkpoint, the exact baseline list, the pending list, and problems. It performs no writes. Expect:

* `Detected checkpoint : saas_through_17`
* `To be baselined : 17`, `Pending deploy : 2`

### 4.3 Approval

Record in the change ticket: the detected checkpoint, the baseline and pending lists, the release
manifest commit, and the verified-backup identifier. Two people: operator and approver.

### 4.4 Baseline (writes ledger rows only)

**Preferred path — official Prisma tooling.** On a machine where `prisma` can fetch or has pinned
engines, run the printed commands verbatim:

```bash
npx prisma migrate resolve --applied 20260915161717_init
# ... one line per baselined migration ...
npx prisma migrate resolve --applied 20261027100000_add_membership_department
```

**Equivalent path — no Prisma engines available.** The same rows, written in a single transaction
behind an in-transaction checkpoint re-verification:

```bash
SAAS_ENVIRONMENT=saas SAAS_DATABASE_IDENTIFIER=<id> DIRECT_URL='postgresql://...' \
  node scripts/migrate-adopt.mjs --execute \
    --approved-by "<operator>" --confirm-database <database-name>
```

Both paths produce the same `_prisma_migrations` rows (Prisma's table definition, SHA-256 checksum,
`applied_steps_count = 1`, `finished_at = now()`), with a `logs` entry recording the checkpoint and
approver.

### 4.5 Deploy the pending migrations

```bash
npx prisma migrate deploy        # or: npm run prisma:deploy
```

Expected outcome: migrations 18 and 19 apply; nothing else runs. Migration 19 may refuse:

* `Tenant-integrity precheck failed: ReservationRoom ...` → a link crosses hotels;
* `... RecipeIngredient ...` → a recipe ingredient points at another hotel's stock;
* `... OrderItem ...` → an order line references a missing or foreign menu item.

That failure is the design. The migration rolls back, the database is unchanged, and the pending
row is not recorded. Resolve the specific rows with the data owner, then re-run `migrate deploy`.
Both new migrations are idempotent, so a re-run after an interrupted attempt converges on the same
schema. If Prisma reports the migration as failed (it records a failure row on a non-transactional
failure), mark it with `prisma migrate resolve --rolled-back <name>` and re-deploy — never edit the
file.

### 4.6 Verify

```bash
npx prisma migrate status        # "Database schema is up to date!"
npm run migration:adopt          # expect saas_current, 0 baseline, 0 pending
```

Then confirm the new invariants directly:

```sql
SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NULL;              -- 0
SELECT count(*) FROM "ReservationRoom" WHERE "hotelId" IS NULL;                     -- 0
SELECT count(*) FROM "Order" WHERE ("idempotencyOperation" IS NULL)
                             <> ("idempotencyKey" IS NULL);                          -- 0
```

And smoke-test the application: POS charge-to-room (including a deliberate retry with the same
key), reservations with multiple rooms, recipe editing and stock deduction.

### 4.7 If something is wrong

There is no down-migration and none should be improvised. Recovery is a verified restore of the
pre-deploy backup, followed by investigation. The baseline step only inserts ledger rows, so rolling
back the *baseline* alone is a matter of deleting those rows — but do not do that piecemeal; restore
or fix forward.

---

## 5. Deployment compatibility window

Migrations 18 and 19 add `NOT NULL` tenant columns to four join tables. Application writes must be
quiesced (or already be the version that supplies `hotelId`) across the deploy:

| Window | Old app + old schema | Old app + new schema | New app + new schema |
|---|---|---|---|
| Paused writes (recommended) | — | — | — |
| Deploying during live traffic | OK | **inserts fail** (no `hotelId`) | OK |

For this single-tenant-per-deployment hotel system, a short maintenance window outside service hours
is the pragmatic choice: announce it, pause POS and front-desk writes, run §4.4–4.5, verify, resume.

A true zero-downtime variant would split migration 19 into three deployments (add nullable columns →
deploy writing code → backfill and `SET NOT NULL` + FKs). That is a new migration series, not an
edit to this one; treat it as a follow-up if the maintenance window ever becomes unacceptable.

---

## 6. Rehearsal

`scripts/migration-rehearsal.mjs` builds every scenario in disposable loopback databases, runs the
real `psql` client against a real PostgreSQL server, and drops what it created:

```bash
REHEARSAL_BASE_URL=postgresql://postgres@127.0.0.1:55432 \
PSQL_BIN=/path/to/pg17/bin/psql \
npm run migration:rehearse
```

| Scenario | Proves |
|---|---|
| `fresh-chain` | All 19 migrations apply to an empty database and match `saas_current`; a dry run writes nothing; baselining records all 19 with correct checksums; a second run is a no-op |
| `legacy-upgrade` | A populated single-hotel database (12 migrations + fixture) converts without losing ownership: roles, departments, meal plans, category merge, join-row tenancy, notification/audit transformation |
| `checkpoint-ladder` | Every one of the 20 intermediate schema states is classified exactly as this table says, and unrecognised states stay unrecognised |
| `unmanaged-saas` | The expected deployed shape (`saas_through_17`, no ledger) baselines 17 and deploys exactly 2 |
| `unmanaged-current` | A fully current schema with no ledger records history and deploys nothing |
| `conflict-guard` | A cross-tenant join row aborts migration 19 with no schema change, records 18 but not 19, leaves the conflicting row intact, and converges after repair |
| `empty-adopt` | An empty database is brought up entirely through the ledger path |
| `partial-rerun` | Re-applying migrations 18 and 19 after an interrupted deploy is a no-op |

Run result: 8 scenarios, 83 assertions, no failures (PostgreSQL 17.11).

Results, versions and the exact commands are recorded in
[saas-migration-rehearsal.md](saas-migration-rehearsal.md).

---

## 7. Engine verification (real Prisma migration engine)

§6 proves the SQL, the ledger shape, the ordering and the checkpoints with `psql`. It cannot prove what
Prisma's own runner does with the same files: which ledger rows it writes, which checksum it records,
what it does with a baseline, and what a failed migration leaves behind.

`scripts/prisma-engine-verify.mjs` closes that gap. It drives the command implementations behind
`prisma migrate deploy`, `prisma migrate resolve --applied`, `migrate resolve --rolled-back` and
`migrate status` (`@prisma/migrate`) against the official Schema Engine compiled to WebAssembly, and
asserts on the resulting ledger, schema fingerprint and adoption-tool interop.

### 7.1 Which engine, and why it is not 5.17.0

The application stays pinned to `prisma@5.17.0`; the verification tool stack is separate. That
version distinction is deliberate and has a hard cause:

| Attempt to get a 5.17.0 engine | Result |
|---|---|
| `binaries.prisma.sh` (the only official distribution host) | unreachable from this environment (TLS reset); `@prisma/engines@5.17.0` on npm is 24 KB of postinstall scripts, no binaries |
| `@prisma/schema-engine-wasm` 5.x | does not exist — the package starts at 6.10.0, so a 5.17 CLI has no WebAssembly engine to load |
| any bundled engine in the 5.x npm tarballs (`prisma`, `@prisma/migrate`, `@prisma/client`) | none contain `schema-engine`/`libquery_engine` binaries |
| PyPI / GitHub mirrors of the 5.17.0 artifact | no package or mirror publishes it under a reachable host |

Prisma 6.19.0 ships the same Rust schema engine inside the npm package
(`prisma/build/schema_engine_bg.wasm`, SHA-256 `febbb50ef48a4e577b6d3652841166fac47eb129e63f727f9c9401f3d4b84bf1`,
byte-identical to `@prisma/schema-engine-wasm@6.19.0-26.2ba551f…`), and `@prisma/migrate@6.19.0` issues
the same engine commands as 5.17.0 (`applyMigrations`, `markMigrationApplied`,
`markMigrationRolledBack`, `diagnoseMigrationHistory`). So the migration files, the ledger rows, the
SHA-256 checksums, the ordering, the baseline semantics and the drift detection are exercised by real
Prisma code — one engine generation removed from the pinned release.

**The 5.17.0 binary itself is still unexercised.** When it is available, the remaining gap closes with:

```bash
PRISMA_SCHEMA_ENGINE_BINARY=/path/to/schema-engine-debian-openssl-3.0.x \
PRISMA_QUERY_ENGINE_LIBRARY=/path/to/libquery_engine-debian-openssl-3.0.x.so.node \
npx prisma migrate deploy --schema prisma/schema.prisma   # against a restored copy, never the target first
```

### 7.1.1 What the official distribution serves (measured, not remembered)

The 5.17.0 engine is addressed by commit, not by version. The commit is already recorded in
`package-lock.json` for `@prisma/engines@5.17.0`: **`393aa359c9ad4a4bb28630fb5613f9c281cde053`**.
`@prisma/fetch-engine@5.17.0` builds every download URL from that commit:

```
https://binaries.prisma.sh/all_commits/393aa359c9ad4a4bb28630fb5613f9c281cde053/debian-openssl-3.0.x/schema-engine.gz.sha256
https://binaries.prisma.sh/all_commits/393aa359c9ad4a4bb28630fb5613f9c281cde053/debian-openssl-3.0.x/schema-engine.sha256
https://binaries.prisma.sh/all_commits/393aa359c9ad4a4bb28630fb5613f9c281cde053/debian-openssl-3.0.x/libquery_engine.so.node.gz.sha256
https://binaries.prisma.sh/all_commits/393aa359c9ad4a4bb28630fb5613f9c281cde053/debian-openssl-3.0.x/libquery_engine.so.node.sha256
```

That list is not inferred. `PRISMA_ENGINES_MIRROR` was pointed at a local HTTP probe and
`npx prisma -v` (5.17.0) was run against it; the probe logged exactly the four requests above and the
client aborted on the first 404. The client therefore also accepts a mirror or an explicit binary:

| Variable | Effect |
|---|---|
| `PRISMA_ENGINES_MIRROR` / `PRISMA_BINARIES_MIRROR` | replace `https://binaries.prisma.sh` as the download root |
| `PRISMA_SCHEMA_ENGINE_BINARY` | use this `schema-engine` file instead of downloading one |
| `PRISMA_QUERY_ENGINE_LIBRARY` | use this `libquery_engine.so.node` file instead of downloading one |

Checksums for the `debian-openssl-3.0.x` artifacts (captured from the `.sha256` sidecars during the
same probe, so they can be compared without trusting a download):

| Artifact | SHA-256 |
|---|---|
| `schema-engine.gz` | `98ad433fd64da2ea1eb6d565553a9a4339ecf30f1c211b28b69690f591269a41` |
| `schema-engine` (gunzipped) | `0a52943c68c41f28d00359001b6f271df7c0ad9a68aa32be2570f80594db956e` |
| `libquery_engine.so.node.gz` | `125d75739bd7fcdb8eabb5428355b5be00f540043e6bc1f5b30268947afab1bd` |
| `libquery_engine.so.node` (gunzipped) | not captured — the probe answered with 404 before the plain digest was read |

Nothing in this environment can fetch those files: `binaries.prisma.sh` resets the TLS connection and
every GitHub host is unreachable; only `registry.npmjs.org` and `pypi.org` respond. No npm or PyPI
package ships the 5.17.0 native engines (checked: `prisma`, `@prisma/engines`, `@prisma/migrate`,
`@prisma/client`, `@prisma/schema-engine-wasm`, `prisma-engines`, `prisma-binaries`, plus three
third-party downloaders), and the local Prisma cache contains only WASM engines. The gap is an
egress restriction, not a missing procedure.

### 7.1.2 Recovering the engine where egress permits

Run this on a machine that can reach `binaries.prisma.sh` (or the mirror the operator uses), and do
not substitute a build from another commit:

```bash
COMMIT=393aa359c9ad4a4bb28630fb5613f9c281cde053     # @prisma/engines@5.17.0, from package-lock.json
PLATFORM=debian-openssl-3.0.x                        # must match the deployment host
BASE="https://binaries.prisma.sh/all_commits/$COMMIT/$PLATFORM"
OUT="$HOME/.cache/prisma-engines/5.17.0/$PLATFORM"; mkdir -p "$OUT"

for f in schema-engine libquery_engine.so.node; do
  curl -fsSLO --output-dir "$OUT" "$BASE/$f.gz"
  curl -fsSL "$BASE/$f.gz.sha256"                    # must equal the table in §7.1.1
  gunzip -c "$OUT/$f.gz" > "$OUT/$f" && chmod +x "$OUT/$f"
  sha256sum "$OUT/$f"                                # schema-engine: 0a52943c…956e
done

"$OUT/schema-engine" --version        # expect: schema-engine-cli 393aa359c9ad4a4bb28630fb5613f9c281cde053
```

The commit printed by `--version` is the check that matters: a binary from a different commit may
still say `5.17.0`-ish in a filename, but the commit decides which SQL and ledger behaviour it has.

### 7.1.3 Verifying the pinned engine against a restored disposable database

The engine is only proven once it has run the migration set against a **restored copy**, never the
target. With `PRISMA_SCHEMA_ENGINE_BINARY` and `PRISMA_QUERY_ENGINE_LIBRARY` exported (§7.1.2) and a
scratch server:

```bash
# 1. restore the archive into a scratch database, digest-verified, and keep it
npm run migration:restore-rehearsal -- \
  --dump hotel-management-saas-20261028-140823.dump \
  --expect-sha256 F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7 \
  --database hms_engine_check --keep
# 2. read the restored copy before deploying anything (read-only)
SAAS_ENVIRONMENT=saas SAAS_DATABASE_IDENTIFIER=hms_engine_check \
  DIRECT_URL='postgresql://…/hms_engine_check' npm run migration:adopt
# 3. run §4.4–4.6 against that copy with the pinned engine in the environment
npx prisma -v                                        # 5.17.0, commit 393aa359…
npx prisma migrate status --schema prisma/schema.prisma
```

Acceptance criteria for closing gap 1 in §8, recorded verbatim in
[saas-migration-rehearsal.md §9](saas-migration-rehearsal.md):

1. `prisma -v` reports `5.17.0` and engine commit `393aa359…`.
2. `migrate status` on the restored copy reports the full 19-migration history (after adoption) and
   no failed migrations; `migrate deploy` applies exactly the pending migrations.
3. Every ledger checksum equals `prisma/migration-release-manifest.json`.
4. `npm run migration:target-check` on the restored copy reports the checkpoint the adoption run
   expected, with `readOnly: on`.

Until all four are recorded, §8 item 1 stands.

### 7.2 Setting up the verification environment

The tool stack is installed outside the repository so the pinned `prisma@5.17.0` dependency and
`package-lock.json` stay untouched:

```bash
mkdir -p /tmp/prisma-engine-verify && cd /tmp/prisma-engine-verify
npm init -y
npm install --ignore-scripts prisma@6.19.0 @prisma/migrate@6.19.0 @prisma/internals@6.19.0 \
  @prisma/adapter-pg@7.10.1 @prisma/driver-adapter-utils@6.19.0 pg@8.13.1
```

Then, against a disposable PostgreSQL server:

```bash
VERIFY_BASE_URL=postgresql://postgres@127.0.0.1:55432 \
VERIFY_MODULES=/tmp/prisma-engine-verify/node_modules \
VERIFY_PSQL=/path/to/pg17/bin/psql \
npm run migration:verify-engine            # or: node scripts/prisma-engine-verify.mjs all
```

The harness creates and drops its own `prisma_engine_verify_*` databases (`VERIFY_KEEP=1` keeps them).

### 7.3 Two deviations, both deliberate and documented

| Deviation | Why | Effect on the evidence |
|---|---|---|
| `@prisma/adapter-pg@7.10.1` instead of `6.19.x` | 6.19.x throws `Unsupported column type 'name'` (OID 19) while the engine initialises the ledger, so no migration could run at all. 7.10.1 adds the missing OID mapping; the driver-adapter protocol is unchanged | none for the ledger; it only makes PostgreSQL's `information_schema` queries readable |
| `executeScript` sends the whole migration script as one multi-statement query | `adapter-pg` implements `executeScript` as `script.split(";")`, which corrupts any migration whose comments or literals contain a semicolon (`20261001120000_add_wastage_accountability` does). The engine hands the adapter the complete script in one call, and the native engine's `raw_cmd` also sends it in one call | the engine executes the migration file bytes verbatim — asserted per file in the `fresh` scenario |

`@prisma/internals` also expects the WASM engine at `@prisma/internals/build/schema_engine_bg.wasm`,
which the published tarball omits; the harness copies the byte-identical file into place and refuses
to run if the copies disagree.

### 7.4 Results (PostgreSQL 17.11, `@prisma/migrate` 6.19.0, WASM schema engine)

| Scenario | Proves | Assertions |
|---|---|---|
| `fresh` | The engine applies all 19 files verbatim, in directory order, and writes 19 finished ledger rows whose checksums equal `prisma/migration-release-manifest.json`; `applied_steps_count` is recorded; the fingerprint is `saas_current`; **the ledger DDL the engine creates is column-for-column identical to `PRISMA_LEDGER_DDL`** | 9 |
| `legacy` | A single-hotel database (migrations 1-11, no ledger) is adopted with `markMigrationApplied` (11 baselines, `applied_steps_count = 0`), then `applyMigrations` deploys exactly the 8 pending files; a second deploy is a no-op | 7 |
| `saas18` | A database that predates migrations 18-19 baselines 18 and deploys exactly one | 2 |
| `interop` | A ledger written by `scripts/migrate-adopt.mjs` (not by the engine) is accepted by the engine: it finds nothing to deploy, reports `hasMigrationsTable`, no edited and no failed migrations, and the checksums match the manifest | 8 |
| `conflict` | A tampered checksum is detected twice: the engine lists the migration in `editedMigrationNames`, and `migrate-adopt` exits 1 naming the file | 3 |
| `failure` | Migration 19's own tenant precheck aborts the deploy; the last good migration stays recorded, the failed one is recorded with `finished_at IS NULL` and the engine error in `logs`, **no partial schema change survives**, and `markMigrationRolledBack` + redeploy converges to `saas_current` | 8 |

Run result: **6 scenarios, 37 assertions, no failures** (~50 s). The `failure` scenario also documents
Prisma's real recovery path, which §4.7 describes: a failed migration row blocks the next deploy
until it is marked rolled back.

Two operational facts came out of the run:

* Each migration script is executed as a **single multi-statement statement** with no explicit
  `BEGIN`/`COMMIT`; PostgreSQL wraps such a message in an implicit transaction, which is why the
  aborted migration 19 left the previously dropped constraints in place.
* With a driver adapter, the engine reports a failed statement as `external connector error` with an
  error id and stores the same text in `_prisma_migrations.logs`; the human-readable PostgreSQL
  message (`Tenant-integrity precheck failed: ReservationRoom …`) is only visible on the adapter side.
  Do not expect the ledger to explain *why* in prose.

---

## 8. What is still unproven

Be explicit about this; do not let the rehearsal or engine evidence imply more than it shows.

1. **The pinned Prisma 5.17.0 engine has not run.** §7 exercises the real engine, but from the 6.19.0
   tool stack, because the 5.17.0 binaries are only published to a host this environment cannot reach
   and Prisma published no 5.x WebAssembly schema engine. The command set, the ledger format and the
   checksum algorithm are unchanged between those releases, and the 5.17.0 engine is still the one
   production will run. §7.1.1–7.1.3 record the exact artifacts, checksums and recovery commands, so
   closing this is a matter of running them where `binaries.prisma.sh` is reachable and recording the
   four acceptance results from §7.1.3.
2. **The deployed database's checkpoint is inferred, not observed.** No connection to the Supabase
   target was made in this work — no `DIRECT_URL` or credentials were available, and connecting was
   out of scope. `npm run migration:target-check` settles it read-only: it has no write path, it sets
   `default_transaction_read_only = on` on the session and refuses to report if the server did not
   apply it, and it prints the checkpoint, the ledger-versus-manifest comparison and an md5
   fingerprint of the public schema. §4.2 (`migration:adopt`, a dry run) answers the same question
   with the adoption plan attached.
3. **The production archive has not been restored.** The restoration *procedure* is now a single
   command, `npm run migration:restore-rehearsal`, which verifies the archive's SHA-256 **before**
   contacting the server, creates its own scratch database, restores, fingerprints the result
   read-only and drops the database again. It is proven end to end on an archive built here (see
   [saas-migration-rehearsal.md §9](saas-migration-rehearsal.md)), but
   `hotel-management-saas-20261028-140823.dump` (384 096 bytes, SHA-256 `F81566E9…24A7`) is not
   present in this workspace, so *that* archive has not been restored, counted or rehearsed. Run it
   before §4.4:
   ```bash
   npm run migration:restore-rehearsal -- --dump hotel-management-saas-20261028-140823.dump \
     --expect-sha256 F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7 \
     --base-url "postgresql://…/postgres"
   ```
4. **Per-migration atomicity holds only as far as PostgreSQL's implicit transaction.** §7 shows the
   engine sends each migration as one multi-statement message (no explicit `BEGIN`/`COMMIT`), so a
   failure rolls the whole file back — demonstrated. That is a property of the simple-query protocol,
   not of Prisma, and it does not cover operator interruption of the connection mid-file. The
   migrations stay written to be re-runnable, and `partial-rerun` checks that property.
5. **The Axis-specific Half Board tariff rows** inserted by migration 12 remain a product decision,
   not a technical one; they are harmless for other hotels but should be confirmed by the owner.

---

## 9. Files

| Path | Role |
|---|---|
| `prisma/migrations/*/migration.sql` | The 19 released migrations (frozen) |
| `prisma/migration-release-manifest.json` | Reviewed SHA-256 of every migration |
| `prisma/schema.prisma` | Target schema; must equal the migrated database |
| `scripts/migration-ledger.mjs` | Checkpoints, feature probes, manifest, adoption planner (pure) |
| `scripts/migrate-adopt.mjs` | Ledgerless-target adoption CLI (dry-run by default) |
| `scripts/migration-rehearsal.mjs` | Disposable PostgreSQL rehearsal driver |
| `scripts/prisma-engine-verify.mjs` | Drives the real Prisma migration engine against disposable databases |
| `scripts/backup-db.mjs` / `scripts/restore-db.mjs` | Verified custom-format backup and restore into a scratch database |
| `scripts/restore-rehearsal.mjs` | Digest-verified restore into a self-created, self-dropped scratch database, with a read-only fingerprint of the result |
| `scripts/target-check.mjs` | Read-only checkpoint, ledger-vs-manifest and schema-fingerprint check against a configured target |
| `scripts/psql.mjs` | Explicit `psql` wrapper used by both tools |
| `__tests__/schema/migration-adoption.test.ts` | Unit tests for checkpoints, planning and manifest |
| `__tests__/schema/migrations.test.ts` | Chain, schema parity, legacy conversion, idempotency guards |
| `__tests__/scripts/migration-evidence-tools.test.ts` | CLI-level refusals for `target-check` and `restore-rehearsal` (no database needed) |
