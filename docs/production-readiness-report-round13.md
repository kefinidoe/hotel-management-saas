# Production readiness — round 13 (final verification)

Date: 2026-10-30 · Branch `arena/d28d7e4a-hotel-management-saas` · Base `main` = `2ad417e`
Commits this round: `b17a353`, `ff5246c`, `c9fd215`, `a9c1180`, `dce4b93`, plus this report's commit.

This round did what round 12 could not: it put a real browser on the recovery runbook's browser cases
and it fixed what the browser found. It also settled the two remaining prerequisites — the production
archive and the native query engine — with a verdict each, `BLOCKED`, and the exact missing access plus
a runnable handoff in [handoff-production-verification.md](handoff-production-verification.md).

**Nothing was deployed.** The deployment gate in §6 is unchanged and still closed.

---

## 1. Verdict

| # | Criterion | Verdict | Evidence |
|---|---|---|---|
| 1 | Genuine production archive restored into isolated PostgreSQL, integrity checks investigated | **BLOCKED** | §3 — archive bytes absent; access gap and handoff in the handoff doc §1 |
| 2 | Browser automation available and the runbook's browser cases executed; multi-hotel, multi-role; screenshots and results recorded; defects fixed and re-run | **PASS** | §4 — 25/25, `docs/evidence/browser/` (25 PNGs), `docs/evidence/browser-results.json` |
| 3 | Native Prisma engine generated **and loaded** in the intended production environment, connectivity and critical operations proven with it | **BLOCKED** | §5 — no binary source here; `node scripts/native-engine-verify.mjs` → `BLOCKED` (exit 2), handoff doc §2 |
| 4 | Report updated with evidence, commits, results, remaining risks | **PASS** | this document |

Supporting gates, all re-run on the final code:

| Gate | Result |
|---|---|
| Unit + integration (vitest) | **823 passed / 823**, 54 files |
| HTTP end-to-end (`scripts/e2e-smoke.mjs`) | **46/46 PASS** |
| Browser end-to-end (`scripts/browser-e2e.mjs`) | **25/25 PASS** (68 s) |
| Database integrity on the migrated schema (`db:integrity`) | **49/49**, `ok: true` |
| `tsc --noEmit` | 0 errors |
| `eslint .` | 0 problems |
| `next build` | PASS |
| Migrations from empty | 19/19 → 28 tables |
| `npm run migration:readiness` | 3 BLOCKED prerequisites + 1 PENDING APPROVAL (§3, §5) |

---

## 2. What the browser run found, and the fixes

A browser was not available in this environment in round 12, and the HTTP harness cannot see the
difference between "the server returned 200" and "the application works". Four defects lived in that
gap. Each was found by a failing step with a screenshot, fixed, and re-run to green.

### 2.1 Hotel switching was broken for every user with more than one hotel — `b17a353`

`POST /api/auth/switch-hotel` rejected requests that carried no `Origin` header. Chromium does not send
`Origin` on a same-origin `fetch()`, so the application's own request was refused with
`403 CSRF_ORIGIN_INVALID` — while `scripts/e2e-smoke.mjs` passed, because it sets the header by hand.

`lib/request-origin.ts` now decides on both signals a browser actually provides: `Sec-Fetch-Site:
cross-site` is rejected outright; a present `Origin` must equal `NEXTAUTH_URL`; with no `Origin`,
`Sec-Fetch-Site: same-origin` is accepted; neither header fails closed. Cross-site form posts carry
both headers and are still refused, so the protection is unchanged in the direction that matters.
Eight unit tests pin the matrix (`__tests__/auth/request-origin.test.ts`).

Not a browser-only nicety: this bug made multi-hotel accounts unusable in production.

### 2.2 An invited staff member was shown as an active one — `ff5246c`

The add-staff dialog rendered `status: "ACTIVE", isActive: true` locally when the API had answered
`202 { status: "SUSPENDED", invitationPending: true }` — telling an administrator that a person had
access they did not have. It now carries the invitation through, the table shows *Invitation pending*,
and the success message says access begins on acceptance. The Initial Password field was `required` in
the DOM even though its label said "new accounts only", and was `type="text"`: the only way to invite
an existing account was to invent a visible password for someone else's account. The field is now
optional, typed as a password, and the server requires a password only in the branch that creates a
new account.

