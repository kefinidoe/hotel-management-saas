# Handoff — the two checks that cannot be run here

Round 13 verified everything that can be verified inside this workspace and stopped at two
prerequisites that are outside it. Both are **external inputs**, not code problems: this environment
has no copy of the production archive and cannot reach Prisma's binary host. Neither check may be
replaced with a substitute — a tool-check archive is not the production archive, and the WASM build is
not the native engine.

**Do not deploy until §1 and §2 both print PASS on the deployment host.**

Everything else is green (see [production-readiness-report-round13.md](production-readiness-report-round13.md)):
54 test files / 823 unit + integration tests, HTTP end-to-end 46/46, browser 25/25 across two hotels
and four roles, database integrity 49/49, `tsc` and `eslint` clean, production build passing.

---

## 1. The production archive — BLOCKED: the file's bytes are not in this environment

### What is missing, exactly

| | |
|---|---|
| File name | `hotel-management-saas-20261028-140823.dump` |
| Size | 384 096 bytes |
| SHA-256 | `F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7` |
| Format | `pg_dump` custom archive, from Supabase (carries `auth`, `storage`, `realtime`, `vault`, `supabase_migrations`) |

Searches performed in round 13, all empty:

* the whole filesystem (`*.dump`, `*.backup`, `*.sql.gz`, `pg_dump*`) — nothing;
* every branch on the remote (`git fetch origin '+refs/heads/*'`, then `git ls-tree -r` on each) — no
  `recovery/` file except `recovery/full-arena-worktree.patch`, which is a source patch, not a dump;
* GitHub releases, release assets and repository contents for `kefinidoe/hotel-management-saas` — no
  assets at all;
* the previous session's patch and evidence files — they *describe* the archive and pin its digest, they
  do not contain it.

The owner reported the file recovered and digest-verified in round 11; the bytes never reached this
workspace. That is the entire gap: **the archive must be placed where this run can read it** (or the
commands below run on a machine that has it).

### Do this

On a host with the archive and Docker (or any PostgreSQL 15+ client and server):

```bash
# 0. Prove the bytes first. Nothing else runs if this line is not exact.
sha256sum hotel-management-saas-20261028-140823.dump
# expect: f81566e9ccbb511dd34d0fea5076934cdfbb03cd8bcde1b1611e8d0f77db24a7

# 1. Describe the archive without touching a server.
node scripts/restore-rehearsal.mjs --dump hotel-management-saas-20261028-140823.dump \
  --expect-sha256 F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7 \
  --toc --json > archive-toc.json

# 2. Restore it into a scratch database this script creates and drops, read-only afterwards.
node scripts/restore-rehearsal.mjs --dump hotel-management-saas-20261028-140823.dump \
  --expect-sha256 F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7 \
  --base-url postgresql://postgres@127.0.0.1:5433 \
  --expect-checkpoint saas_current --json > restore-evidence.json

# 3. Integrity against the restored database (the rehearsal prints its URL; 49 checks).
DATABASE_URL=postgresql://postgres@127.0.0.1:5433/<scratch-db> SAAS_ENVIRONMENT=saas \
SAAS_DATABASE_IDENTIFIER=<scratch-db> npm run db:integrity -- --json > integrity.json

# 4. Record the one-line verdicts.
node -e 'for (const f of ["restore-evidence.json","integrity.json"]) { const j=require("./"+f);
  console.log(f, j.verdict?.ok ?? j.ok, (j.verdict?.failures ?? j.failures ?? []).length, "failures"); }'
```

The rehearsal refuses to restore if the digest differs, opens its own scratch database, sets
`default_transaction_read_only = on` for the inspection, compares the ledger with the migration
manifest, prints an md5 fingerprint of the schema and drops the database afterwards. It never writes to
the database named in `--base-url`.

**Then:** for every failing check, look at the `check`, `expected`, `observed` and `detail` fields in
`integrity.json` and fix the *cause* (a migration, a backfill, a constraint), not the check. Re-run
step 3 until it is 49/49 or the remaining failures are written up as accepted risk with a reason.

Store `archive-toc.json`, `restore-evidence.json` and `integrity.json` under `docs/evidence/restore/`
and paste their verdicts into the report — that is the evidence the criterion asks for, and it can only
come from these commands.

### What is *not* acceptable

* Restoring `docs/evidence/rehearsal/demo-archive.dump` (the archive this repository builds itself) and
  calling it the production restore. It proves the tooling, which round 9 already did; it says nothing
  about the owner's data.
