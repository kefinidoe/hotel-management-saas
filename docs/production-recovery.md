# Production recovery and operations runbook

This document is the operator's path back to a working system after a bad deploy, a bad delete,
or a lost database. It describes what exists in this repository, what it does **not** cover, and the
commands to run. Every command below was exercised against a disposable PostgreSQL 17.11 instance in
round 12 — the evidence for each one is recorded in §17 — unless the row says otherwise (§14 lists the
gaps).

**What round 12 changed here:** the command names, flags and expected outputs in §5–§8 were re-run
against a live server rather than carried over from reading the scripts. Two assumptions did not
survive contact with the implementation and are corrected below: the ledger-adoption summary
wording (§8), and the claim that `npm run build` needs nothing beyond `npm ci` (§7 step 3, §14).

> **Application data only.** Everything here recovers the application's **PostgreSQL data** — the
> 28 tables this repository owns. It does **not** recover a Supabase platform: `auth.users`,
> storage objects, realtime subscriptions, Vault secrets, edge functions, or the platform's own
> configuration. §9 is the honest boundary.

---

## 1. System architecture

| Layer | What it is |
|---|---|
| Frontend / API | Next.js (App Router) — pages under `app/`, 57 route handlers under `app/api/` |
| Auth | NextAuth credentials provider; bcrypt hashes in `User.passwordHash`; session JWT carries `id`; active hotel is a separate `active_hotel_id` cookie validated server-side on every request |
| Tenancy | `Hotel` is the tenant root. Every tenant-scoped row carries `hotelId`; access is resolved through `HotelMembership` (`ACTIVE`) in `lib/tenant-context.ts` and authorised in `lib/authz.ts` / `lib/permissions.ts` |
| Data | PostgreSQL 17 (Supabase in production). Prisma 5.17.0; 19 frozen migrations under `prisma/migrations/`, checksum-pinned in `prisma/migration-release-manifest.json` |
| Billing | `Subscription` per hotel, plan bands in `lib/plans.ts`, enforcement in `lib/entitlements.ts` |
| Backups | `scripts/backup-db.mjs` (custom-format `pg_dump`, digest-checked, retention) |

## 2. Database architecture

28 application tables in the `public` schema, all keyed by `String @id @default(uuid())` (no
sequences). Tenant-scoped tables carry `hotelId` with a foreign key to `Hotel` and an index that
covers `hotelId`. Child tables that must share their parent's hotel also carry `hotelId` and use
composite foreign keys (for example `ReservationRoom(hotelId, reservationId)` →
`Reservation(hotelId, id)`), so a cross-hotel row is rejected by the database, not only by
application code. `scripts/db-integrity.mjs` verifies all of this after a restore (§7 step 6).

Two tables are deliberately different: `FolioItem` has no `hotelId` (it is scoped through its
`Folio`), and `AuditLog.hotelId` is nullable because platform-level events have no hotel.

## 3. Environment and configuration

Copy `.env.example` and fill it in. **Never commit `.env`.** Required variables:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Pooled application connection (Supabase transaction pooler, port 6543) |
| `DIRECT_URL` | Direct connection (port 5432) — used by backups, restores and migrations |
| `SAAS_ENVIRONMENT` | Must be exactly `saas`; the safety guard aborts on anything else |
| `SAAS_DATABASE_IDENTIFIER` | Must be the Supabase **project reference** (20 lowercase characters) — a database name is not accepted for a remote target, because every Supabase project's database is called `postgres`; every guard, backup and restore checks it |
| `NEXTAUTH_SECRET` | Session signing secret (`openssl rand -base64 32`) |
| `NEXTAUTH_URL` | Public base URL of the deployment |

Optional: `PSQL_BIN` / `PG_RESTORE_BIN` (absolute paths to the client tools), `SEED_ALLOW_DESTRUCTIVE_CLEANUP`.

Client tools: `psql`, `pg_dump` and `pg_restore` **17.x** must be on `PATH` (or given explicitly) —
they are not bundled. Without them, backup, restore and rehearsal stop with a clear message rather
than falling back to a different client.

## 4. Creating a backup

