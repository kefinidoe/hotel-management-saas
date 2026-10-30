# Round 12 — production-readiness report

**Branch:** `arena/2d248a1e-hotel-management-saas`, branched from `main` = `03cc49d`
**Commits:** `e2f0e9e` (advisory-lock cast) · `8d1396d` (invitation consent) · `dfc7759` (integrity CLI envelope) · `14dd9fe` (engine-pin path) · `ac09c93` (HTTP e2e harness + local client aid) · the commit that adds this report and the documentation changes
**Date:** 2026-10-30 · **Environment:** isolated sandbox, disposable resources only.

No connection was made to Supabase, to any production database, or to the live Axis Hotel system. The
genuine backup was neither read nor modified — it is not present here (see §5).

Every criterion carries **PASS / FAIL / BLOCKED / NOT TESTED**, decided by evidence produced in this
environment. Where a criterion could only be partly exercised, it is split, and the untested half is
labelled **BLOCKED** or **NOT TESTED** rather than folded into a PASS.

---

## 1. Verdict

**Production readiness is not established, and this report does not claim it.** Three of the four
gates a go-live decision depends on were closed or opened in this round; one remained open and one is
only half-verifiable here:

| Gate | Status |
|---|---|
| Build from a clean checkout | **PASS** — `prisma validate`, `tsc --noEmit`, `eslint`, `next build` all succeed (with one documented, non-product local aid; see §3) |
| Genuine backup restore + integrity check | **BLOCKED** — the archive does not exist in this environment |
| Browser-based smoke and E2E | **NOT TESTED** — no browser in the environment; an HTTP-level harness covers 46 checks instead (§6) |
| Invitation consent (F-3) | **PASS** — implemented, tested at unit and HTTP level |

The application code is in demonstrably better shape than at the start of the round: two real defects
were found and fixed by running the product rather than reading it, and the previously-unknown
"297 TypeScript errors" is now fully explained and reduced to zero without touching a single compiler
setting.

---

## 2. Criterion-by-criterion results

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1a | Investigate the build blocker | **PASS** (diagnosis complete) | `binaries.prisma.sh` is unreachable from this sandbox: TLS `ECONNRESET` on every attempt, for the engine binary, the schema-engine binary and the CLI's own download path. Reachability probed on 2026-10-30: `registry.npmjs.org`, `api.github.com`, `files.pythonhosted.org` respond; `binaries.prisma.sh`, Prisma's S3 bucket, `cdn.jsdelivr.net` and `cdn.playwright.dev` do not |
| 1b | `npx prisma validate` | **PASS** | `The schema at prisma/schema.prisma is valid 🚀` |
| 1c | `npx tsc --noEmit` | **PASS** — 0 errors | see §4 |
| 1d | `npm run lint` | **PASS** — 0 findings | `eslint . --ext .js,.mjs,.cjs,.jsx,.ts,.mts,.cts,.tsx` |
| 1e | `npm run build` | **PASS** (WASM client) / **BLOCKED** (native engine) | 41 route entries, `Compiled successfully`; the native-engine build needs engine-host access this sandbox does not have |
| 1f | Fix genuine application errors behind the 297 | **PASS** | 297 → 0 by generating the client; no `tsconfig` relaxation, no `@ts-ignore`, no `skipLibCheck` change. Three real defects found and fixed instead (§3) |
| 2a | Verify the genuine archive's SHA-256 before restoring | **BLOCKED** | archive absent; expected `F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7` |
| 2b | Restore into an isolated disposable PostgreSQL | **BLOCKED** for the genuine archive; **PASS** for the rehearsal tooling | a real `pg_dump` archive was restored into a scratch database `rehearsal_restore_20261030_164405` on the disposable cluster, 28 tables, checkpoint `saas_current`, dropped afterwards |
| 2c | `npm run db:integrity -- --json` | **PASS** | 49 checks, 0 failures, 24/28 tables populated after the end-to-end run |
| 2d | Investigate every failed integrity check | **PASS** (none failed) / historically **PASS** | the round-11 false positives are fixed in `dfc7759` and now covered by six tests |
| 3a | HTTP-level end-to-end against the built app + test DB | **PASS** — 46/46 | `scripts/e2e-smoke.mjs`, exit 0 |
| 3b | Browser-based smoke and E2E | **NOT TESTED** | no chromium/playwright/cypress installed, `cdn.playwright.dev` unreachable, so no browser could be installed either |
| 4 | Agreement/consent for adding an existing account | **PASS** — implemented, not merely documented | `docs/membership-invitations.md`, 11 unit tests, 4 HTTP checks |
| 5 | Reconcile `docs/production-recovery.md` | **PASS** | every command re-run; four inaccuracies corrected; §17 holds the evidence |
| 6 | This report | **PASS** | — |

