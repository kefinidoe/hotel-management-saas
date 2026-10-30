# Production deployment checklist

Prepared, **not executed**. Nothing in this document has been run against production, and it must not
be until the owner has completed acceptance testing and given explicit approval.

The test environment described in [OWNER-ACCEPTANCE-TESTING.md](OWNER-ACCEPTANCE-TESTING.md) is a
different database on a different host. It must never be pointed at production data, and production must
never be pointed at it.

---

## 0. Gate

| Gate | State | Evidence |
|---|---|---|
| Owner acceptance testing | **NOT STARTED** | this round hands the environment over |
| Genuine backup restored and integrity-checked | **BLOCKED** | `docs/handoff-production-verification.md` §1 |
| Native Prisma engine verified on the target | **BLOCKED** | `docs/handoff-production-verification.md` §2; `npm run native-engine:verify` |
| Owner's explicit written approval | **PENDING** | — |

Deployment may not proceed until every row above is PASS or an explicit, recorded owner waiver.

---

## 1. Environment variables

Set these on the production host (a secret manager, not a committed file). `.env.example` documents the
shape; none of the values belong in Git.

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Pooled connection string for the application user |
| `DIRECT_URL` | yes | Direct (non-pooled) URL, used by migrations |
| `NEXTAUTH_SECRET` | yes | 32+ random bytes. Rotating it signs everybody out |
| `NEXTAUTH_URL` | yes | Exact public origin, `https://…`, no trailing slash. The CSRF guard compares against it |
| `SAAS_ENVIRONMENT` | yes | `saas` in production (`local` only for the demo seeder) |
| `SAAS_DATABASE_IDENTIFIER` | yes | Must match the real database name; the safety guard compares it to `DATABASE_URL` |
| `NODE_ENV` | yes | `production` |
| `SAAS_ALLOW_LOCAL_DEMO_SEED` | **must be unset** | The demo seeder refuses to run without `SAAS_ENVIRONMENT=local` as well |

Start-up fails closed when the guard variables are missing or disagree — that is intended, not a bug to
work around. `scripts/db-safety-guard` refuses to connect when `SAAS_ENVIRONMENT` and the URL disagree.

## 2. Database

1. Provision PostgreSQL 15+ (the project targets 17). Enable automated daily backups with point-in-time
   recovery **before** the first migration.
2. Create a dedicated role for the app with `CONNECT`, `USAGE` and DML rights on the application schema —
   not a superuser, and not the migration role.
3. Create a separate migration role for `prisma migrate deploy`.
4. Run `npm run migration:manifest` — it must report that the release manifest matches the 19 migration
   files shipped in the build.
5. Apply migrations with `npx prisma migrate deploy` (never `migrate dev`, never `db push`).
6. Confirm the ledger: `npm run migration:checkpoints` and `node scripts/target-check.mjs --url "$DIRECT_URL"`
   must both pass, and the checkpoint must read `saas_current`.
7. For a database that already holds the Axis schema but no ledger, use `npm run migration:adopt`
   (dry run first) — [migration-strategy.md](migration-strategy.md) §4.2.
8. Seat the checkpoint: `npm run migration:verify-engine` must pass on the production host.

## 3. Prisma engine

The client must run on the **native** engine:

* `prisma generate` (or `npm ci` without `--ignore-scripts`) must be able to reach `binaries.prisma.sh`;
* the installed `libquery_engine-debian-openssl-3.0.x.so.node` must match
  `077e86821d96c3225ec75c4e2172822f8969cd4f720942f944bc853ea1b77f9f` (see `scripts/prisma-engine-pins.mjs`);
* `npm run native-engine:verify -- --json` must print `PASS` **on the deployed image** — it checks the
  digest, loads the library into the running Node major, asserts `engineType: "library"`, runs a query
  and a rolled-back write.

A WASM build (the local test aid) must never be deployed. If the verifier reports `BLOCKED`, the
deployment is blocked.

## 4. Authentication

* Same-origin protection: `lib/request-origin.ts` accepts a request only when `Origin` matches
  `NEXTAUTH_URL`, or when `Sec-Fetch-Site: same-origin`, or (only when both are absent) the `Host`
  header is the configured host. Set `NEXTAUTH_URL` to the real public origin or writes will be refused.
* Session cookies: `httpOnly`, `secure` in production, `sameSite=lax`, 12-hour JWT lifetime with hourly
  refresh. Confirm the cookie is issued with the `__Secure-` prefix over HTTPS.
* Behind a proxy or CDN, forward `Host`, `X-Forwarded-Proto` and `X-Forwarded-For`, and do not strip
  `Origin` or `Sec-Fetch-*`.
* Rate-limit `/api/auth/callback/credentials` and `/api/auth/register` at the edge.
* Platform super-admin accounts must not be shared with hotel staff.

## 5. Domain, TLS, transport

* HTTPS only; redirect HTTP with HSTS (`max-age=31536000; includeSubDomains`).
* One canonical hostname in `NEXTAUTH_URL`. Extra hostnames (www, an old domain) must 301 to it, or
  writes will be rejected as cross-origin — by design.