```bash
SAAS_ENVIRONMENT=saas SAAS_DATABASE_IDENTIFIER=<project-ref> \
  npm run backup -- --out /var/backups/hotel --keep 30
```

`scripts/backup-db.mjs`:

1. refuses a target that does not match `SAAS_DATABASE_IDENTIFIER`;
2. writes a custom-format archive (`pg_dump -Fc`) to `--out` (default `backups/`);
3. **re-reads the archive with `pg_restore --list`** — a non-zero exit means the backup is not
   trusted, whatever `pg_dump` returned;
4. prints the path, size and SHA-256, and prunes older copies beyond `--keep`.

`backups/`, `*.dump`, `*.dump.gz` and `*.backup*` are git-ignored: a database archive must never be
committed.

Nightly scheduling on Windows: `scripts/backup-nightly.cmd`. On Linux, a cron entry or systemd timer
calling the same command is sufficient.

## 5. Verifying a backup's integrity

Record the digest at creation time, in a place that outlives the machine:

```bash
sha256sum /var/backups/hotel/hms-2026-10-30T12-00-00.dump
```

Then before any restore:

```bash
# 1. Digest matches the recorded value?
node scripts/restore-rehearsal.mjs --dump <archive> \
  --expect-sha256 <recorded-digest> --toc          # analysis only: no database created

# 2. Full rehearsal: restore into a scratch database, fingerprint it, drop it
node scripts/restore-rehearsal.mjs --dump <archive> \
  --expect-sha256 <recorded-digest> \
  --base-url "postgresql://postgres@127.0.0.1:5432" \
  --expect-checkpoint saas_current --json > /tmp/restore-evidence.json
```

The rehearsal verifies the digest **before** contacting a server, restores with
`--single-transaction --exit-on-error`, checks that every table in the archive exists afterwards,
reports per-table row counts, confirms the schema matches an approved checkpoint, and drops the
scratch database on every exit path. `--toc` proves the archive can be read and describes its
contents without touching a database.

Observed output on a 116 KB application archive (round 12, PostgreSQL 17.11):

```
--toc            → Schemas: public · Application tables: 28 in public · Looks like Supabase: no
                   Recommended profile: plain
--json           → ok: true · scratch { database: "rehearsal_restore_20261030_164405",
                   created: true, kept: false } · restore { ok: true, kept: 237 entries,
                   excluded: 0 } · inspection { publicTables: 28, ledgerExists: false,
                   checkpoints: saas_current } · cleanup { dropped: true }
```

The scratch database is named `rehearsal_restore_<UTC timestamp>`; `kept: false` and
`cleanup.dropped: true` are the proof that nothing was left behind. If a run is interrupted, drop any
`rehearsal_restore_*` database by hand before retrying.

## 6. Restoring the database

Restore into a **disposable** target first — always:

```bash
# A scratch server or a disposable Supabase project, never production.
node scripts/restore-db.mjs \
  --file /var/backups/hotel/hms-2026-10-30T12-00-00.dump \
  --target "postgresql://postgres@127.0.0.1:5433/postgres" \
  --confirm-target "postgres@127.0.0.1:5433/postgres"
```

`scripts/restore-db.mjs` refuses to run without `--target`, refuses a target that is the database the
app is configured for unless `--force` is given, requires an exact `--confirm-target` string, and
**drops the target's existing objects** so the result is a replacement rather than a merge. Read its
`--help` before using `--force`.

Only after the rehearsal and the integrity check pass (§7) should the same procedure be applied to
the production project — during a declared maintenance window, with the application stopped.

## 7. Application recovery procedure

