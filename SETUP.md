# Setup — getting this running

Everything here runs on your machine. The sandbox this was developed in can reach
`registry.npmjs.org` and `github.com`, but not `binaries.prisma.sh` (so `prisma generate`
fails) and not Supabase (TCP connects, then the connection is reset) — so the app has never
been executed there. These are the steps to do it properly.

---

## 1. Install

```bash
npm install --legacy-peer-deps
```

> **`--legacy-peer-deps` is currently required.** `vite@8` wants
> `@types/node@^20.19.0 || >=22.12.0` and `package.json` pins `20.14.11`, so plain
> `npm install` fails with `ERESOLVE`. The real fix is to bump `@types/node`:
> ```bash
> npm install --save-dev @types/node@^20.19.0
> ```
> then plain `npm install` works. I didn't make that change for you because it touches your
> toolchain and I couldn't run `tsc` here to confirm nothing else shifts.

## 2. Create the database

Supabase → **New project**. Then **Project Settings → Database → Connection string**, and
copy **both** strings:

| | Which one | Port | Goes in |
|---|---|---|---|
| Transaction pooler | "Connection pooling", mode **Transaction** | `6543` | `DATABASE_URL` |
| Session pooler / direct | "Connection pooling", mode **Session**, or "Direct connection" | `5432` | `DIRECT_URL` |

`prisma migrate` needs the session/direct one because it opens prepared statements and
holds a session; the transaction pooler rejects both.

## 3. Configure `.env`

```bash
cp .env.example .env
```

Fill in `DATABASE_URL`, `DIRECT_URL`, and generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Put that in `NEXTAUTH_SECRET`. `NEXTAUTH_URL` should be `http://localhost:3000` with no
trailing slash.

**URL-encode the password** if it contains `@`, `#`, `/` or a space — `@` → `%40`, `#` → `%23`,
space → `%20`. This is the single most common cause of "can't reach database server".

## 4. Generate the client; keep migrations and demo seeding isolated

```bash
npm run prisma:generate
```

## 4b. Migrations

There are 19 reviewed migrations, checksum-pinned in `prisma/migration-release-manifest.json`.
`npm run migration:manifest` verifies the files still match that manifest.

- **Fresh local database:** `npx prisma migrate deploy` (or apply `prisma/migrations/*` in order).
- **A database that already has a schema but no `_prisma_migrations` table** (this includes the
  deployed Supabase project): do **not** run `migrate deploy` first — it would replay migration 1
  against live tables. Run the read-only dry run, then the documented baseline:
  ```bash
  SAAS_ENVIRONMENT=saas SAAS_DATABASE_IDENTIFIER=<id> DIRECT_URL='postgresql://...' \
    npm run migration:adopt
  ```
  The full runbook is `docs/migration-strategy.md`; the rehearsal evidence is
  `docs/saas-migration-rehearsal.md`; restoring the owner's Supabase backup is
  `docs/rehearsal-supabase-archive.md`. A rehearsal needs an explicitly approved, disposable local
  target (`npm run migration:rehearse`, loopback only).
- **Against the real Prisma migration engine:** `npm run migration:verify-engine` deploys,
  baselines, detects drift and recovers using Prisma's own migrate implementation. It needs a
  verification-only tool stack outside the repository (`docs/migration-strategy.md` §7.2) and a
  disposable PostgreSQL server; it never touches the app's pinned `prisma@5.17.0` dependency.
- **What is still missing, in one command:** `npm run migration:readiness` reports the three external
  prerequisites — the owner's archive (hashed against its recorded digest), the read-only target
  credentials, and the pinned 5.17.0 engine artifacts (hashed against the official digests) — using four
  states: **PASS** (demonstrated), **BLOCKED** (external input missing), **FAIL** (a check ran and
  failed), **PENDING APPROVAL** (owner decision). A green test suite never produces PASS. Add
  `--check-target` to run the read-only target check as well.
