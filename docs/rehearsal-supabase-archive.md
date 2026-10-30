# Restoring the owner's Supabase archive — a Windows runbook

This is the procedure for the one piece of migration evidence that cannot be produced from a
synthetic fixture: a restoration of the owner's actual backup,
`hotel-management-saas-20261028-140823.dump` (384,096 bytes, SHA-256
`F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7`).

It assumes Windows + PowerShell, a checkout of this repository at `C:\hotel-saas-rehearsal`, and the
archive copied to a folder outside the repository. Nothing here connects to the live Axis Hotel
database or to the Supabase project: every command below targets a disposable server on `127.0.0.1`.

The tooling is `scripts/restore-rehearsal.mjs` (verified and rehearsed without the owner's bytes — see
`docs/saas-migration-rehearsal.md` §11 and §12).

---

## 0. Why this archive needs a runbook at all

The owner's database is a Supabase project, and a Supabase project is not just the application's
tables. A dump of it also contains:

| In the archive | Owner | Why it breaks a stock PostgreSQL restore |
|---|---|---|
| `auth`, `storage`, `realtime`, `vault`, `graphql`, `supabase_migrations`, `net`, `cron`, `pgsodium` schemas | `supabase_admin` | Created by Supabase's own migrations; their objects reference Supabase-only roles, functions and extensions |
| `supabase_realtime` publication, event triggers | `supabase_admin` | Point at Supabase platform functions that a plain server does not have |
| Extensions only Supabase ships (`pg_graphql`, `pg_net`, `pgjwt`, `pgsodium`, `supabase_vault`, …) | `supabase_admin` | `CREATE EXTENSION` fails where the extension package is absent |
| `public.*` — the application's own 28 tables | `postgres` | **This is the part that matters, and it restores cleanly** |

Restored wholesale into a stock PostgreSQL server, the restore therefore fails partway through and
leaves a **half-restored database**: `public` is populated, the Supabase platform schemas are not, and
`pg_restore` exits non-zero — or, worse, exits zero while the platform objects are missing.

`restore-rehearsal.mjs` handles this by deciding *before* restoring what the target can satisfy. It
reads the archive's table of contents with `pg_restore --list`, keeps `public` (and the `extensions`
schema, which `CREATE EXTENSION ... SCHEMA extensions` depends on), skips the Supabase-managed
schemas, skips extensions the target cannot install, skips Supabase-only object types, and then
verifies that **every table in the archive exists in the restored copy with its rows**. Anything the
filter drops is reported, so a filtered rehearsal can never quietly become a no-op.

Pick one of two targets:

| | A — local Supabase stack | B — stock PostgreSQL 17 |
|---|---|---|
| What it is | `supabase start` (Docker) in `C:\hotel-saas-rehearsal` | A local PostgreSQL 17 server |
| Profile | `--profile supabase` (or `auto`) | `--profile plain` (default when `auto` detects the archive) |
| Proves | The application data **and** that Supabase's platform objects can be recreated | The application data and schema end-state |
| Cost | Docker Desktop, ~2 GB image pull, slower | None beyond PostgreSQL |
| Risk | Platform objects depend on the exact Supabase version; expect to iterate | Low |

**Recommended first run: B.** Migration readiness depends on the application schema and its data, and
B isolates exactly that. Run A afterwards if you also want the Supabase platform state restored.

---

## 1. One-time prerequisites

```powershell
node --version        # 20 or newer
psql --version        # 17.x client tools
pg_restore --version  # must be the same install as psql
```

If `psql` is not on `PATH`, both tools take an explicit path:

```powershell
$pgsql = "C:\Program Files\PostgreSQL\17\bin"
$psql  = Join-Path $pgsql "psql.exe"
$pgres = Join-Path $pgsql "pg_restore.exe"
```

For option A only: Docker Desktop running, and the Supabase CLI (`supabase --version`).

---

## 2. Step 1 — verify the archive's identity before anything touches it

```powershell
$repo    = "C:\hotel-saas-rehearsal\hotel-saas"
$archive = "C:\hotel-saas-rehearsal\archive\hotel-management-saas-20261028-140823.dump"

(Get-Item $archive).Length
(Get-FileHash -Algorithm SHA256 $archive).Hash
```

Expected:

```
384096
F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7
```

If either line differs, **stop**. A different file is a different backup, and rehearsing it would
produce evidence for the wrong archive. The digest is case-insensitive when passed to the tool, so
PowerShell's upper-case output can be pasted as-is.

Keep the archive out of the repository: `*.dump` is ignored by `.gitignore`, but the file should live
outside the working tree regardless.

---

## 3. Step 2 — analyse the archive (no database is created, nothing connects)

```powershell
cd $repo
npm run migration:restore-rehearsal -- `
  --dump $archive `
  --expect-sha256 F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7 `
  --toc