---

## 3. Build: what the blocker was, and what was done about it

**The blocker is a network boundary, not a schema or code problem.** `npm ci` runs
`postinstall: prisma generate`, which fetches `libquery_engine-debian-openssl-3.0.x.so.node` from
`binaries.prisma.sh`. That host resets the TLS handshake from this sandbox, so:

- `npm ci` (with scripts) cannot complete;
- `npx prisma generate` without engines leaves a 0-byte `node_modules/.prisma/client/libquery.so.node`;
- `next build` then fails during static generation with
  `PrismaClientInitializationError … file too short`.

Everything that does *not* need the binary works, and was run: `npm ci --ignore-scripts`,
`npx prisma validate`, `npx prisma generate` (schema → typed client), `npx tsc --noEmit`,
`npm run lint`.

To still exercise the **real application** end to end, `scripts/wasm-runtime-shim.mjs` regenerates the
client with the `driverAdapters` preview feature and patches `node_modules/.prisma/client` to run
Prisma's bundled **WASM** query engine through `@prisma/adapter-pg`. It writes only inside
`node_modules`; no product code, schema or TypeScript setting was changed for it, and the shim is not
referenced by anything the application imports.

What that means for the build result, stated plainly:

- **Proven:** the application compiles, renders, and runs under the real Next.js 15 toolchain, against
  a real PostgreSQL 17.11 server, executing real SQL for real requests.
- **Not proven:** the native-engine production build. That remains **BLOCKED** until it is run on a
  host that can reach Prisma's engine host. It is not marked PASS.

### The 297 TypeScript errors

All 297 were downstream of an **ungenerated Prisma client**: `@prisma/client` had no exported model
types, so every `prisma.guest.findMany()` and every `import type { Hotel }` failed. Once the client was
generated — which needs no engine binary — the count went to **0** with no other change. That
conclusion was verified rather than assumed: the error list was checked *before* generating (all
errors pointed at `@prisma/client` type paths), and after generating, `tsc --noEmit` exits 0 on the
application code, the tests and the scripts.

**Three genuine defects were found by running the product**, not by reading it:

1. **`lib/entitlements.ts` — quota-checked writes always failed.** `SELECT pg_advisory_xact_lock(...)`
   returns `void`, which the driver cannot deserialize, so every seat- or room-limited write
   (`POST /api/rooms`, `POST /api/staff`, plan-gated creates) returned **503**. Fixed in `e2f0e9e` by
   casting the call to `::text AS locked`. Found by the e2e harness, which had been reporting 503s
   that looked like a permissions problem.
2. **F-3 — access without consent (see §4).**
3. **`scripts/db-integrity.mjs` — a healthy database could report a failure.** Counts and lists were
   decoded through different paths, and the per-table row-count inventory was mistaken for a
   completeness assertion. Fixed in `dfc7759`; six tests now pin the envelope.

---

## 4. Invitation consent (finding F-3)

Previously: a hotel administrator could type any email into "add staff"; if that email already had an
account, the handler created an **ACTIVE** membership immediately. The account holder gained access to
another hotel's operational and financial data with no notice and no ability to refuse.