* Security headers at the edge: `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
  `X-Frame-Options: DENY` (the app never needs to be framed), and a CSP that allows `'self'` plus the
  inline styles Next.js emits.

## 6. Subscription and billing configuration

* Plans and room bands come from `lib/plans.ts`; prices are per `billingInterval`. Confirm the amounts
  and room limits for each plan with the owner **before** the first live subscription is created.
* Trials: `Subscription.trialEndsAt` is authoritative. A hotel past its trial without an active
  subscription is limited to billing recovery (`/dashboard/subscription`).
* Suspension blocks operational writes and keeps data intact; reactivation restores access without a
  migration.
* Invoices/receipts are folio-based today (folio + items + payments). If the owner needs sequential
  invoice numbers for tax, that is a product change to schedule, not a configuration switch.

## 7. Backups and restore

1. Automated daily full backup **plus** point-in-time recovery, stored off the database host, encrypted,
   with a retention policy agreed with the owner.
2. Encrypt backups and record their SHA-256 at creation, so a restore can prove it used the right file.
3. Rehearse a restore into an isolated server at least quarterly:
   `node scripts/restore-rehearsal.mjs --dump … --expect-sha256 … --base-url postgresql://…/postgres`
   followed by `npm run db:integrity -- --json`. The rehearsal drops its own scratch database.
4. Store the rehearsal output under `docs/evidence/restore/`.
5. Never restore over production without first taking a fresh backup of the current state.

## 8. Monitoring and error logging

| What | Where |
|---|---|
| Application logs | stdout/stderr, collected by the platform; look for `Failed to write audit log entry`, `Failed to write notification`, `prisma:error` |
| Failed 5xx responses | edge/platform access logs; the API returns typed errors (`FORBIDDEN`, `UNAUTHORIZED`, `CONFLICT`) rather than stack traces |
| Database | connection count, slow queries (>1 s), replication lag if any |
| Availability | GET `/login` (public) every minute; alert on two consecutive failures |
| Certificate | expiry alert 30 days ahead |
| Business health | a hotel with zero payments for 7 days while it has checked-in guests is worth a human look |

Alerts go to a channel the owner reads. Log retention: 30 days minimum, 90 preferred.

## 9. Rollback

1. Keep the previous release build and its environment snapshot until the new one has been healthy for
   48 hours.
2. **Migrations are forward-only.** None of the 19 migrations can be reversed safely; rolling back code
   past a migration that changed a constraint requires a restore, so plan migrations separately from
   releases when possible.
3. Code rollback: redeploy the previous image, restoring its environment variables. The database stays
   as-is; the previous code must therefore tolerate the newer schema (additive changes only — the current
   chain satisfies this).
4. Data rollback: restore from the pre-deployment backup into a **new** database, verify with
   `npm run db:integrity`, then repoint `DATABASE_URL` after approval.
5. Record every rollback in the same place incidents are recorded, with the times and the backup used.

## 10. Security review before go-live

| Check | How |
|---|---|
| No secrets in Git | `git log -p -- .env* | grep -i secret` returns nothing; `.env*` is ignored except `.env.example` |
| Demo seed cannot reach production | `assertLocalDemoSeedTarget` requires `SAAS_ENVIRONMENT=local` + a `hotel_saas_demo_*` database on loopback |
| Tenant isolation | 33 browser steps and the tenant-isolation test suite; re-run against the release candidate |
| Role enforcement | Every API route checks a role group; `/dashboard` pages re-check server-side |
| Password storage | bcrypt, cost 10, no plaintext anywhere; the audit log never records passwords |
| Session fixation | NextAuth JWT with a signed, httpOnly cookie; sign-out clears it |
| CSRF | same-origin guard on state-changing routes; NextAuth CSRF token on auth routes |
| Rate limiting | at the edge for auth endpoints — the app itself does not rate-limit |
| Dependency audit | `npm audit --omit=dev` reviewed; no critical advisories at release time |
| Backups encrypted | verified by restoring one into the isolated server |
| Least privilege | app role cannot `DROP`; migration role separate; super-admin accounts limited |

## 11. Go-live sequence

1. Owner approval recorded, with a date and a fresh backup timestamp.
2. Freeze schema changes; tag the release commit.
3. Take a fresh production backup and record its digest.
4. Deploy the build; run `npm run native-engine:verify` on the host.
5. Run `npx prisma migrate deploy`; confirm `npm run migration:checkpoints` and `target-check`.
6. Smoke test: sign in as a throwaway owner, create a hotel, add a room type and room, take a
   reservation, check in, take a payment, check out. Then delete the throwaway data with
   `npm run db:clean` (or the platform console) — never by hand in SQL.
7. Run `node scripts/e2e-smoke.mjs --base https://… --allow-remote` if the environment allows it, and
   `npm run test:browser -- --base https://…` against the deployed candidate.
8. Watch the dashboard and error log for 48 hours; keep the previous build deployable.
9. Confirm the live Axis Hotel system was never contacted: no command above defaults to its URL, and its
   credentials were never placed in this environment.

## 12. Post-deployment

* Re-run the restore rehearsal within a week of go-live, and then quarterly.
* Keep the demo environment separate and disposable; it holds invented data only.
* Rotate `NEXTAUTH_SECRET` only with a planned sign-out window.
* Review the audit trail monthly for staff changes, and the subscription console for hotels past their
  trial.