### 2.3 Rooms created in the UI could not be booked — `c9fd215`

The reservation dialog selects a tariff by occupancy and meal plan; the room-type form had no meal-plan
field, so every room type created through the UI stored `mealPlan: null`, matched no tariff, and *Create
Reservation* stayed disabled. A hotel could complete setup and still be unable to take a booking. The
form now offers BED_ONLY / BED_AND_BREAKFAST / HALF_BOARD, defaults to BED_ONLY, restores it on edit and
shows it in the list; the frontend contract test asserts the new payload field.

### 2.4 The POS menu needed a manual reload — `a9c1180`

Adding a category or item left the menu untouched and told the operator to refresh. Because the menu is
a server-rendered prop, a new category could not be selected, so the item form pointed at nothing and a
new hotel could not create its first menu item at all. Both handlers now call `router.refresh()` and keep
the selected category valid.

### 2.5 The harness itself (found and fixed, no product change)

Puppeteer's `click({ clickCount: 3 })` + `type()` does not clear a React controlled input; a stale
`50000` stayed in a field with `max=5000`, the browser blocked the submit, and the step failed silently.
A `replaceValue()` helper (click, Ctrl+A, Backspace, type) now backs every text fill. The check-in step
was also wrong about the product: checking in with no payment legitimately leaves a balance, so the
folio shows *Collect Payment* rather than *Complete Checkout*; the step now accepts either state, pays
the balance, and then completes checkout. A database check confirmed the app's behaviour was right both
times.

---

## 3. Criterion 1 — genuine restore: BLOCKED

Round 12 established that `hotel-management-saas-20261028-140823.dump` (384 096 bytes, SHA-256
`F81566E9…B24A7`) is not in this workspace. Round 13 re-ran the search from scratch and widened it:

| Where | Result |
|---|---|
| Filesystem (`*.dump`, `*.backup`, `*.sql.gz`, `pg_dump*`) | none |
| Every remote branch (`git fetch origin '+refs/heads/*'` + `git ls-tree -r`) | none; the only `recovery/` file is `recovery/full-arena-worktree.patch`, a source patch |
| GitHub releases, assets, repository contents | no assets at all |
| Prior-session patch and evidence | describe the archive and pin its digest; no bytes |

`npm run migration:readiness` — the repository's own gate — says the same:

```
archive     : BLOCKED — no archive supplied; expected hotel-management-saas-20261028-140823.dump,
              384096 bytes, sha256 f81566e9…77db24a7
credentials : BLOCKED — SAAS_ENVIRONMENT, SAAS_DATABASE_IDENTIFIER and DIRECT_URL are set, but the
              target has not been contacted
engine      : BLOCKED — no artifacts supplied (PRISMA_SCHEMA_ENGINE_BINARY / PRISMA_QUERY_ENGINE_LIBRARY)
approval    : PENDING APPROVAL — owner sign-off for the deployment window
Decision    : BLOCKED — 3 of 3 prerequisites are not demonstrated
```

**The missing access is one file's bytes.** Everything else for this criterion is in place and was
re-proven this round on a disposable PostgreSQL 17.11 cluster: 19 migrations from empty → 28 tables,
then `db:integrity` **49/49, `ok: true`**. The tool-check archive was *not* substituted; a restore of the
demo archive proves the tooling and nothing about the owner's data, and round 9 already did it.

Run the four commands in [handoff §1](handoff-production-verification.md#1-the-production-archive--blocked-the-files-bytes-are-not-in-this-environment)
on a host that has the file: digest first, then `--toc`, then the rehearsal into a scratch database, then
`db:integrity --json`. Keep `restore-evidence.json` and `integrity.json`; every failing check gets its
cause fixed, not its check relaxed.

---

## 4. Criterion 2 — browser testing: PASS

### 4.1 The environment

There was no browser and no way to install Chrome's system dependencies here (the Playwright CDN is
unreachable). `@sparticuz/chromium@153.0.0` — headless Chromium for AWS Lambda, unpacked from its own
`.br` archives — plus `puppeteer-core@25.16.0` runs here, and both are now real devDependencies, so the
suite is reproducible rather than a one-off in `/tmp`:

```bash
DATABASE_URL=postgresql://…/scratch npm run test:browser -- \
  --base http://127.0.0.1:3100 --out docs/evidence/browser --json docs/evidence/browser-results.json
```

Options: `--only step,step`, `--headed`, per-step `psql` assertions when `DATABASE_URL` is set. Every step
writes a PNG; a failure writes the PNG, the page HTML and the network log, and every `/api/` 4xx/5xx
response is recorded with its body — which is how the `switch-hotel` 403 was identified rather than
guessed at.

### 4.2 The cases — 25/25, two hotels, four roles

`docs/evidence/browser-results.json`, screenshots `docs/evidence/browser/NN-<step>.png`
(Chromium 153.0.8010.0, 68 s):

| Hotel / role | Steps |
|---|---|
| Hotel A — owner | `hotel-a-register`, `hotel-a-dashboard`, `rooms-create-type`, `rooms-create-room`, `staff-add-new-account` |
| Hotel B — owner | `hotel-b-register`, `tenant-isolation-a`, `tenant-isolation-b` |
| Invitations | `invitation-sent`, `invitation-not-yet-access`, `invitation-accepted` |
| Multi-hotel | `hotel-switch` |
| Roles | `role-sign-in`, `role-navigation`, `role-direct-url-denied` |
| Front office | `reservation-create`, `check-in`, `folio-payment-checkout` |
| Operations | `housekeeping-task`, `maintenance-ticket`, `inventory-item` |
| Restaurant | `pos-sale` |
| Reporting / billing | `reports-render`, `subscription-render` |
| Session | `sign-out` |

All 25 `PASS`. Isolation is tested in both directions (A cannot see B's data and B cannot see A's), and
the role steps sign in as receptionist and as a staff account with no permissions, then assert that a
direct URL to a forbidden page is refused rather than merely hidden from the menu.

Result on the final code, `npm run test:browser`:

```
Result: PASS — 25/25 browser steps passed
```

### 4.3 Failures and repeats

| Run | Result | Cause |
|---|---|---|
| 1 | 11/25 | harness: modals, labels, calendar cells |
| 2 | 15/25 | harness; invitation UI defect exposed |
| 3–4 | 19/25 | harness; meal-plan defect, POS refresh defect |
| 5 | 21/25 | `switch-hotel` 403 → product defect 2.1 |
| 6 | 22/25 | `hotel-switch` PASS after fix; harness clearing bug exposed |
| 7 | 5/8 (subset) | harness assumption about check-in balance |
| final | **25/25** | — |

Each failure is recorded in the round-13 scratch logs; the fixes are the commits in the header and the
final artifacts are the committed evidence.

---

## 5. Criterion 3 — native engine: BLOCKED

The query engine production needs is `libquery_engine-debian-openssl-3.0.x.so.node` for Prisma 5.17.0
(commit `393aa359…`, unpacked SHA-256 `077e8682…f9f`), downloaded from `binaries.prisma.sh`. In this
sandbox that host never completes a TLS handshake (`curl` exit 35, HTTP 000), and every alternative was
checked and is empty:

* `@prisma/engines@5.17.0`'s npm tarball is 24 KB and contains only `dist/*.js` — the postinstall
  downloader, no binaries;
* `prisma/prisma-engines` publishes no releases and no assets;
* npm search finds no package shipping a 5.17.0 native engine for Debian/OpenSSL 3 (the
  `@prisma/*-wasm` packages are WASM — a different engine, and not evidence);
* building from source needs Rust and `crates.io`, also unreachable.

So `npm ci` leaves a 4-byte placeholder at `node_modules/.prisma/client/libquery.so.node` and `prisma
generate` falls back to the WASM build. The application in this workspace **has never run on the native
engine**, and its green tests are evidence about the application, not about the engine — exactly the
distinction the criterion draws.