* Editing `scripts/migration-readiness.mjs`'s pinned digest, or any default, to make the check pass.
* Running the restore against the live Axis Hotel database, or any database that is not disposable.

---

## 2. The native Prisma engine — BLOCKED: no source for the binary in this environment

### What is missing, exactly

Prisma 5.17.0's query engine is a native shared object, `libquery_engine-debian-openssl-3.0.x.so.node`,
downloaded by `@prisma/engines`' postinstall from `binaries.prisma.sh`:

```
https://binaries.prisma.sh/all_commits/393aa359c9ad4a4bb28630fb5613f9c281cde053/debian-openssl-3.0.x/libquery_engine.so.node.gz
sha256 (unpacked) 077e86821d96c3225ec75c4e2172822f8969cd4f720942f944bc853ea1b77f9f
```

In this sandbox that host does not resolve to a working endpoint (`curl` exits 35, TLS handshake never
completes), and no substitute exists:

* `@prisma/engines@5.17.0` on npm is a 24 KB downloader — its tarball contains only `dist/*.js`
  (the postinstall script). No binaries.
* `prisma/prisma-engines` publishes no GitHub release assets.
* npm search finds no package that ships a 5.17.0 `libquery_engine` for Debian/OpenSSL 3
  (the `@prisma/*-wasm` packages are WASM; that is not this engine).
* Building it needs Rust and `crates.io`, which are also unreachable.

`npm ci` therefore left a 4-byte placeholder at `node_modules/.prisma/client/libquery.so.node`, and
`prisma generate` fell back to the WASM build. **The application has never run on the native engine in
this environment.** The WASM build passing 823 tests and the browser suite is evidence about the
application; it is not evidence about the native engine.

### Do this

New in this round: `scripts/native-engine-verify.mjs` — four checks, one command, PASS/FAIL/BLOCKED
verdict. Run it on the deployment host (or the image you will deploy), where the engine is installed:

```bash
export PRISMA_QUERY_ENGINE_LIBRARY=/app/node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node
export DATABASE_URL=... SAAS_ENVIRONMENT=saas SAAS_DATABASE_IDENTIFIER=...
node scripts/native-engine-verify.mjs --json > docs/evidence/native-engine/verify.json
```

It checks, in order:

1. **artifact** — the file exists, is not a placeholder, and its SHA-256 equals the pin in
   `scripts/prisma-engine-pins.mjs` (`077e8682…f9f`), so a wrong or rebuilt engine cannot slip through;
2. **loadable** — `require()`s the shared object into the running Node build, proving the ABI matches
   (Node 24 — the project's pinned runtime (`.nvmrc`, `engines.node`); use the same major as production);
3. **client** — the application's own Prisma client reports `engineType: "library"`, i.e. it is *not*
   running on the WASM shim or a driver adapter;
4. **queries** — `SELECT version()`, a real `hotel.count()`, and a write inside a transaction that is
   rolled back, all through that engine.

Exit codes: `0` PASS, `1` FAIL, `2` BLOCKED. Only `0` is evidence.

If the engine is missing, get it the normal way on that host — `npm ci` (not `--ignore-scripts`) or
`npx prisma generate` with the network available — or copy the pinned binary in and point
`PRISMA_QUERY_ENGINE_LIBRARY` at it. Do not build or ship the WASM output as a substitute, and do not
disable the engine check.

### Where it stands today

```
$ node scripts/native-engine-verify.mjs --json      # this sandbox
verdict: BLOCKED   (exit 2)
artifact  BLOCKED  node_modules/@prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node — missing
                   node_modules/.prisma/client/libquery_engine-debian-openssl-3.0.x.so.node — missing
                   node_modules/.prisma/client/libquery.so.node — placeholder, 4 bytes
```

`npm run migration:readiness` reports the same three BLOCKED prerequisites (archive, target
credentials, engine) and one PENDING APPROVAL, which is the owner's decision and not something a tool
can produce.

---

## 3. Order of operations for the deployment window

1. §1 steps 0–4 on a host with the archive → `docs/evidence/restore/`; fix every integrity failure.
2. §2 on the target image → `docs/evidence/native-engine/verify.json` must be `PASS`.
3. `npm run migration:readiness -- --dump … --expect-sha256 … --check-target` → all prerequisites PASS.
4. Browser suite against the deployed candidate: `npm run test:browser -- --base https://…` — 25/25.
5. Only then approve, and only with a fresh backup taken immediately before the window.

Keep the live Axis Hotel system isolated throughout: none of the commands above take a production URL
as a default, and `--base-url` for the restore must be a disposable server.