1. **Provision** the target (PostgreSQL 17, or a Supabase project of the same major version).
2. **Configure** `.env` with `DATABASE_URL`, `DIRECT_URL`, `SAAS_ENVIRONMENT=saas`,
   `SAAS_DATABASE_IDENTIFIER`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`.
3. **Install** dependencies: `npm ci` (its `postinstall` runs `prisma generate`). This step needs
   network access to Prisma's engine host (`binaries.prisma.sh`); on a host that cannot reach it the
   install fails before the application is ever built. That is a network prerequisite, not a code
   problem — see §14.
4. **Restore** the archive (§6) into the target.
5. **Adopt or migrate** the migration ledger — see §8. A restored database has no
   `_prisma_migrations` table, so `prisma migrate deploy` must not be run against it before
   `npm run migration:adopt` has baselined it.
6. **Validate** the restored data, read-only:
   ```bash
   node scripts/db-integrity.mjs --url "$DIRECT_URL"            # loopback target
   node scripts/db-integrity.mjs --url "$DIRECT_URL" --allow-remote-target   # remote
   ```
   (`npm run db:integrity -- --json` is the same command through the package script; the JSON
   document is printed to **stdout**, so redirect it — `> integrity.json` — and read
   `results[]`, `verdict.ok` and `verdict.failures[]`.)
   The checker is read-only and refuses non-loopback hosts unless
   `--allow-remote-target` is passed, so it can never be aimed at an arbitrary
   server by accident.
   This checks that all 28 tables exist, that no tenant-scoped row points at a missing hotel, that no
   child row belongs to a different hotel from its parent, that every tenant relation is backed by a
   real foreign key, and that every hotel-scoped table has a `hotelId` index. Non-zero exit means
   **do not** point the application at it.
7. **Check the target's schema state**:
   ```bash
   node scripts/target-check.mjs --url "$DIRECT_URL"
   ```
   Read-only: it reports the ledger state, the matched checkpoint and a schema fingerprint.
8. **Start** the application (`npm run build && npm start`), sign in, and walk §11. `npm run build`
   is `prisma generate && next build`, so it needs the same engine-host access as `npm ci`.
   With the server running, the scripted half of §11 can be executed instead of clicked:
   `node scripts/e2e-smoke.mjs --base http://127.0.0.1:3100 --json e2e.json` (exit 0 = every check
   passed; see §17 for what it covers and what it cannot).
9. **Clean up** any scratch databases and temporary files created above.

## 8. Prisma generation and migrations

```bash
npm ci                        # postinstall: prisma generate
npx prisma validate           # "The schema at prisma/schema.prisma is valid 🚀"
npm run migration:manifest    # "Release manifest matches 19 migration files."
npm run migration:checkpoints # the approved schema checkpoint catalogue (JSON)
```

`npx prisma validate` reads `DATABASE_URL` and `DIRECT_URL` from the environment and fails with
`P1012 Environment variable not found` when they are absent — Prisma CLI loads `.env`, not
`.env.local`, so export both explicitly when validating outside the app's runtime.

Applying migrations to a database that has a ledger:

```bash
npx prisma migrate deploy     # only after target-check says the ledger is present and current
```

A restored database has **no** ledger. Never run `migrate deploy` against it directly — Prisma would
replay every migration. Baseline it first:

```bash
npm run migration:adopt                 # dry run, read-only: prints the checkpoint and
                                        # "To be baselined : 19 migration(s)" plus the rows to write
npm run migration:adopt -- --apply      # writes only the ledger rows, after approval
```

Two details worth knowing before an incident: the dry run reports **"Already recorded: 0"** when the
target has no ledger (or only an empty `_prisma_migrations` table), and `--apply` writes rows only —
it never replays migration SQL.

`prisma migrate dev` is a development-only command and must never be run against a restored or live
database.

## 9. Supabase-specific recovery requirements

A Supabase project is far more than PostgreSQL. What this repository can recover, and what it cannot:

| Component | Recoverable from this repository's backups? | How to recover |
|---|---|---|
| `public` schema (application data) | **Yes** | §6 and §7 |
| `auth.users` (accounts, bcrypt hashes, identities) | **No** | Supabase Dashboard → Database → Backups, or `pg_dump` of the `auth` schema taken separately; Supabase does not expose password hashes through its API |
| Storage objects (files) | **No** | Supabase Storage backup / object-level copy; `pg_dump` captures only metadata |
| Realtime (publications, subscriptions) | No (recreated) | Recreate the publication; active subscriptions are transient |
| Vault secrets | **No** | Restore from your own secret store; Vault data is encrypted with a key you manage |
| Edge functions | No | Re-deploy from their own source control |
| Project configuration (settings, API keys, redirect URLs) | No | Recreate in the dashboard |