To make the deployment check a command rather than a paragraph, this round adds
`scripts/native-engine-verify.mjs`. It verifies the pinned digest, `require()`s the shared object to prove
the ABI against the running Node major, asserts the application's Prisma client reports
`engineType: "library"` (i.e. is not on the WASM shim), and then runs `SELECT version()`, a real
`hotel.count()` and a write inside a transaction that is rolled back. Exit `0` PASS, `1` FAIL,
`2` BLOCKED. Here:

```
$ node scripts/native-engine-verify.mjs --json
verdict: BLOCKED   (exit 2)
artifact  BLOCKED  @prisma/engines/libquery_engine-debian-openssl-3.0.x.so.node          — missing
                   .prisma/client/libquery_engine-debian-openssl-3.0.x.so.node           — missing
                   .prisma/client/libquery.so.node                                       — placeholder (4 bytes)
```

Run it on the deployment image with the real engine installed
([handoff §2](handoff-production-verification.md#2-the-native-prisma-engine--blocked-no-source-for-the-binary-in-this-environment)).
Only `PASS` from that host is evidence; the WASM build will not produce it.

---

## 6. Deployment gate

**Not approved.** In order:

1. Genuine archive digest verified and restored into disposable PostgreSQL, `db:integrity` green with
   every failure investigated (handoff §1).
2. `scripts/native-engine-verify.mjs` → `PASS` on the target image (handoff §2).
3. `npm run migration:readiness -- --dump … --expect-sha256 … --check-target` → all prerequisites PASS.
4. Browser suite against the deployment candidate, 25/25, with screenshots.
5. Owner's explicit approval and a fresh backup taken immediately before the window.

The live Axis Hotel system stays isolated throughout: no command above defaults to a production URL, and
the restore's `--base-url` must be a disposable server.

---

## 7. Remaining risks

| Risk | State | Mitigation |
|---|---|---|
| Production archive never restored here | BLOCKED | handoff §1; the procedure is proven on an archive built in-repo (round 9), and the target-side run is four commands |
| Native engine never loaded here | BLOCKED | handoff §2; `native-engine-verify.mjs` gives a pass/fail answer on the real host |
| Same-origin CSRF logic is new | Mitigated | 8 unit tests; the two-header rule fails closed; hotel switching exercised by the browser suite |
| Browser suite uses SQL assertions against a disposable DB | Accepted | the same steps assert through the UI; DB checks are an extra, not the only evidence |
| Chromium is the Lambda build (153.x) | Accepted | same Blink/DevTools protocol as desktop Chrome; the suite does not depend on Lambda-specific behaviour |
| `@sparticuz/chromium` + `puppeteer-core` are dev-only | Accepted | not in the production bundle; `npm ci --omit=dev` is unaffected |
| Round-13 evidence images are 3.0 MB in Git | Accepted | project convention for evidence; 25 files |
| Stale scratch data in the local cluster | Accepted | everything ran against `hms_recovery` on a disposable server, never a populated system |

---

## 8. Reproducing this round

```bash
# disposable PostgreSQL 17.11 on :55432, database hms_recovery
npm ci --ignore-scripts
npx prisma generate            # WASM fallback here — see §5
npx tsc --noEmit && npm run lint
env -u DATABASE_URL -u SAAS_ENVIRONMENT -u SAAS_DATABASE_IDENTIFIER -u DIRECT_URL vitest run   # 823
npx next build && npx next start -p 3100 -H 0.0.0.0
node scripts/e2e-smoke.mjs --base http://127.0.0.1:3100 --json      # 46/46
npm run test:browser -- --base http://127.0.0.1:3100 \
  --out docs/evidence/browser --json docs/evidence/browser-results.json   # 25/25
npm run db:integrity -- --json                                     # 49/49
node scripts/native-engine-verify.mjs --json                       # BLOCKED (exit 2) here; PASS on the host
npm run migration:readiness                                        # BLOCKED: archive, credentials, engine
```
