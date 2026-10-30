# Production recovery and operations runbook

This document is the operator's path back to a working system after a bad deploy, a bad delete,
or a lost database. It describes what exists in this repository, what it does **not** cover, and the
commands to run. Every command below has been exercised in this repository against a disposable
PostgreSQL 17.11 instance unless the row says otherwise (see §11 for the checklist and §14 for the
gaps).

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
| `SAAS_DATABASE_IDENTIFIER` | Must match the Supabase project ref / database name; every backup and restore checks it |
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
3. **Install** dependencies: `npm ci` (runs `prisma generate` on install).
4. **Restore** the archive (§6) into the target.
5. **Adopt or migrate** the migration ledger — see §8. A restored database has no
   `_prisma_migrations` table, so `prisma migrate deploy` must not be run against it before
   `npm run migration:adopt` has baselined it.
6. **Validate** the restored data, read-only:
   ```bash
   node scripts/db-integrity.mjs --url "$DIRECT_URL"            # loopback target
   node scripts/db-integrity.mjs --url "$DIRECT_URL" --allow-remote-target   # remote
   ```
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
8. **Start** the application (`npm run build && npm start`), sign in, and walk §11.
9. **Clean up** any scratch databases and temporary files created above.

## 8. Prisma generation and migrations

```bash
npm ci                        # postinstall: prisma generate
npx prisma validate           # schema is syntactically valid
npm run migration:manifest    # every migration file matches its recorded sha256 (19/19)
npm run migration:checkpoints # the approved schema checkpoint catalogue
```

Applying migrations to a database that has a ledger:

```bash
npx prisma migrate deploy     # only after target-check says the ledger is present and current
```

A restored database has **no** ledger. Never run `migrate deploy` against it directly — Prisma would
replay every migration. Baseline it first:

```bash
npm run migration:adopt                 # dry run, read-only: prints "19 to baseline, 0 to deploy"
npm run migration:adopt -- --apply      # writes only the ledger rows, after approval
```

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