A plain PostgreSQL restore of a Supabase dump necessarily skips `auth`, `storage`, `realtime`,
`vault`, `graphql`, `supabase_migrations` and `net`. That is why the rehearsal reports what it
skipped (`restore.filter`) instead of hiding it: application data is restored, platform identity is
not. See `docs/rehearsal-supabase-archive.md`.

**Authentication after a restore into a new Supabase project:** every user must re-register or be
re-created, because `auth.users` is not in the application backup. `User.passwordHash` in the
application schema holds a bcrypt hash used by the NextAuth credentials provider, so a restored
application database can authenticate users in `public.User` **without** Supabase Auth — but only if
the restored rows are the source of truth for those accounts.

## 10. Authentication and account recovery

| Situation | Recovery |
|---|---|
| A staff member forgot their password | Account holder uses the reset flow; no hotel administrator may set another user's password (the staff API rejects `newPassword` with 403) |
| Nobody can sign in | Break-glass CLI: `npm run reset-password -- admin@hotel.com` (generates a strong password) or `npm run reset-password -- admin@hotel.com 'NewPassword'`. It writes only a bcrypt hash and runs the fail-closed database target guard first |
| Staff member has left | Hotel owner/admin removes the membership (`DELETE /api/staff/:id`); with history it is suspended, not deleted, to preserve audit trails |
| New colleague already has an account | The administrator's "add staff" call creates an **invitation**: a `SUSPENDED` membership plus a `STAFF_INVITATION_CREATED` audit row, never access. The invitee accepts or declines from `/select-hotel` (`POST /api/auth/invitations/:id`), and the plan's staff limit is enforced at acceptance. Until then the membership is invisible to them. Detail and threat model: `docs/membership-invitations.md` |
| Session must be invalidated | Rotate `NEXTAUTH_SECRET`; all existing JWTs become invalid immediately |
| A user belongs to several hotels | Membership is per hotel; the active hotel is chosen through `POST /api/auth/switch-hotel` and re-validated server-side on every request |

## 11. Post-restore validation checklist

Run in order; stop at the first failure.

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Archive digest | `sha256sum <archive>` | equals the recorded digest |
| 2 | Archive readable | `… restore-rehearsal --toc` | TOC entries listed, no database created |
| 3 | Rehearsed restore | `… restore-rehearsal --expect-checkpoint saas_current` | `Result: PASS` |
| 4 | Data integrity | `node scripts/db-integrity.mjs --url "$DIRECT_URL" [--allow-remote-target]` | `PASS — no integrity violations found` |
| 5 | Schema state | `node scripts/target-check.mjs --url "$DIRECT_URL"` | checkpoint + fingerprint reported, read-only |
| 6 | Migration ledger | `npm run migration:adopt` (dry run) | `N to baseline, 0 to deploy` |
| 7 | Row counts | `db-integrity --json` → `row.counts` | matches the pre-incident counts |
| 8 | Application boots | `npm run build && npm start` | no startup errors |
| 9 | Sign-in | browser, one admin | dashboard loads, hotel name correct |
| 10 | Tenant isolation | sign in as Hotel B, open reservations/guests | none of Hotel A's records are visible |
| 11 | Financial pages | as `ACCOUNTANT` / `MANAGER` | reports render; a role without `FINANCIAL_REPORTS` is refused |
| 12 | Subscription state | open billing page | plan, status and limits match the pre-incident state |
| 13 | Scripted end-to-end | `node scripts/e2e-smoke.mjs --base http://127.0.0.1:3100` | `Result: PASS`, exit 0 (auth, switching, membership/invitations, permissions, subscription, reservations, check-in/out, billing, payments, POS idempotency, inventory, housekeeping, maintenance, reports) |
| 14 | Invitation consent | as an admin, add an account that already exists at another hotel; sign in as that account | `202` with `invitationPending: true`; the hotel is **not** in the invitee's switch list until they accept |

