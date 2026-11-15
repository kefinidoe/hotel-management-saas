# Diagnostic report — `prisma.hotelPricingSettings` is `undefined` on Pricing & Rates

> **Resolution (same day):** the diagnosis below was confirmed and fixed. The client was stale, and
> the silent fallback it exposed is gone. See `docs/pricing-engine.md` §9a and the commit that follows
> this report: start-up guard (`lib/prisma.ts`), build check (`scripts/check-prisma-client.mjs`),
> fail-closed configuration reads (`lib/pricing/config.ts`), typed 503s on every pricing route, and the
> tests listed there.

**Round 17 · read-only investigation · 2026-10-31**
No code, schema, migration, database, env or configuration was modified while producing this report.
The only file written is this document.

---

## 0. Environment snapshot (read this first)

| Item | Value |
| --- | --- |
| Repo | `/home/user/hotel-management-saas` |
| Current branch | `arena/5e8e045b-hotel-management-saas` |
| Local `HEAD` (detached from remote content) | `4514a5f29cf8be715a2219c26fc1312c7354648a` — *"Merge pull request #20"* |
| Remote branch head (`git ls-remote`) | `d3725926277c066dabe69e698afb83b4ec57966a` (PR #21, **OPEN**, `MERGEABLE`) |
| Working tree | pricing engine present but **uncommitted**: `M prisma/schema.prisma`, `?? lib/pricing/`, `?? app/api/pricing/`, `?? app/dashboard/settings/pricing/`, `?? components/pricing/`, `?? prisma/migrations/20261031120000_add_pricing_engine/`, `?? prisma/migrations/20261031160000_price_version_history/`, `?? prisma/migrations/20261101120000_add_reservation_extension_history/` (+ test/doc files) |
| `node_modules/` | **absent** in this sandbox (snapshot excludes it) |
| Local PostgreSQL (port 55433) / running app (port 3000) | **absent** — no listeners |

**Consequences for this investigation**

* Everything about the *source of truth* (schema, migrations, application code, git history, PR content) could be verified.
* The two runtime artefacts the crash depends on — the **generated Prisma Client actually in use** and the **table presence in the live database** — **cannot be inspected from this sandbox right now** (no `node_modules`, no database, no server). Those two checks are marked **BLOCKED-HERE** below, with exact read-only commands you can run in your own environment.

> ⚠️ Note the git discrepancy: local `HEAD` is `4514a5f` and the pricing engine exists **only as uncommitted/untracked working-tree files**, while the remote branch at `d372592` has it committed. That means the sandbox has been through at least one rollback (the PR history itself contains a commit titled *"Restore PR #21 working-tree changes after sandbox rollback"*). This is reported, not fixed.

---

## 1. Does `HotelPricingSettings` exist in `prisma/schema.prisma`?

**Yes.** `prisma/schema.prisma:1027`, identical on the remote branch head `d372592` (verified through the GitHub API, not from local files).

```prisma
model HotelPricingSettings {
  id                  String       @id @default(uuid())
  hotelId             String       @unique
  hotel               Hotel        @relation(fields: [hotelId], references: [id], onDelete: Cascade)
  pricingModel        PricingModel @default(LEGACY_BASE_RATE)
  useOccupancyRates   Boolean      @default(false)
  useMealPlans        Boolean      @default(false)
  useSeasonalPricing  Boolean      @default(false)
  useWeekendPricing   Boolean      @default(false)
  useChildPricing     Boolean      @default(false)
  useExtraBeds        Boolean      @default(false)
  useTaxes            Boolean      @default(false)
  pricesIncludeTax    Boolean      @default(false)
  updatedAt           DateTime     @updatedAt
  createdAt           DateTime     @default(now())
}
```

Related pieces that must exist for this page to work: enum `PricingModel`, and the `Hotel.pricingSettings HotelPricingSettings?` back-relation. **It is not on `main`**: `prisma/schema.prisma` at `4514a5f` contains **0** occurrences of `hotelPricingSettings`.

## 2. Exact model name and generated client accessor

* Model: `HotelPricingSettings`
* Accessor: **`prisma.hotelPricingSettings`** (Prisma camel-cases the model; the model name already ends in `s`, so the delegate is *not* `hotelPricingSetting`).
* `prisma/schema.prisma` is the one the code uses: `app/dashboard/settings/pricing/page.tsx` → `listPricingBundle()` → `prisma.hotelPricingSettings.findUnique({ where: { hotelId } })` (`lib/pricing/admin.ts:129`).

## 3. Is the model present in the generated client used by the running app?

**BLOCKED-HERE — cannot be verified in this sandbox** (`node_modules/` does not exist; there is no running server to introspect).

What *is* verifiable is the generation configuration, which determines where the client lives:

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["relationJoins"]
}
```

* **No `output` override** → the client is generated into the default location `node_modules/.prisma/client`, and `lib/prisma.ts` imports it via `import { PrismaClient } from "@prisma/client"` — the standard single-instance path. No custom output directory, no `prisma-client` (new generator) variant.
* `package.json`: `@prisma/client` **5.17.0**, `prisma` **5.17.0**; `"postinstall": "prisma generate"` and `"build": "prisma generate && next build"`.

Read-only checks to run where the app runs:

```bash
cd /path/to/hotel-management-saas
grep -c "hotelPricingSettings" node_modules/.prisma/client/index.d.ts   # 0 => stale client
grep -c "hotelPricingSettings" node_modules/.prisma/client/index.js     # 0 => stale client
ls -l --time-style=full-iso prisma/schema.prisma node_modules/.prisma/client/index.d.ts
node -e 'const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();
console.log(Object.keys(p).filter(k=>/pricing|occupancy|mealPlan|taxRule|extraBed|childPricing|rateAdjustment/.test(k)));
p.$disconnect()'
```

If that `Object.keys(...)` list is empty (or lacks `hotelPricingSettings`), the client in use was generated from a schema **without** the pricing engine, which is exactly the observed symptom. (Constructing the client and disconnecting runs no query.)

## 4. Did PR #21 introduce or rename this model?

* **Introduced, not renamed** — added wholesale by branch commit **`f592894e` "feat(pricing): tenant-scoped configurable pricing engine with frozen snapshots"**. Its parent `c3da6f1` has **zero** `PricingSetting*` / `PricingModel` occurrences, so there was no earlier name to rename from.
* PR #21 is the umbrella PR for this branch, so the model appears in its diff, but the later commits — `03e18693` (pricing hardening) and **`d372592`** (round-16 delete/extension work) — did not introduce or rename it. Round 16's schema change was `ReservationExtension` (migration 22) only.
* Commits touching `prisma/schema.prisma` on this branch: `f592894e`, `03e18693`, `d372592` (plus the pre-existing `main` history).

**Implication:** if your running install was built from `main` (or from any checkout made before `f592894e`), its generated client cannot contain the delegate.

## 5. Is the local generated client stale / generated from a different schema?

**Most likely yes (cannot be proven here; see §3 commands).**

Reasoning chain that matches the reported stack exactly:

1. `lib/pricing/admin.ts:128-129` builds one `Promise.all([...])` array. Array elements are evaluated **left to right**, so `prisma.hotel.findUnique(...)` runs first (hence "the hotel query is reached"), and `prisma.hotelPricingSettings.findUnique(...)` throws as the *second* element.
2. `prisma.hotel` exists in every generation of this schema; `prisma.hotelPricingSettings` exists **only** from `f592894e` onward.
3. So the process that served the request has a Prisma Client built from a schema predating `f592894e` — either never regenerated after the pricing files landed, or regenerated from `main`.
4. All other delegates in that same array (`occupancyType`, `roomTypeOccupancy`, `mealPlanConfig`, `mealPlanRoomType`, `rateAdjustment`, `extraBedRule`, `childPricingRule`, `taxRule`) are missing for the same reason — the crash only names `hotelPricingSettings` because it is the first pricing delegate evaluated.

Two related, distinguishable sub-cases:

* **Stale on disk** (no `prisma generate` after the schema change, or generated from `main`): fix is a regenerate + rebuild/restart.
* **Stale in memory** (`prisma generate` was run but the long-running `next dev`/`next start` process was not restarted). `lib/prisma.ts` caches the instance on `globalThis.prisma` in non-production (`if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;`), so a process started before regeneration keeps the old delegate table until it is restarted. `npm run build` itself runs `prisma generate`, so a **production build made before the schema change** and then merely restarted still serves the old client bundle from `.next` + the old client in `node_modules` until `prisma generate` runs again.

## 6. Does the table-creating migration exist, and is it applied to the local SaaS DB?

* **Migration exists:** `prisma/migrations/20261031120000_add_pricing_engine/migration.sql` (lines 226-246):

```sql
CREATE TABLE "HotelPricingSettings" (
    "id" TEXT NOT NULL,
    "hotelId" TEXT NOT NULL,
    "pricingModel" "PricingModel" NOT NULL DEFAULT 'LEGACY_BASE_RATE',
    ...
    CONSTRAINT "HotelPricingSettings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "HotelPricingSettings_hotelId_key" ON "HotelPricingSettings"("hotelId");
ALTER TABLE "HotelPricingSettings" ADD CONSTRAINT "HotelPricingSettings_hotelId_fkey"
    FOREIGN KEY ("hotelId") REFERENCES "Hotel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

It is the only migration that mentions the table (`grep -rl HotelPricingSettings prisma/migrations` → 1 file). Branch migrations, in order: `…20261031120000_add_pricing_engine`, `…20261031160000_price_version_history`, `…20261101120000_add_reservation_extension_history`.

* **Applied to the current local SaaS DB: BLOCKED-HERE.** There is no PostgreSQL server and no database in this sandbox any more (no `_owner-test` data dir, nothing listening on 55433), so the ledger and the table could not be queried. Read-only verification:

```bash
psql "$DATABASE_URL" -c "select to_regclass('public.\"HotelPricingSettings\"') as table_present;"
psql "$DATABASE_URL" -c "select migration_name, finished_at from _prisma_migrations order by finished_at desc nulls last limit 8;"
```

Note: a **missing table would produce a different error** (Prisma `P2021` "The table `public.HotelPricingSettings` does not exist", or a caught failure inside `safeFindMany`), **not** `Cannot read properties of undefined (reading 'findUnique')`. The observed message is a *missing client delegate*, i.e. a generation problem, not a migration problem. The migration state matters only for what happens **after** the client is regenerated.

## 7. Does the app import the expected client, and are there multiple clients/versions?

* **Single expected instance.** `lib/prisma.ts:69-77` is the only application-level instantiation (`new PrismaClient({...})`), cached on `globalThis` outside production, exported as `prisma`. `lib/pricing/admin.ts` and `lib/pricing/config.ts` both import `{ prisma } from "@/lib/prisma"`.
* Other `new PrismaClient()` sites are standalone CLI scripts only, and they also resolve `@prisma/client` from the same root `node_modules`: `scripts/clean-test-data.ts`, `scripts/reset-password.ts:26`, `prisma/seed.ts:17`, `scripts/owner-test/seed-demo.ts:37`.
* `package-lock.json` has exactly one `node_modules/@prisma/client` and one `node_modules/prisma` entry — **no duplicate/nested client**, no workspace hoisting, no second `output` path. (This sandbox cannot enumerate `node_modules` to double-check for stray copies, but the lockfile and generator config rule out a configured second client.)
* **No client-side bundling of Prisma.** No `"use client"` file imports `@/lib/prisma`, `@/lib/pricing/admin` or `@/lib/pricing/config` (checked across `app/` and `components/`). `app/dashboard/settings/pricing/page.tsx` is a server component (`export const dynamic = "force-dynamic"`), so the stack you saw in Chrome is the **server-side** error surfaced by the Next.js error overlay/dev overlay — not a browser bundle executing Prisma.

## 8. Other places that use `prisma.hotelPricingSettings` and are affected

| Location | Usage | Behaviour with a stale client |
| --- | --- | --- |
| `lib/pricing/admin.ts:129` (`listPricingBundle`) | `findUnique` | **Hard crash** — the reported error |
| `lib/pricing/admin.ts:257` (`upsertPricingSettings`) | `upsert` | **Hard crash** on any settings save/add-rate action |
| `lib/pricing/config.ts:65` (`loadPricingConfig`) | `findMany` via `safeFindMany` | **No crash — silent fallback** |

Affected callers/entry points:

* `app/dashboard/settings/pricing/page.tsx` (Settings → Pricing & Rates page) — crashes.
* `app/api/pricing/route.ts:32` `GET` — same crash (same function); the PUT/DELETE entity routes (`app/api/pricing/[entity]/route.ts`, `app/api/pricing/room-rates/route.ts`) fail via `upsertPricingSettings`.
* `app/api/reservations/route.ts:112`, `app/api/reservations/quote/route.ts:67`, `app/api/reservations/[id]/reprice/route.ts:190` — use `loadPricingConfig`, whose `safeFindMany` deliberately swallows a missing delegate:

  ```ts
  const model = delegate(client, name);
  if (!model?.findMany) return [];
  ```

  So reservations still get created/quoted/repriced, **but every pricing table reads back empty**: occupancy rates, meal plans, seasonal/weekend/child pricing, extra beds and **tax rules** are all ignored and the hotel falls through to `RoomType.baseRate` (`LEGACY_BASE_RATE`). That is a silent pricing-authority degradation — no error shown, just wrong money.

**This asymmetry is itself evidence:** the codebase already anticipated "an installation whose client/schema predates the pricing tables" in the reservation path but not in the admin path.

---

## 9. Verdict

| Hypothesis | Verdict |
| --- | --- |
| **Schema issue** (model missing/misnamed) | **Ruled out** — model present at `prisma/schema.prisma:1027` on both the working tree and remote `d372592`; accessor name matches the call site. |
| **Migration issue** (table not created/applied) | **Ruled out as the cause of this message** — migration file exists with correct SQL; a missing table raises `P2021`, not `undefined.findUnique`. DB state still worth confirming after the client is fixed (**BLOCKED-HERE**). |
| **Application-import issue** (wrong client, duplicate client, Prisma bundled into a client component) | **Ruled out** — single `new PrismaClient()` in `lib/prisma.ts`, single `@prisma/client` in the lockfile, default generator output, no client-component imports of Prisma. |
| **Generated-client issue (stale / generated from a different schema)** | **✔ Most likely root cause.** The running process holds a Prisma Client generated from a schema predating `f592894e`, so `prisma.hotelPricingSettings` is `undefined` while `prisma.hotel` works — exactly the observed ordering of the `Promise.all` elements. |

Three scenarios produce this, in likelihood order:

1. **The app was started (or built and started) without re-running `prisma generate` after the pricing engine files landed** — pre-change `.next` output and/or pre-change `node_modules/.prisma/client`. Most probable given the branch/working-tree churn seen above and the `postinstall`/`build` hook only running on install/build.
2. **`prisma generate` ran but the server process was not restarted**, so `globalThis.prisma` in a non-production process still exposes the old delegate table (or the `.next` server bundle is from before the regeneration).
3. **Dependencies were installed / the client generated from `main` (schema without the model) and the pricing files were added afterwards** — `main` at `4514a5f` has zero `hotelPricingSettings` references, so this reproduces the error identically.

## 10. Suggested next step (your call — nothing was changed)

Read-only confirmation, in this order:

```bash
# 1. Does the client in use know the model?
grep -c hotelPricingSettings node_modules/.prisma/client/index.d.ts

# 2. Is the client older than the schema?
ls -l --time-style=full-iso prisma/schema.prisma node_modules/.prisma/client/index.d.ts

# 3. Is the table actually there (needed after a regenerate)?
psql "$DATABASE_URL" -c "select to_regclass('public.\"HotelPricingSettings\"');"
```

If (1) returns `0`, the fix is a regeneration plus a clean restart — e.g. stop the server, `npx prisma generate` (add `--no-engine` only if this sandbox's stub-engine workaround is in use), then `npm run build && next start` (or restart `next dev`). **No schema change and no migration is needed**; if the regenerate reveals the table is missing, then `prisma migrate deploy`/`migrate status` becomes the follow-up decision.

Also worth deciding separately: whether `listPricingBundle` should fail with a clear, actionable error (like `PRICING_TABLES_MISSING`, 503) instead of a raw `TypeError`, given that the reservation path already degrades gracefully — and whether that graceful degradation should be loud rather than silent about prices.