Now (commit `8d1396d`, design and threat model in `docs/membership-invitations.md`):

- adding an **existing** account returns **202** with `invitationPending: true` and creates the
  membership **SUSPENDED**, plus a `STAFF_INVITATION_CREATED` audit row naming the inviter;
- only the invitee can resolve it: `POST /api/auth/invitations/:id` with `{action:"accept"|"decline"}`;
- accepting re-checks the plan's staff limit **at that moment** under the same advisory lock as every
  other seat-consuming write, then flips the membership to ACTIVE; declining deletes it;
- pending state is derived from the newest audit event for the membership, so a later
  `STAFF_MEMBERSHIP_SUSPENDED` (a revoked membership) can never be accepted;
- foreign invitations answer **404**, not 403, so the endpoint is not an existence oracle;
- **`User` is never written** by any of this: no hotel can alter another hotel's credentials.

Verified by 11 unit tests (including cross-hotel acceptance refused, double acceptance, seat limit
enforced, revoked invitation not offered) and 4 HTTP checks in the harness (invite → not switchable →
foreign accept refused → accept → switch → Hotel B data only).

---

## 5. The genuine backup: **BLOCKED**

The archive `hotel-management-saas-20261028-140823.dump` is **not present** anywhere in this
environment (`find` over the workspace and `/tmp` returns nothing), so:

- its SHA-256 could not be compared against
  `F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7`;
- it was never restored, not even partially;
- no claim is made that it restores successfully.

Nothing synthetic was substituted for it. What *was* done is the next best thing that is honest: the
rehearsal tooling itself was exercised against a **tool-check archive** dumped from the disposable
cluster (116 KB, sha256 `25b60c8e…12ee3`), through the exact commands the runbook prescribes:

```
--toc            → 28 application tables in public, "Looks like Supabase: no", profile: plain
full rehearsal   → ok: true · restore { ok: true, kept: 237, excluded: 0 } ·
                   inspection { publicTables: 28, checkpoint: saas_current } ·
                   cleanup { dropped: true }
```

That proves the commands, flags and outputs in `docs/production-recovery.md` §5–§8 work against a live
server. It is **not** evidence about the owner's archive, and it is not presented as such.

**To close this criterion**, the owner needs to place the archive (or run the commands themselves) on a
host with PostgreSQL 17 client tools, then:

```bash
sha256sum hotel-management-saas-20261028-140823.dump
# must equal F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7
node scripts/restore-rehearsal.mjs --dump hotel-management-saas-20261028-140823.dump \
  --expect-sha256 F81566E9…B24A7 --base-url "postgresql://postgres@127.0.0.1:5433" \
  --expect-checkpoint saas_current --json > restore-evidence.json
```

---

## 6. End-to-end testing: 46 checks over HTTP, **no browser**

`scripts/e2e-smoke.mjs` runs against the **built** application (`next start`, port 3100) and the
disposable PostgreSQL database. Result: **46/46 PASS, exit 0**.

It covers, with real sessions and a cookie jar per user: login page rendering, unauthenticated
rejection, registration, credentials sign-in, workspace creation, guest and room-type and room setup,
reservations, check-in, folio billing, payment settlement, check-out (refused while a balance is
outstanding, then allowed), POS pay-now with an idempotency-key replay that is verified **in the
database** (same `paymentId`, exactly one `Payment` row), inventory, wastage, housekeeping,
maintenance, reports, role-denied requests, subscription gating (operational writes blocked while
suspended, restored when active), hotel switching, membership invitations, and cross-tenant isolation
(`C cannot switch into a hotel it does not belong to`).

Every state-changing request sends `Origin`, because the CSRF guard rejects requests without it —
the harness exercises the guard rather than working around it. Where the API's own response could be
self-serving (the idempotency case), the assertion is a direct `psql` query instead.