Rows 1–8 and 13–14 are scriptable and were executed in round 12. Rows 9–12 (a human clicking through
two hotels' pages in a browser) are **manual**; they are not covered by the HTTP harness, and in round
12 they were **NOT TESTED** because no browser was available in the verification environment.

## 12. Rollback

Before touching production, record: the current backup path and digest, the current `main` commit,
and the current Prisma migration count.

| Failure | Rollback |
|---|---|
| Application deploy is bad, database untouched | redeploy the previous commit; no data action |
| Bad migration applied | restore the pre-deploy archive into a **new** database, verify it (§7), then repoint the application; never edit the ledger by hand |
| Restore went to the wrong target | stop the application, restore the pre-incident archive into the correct target, re-verify |
| Data deleted by an operator | restore into a scratch database, extract the affected rows, and re-insert them under a reviewed script — do not restore over production to fix one table |

## 13. Recovery limitations

- Backups capture **application data only** (§9).
- A restore is a **replacement**, not a merge: `restore-db.mjs` drops the target's objects first.
- The rehearsal runs on a **loopback** server by default; a remote target requires an explicit
  `--allow-remote-target`.
- Recovery granularity is a full database. There is no point-in-time recovery in this repository;
  Supabase's own PITR (paid plans) is a separate control.
- A restored database has no migration ledger; it must be adopted (§8) before any deploy.
- Password hashes in `public.User` are bcrypt; if Supabase Auth was the sign-in path, those accounts
  need re-creation (§9).

## 14. Troubleshooting

| Symptom | Cause | Action |
|---|---|---|
| `Refusing to guess a target` / identifier mismatch | `SAAS_ENVIRONMENT` / `SAAS_DATABASE_IDENTIFIER` missing or wrong | set them to the intended project; never guess |
| `psql: command not found` | client tools absent | install PostgreSQL 17 client tools or set `PSQL_BIN` |
| `extension "supabase_vault" does not exist` | Supabase extension excluded by the `plain` profile | expected; the comment entry is filtered with it |
| `schema "realtime" does not exist` | a retained entry referencing an excluded schema | fixed in `archive-toc.mjs` (§14 of the rehearsal record); the `Command was:` line names the statement if it recurs |
| Restore halts with `current transaction is aborted` | a filtered dependency failed mid-restore | read `restore.problems`, fix the filter, re-run; the scratch database is dropped automatically |
| `P3005: database schema is not empty` | `migrate deploy` against a restored database | baseline it with `migration:adopt` first |
| `P1001: can't reach database server` | pooled vs direct URL, or IP not allow-listed | use `DIRECT_URL` (5432) for admin work; check network restrictions |
| `npm ci` / `npm run build` fails fetching `libquery_engine-*.so.node` (`ECONNRESET`, TLS reset, 403) | the host cannot reach `binaries.prisma.sh` | build on a host that can, or vendor the pinned engine (`.env` `PRISMA_QUERY_ENGINE_LIBRARY` + `prisma/migration-release-manifest.json` digests). Do **not** commit a dummy engine: `next build` fails during static generation with `PrismaClientInitializationError … file too short` |
| Build succeeds but the app throws `PrismaClientInitializationError` at runtime | client generated against an engine file that is absent or a 0-byte stub | re-run `npx prisma generate` with the real engine present, then rebuild |
| `db-integrity` exits with `Refusing to inspect a non-loopback target` | safety default | pass `--allow-remote-target` only after confirming the target is the intended restored database |
| App shows stale hotel data | `active_hotel_id` cookie points at a hotel the user has left | sign out and back in; the server clears the cookie on an invalid membership |
| `db-integrity` reports `hotel.orphans` | rows whose hotel was deleted outside the app | investigate before serving traffic; do not delete the rows to silence the check |

## 15. Backup frequency and retention

| Aspect | Recommendation |
|---|---|
| Frequency | Nightly at minimum; before every deploy, migration or bulk import; hourly during a data-heavy migration window |
| Retention | 30 daily, 12 weekly, 12 monthly; keep at least one copy off the database host |
| Verification | `--toc` on every backup; a full rehearsal weekly and before any risky change |
| Storage | outside the repository (`backups/` is git-ignored); encrypted at rest, access-controlled |
| Test restores | at least quarterly, into a disposable database, with the §11 checklist |

## 16. Recovery objectives and gaps

| Objective | Value | Basis |
|---|---|---|
| RPO (data loss window) | ≤ 24 h with nightly backups; ≤ 1 h if the pre-deploy backup practice is followed | no WAL archiving / PITR in this repository |
| RTO (time to service) | ~1–2 h: provision, restore, integrity check, adopt ledger, deploy, smoke test | measured on a small archive; a 93 KB archive restores in seconds, the rest is human process |

Known gaps, stated plainly:

1. **No PITR.** Recovery granularity is the last successful backup. Supabase PITR is an external,
   paid control this repository does not manage.
2. **Platform state is not covered** (auth, storage, vault, functions) — §9.
3. **No automated off-host backup shipping.** `backup-db.mjs` writes locally; copying the archive off
   the host is an operational step, not something the script does.
4. **Restore rehearsal is manual.** It is a single command, but nothing schedules it.
5. **Encryption at rest** is inherited from the host filesystem / storage bucket; the scripts do not
   encrypt archives themselves.

## 17. Verification performed (round 12, 2026-10-30)

Everything in this section ran against a **disposable** PostgreSQL 17.11 cluster on `127.0.0.1:55432`
(database `hms_recovery`) plus the built application on `127.0.0.1:3100`. No production, Supabase or
Axis Hotel system was contacted, and no live data was read.

| # | Command | Result | Note |
|---|---|---|---|
| 1 | `npx prisma validate` | **PASS** | needs `DATABASE_URL` + `DIRECT_URL` exported |
| 2 | `npx prisma generate` | **PASS** | engine *files* could not be downloaded here; see 3 |
| 3 | `npx tsc --noEmit` | **PASS** — 0 errors | the 297 errors reported in earlier rounds were all downstream of an ungenerated Prisma client. No `tsconfig` or `@ts-*` suppression was added at any point |
| 4 | `npm run lint` | **PASS** — 0 findings | |
| 5 | `npm run build` | **PASS** — 41 route entries | built with the local WASM client aid described below; the native-engine build is **BLOCKED** in this sandbox |
| 6 | `npx vitest run` | **PASS** — 53 files, 815 tests, 0 failures, 0 skipped | with `REHEARSAL_TEST_BASE_URL` and PostgreSQL tools on `PATH`, the 6 archive/rehearsal tests that normally skip also run and pass |
| 7 | 19 migrations replayed into an empty database | **PASS** — 19/19 | `scripts/db-integrity.mjs` then found 28/28 tables |
| 8 | `node scripts/db-integrity.mjs --json` | **PASS** — 49 checks, 0 failures | after the 46-check end-to-end run, 24 of 28 tables carried rows (e.g. `Hotel=15`, `Guest=24`, `Payment=23`) |
| 9 | `node scripts/e2e-smoke.mjs --base http://127.0.0.1:3100` | **PASS** — 46/46 | cookie-session HTTP harness against the built app |
| 10 | `npm run migration:manifest` | **PASS** — 19 files match | |
| 11 | `npm run migration:checkpoints` | **PASS** | catalogue printed |
| 12 | `node scripts/target-check.mjs --url "$DIRECT_URL"` | **PASS** — checkpoint `saas_current` | read-only session enforced by the server |
| 13 | `npm run migration:adopt` (dry run) | **PASS** — "To be baselined: 19" | target had an empty ledger |
| 14 | rehearsal of a **tool-check** archive (§5) | **PASS** — digest verified, 28 tables restored, scratch dropped | archive produced from the disposable cluster only, **not** the owner's backup. It proves the commands work; it is not evidence about the genuine archive |
| 15 | Genuine `hotel-management-saas-20261028-140823.dump` restore | **BLOCKED** | the archive is not present in this environment; expected sha256 `F81566E9…B24A7` |
| 16 | Browser walkthrough of §11 rows 9–12 | **NOT TESTED** | no browser/Playwright/Cypress in the environment at the time. Superseded in round 13: the whole browser suite ran, 25/25 — see §18 |

### The local Prisma client aid (not part of the product)

This sandbox cannot reach `binaries.prisma.sh`, so the native query engine cannot be downloaded and
`prisma generate` produces a client whose engine file is missing. To still build and execute the real
application code, `scripts/wasm-runtime-shim.mjs` regenerates the client with `driverAdapters` and
patches `node_modules/.prisma/client` to run Prisma's bundled WASM query engine through
`@prisma/adapter-pg`. It touches only `node_modules` and never the repository's runtime code.

Consequences for reading the evidence above:

- The **TypeScript and lint** results are unaffected: types come from the schema, not from the engine.
- The **build** result proves the application compiles and renders under the real Next.js toolchain,
  but it does not prove the native-engine production path. That path is exercised only on a host with
  engine-host access, and is recorded as **BLOCKED** rather than PASS.
- The **HTTP end-to-end** result exercises the real route handlers, the real Prisma schema, the real
  PostgreSQL database and the real SQL — only the engine binary that executes the SQL is different
  (WASM instead of native). `scripts/db-integrity.mjs` and every `psql` assertion in the harness run
  against the same server independently of Prisma, so the database state is not self-reported.

### What the end-to-end harness covers

`scripts/e2e-smoke.mjs` signs in with real credentials, keeps per-user cookie jars, and sends `Origin`
on every state-changing request (from round 13 the CSRF guard also accepts a same-origin request that
carries `Sec-Fetch-Site: same-origin` and no `Origin`, which is what a browser sends — see
`lib/request-origin.ts`). Its 46 checks span:
sign-up and sign-in, hotel switching, membership and the invitation consent flow, role-denied requests,
subscription limits, room types and rooms, reservations, check-in, folios and billing, payment
settlement, check-out (refused while a balance is outstanding), POS pay-now with idempotency-key
replay, inventory, wastage, housekeeping, maintenance and the reports endpoints. It asserts database
state directly with `psql` for the idempotency and cross-tenant cases rather than trusting the API's
own response.

## 18. Verification performed (round 13, 2026-10-30)

Round 13 re-ran every gate in §17 on the final code and closed the browser gap; the narrative,
the defect list and the risk table are in
[production-readiness-report-round13.md](production-readiness-report-round13.md), and the two remaining
external prerequisites are in
[handoff-production-verification.md](handoff-production-verification.md).

| # | Command | Result | Note |
|---|---|---|---|
| 1 | `npx tsc --noEmit` | **PASS** — 0 errors | no suppression added |
| 2 | `npm run lint` | **PASS** — 0 findings | |
| 3 | `npx next build` | **PASS** | 41 route entries; WASM client aid still required here (§17) |
| 4 | `npx vitest run` | **PASS** — 54 files, 823 tests | includes 8 new `request-origin` cases |
| 5 | 19 migrations replayed into an empty database | **PASS** — 19/19 → 28 tables | disposable cluster, `hms_recovery` |
| 6 | `node scripts/e2e-smoke.mjs --base http://127.0.0.1:3100` | **PASS** — 46/46 | |
| 7 | `npm run test:browser -- --base http://127.0.0.1:3100` | **PASS** — 25/25 | real Chromium, two hotels, four roles; PNG per step in `docs/evidence/browser/`, `docs/evidence/browser-results.json` |
| 8 | `node scripts/db-integrity.mjs --json` | **PASS** — 49 checks, 0 failures | |
| 9 | `node scripts/native-engine-verify.mjs --json` | **BLOCKED** — exit 2 | engine artifact absent (4-byte placeholder); no reachable source for the pinned 5.17.0 binary here. Run it on the deployment image: handoff §2 |
| 10 | Genuine `hotel-management-saas-20261028-140823.dump` restore | **BLOCKED** | bytes still absent; search repeated across filesystem, all remote branches, releases and prior patches. Four-command handoff in handoff §1 |
| 11 | `npm run migration:readiness` | **BLOCKED** | archive, target credentials, engine; plus owner approval, which no tool can decide |

The browser run found four product defects that no server-side harness could see — hotel switching
refused with `403 CSRF_ORIGIN_INVALID` (Chromium omits `Origin` on same-origin `fetch`), invitations
rendered as active staff with a required visible password, room types with no meal plan (so their rooms
could not be reserved), and a POS menu that needed a manual reload before a new category or item
appeared. Each is fixed in its own commit and the suite was re-run to green.

**Deployment remains gated**: rows 9 and 10 must be PASS on the target host first.
