# Database operation policy

This document is the rulebook for every command in this repository that can reach
a PostgreSQL server. It exists because the guard used to cover the application and
the maintenance scripts but **not** the Prisma CLI, which is exactly where
`migrate deploy`, `migrate dev`, `migrate reset`, `db push` and `studio` live.

The short version:

> `prisma migrate deploy` is the only approved way to change a remote schema.
> `migrate dev`, `migrate reset`, `db push` and `db push --force-reset` are never
> approved against the remote Supabase project.
> The Axis Hotel database is never a valid target for this project.

---

## 1. The identity model

Two kinds of target are accepted, and nothing else.

| Target | Identity | Where the identity comes from |
| --- | --- | --- |
| **Loopback** (`127.0.0.1`, `localhost`, `::1`, `127.0.0.0/8`) | the database name | `SAAS_DATABASE_IDENTIFIER` must equal the database in the URL, e.g. `hotel_saas_dev` |
| **Supabase project** | the **project reference** (20 lowercase alphanumeric characters) | `db.<ref>.supabase.co` / `db.<ref>.supabase.in` / the pooler username `postgres.<ref>` |

Everything else — any other remote hostname — is refused, even when the hostname
or the database name happens to equal the identifier.

Why so strict:

- **Every Supabase project's database is called `postgres`.** Matching on the
  database name would therefore accept *every* Supabase project, including the
  legacy one. `SAAS_DATABASE_IDENTIFIER=postgres` is now rejected outright.
- **Hostname prefixes are not identity.** `jhablmqphfcjwealyxxr.evil.example`
  used to match the old rule. It does not any more.
- **The pooled and direct URLs must describe the same project.** A pooled URL in
  one project and a direct URL in another is refused before anything connects.

`SAAS_DATABASE_IDENTIFIER` for this project is the Supabase project reference
`jhablmqphfcjwealyxxr`. It is not a secret, and `.env.example` shows it, but it
must still be the project you actually verified in the Supabase dashboard.

## 2. Command policy

| Command | Loopback | Remote Supabase | Notes |
| --- | --- | --- | --- |
| `npm run prisma:deploy` (`migrate deploy`) | allowed | **allowed** | The only approved remote migration path. Uses `DIRECT_URL`. |
| `npm run prisma:migrate` (`migrate dev`) | allowed | **refused** | Prisma creates and drops a *shadow database* on the target server. |
| `migrate reset` | refused unless `SAAS_ALLOW_LOCAL_RESET=true` | **refused** | Drops and recreates the schema. No confirmation makes this safe remotely. |
| `db push` | allowed | **refused** | Not the approved schema workflow; bypasses the migration ledger. |
| `db push --force-reset` / `--accept-data-loss` | **refused** | **refused** | Destructive flags are refused on every target. |
| `migrate status`, `migrate resolve`, `migrate diff`, `studio` | allowed | allowed after identity check | `resolve` rewrites the ledger; it is allowed only for the verified project. |
| `db pull`, `db execute`, `db seed` | allowed | **refused** | `db execute` runs arbitrary SQL outside the ledger. |
| `prisma format` | refused | refused | It rewrites `schema.prisma`; format by hand. |
| `prisma generate`, `prisma validate` | allowed | allowed | Neither opens a connection. |
| Anything unrecognised | refused | refused | A guard that forwards unknown verbs is not a guard. |
| `--schema <other file>` | refused | refused | Another schema can read its URL from a variable the guard never validates. Only `prisma/schema.prisma` is approved. |

Every remote row requires `SAAS_ENVIRONMENT=saas` **and** a matching
`SAAS_DATABASE_IDENTIFIER`, and the migration rows additionally require
`DIRECT_URL` to be present and to belong to the same project.

## 3. Where the protection lives

| File | Role |
| --- | --- |
| `lib/db-safety-guard.ts` | the application guard (`lib/prisma.ts`, `db:verify`) |
| `scripts/database-target-safety.mjs` | the same rules for `.mjs` scripts (backup, restore, adopt, target-check, db-integrity, the Prisma wrapper). A shared test matrix runs both implementations, so they cannot drift. |
| `scripts/prisma-safe.mjs` | wraps the Prisma CLI: loads `.env`, checks identity, applies the policy above, then spawns the real CLI |
| `scripts/env-file.mjs` | the single `.env` parser. `prisma/.env` first, then `.env`, never overriding an exported variable — the same precedence the Prisma CLI uses. |
| `scripts/db-integrity.mjs` | read-only integrity checks; `--allow-remote-target` now also requires the project identity |
| `scripts/verify-database-target.ts` (`npm run db:verify`) | pre-flight verification; loads `.env` through the shared loader |

`package.json` routes `prisma:deploy`, `prisma:migrate` and `prisma:studio`
through `scripts/prisma-safe.mjs`. There are no pre-hooks to bypass: the script
*is* the command.

## 4. The limitation you must not forget

**A hand-typed `npx prisma ...` is not intercepted.** Prisma 5.x has no hook
mechanism, and `npx prisma migrate reset` starts the CLI without touching this
repository's code. The wrapper protects every `npm run` path, which is how this
project is documented and how CI invokes it — it cannot protect a command that
never loads these files.

Practical consequences:

- Do not put `DATABASE_URL`/`DIRECT_URL` in a shell profile or a system-wide
  environment variable. Keep them in `.env` only, so a bare `npx prisma` fails
  closed on a missing variable instead of connecting somewhere unexpected.
- Type `npm run prisma:*`, not `npx prisma *`.
- If you must run a raw CLI command, run `npm run db:verify` in the same shell
  first, and read the `Endpoint Class` and `Supabase Project` lines.

## 5. `db:verify` and the environment it judges

Before round 28, `db:verify` read only the shell environment while the Prisma CLI
read `.env` — so an operator could verify one database and migrate another.
`db:verify` now loads `.env` through `scripts/env-file.mjs`, which is the same
loader the wrapper and the maintenance scripts use. It prints which files it
loaded and how many variables came from them, and it requires `DIRECT_URL` for
any remote target.

The check still does **not** prove ownership, migration history, or that the
project is the one you think it is. It proves only that the configured strings
agree with the configured identifier.

## 6. Backups before and after

1. `npm run backup` **before** any migration, and keep the archive outside the
   repository (`backups/` and `*.dump` are gitignored because dumps contain real
   guest data).
2. Run the migration.
3. `npm run backup` **after** it, then `npm run backup:rehearse -- --file <dump>`
   if you want proof the new archive can be restored.
4. Restoring requires an exact `--confirm-target` matching the target identity,
   and refuses the live database unless you pass `--force`.
5. Restoring into a **second** Supabase project (a scratch project) now requires
   `SAAS_DATABASE_IDENTIFIER` to be that project's reference for the duration of
   the restore — the old "database name `postgres` matches everything" rule is
   gone. Put the main project's reference back afterwards.

## 7. First migration against the SaaS project (Windows)

Run every step in **one** terminal, in this order. Nothing below writes to the
database until step 6.

```powershell
# 0. Activate the validated environment (once per shell).
#    Prefer explicit exports over .env for this run so every step sees identical values.
$env:SAAS_ENVIRONMENT      = "saas"
$env:SAAS_DATABASE_IDENTIFIER = "jhablmqphfcjwealyxxr"
$env:DATABASE_URL          = "<pooler :6543 URL with pgbouncer=true>"
$env:DIRECT_URL            = "<direct :5432 URL>"

# 1. Verify the strings and their identity (no connection).
npm run db:verify

# 2. Verify the same thing through the wrapper, without running anything.
npm run prisma:guard

# 3. Schema parses; no connection.
npx prisma validate

# 4. Migration bytes and ledger are the reviewed ones.
npm run migration:verify-eol
npm run migration:manifest

# 5. Read-only reachability + ledger/checkpoint state.
npm run migration:target-check -- --url "$env:DIRECT_URL"

# 6. The migration itself.
npm run prisma:deploy

# 7. Prove the result.
npm run migration:target-check -- --url "$env:DIRECT_URL"
npm run backup
```

If the target already has a schema but no `_prisma_migrations` ledger, stop and
use `npm run migration:adopt` (dry run first) instead of `prisma:deploy`.

Do **not** run `npm run seed`, `npm run db:clean`, or `migrate reset` against the
SaaS project. Demo data belongs in a loopback database.

## 8. Axis Hotel

The Axis Hotel Management System is a separate application with a separate
database. Nothing in this repository may connect to it:

- there is no Axis hostname, reference, or credential anywhere in the tree;
- the guard accepts only loopback targets and the verified Supabase project;
- the only realistic route to the Axis database would be a developer `.env`
  pointing at it — which the wrapper now refuses even for `migrate deploy`,
  because the project reference would not match.

## 9. When a command is refused

| Message | What it means | What to do |
| --- | --- | --- |
| `SAAS_ENVIRONMENT ... is MISSING` | the environment was not loaded | export it, or check `.env` is in the repo root |
| `SAAS_DATABASE_IDENTIFIER ... MISSING` | no identity configured | set it to the 20-character project reference |
| `must be the Supabase project reference` | the identifier is `postgres` or another database/role name | use the project reference |
| `does not match the approved SAAS_DATABASE_IDENTIFIER` | the URL belongs to another project, or to a host that is not Supabase | re-read the URL; never "fix" it by changing the identifier |
| `DIRECT_URL is missing or empty` | migration commands need the direct connection | add `DIRECT_URL` for the same project |
| `belong to different Supabase projects` | pooled and direct URLs are from two projects | correct one of them |
| `not permitted against a remote database` | `migrate dev` | use `npm run prisma:deploy` |
| `forbidden against any remote database` | `migrate reset` | there is no override; restore from a backup instead |
| `the Prisma CLI is not installed` | `node_modules` is missing | `npm ci` (the wrapper never downloads a CLI) |

## 10. Tests that keep this honest

```powershell
npx vitest run __tests__/safety/database-identity.test.ts `
               __tests__/safety/prisma-command-guard.test.ts `
               __tests__/safety/db-safety-guard.test.ts `
               __tests__/scripts/db-integrity-identity.test.ts `
               __tests__/scripts/prisma-script-guardrails.test.ts `
               __tests__/scripts/database-target-safety.test.ts `
               __tests__/scripts/env-file.test.ts
```

They are static or `--print-target` only: no test connects to a database, and
none of them runs the Prisma CLI. CI runs the same files through the full
`npx vitest run`, plus a dedicated step so a broken safeguard fails fast.