- **Pinned Prisma 5.17.0 engine:** `npm run migration:verify-pin -- --schema-engine <path>
  --query-engine-library <path>` checks both files against the official digests recorded in
  `scripts/prisma-engine-pins.mjs`, requires `schema-engine --version` to name commit `393aa359…`, and
  (with `--prisma node_modules/prisma/build/index.js`) requires `prisma -v` to report 5.17.0 with that
  commit. It downloads nothing and fails closed; obtaining the artifacts is §7.1.2 of
  `docs/migration-strategy.md`.
- **Read-only checkpoint and fingerprint of a target:** `npm run migration:target-check` has no write
  path at all (the session runs with `default_transaction_read_only = on`, enforced by the server) and
  reports the detected schema checkpoint, the ledger against the release manifest, and an md5
  fingerprint of the public schema:
  ```bash
  SAAS_ENVIRONMENT=saas SAAS_DATABASE_IDENTIFIER=<id> DIRECT_URL='postgresql://…' \
    npm run migration:target-check -- --expect-ledger absent
  ```
  For a disposable local database only, `SAAS_ENVIRONMENT=rehearsal` is accepted and requires a
  loopback host.
- **Restore rehearsal:** `npm run migration:restore-rehearsal -- --dump <archive> --expect-sha256 <hex>`
  checks the archive's digest *before* connecting, parses its table of contents with `pg_restore --list`
  before creating anything, restores into a scratch database it creates, fingerprints the result
  read-only, and drops the database again (`--keep` keeps it). The archive is real guest data: keep it
  outside the repository (`*.dump` is ignored, so it cannot be committed by accident). It refuses a
  non-loopback `--base-url` unless `--allow-remote-target` is passed. Never point it at the live
  database.

Never run `migrate dev`, `db push`, `migrate resolve`, or reset against Supabase or any
populated/shared database.

`npm run seed` inserts fictional demo hotels and users. It is refused unless both database URLs
point to the same loopback database named `hotel_saas_demo_<suffix>`,
`SAAS_ENVIRONMENT=local`, and `SAAS_ALLOW_LOCAL_DEMO_SEED=true`. Set
`SAAS_DEMO_INITIAL_PASSWORD` only in the local process environment to a unique password of at
least 16 characters; the seed does not print it. Never seed Supabase, a shared database, or the
Axis Hotel system. Existing user passwords are not changed by rerunning the seed.

## 5. Run it

```bash
npm run dev
```

<http://localhost:3000> redirects to `/login`. Sign in, and you land on `/dashboard`.

## 6. Verify — run these and tell me what they say

```bash
npm run test:run             # expect 678 passed / 46 files
npm run lint                 # expect "No ESLint warnings or errors"
npx tsc --noEmit             # expect NO output. This is the one check still unproven.
npx prisma migrate status    # expect "Database schema is up to date!"
```

`npx tsc --noEmit` is the important one. Every type error I saw in the sandbox traced to the
un-generated Prisma client, so I expect this to be clean — but I could not prove it. If it
prints anything, paste the output.

---

## Checks that need no database at all

These run anywhere, including CI, because they build their own PostgreSQL from WebAssembly:

```bash
npx vitest run __tests__/schema/migrations.test.ts   # migrations vs schema.prisma vs real Postgres
npx vitest run __tests__/seed/seed.test.ts           # runs prisma/seed.ts against a fake client
npx vitest run __tests__/middleware/matcher.test.ts  # every /api route is actually guarded
npx vitest run __tests__/seed/seed.test.ts __tests__/middleware/matcher.test.ts
```

All three were checked to **fail** when the underlying bug is reintroduced, so they are real
guards rather than assertions that can't fail.

---

## Gotchas

- **`npm run seed` is safe to re-run.** Everything is an upsert. It will not duplicate rooms,
  payment methods or menu items.
- **`prisma/schema.prisma` reads `DIRECT_URL`.** If you only set `DATABASE_URL`, Prisma fails
  at startup with `Environment variable not found: DIRECT_URL`.
- **The Prisma client must be regenerated** after any `schema.prisma` change
  (`npm run prisma:generate`) or the types and the database disagree.
- **Don't commit `.env`** — it's already in `.gitignore`.
- **`prisma migrate dev` on production data** is a bad idea. Use `migrate deploy`.