**What this does not replace:** a browser. No chromium, playwright or cypress is installed, and
`cdn.playwright.dev` is unreachable, so one could not be installed either. Everything a browser proves
that HTTP does not — hydration, client-side routing, layout, form behaviour, the actual rendering of
the select-hotel page and its Accept/Decline buttons — is **NOT TESTED**. §11 rows 9–12 of the runbook
remain manual steps.

---

## 7. Verification summary

| Command | Result |
|---|---|
| `npx prisma validate` | PASS |
| `npx prisma generate` | PASS (client types); engine binary download BLOCKED |
| `npx tsc --noEmit` | PASS — 0 errors |
| `npm run lint` | PASS — 0 findings |
| `npm run build` | PASS — 41 routes (WASM client); native-engine build BLOCKED |
| `npx vitest run` | **PASS — 53 files, 815 tests, 0 failures, 0 skipped** (with PostgreSQL tools on `PATH` and `REHEARSAL_TEST_BASE_URL` set, the 6 archive/rehearsal tests that otherwise skip also run and pass) |
| 19 migrations into an empty database | PASS — 19/19 |
| `node scripts/db-integrity.mjs --json` | PASS — 49 checks, 0 failures |
| `node scripts/e2e-smoke.mjs --base http://127.0.0.1:3100` | PASS — 46/46 |
| `npm run migration:manifest` | PASS — 19 files match |
| `node scripts/target-check.mjs --url …` | PASS — checkpoint `saas_current`, read-only enforced by the server |
| `npm run migration:adopt` (dry run) | PASS — "To be baselined: 19" |
| Genuine archive restore | BLOCKED |
| Browser smoke | NOT TESTED |

Note on the test count: running the suite with `SAAS_ENVIRONMENT` / `DATABASE_URL` exported *changes*
the result of `__tests__/safety/db-safety-guard.test.ts` (it asserts fail-closed behaviour when those
variables are absent). The reported 815/815 is the run with them unset, which is how CI runs it.

---

## 8. Documentation changes

`docs/production-recovery.md` was re-derived from live runs rather than from reading the scripts:

- §5 now shows the rehearsal's actual output shape (`ok`, `scratch`, `restore.filter`, `inspection`,
  `cleanup`) so an operator can tell success from a partial run;
- §7 states the `npm ci` → engine-host prerequisite, the `npm run db:integrity -- --json`
  stdout-only behaviour, and the `node scripts/e2e-smoke.mjs` step;
- §8 shows exact expected output for `prisma validate`, `migration:manifest` and `migration:adopt`
  (the dry run prints "To be baselined: 19 migration(s)", not the wording previously documented), and
  records that the Prisma CLI reads `.env`, not `.env.local`;
- §10 documents the invitation flow for a colleague who already has an account;
- §11 adds two scripted checks and marks which rows are manual;
- §14 gains the four failure modes actually encountered here (engine download, dummy engine stub,
  runtime `PrismaClientInitializationError`, `db-integrity` remote-target refusal);
- §17 is new: the full evidence table, the WASM aid's exact scope, and what it does not prove.

`docs/membership-invitations.md` is new: the model, the API contract, the threat analysis (including
what it does **not** claim — possession of credentials is the consent signal, there is no out-of-band
email confirmation) and its evidence.

---

## 9. Residual risks

| Risk | Severity | State |
|---|---|---|
| No browser-level verification of any page | High for a go-live decision | NOT TESTED — needs a host with a browser |
| Genuine archive never restored here | High | BLOCKED — needs the owner's archive |
| Native-engine build never exercised | Medium | BLOCKED — needs engine-host access |
| Invitation consent trusts credential possession | Low–Medium | Documented in `docs/membership-invitations.md` §4; no email confirmation step exists |
| Email enumeration by an administrator at invite time | Low | Accepted and documented: an administrator must be able to invite; the audit trail names them |
| No PITR; backups are application-data only | Medium | Unchanged, documented in the runbook §9/§16 |
| The e2e harness writes real rows into its target database | Low | It requires `SAAS_ENVIRONMENT`/`SAAS_DATABASE_IDENTIFIER` and is meant for a disposable target; never point it at production |