```

This reads the archive with `pg_restore --list` and exits. It does not create a database or open a
connection. Expect output shaped like this (values from a Supabase-shaped fixture, not the owner's
archive):

```
Archive analysis (no database is created)
----------------------------------------
Archive            : ...\hotel-management-saas-20261028-140823.dump
Size / SHA-256     : 375 KB / f81566e9...24a7
Digest verified    : yes
TOC entries        : <n>
Schemas            : auth, extensions, public, storage, supabase_migrations, ...
Application tables : 28 in public
Extensions         : ...
Supabase schemas   : auth, extensions, storage, supabase_migrations, ...
Looks like Supabase: yes
Recommended profile: plain (application schema only) unless the target is a local Supabase stack
```

Record `TOC entries` and `Application tables`. `Application tables: 28` is the number the full
migration chain creates; a lower number would mean the archive predates some migrations, and
`--expect-checkpoint es_2026_10_27` (instead of `saas_current`) would be the matching end-state.
Cross-check with the release manifest:

```powershell
npm run migration:manifest
```

Add `--json` to the analysis to keep the machine-readable version:

```powershell
npm run migration:restore-rehearsal -- --dump $archive `
  --expect-sha256 F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7 `
  --toc --json | Out-File -Encoding utf8 toc-analysis.json
```

---

## 4. Step 3 — the rehearsal

### Option B — stock PostgreSQL 17 (recommended first run)

Start a disposable server (any empty cluster works; port 5433 keeps it clear of an existing install):

```powershell
$pgdata = "C:\hotel-saas-rehearsal\pgdata"
initdb -D $pgdata -U postgres -A trust
pg_ctl -D $pgdata -l "C:\hotel-saas-rehearsal\pg.log" -o "-p 5433" start
```

Then rehearse:

```powershell
npm run migration:restore-rehearsal -- `
  --dump $archive `
  --expect-sha256 F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7 `
  --base-url "postgresql://postgres@127.0.0.1:5433" `
  --profile plain `
  --expect-checkpoint saas_current `
  --json | Tee-Object -FilePath restore-evidence.json
```

`--profile plain` is explicit here on purpose: it states what is being proven. Omit it and the tool
chooses `auto`, which picks `plain` for this archive on a stock server anyway — but then the report's
profile line reflects a guess rather than an instruction.

`Tee-Object` keeps the full report (digest, TOC count, filter, row counts, cleanup) on screen and in
`restore-evidence.json` without committing anything.

### Option A — local Supabase stack

```powershell
cd C:\hotel-saas-rehearsal
supabase init                      # once; creates .\supabase
supabase start                     # pulls images on first run, prints the connection strings
```

Use the **direct** connection string (`...@127.0.0.1:54322/postgres`), never the pooler on 5432/6543:
session-level state and `CREATE DATABASE` are unreliable through a pooler, and the rehearsal creates
its own scratch database.

```powershell
cd C:\hotel-saas-rehearsal\hotel-saas
npm run migration:restore-rehearsal -- `
  --dump $archive `
  --expect-sha256 F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7 `
  --base-url "postgresql://postgres:postgres@127.0.0.1:54322/postgres" `
  --profile supabase `
  --expect-checkpoint saas_current `
  --json | Tee-Object -FilePath restore-evidence-supabase.json
```

The stack's roles (`supabase_admin`, `authenticated`, `anon`, `service_role`) exist cluster-wide, so
`auto` resolves to `supabase` here. If an event trigger or publication fails because it references a
Supabase function the scratch database does not have, that is a real finding about what the archive
requires — capture the error and fall back to `--profile plain` for the application-data evidence.

Tear the stack down afterwards:

```powershell
supabase stop --no-backup
```

---

## 5. Step 4 — read the report

A passing run ends like this (numbers from the 28-table chain rehearsal):

```
Restore profile      : plain — kept 237 of 237 TOC entries, skipped 0
Restore              : finished with no errors

Restored database (read-only inspection)
  Server version     : 17.11
  Public tables      : 28
  Ledger             : absent (pre-ledger backup)
  Detected checkpoint: saas_current
  Table coverage     : every archive table restored
  Row counts (28 tables):
    Hotel                        1
    Guest                        3
    ...

Checks
  PASS  restore finished with no errors: 28 table(s) in public
  PASS  every application table in the archive was restored: 28 of 28 table(s)
  PASS  restored schema matches a known checkpoint: saas_current
  PASS  inspection ran read-only: transaction_read_only=on

Cleanup              : scratch database rehearsal_restore_20261030_131521 dropped

