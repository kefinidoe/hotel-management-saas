# Flexible multi-tenant pricing engine

Status: implemented on branch `arena/5e8e045b-hotel-management-saas` (continues PR #21).
Nothing is merged, nothing is deployed, no production or Axis Hotel system was contacted, and
no demo data was reset or reseeded.

This document covers the design, the code that now exists, the verification that was actually
executed, and the honest gaps.

---

## 1. Completed / partial / proposed

### Completed

| Area | What exists |
| --- | --- |
| Occupancy options | `OccupancyType` per hotel — own names, adult/child bounds, order, active flag. Nothing is a fixed enum. |
| Per-occupancy rates | `RoomTypeOccupancy` (room type × occupancy → `Decimal` nightly rate). A room type is only sold at occupancies it has a rate for. |
| Pricing models | `HotelPricingSettings.pricingModel`: `ROOM_TYPE_OCCUPANCY` or `LEGACY_BASE_RATE`; switches on the Settings tab and is refused if no rate exists yet. |
| Meal plans | `MealPlanConfig` + `MealPlanRoomType`: description, included items, charge, `PER_PERSON`/`PER_ROOM` × `PER_NIGHT`/`PER_STAY`, room-type allowlist, effective dates, active flag. |
| Seasonal / holiday / event pricing | `RateAdjustment` (`SEASONAL`) with free date ranges, `PERCENT` / `FIXED_PER_NIGHT` / `SET_RATE`, priority, optional room type. |
| Weekend pricing | `RateAdjustment` (`WEEKEND`) with hotel-defined `daysOfWeek` (0 = Sunday). |
| Adult / child pricing | `ChildPricingRule` age bands, `FIXED_PER_NIGHT` or `PERCENT_OF_ADULT`. |
| Extra beds | `ExtraBedRule` with nightly rate, child rate, `maxPerRoom`, optional room-type scope. |
| Taxes & service charges | `TaxRule`: `PERCENT` or `FIXED`, `ROOM`/`MEALS`/`ALL`, `PER_NIGHT`/`PER_STAY`/`PER_PERSON_PER_NIGHT`, inclusive or exclusive. |
| Discounts | Fixed or percentage, management-only, validated server-side, stored on the reservation and in the snapshot. |
| Server-authoritative pricing | One pure engine (`lib/pricing/engine.ts`) used by the quote endpoint, reservation creation and repricing. The browser never computes money. |
| Price snapshots | Append-only version ledger: version 1 frozen at creation, every repricing appends an immutable version (DB trigger); the current price is the highest version. |
| Snapshot failures | Fail closed: a configured-price reservation whose snapshot cannot be written is rolled back and never sold. Legacy hotels unaffected. |
| Repricing integrity | New version + `ReservationPriceChange` + reservation update + `RESERVATION_REPRICED` audit event in one serializable transaction; `500 AUDIT_UNAVAILABLE` and full rollback if the audit cannot be written. |
| Financial retention | `ON DELETE RESTRICT` from reservation and hotel; the delete API refuses repriced reservations; only an explicit purge removes history. |
| Folio consistency | `lib/stay-service.ts` bills the snapshot (`grandTotal`) and emits meal/extra/tax folio lines from the frozen breakdown. |
| Configuration UI | `/dashboard/settings/pricing` — seven sections, currency labels, enable/disable, delete, management-only. |
| Repricing UI | “Reprice” on Front Desk arrival cards (management only) → explicit confirm with a reason. |
| Tests | Engine unit tests, API/isolation integration tests, form tests, repricing dialog tests, browser acceptance (31 checks), plus every pre-existing regression suite. |

### Partial

- **Rate plans** (standard / non-refundable / corporate / promo / advance) are not separate entities. Cancellation- and payment-policy variants belong to a rate-plan model that this repo does not have; representing them as `RateAdjustment` rows would conflate policy with price. The engine already prices from a config object, so adding a `RatePlan` dimension later is additive (see §11).
- **Minimum-stay / closed-to-arrival / LOS rules** are not implemented; only capacity, occupancy membership, effective dates and positivity are enforced.
- **Multi-room reservations**: repricing currently refuses reservations with more than one room, by design, rather than silently pricing only the first.
- **Repricing UI placement**: only on Front Desk arrivals (the natural moment before check-in), not yet inside a reservation detail view — there is no reservation detail screen in this app.

### Proposed (not built, with reasons)

1. **Rate plans as a first-class model** (`RatePlan` + `RatePlanRate`) with an optional percentage delta over the occupancy rate and policy flags. Reason for deferral: it needs cancellation/deposit policy fields owned by the bookings domain, otherwise it is another name for an adjustment.
2. **Season calendars** (`Season` + day-level overrides) for hotels that price dozens of holiday windows. Current `RateAdjustment` windows are enough for a boutique hotel but become a list to maintain at scale.
3. **Promotion codes** — a discount source that is not a manager typing a number; requires a code entity, redemption limits and audit. Not attempted to avoid inventing business rules.
4. **Per-night minimum/maximum stay and closed dates** on the calendar (occupancy grid), which is a booking-availability feature rather than a pricing one.

---

## 2. How the price is produced

`priceStay(config, request)` in `lib/pricing/engine.ts` is pure: it takes the hotel's loaded
configuration plus a request and returns either a full breakdown or a typed failure. No database
access, no clock, no request headers — which is why it is exhaustively unit-testable.

Order of operations (all amounts are `Decimal`-safe numbers rounded to 2dp at the end):

1. **Nights**: `checkOut - checkIn` in whole days; `INVALID_DATES` if ≤ 0 or not a stay.
2. **Room type**: must belong to the configured hotel and be active.
3. **Occupancy** (when occupancy rates are on): the option must exist, be active, be sold for that
   room type, and the party must fit `minAdults…maxAdults` / `maxChildren`.
4. **Base nightly rate**: the room type × occupancy rate, or the room type `baseRate` in legacy mode.
5. **Seasonal / weekend adjustments**, per night, in `priority` order. `PERCENT` and
   `FIXED_PER_NIGHT` accumulate; `SET_RATE` replaces the night's rate. A night can match several
   adjustments; each is reported as its own breakdown line.
6. **Meal plan**: charge × basis. `PER_PERSON_*` multiplies by the travel party, `PER_NIGHT`
   multiplies by nights, `PER_STAY` is charged once. Availability is checked (active, room-type
   allowlist, effective dates).
7. **Child pricing** by age band, when enabled.
8. **Extra beds**, when enabled: room-type rule first, hotel-wide rule as fallback, capped by
   `maxPerRoom`.
9. **Discount**: fixed and/or percentage, never larger than the discounted subtotal.
10. **Taxes** in `sortOrder`, applied to their `appliesTo` base. Inclusive taxes are reported as a
    portion of the total; exclusive taxes are added. `grandTotal = netBeforeTax + taxAdded`.

Failures are explicit codes so the UI can say something actionable:
`ROOM_TYPE_NOT_FOUND`, `OCCUPANCY_REQUIRED`, `UNSUPPORTED_OCCUPANCY`, `CAPACITY_EXCEEDED`,
`RATE_NOT_CONFIGURED`, `INVALID_DATES`, `INVALID_GUESTS`, `MEAL_PLAN_NOT_AVAILABLE`,
`INVALID_DISCOUNT`, `EXTRA_BEDS_UNAVAILABLE`, `INVALID_CONFIG`.

### Defaults and "no dead ends"

- With occupancy pricing on, the **quote** endpoint picks a default occupancy when the form has not
  chosen one yet: the cheapest option that fits the party, otherwise the roomiest (so an oversized
  party gets a capacity message, not an empty picker). The reservation itself still has to name its
  occupancy.
- If a later quote is refused because the chosen occupancy no longer fits (the receptionist raised
  the guest count), the form drops the selection and asks the server for a fitting default.
- The occupancy and meal-plan pickers keep the options from the last successful quote for that room
  type, so a refusal never leaves the receptionist without the control they need to fix it.

---

## 3. Data model

Eleven new models, all tenant-scoped, all money as `Decimal(10, 2)`.

```
Hotel ──1:1── HotelPricingSettings            (toggles + pricingModel)
  │
  ├──1:N── OccupancyType ──1:N── RoomTypeOccupancy ──N:1── RoomType
  │                                    (nightlyRate, isActive)     (already existed)
  ├──1:N── MealPlanConfig ──1:N── MealPlanRoomType ──N:1── RoomType
  │            (pricingBasis, charge, effectiveFrom/To, includedItems[])
  ├──1:N── RateAdjustment        (kind SEASONAL|WEEKEND, type PERCENT|FIXED_PER_NIGHT|SET_RATE,
  │                               amount, daysOfWeek[], startDate, endDate, priority, roomTypeId?)
  ├──1:N── ExtraBedRule          (nightlyRate, childRate, maxPerRoom, roomTypeId?)
  ├──1:N── ChildPricingRule      (minAge, maxAge, chargeType, amount)
  ├──1:N── TaxRule               (basis, amount, appliesTo, chargeBasis, isInclusive, sortOrder)
  │
  └── Reservation
        ├──1:N── ReservationPriceSnapshot   (one immutable row per version: version 1 = the
        │                                    agreement at booking, 2.. = repricings)
        └──1:N── ReservationPriceChange     (previousTotal, newTotal, previous/new version,
                                             reason, breakdown, actor)
```

Design decisions worth stating:

- **Room type × occupancy as a join model, not columns.** A hotel that never sells Twin cannot be
  forced to; a rate exists only where the hotel says the combination is sold.
- **`@@unique([id, hotelId])` on every pricing model** and composite foreign keys
  (`fields: [roomTypeId, hotelId], references: [id, hotelId]`) so the database itself refuses a
  cross-tenant attach, not only the application code.
- **One settings row per hotel** (`hotelId @unique`), created lazily; absent means legacy pricing, so
  an un-migrated hotel keeps working.
- **Snapshots are a ledger, not a column.** One row per agreed version, unique on
  `(reservationId, version)`, never updated (trigger-enforced). "Current price" is the highest
  version — see §6.
- **`MealPlanRoomType` instead of an array column** keeps referential integrity when a room type is
  deleted.
- **No duplicated models**: `RateAdjustment` covers both seasonal and weekend pricing (same shape,
  different selector); no separate `Season`/`WeekendRate` tables.

---

## 4. Multi-tenant isolation

- `hotelId` is always taken from the authenticated tenant (`getTenantFromRoute`), never from the
  request body — sending `hotelId` in a payload does nothing.
- Every read in `lib/pricing/config.ts` filters by `hotelId`; every write in `lib/pricing/admin.ts`
  writes it and re-checks every referenced id against that hotel before inserting (fixed a real
  partial-write bug: a meal plan used to be created before its room-type links were validated).
- Cross-tenant references are indistinguishable from missing ones: 404, not 403, so a hotel cannot
  probe another hotel's ids.
- Room lookup uses `id_hotelId`, so another hotel's room id simply is not found.
- Composite FKs in Postgres back the application checks.

---

## 5. Server authority

| Attack | Result |
| --- | --- |
| Client sends `total`, `grandTotal`, `rate`, `nightlyRate` | Ignored; the engine's number is stored. |
| Client sends another hotel's `occupancyTypeId` | 400 `UNSUPPORTED_OCCUPANCY`. |
| Client sends an occupancy the room type is not sold as | 400 with “not sold as …”. |
| Client sends more guests than the occupancy allows | 400 with the allowed range. |
| Client sends another hotel's `roomId` | 404. |
| Client sends a discount as a receptionist | 403; the discount is not applied. |
| Discount larger than the stay | 400. |
| Discount in the quote but not at creation | Re-priced at creation; the stored total is authoritative. |
| Manipulated dates (`checkOut <= checkIn`) | 400 `INVALID_DATES`. |

The quote endpoint and the reservation endpoint run the *same* engine, so what the receptionist
sees is what is stored — and the stored number is recomputed, not echoed.

---

## 6. Price versions, repricing, folios

Pricing history is a ledger. `ReservationPriceSnapshot` holds one immutable row per version of a
reservation's agreed price:

- **version 1** is written inside the reservation-creation transaction;
- every repricing **appends** the next version — earlier rows are never updated;
- the **current price is the highest version** for that reservation (one helper,
  `currentPriceVersion` in `lib/pricing/versions.ts`, is the only definition, used by repricing,
  check-in billing and the API).

Each version freezes: pricing model, currency, room type, occupancy name, meal plan name and basis,
nightly rate, nights, adults/children/extra beds, room/meals/extras/adjustments/discount/tax totals,
grand total, the full per-night breakdown, the actor (`createdById`) and `createdAt`.

Guarantees enforced by the database, not only by code (migration 21):

| Guarantee | Mechanism |
| --- | --- |
| No two versions of the same reservation share a number | `UNIQUE (reservationId, version)` |
| A written version can never be altered | `BEFORE UPDATE` trigger raising `restrict_violation` |
| Pricing evidence cannot be cascade-deleted with the reservation | `ON DELETE RESTRICT` on both pricing foreign keys |
| Pricing evidence cannot be cascade-deleted with the hotel | `ON DELETE RESTRICT` on the hotel foreign key |

### Fail-closed snapshot creation

When a hotel prices from configuration, the frozen version is part of the charge: without it the
hotel cannot defend what the guest was quoted. `POST /api/reservations` therefore treats the
snapshot write as mandatory — a missing delegate, a failed insert or a missing table throws, the
transaction rolls back, and the API answers `500` ("The reservation price could not be recorded, so
the reservation was not created"). Nothing is sold: no reservation, no room block, no guest row.

Legacy hotels (`LEGACY_BASE_RATE`) keep their pre-pricing behaviour exactly: their charge comes from
the legacy tariff calculation, so the snapshot is not required and a missing table is logged rather
than blocking the booking.

### Repricing is explicit, atomic and audited

`POST /api/reservations/:id/reprice` (management only, pending/confirmed, single room) runs one
serializable transaction that:

1. locks the reservation row (`SELECT … FOR UPDATE`) so two managers cannot write the same version;
2. reads the current version and computes the next one;
3. updates `ReservationRoom.rate` and the reservation discount;
4. inserts the new immutable snapshot version;
5. inserts the `ReservationPriceChange` (previous/new total, previous/new **version**, reason,
   breakdown, actor);
6. writes the `RESERVATION_REPRICED` **audit event into the same transaction**, in strict mode.

`recordAudit` already accepted a transaction client, and `AuditLog` lives in the same PostgreSQL
database as the reservation, so no separate outbox is needed: the audit insert is part of the same
commit. What was missing was strictness — the old helper swallowed write failures and returned
`false`. It now takes `{ strict: true }`, which throws `AuditPersistenceError` both when the write
fails and when no audit model is reachable. The route lets that propagate, so the whole repricing
rolls back and the response is `500 {"code":"AUDIT_UNAVAILABLE"}`, never a success. If auditing ever
moves to a different store, this is the seam where a transactional outbox belongs: the outbox row
would be written in this same transaction and drained afterwards.

### Retention of financial evidence

The original `ON DELETE CASCADE` from `Reservation` meant deleting a reservation silently erased its
price history. That is no longer possible:

- both pricing tables are `ON DELETE RESTRICT` from `Reservation` **and** from `Hotel`;
- `DELETE /api/reservations/:id` refuses (`409`) once a reservation has been repriced — it must be
  cancelled so the history is kept;
- a reservation that was never paid and never repriced can still be deleted, and its frozen quote is
  removed deliberately in the same transaction (it is a discarded quotation, not a financial event);
- the admin test-data purge (`/api/admin/clean-test-data`, disabled in SaaS environments) removes
  pricing rows explicitly before the reservations, so a deliberate teardown still works;
- the only way to alter a version afterwards is a forensic operation that first disables the
  immutability trigger — deliberately awkward, and never something the app does.

### Folio consistency

`lib/stay-service.ts` bills the **current version**: accommodation required is the version's
`grandTotal`, and meal/extra/tax lines are generated from that version's breakdown, with the
discount line taken from the same version. Reprice, then check in — the folio totals equal the
latest agreed total, while version 1 still records what was agreed at booking.

## 7. API surface and permissions

| Endpoint | Method | Who | Purpose |
| --- | --- | --- | --- |
| `/api/pricing` | GET / PATCH | management | Read the bundle; update model + toggles |
| `/api/pricing/room-rates` | POST | management | Set the nightly rate for each occupancy of a room type |
| `/api/pricing/[entity]` | POST / PATCH / DELETE | management | `occupancy-types`, `meal-plans`, `adjustments`, `extra-beds`, `child-rules`, `tax-rules` |
| `/api/reservations/quote` | POST | guest-stays roles | Server-computed breakdown for the form |
| `/api/reservations` | POST | guest-stays roles | Create, priced server-side, snapshot written |
| `/api/reservations/[id]/reprice` | POST | management | Explicit repricing with reason + audit |

All routes are additionally gated by `requireModule(hotelId, "RESERVATIONS")`, so a hotel whose
subscription excludes reservations cannot price anything. Discounts are management-only on both the
quote and the create path.

---

## 8. UI

**Hotel Settings → Pricing & Rates** (`/dashboard/settings/pricing`, management only):

- Room rates — per room type, one field per occupancy, empty = not sold.
- Occupancy options — create/edit/activate/deactivate, name, adult/child bounds, order.
- Meal plans — name, description, included items, basis, charge, room types, effective dates.
- Seasonal & weekend — kind, adjustment type, amount, date range or weekdays, priority, room type.
- Extra beds & children — nightly rate, child rate, max per room, age bands, charge type.
- Taxes & service — percentage/fixed, applies-to, charge basis, inclusive/exclusive.
- Settings — pricing model, each feature toggle, inclusive pricing.

**New Reservation modal**: guest details, stay dates, party, room picker with live room status and
occupancy/meal-plan pickers that only offer what the server says this room type is sold as, the
server's approved nightly rate, and a live breakdown (room line per occupancy, adjustments, meal
plan with `× n`, children, extra beds, discount, taxes, subtotal, total, average per night). The
submit button lists exactly what is missing, and stays disabled while the stay cannot be priced.

**Reprice** on Front Desk arrival cards (management only): shows the currently agreed amount, takes
an optional reason, and reports `previous → new` after the server confirms.

Screenshots: `docs/evidence/pricing/` (see §12).

---

## 9. Migration and backward compatibility

- **Migration 20** — `prisma/migrations/20261031120000_add_pricing_engine/migration.sql`: creates the
  eleven tables, enums and indexes; additive only.
- **Migration 21** — `prisma/migrations/20261031160000_price_version_history/migration.sql`
  (financial integrity):
  - adds `ReservationPriceSnapshot.version` (default 1) and `ReservationPriceChange.previousVersion`
    /`newVersion` — every existing row keeps its data and becomes version 1;
  - replaces the "one snapshot per reservation" unique index with `UNIQUE (reservationId, version)`
    (+ a descending lookup index) — the old constraint is what forced repricing to overwrite;
  - swaps `ON DELETE CASCADE` for `ON DELETE RESTRICT` on the reservation and hotel foreign keys of
    both pricing tables;
  - adds a `BEFORE UPDATE` trigger that rejects any change to a stored version.
  All of it is additive to data: no row is rewritten, no column dropped, nothing deleted. Applied to
  the demo database in place; the ledger then detects it as `saas_current`.
- `scripts/migration-ledger.mjs` now has: `saas_through_19`, `saas_through_20` (pricing engine,
  forbidding the version columns/trigger) and `saas_current`
  (`appliedThrough 20261031160000_price_version_history`, requiring the version column, the version
  index, both RESTRICT delete rules and the immutability trigger). Detected against the demo
  database: `checkpoints matching: saas_current`.
- `prisma/migration-release-manifest.json` re-generated: 21 entries; `--check` passes.
- **Backward compatible by default**: `HotelPricingSettings` absent ⇒ legacy behaviour
  (`LEGACY_BASE_RATE`, every advanced toggle off), which is what the demo hotel is left as. Switching
  a hotel to occupancy pricing is a deliberate, validated action; switching it back does not touch
  snapshots of already-sold stays.

---

## 10. Verification actually executed

Environment: disposable local PostgreSQL 17 (`127.0.0.1:55433`, database
`hotel_saas_demo_owner`, 21 migrations applied in place), app built with
`SAAS_ENVIRONMENT=saas SAAS_DATABASE_IDENTIFIER=hotel_saas_demo_owner` and served by
`npx next start -p 3000 -H 0.0.0.0`.

| Command | Result |
| --- | --- |
| `DATABASE_URL=… DIRECT_URL=… npx prisma validate` | `The schema at prisma/schema.prisma is valid 🚀` |
| `npx tsc --noEmit` | no output (clean) |
| `next lint` | `✔ No ESLint warnings or errors` |
| `vitest run` | **63 files, 953 passed, 6 skipped** |
| `node scripts/verify-pricing-acceptance.mjs --base http://127.0.0.1:3000 --json docs/evidence/pricing/pricing-acceptance.json` | **PASS — 35 passed, 0 failed** |
| `node scripts/verify-reservation-acceptance.mjs --base http://127.0.0.1:3000` | **PASS — 13 passed, 0 failed** |
| `node scripts/e2e-smoke.mjs --base http://127.0.0.1:3000` | **PASS — 55/55** |
| `node scripts/browser-e2e.mjs --base http://127.0.0.1:3000` | **PASS — 33/33 browser steps** |
| `node scripts/owner-test/verify-handover.mjs` (BASE/ORIGIN = 127.0.0.1:3000) | **PASS — 69/69 checks** |
| `node scripts/db-integrity.mjs` | **PASS — 49 checks, no integrity violations** |
| `node scripts/migration-ledger.mjs manifest --check` | `Release manifest matches 21 migration files.` |
| ledger feature probe against the demo DB | `checkpoints matching: saas_current` |
| `next build` | `✓ Compiled successfully` |

Unit tests (`__tests__/pricing/engine.test.ts`, 41 cases) cover each occupancy shape, per-person and
per-room bases, per-stay charges, currencies, seasonal and weekend adjustments, priority resolution,
child pricing, extra beds, fixed and percentage discounts, taxes (inclusive and exclusive) and every
invalid-input failure. Integration tests cover configuration CRUD, cross-tenant refusals, quote
isolation, discount permissions, reservation pricing, snapshot freezing, repricing and audit.

`__tests__/pricing/pricing-integrity.test.ts` (11 cases) runs the real routes and the real check-in
service against a Prisma double whose transactions genuinely roll back, and covers exactly the
financial-integrity cases:

| Case | What it proves |
| --- | --- |
| Snapshot insert throws | `500`, and no reservation, room block or guest is left behind |
| Snapshot delegate missing (configured pricing) | `500`, nothing created — never silently skipped |
| Legacy hotel, snapshot storage missing | `201`; legacy pricing still sells rooms |
| Create → reprice → reprice | versions `[1,2,3]`; version 1 identical byte-for-byte; every version keeps its currency, occupancy, meal plan and actor; current version is 3 |
| Stale version read (racing writer) | duplicate version refused by `UNIQUE (reservationId, version)`, nothing appended |
| Audit write throws during reprice | `500 AUDIT_UNAVAILABLE`; no new version, no price-change row, room rate and discount unchanged |
| Audit model missing during reprice | `500 AUDIT_UNAVAILABLE`; nothing written |
| Another hotel's reservation | `404`, snapshots unchanged |
| Receptionist repricing | `403` |
| Reprice then check in | folio `required` equals the latest version; room charge + meal line equal the repriced breakdown; version 1 unchanged |

Browser/API acceptance (`scripts/verify-pricing-acceptance.mjs`, 35 checks) additionally proves
against real PostgreSQL: two repricings produce versions 1–3 with the original intact, an
`UPDATE` of a stored version is rejected by the database ("immutable"), a `DELETE` of a reservation
with pricing history is refused by the foreign key, and the API itself answers `409` instead of
deleting a repriced reservation.

The pricing acceptance script is intentionally independent of the seed data: it creates its own room
types (rooms 903/904), occupancies (`Pricing Single/Double/Family`), a meal plan and its own rates,
drives the real UI in Chromium, and restores the hotel's original pricing model and rates at the end
(verified: “Restored the demo hotel's pricing model (LEGACY_BASE_RATE)”).

### Known limitations of the evidence

- The browser is the sandbox's Chromium (`@sparticuz/chromium`), not a desktop Chrome with a GPU.
- The public preview URL could not be exercised: the platform edge answers
  `MISSING TRAFFIC ACCESS TOKEN` before the app is reached. All browser evidence is against
  `127.0.0.1:3000` inside the sandbox.
- The Prisma native query engine cannot be downloaded here (`binaries.prisma.sh` TLS failure), so
  runtime verification uses the WASM/driver-adapter path. `prisma validate` and the schema tests run
  against the real schema, and the migration itself was applied by the real PostgreSQL server.
- Hotel deletion is not an application feature. The new `RESTRICT` foreign keys mean that deleting a
  hotel row that still has pricing history now fails by design; a legitimate teardown has to remove
  or export the financial records first. That is the intended retention policy, not an oversight.
- The immutability trigger blocks `UPDATE` only. `DELETE` remains possible for deliberate purges
  (the reservation-delete path and the test-data endpoint), and restoring a version from a backup is
  the recovery route for an erroneous purge.
- Pricing history currently records the *price* versions only. A full financial audit trail also
  wants folio/payment events; those are already recorded by their own modules and were not merged
  into this ledger.

---

## 11. What a hotel would do, step by step

1. Settings → Pricing & Rates → **Occupancy options**: add the occupancies this hotel sells
   (e.g. “Single”, “Double”, “Twin”, “Family” — or “Per Person Sharing”; the names are free text).
2. **Room rates**: open a room type, enter the nightly rate for each occupancy, leave the others
   empty. Save.
3. **Settings**: switch the pricing model to *Occupancy rates*, enable only the features this hotel
   uses (meal plans, seasonal, weekend, children, extra beds, taxes). The switch is refused with a
   clear message if no rate exists yet.
4. Optional: **Meal plans**, **Seasonal & weekend**, **Extra beds & children**, **Taxes & service**.
5. Reception: New Reservation → pick the room, party size, occupancy, meal plan and dates. The rate
   and breakdown come from the server; the receptionist never types a total.
6. If a reservation must follow a later rate change, a manager uses **Reprice** on the Front Desk
   arrival card and states the reason; the previous total stays on record.

The demo tenant is left on `LEGACY_BASE_RATE` so it behaves exactly as before; the configuration the
acceptance run creates (rooms 903/904 and their rates) stays in place as a worked example.

---

## 12. Evidence index

- `docs/evidence/pricing/pricing-acceptance.json` — per-check results of the run above.
- `pricing-01-settings-overview.png` — Pricing & Rates page, hotel currency, sections.
- `pricing-02-rate-edit.png`, `pricing-03-rate-persisted.png` — editing and reloading a rate.
- `pricing-04-modal-breakdown.png` — server-quoted breakdown in the reservation form.
- `pricing-05-occupancy-repriced.png`, `pricing-06-meal-plan-repriced.png`,
  `pricing-07-dates-repriced.png` — the breakdown following each change.
- `pricing-08-ready-to-submit.png`, `pricing-09-created.png`, `pricing-10-after-reload.png` —
  creating and persisting the reservation.
- `pricing-11-reprice-dialog.png`, `pricing-12-repriced.png` — explicit repricing with the audit
  trail written.

---

## 13. Files

New backend: `lib/pricing/{types,engine,config,admin,versions}.ts`,
`app/api/pricing/route.ts`, `app/api/pricing/room-rates/route.ts`, `app/api/pricing/[entity]/route.ts`,
`app/api/reservations/quote/route.ts`, `app/api/reservations/[id]/reprice/route.ts`,
`prisma/migrations/20261031120000_add_pricing_engine/migration.sql`,
`prisma/migrations/20261031160000_price_version_history/migration.sql`.

New UI: `components/pricing/PricingClient.tsx`,
`app/dashboard/settings/pricing/page.tsx`, `components/reservations/RepriceDialog.tsx`, plus the
Pricing & Rates entry in `components/Sidebar.tsx`.

Rewritten: `components/reservations/CreateReservationModal.tsx` (server-quoted, dynamic options).

Changed: `prisma/schema.prisma`, `app/api/reservations/route.ts` (engine + snapshot),
`lib/stay-service.ts` (snapshot-driven folio), `components/frontdesk/FrontDeskClient.tsx` (Reprice),
`scripts/migration-ledger.mjs`, `prisma/migration-release-manifest.json`.

Tests: `__tests__/pricing/{engine,pricing-api,reservation-pricing,pricing-integrity}.test.ts`,
`__tests__/frontend/{create-reservation,reprice-dialog}.test.tsx`,
`__tests__/schema/migration-adoption.test.ts`, `scripts/verify-pricing-acceptance.mjs` (new),
`scripts/verify-reservation-acceptance.mjs` (waits for the server-quoted rate).