Result: PASS.
```

What each check means:

| Check | Meaning | If it fails |
|---|---|---|
| restore finished with no errors | `pg_restore` exited 0 under `--exit-on-error` and `--single-transaction` | Read the first error in `restore.problems`; the scratch database is dropped even on failure |
| every application table in the archive was restored | The archive's `public` tables ⊆ the restored copy, with no unexpected extras | A filtered entry was needed by a remaining object; use `--exclude-schema` to widen the filter deliberately |
| restored schema matches a known checkpoint | The restored schema satisfies exactly one approved checkpoint (`saas_current`) | The archive predates a migration, or the filter dropped something structural — do not baseline it |
| inspection ran read-only | The inspector ran with `default_transaction_read_only=on` | Never ignore this |

Exit codes: `0` all checks passed, `1` a check failed or the run was refused, `2` bad arguments.
A `FAIL` on the checkpoint check with `Ledger : absent` and a schema that is otherwise intact means
the archive is an older end-state: re-run with `--expect-checkpoint` naming the checkpoint the `--toc`
output implies.

On a Supabase archive restored with `--profile plain`, the profile line reports what was skipped and
why, e.g.:

```
Restore profile      : plain — kept 10 of 19 TOC entries, skipped 9 (schema: 8, type: 1)
Skipped schemas      : auth, supabase_migrations
```

That is expected. The line that must say `every archive table restored` is the coverage check; if the
filter ever dropped an application table, it would fail there rather than pass silently.

---

## 6. Step 5 — follow-on evidence on the restored copy (optional but cheap)

`--keep` retains the restored database so the adoption and fingerprint tools can read it:

```powershell
npm run migration:restore-rehearsal -- --dump $archive `
  --expect-sha256 F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7 `
  --base-url "postgresql://postgres@127.0.0.1:5433" --profile plain --keep
```

then, against the name printed in `Scratch database`:

```powershell
npm run migration:adopt -- --url "postgresql://postgres@127.0.0.1:5433/<scratch>" --dry-run
npm run migration:target-check -- --url "postgresql://postgres@127.0.0.1:5433/<scratch>"
```

Drop it when done:

```powershell
psql "postgresql://postgres@127.0.0.1:5433/postgres" -c "DROP DATABASE <scratch>"
```

---

## 7. Step 6 — prove nothing was left behind, and the archive is unchanged

```powershell
psql "postgresql://postgres@127.0.0.1:5433/postgres" -tAc `
  "SELECT count(*) FROM pg_database WHERE datname LIKE 'rehearsal_restore%'"     # expect 0
(Get-FileHash -Algorithm SHA256 $archive).Hash                                     # unchanged
```

Then stop the disposable server:

```powershell
pg_ctl -D "C:\hotel-saas-rehearsal\pgdata" stop
```

The archive is only read, never modified, so the second hash must still equal
`F81566E9…24A7`. If it does not, something rewrote the file — stop and investigate.

---

## 8. Failure playbook

| Symptom | Cause | Action |
|---|---|---|
| `The archive could not be read by pg_restore` | Truncated/corrupt file, or a client older than the dump format | Re-check the digest; install matching or newer client tools |
| `unsupported version (1.x) in file header` | `pg_restore` older than the dump | Install PostgreSQL 17 client tools |
| `extension "…" is not available` | Extension the target cannot install | Expected; the filter skips it. Restore it only if the schema needs it |
| `schema "auth" already exists` | Restoring without the filter | Use `--profile plain` (or `supabase` on a stack) |
| `extension "x" does not exist` while running `COMMENT ON EXTENSION x` | A comment entry that depends on an excluded extension survived the filter | Fixed in `archive-toc.mjs` (§13 of the rehearsal record). If it reappears, check `restore.filter.byReason` for `extension comment` |
| `role "supabase_admin" does not exist` | Archive objects owned by Supabase roles | `--profile plain` skips them; or use option A |
| `permission denied for schema public` | PG 15+ `public` ownership | Connect as the database owner / `postgres` |
| Checkpoint check `FAIL` with `Ledger: absent` | Archive is an older end-state | Re-run with the matching `--expect-checkpoint` |
| Report says `Digest verified: no` | `--allow-unverified` used | Re-run with `--expect-sha256`; an unverified restore proves the file is a dump, not that it is *the* backup |

Every failure above still drops the scratch database (or reports the name it could not drop), so a
retry never collides with a half-restored leftover.

---

## 9. What the record must then say

`docs/saas-migration-rehearsal.md` §2.2 still carries the owner-supplied archive metadata, and §11
records that the bytes were never present in the agent's environment. When this runbook has been
executed, the evidence to append is:

* the `--toc` output (TOC entries, application-table count, Supabase schema list),
* the `--json` rehearsal report (`archive.sha256`, `archive.tocEntries`, `restore.filter`,
  `inspection.rowCounts`, `checks`, `scratch`),
* the cleanup count (`0` databases matching `rehearsal_restore%`),
* the re-computed archive digest.

Until those four exist, the restoration prerequisite stays **BLOCKED** and production migration
readiness is not claimed.
