# Reservation creation — root cause and fix

**Status:** fixed and verified end to end against the disposable demo database
(`hotel_saas_demo_owner`, PostgreSQL 17 on 127.0.0.1:55433). Nothing was deployed,
and no production or live Axis Hotel system was contacted.

Reproduction of the two reported symptoms, before the fix: the reservations
calendar could not sell a room at all — “Approved rate per night (KSh)” showed
`--`, “Create Reservation” stayed disabled, and a hand-crafted `POST
/api/reservations` was rejected with *“The selected tariff does not match the
occupancy and meal plan.”*

---

## Root cause (one cause, two symptoms)

Both controls read the same value, and that value was calculated by matching a
tariff **by name**:

```
lib/tariffs.ts  →  findTariff(tariffs, occupancy, mealPlan)
                    tariffMatches(name, mealPlan, occupancy, mealPlan)
                    → name must start with "Single" / "Double" / "Twin"
                      AND the room type's mealPlan must equal the chosen plan
```

`CreateReservationModal` did:

```ts
const matchedTariff = findTariff(tariffs, occupancy, mealPlan);
const rate = matchedTariff ? Number(matchedTariff.baseRate) : 0;
…
<label>Approved rate per night (KSh)</label>
<p>{matchedTariff ? rate.toLocaleString() : "--"}</p>
<button type="submit" disabled={loading || !matchedTariff}>Create Reservation</button>
```

So for any hotel whose room types are not named after an occupancy —
“Standard”, “Deluxe”, “Family Suite”, or any type saved with no meal plan
(`mealPlan: null`, which `POST /api/room-types` explicitly allows) — the match
returned `undefined`:

* the rate cell rendered `--`, and
* the button was `disabled` because `!matchedTariff` is `true`,
* and the server agreed, because `app/api/reservations/route.ts` used the same
  name-matching rule and threw *“The selected tariff does not match the
  occupancy and meal plan.”*

It was not a frontend-only bug: the API enforced the same heuristic, so no client
could have created that reservation.

Secondary defects found while tracing the workflow:

1. `KSh` was hardcoded in the rate and discount labels, ignoring `Hotel.currency`.
2. No server-side guard against a **zero** rate: a room type saved with
   `baseRate = 0` would have produced a valid-looking reservation at 0.
3. The front-desk walk-in form mounts the same modal but passed no currency and
   no room-type id, so it had the identical defect.

## What changed

| File | Change |
| --- | --- |
| `lib/tariffs.ts` | New `resolveApprovedRate()` — prices the **room being sold** from its own room type, falling back to an occupancy/meal-plan tariff only when the room type has no usable rate; rejects `0`, negative, `NaN`, `Infinity` (`INVALID_TARIFF_RATE`) and reports `NO_TARIFF` when nothing applies. New `tariffPricesStay()` — a tariff may price a stay only if it is the chosen occupancy tariff or the room's own type. |
| `app/api/reservations/route.ts` | Selects `roomTypeId`; validates with `tariffPricesStay(tariff, room.roomTypeId, occupancy, mealPlan)`; after `parseMoney`, refuses `rate <= 0` with *“This room has no nightly rate configured. Set a rate on the Rooms page before selling it.”*; `ReservationError` is re-thrown unchanged. |
| `components/reservations/CreateReservationModal.tsx` | Rate and enabled-state now come from `resolveApprovedRate`. Currency-aware labels (`Approved rate per night (KES)`), `Intl.NumberFormat` money, a source line (“Deluxe Garden room rate” / tariff name), a nights × rate total, an explicit list of what is still missing, and `disabled={!canSubmit}` where `canSubmit` requires guest name, room, valid dates, adults ≥ 1 and an approved positive rate. The same list is re-checked in `submit()` so a hand-crafted submit cannot bypass it. Sends the resolved `tariffId`. |
| `components/reservations/ReservationsClient.tsx` | Accepts `currency`, forwards it to the modal, `Room` carries `roomTypeId`, and creation now calls `load()` **and** `router.refresh()` so room statuses are re-read from the server. |
| `app/dashboard/reservations/page.tsx` | Passes `roomTypeId` per room and `tenant.hotel.currency`. |
| `components/frontdesk/FrontDeskClient.tsx`, `app/dashboard/front-desk/page.tsx` | Same currency/roomTypeId plumbing for the walk-in modal. |

### Pricing precedence — a deliberate decision

The first version preferred a name-matched occupancy tariff over the selected
room's type. Running the real workflow showed why that is wrong: switching from a
Standard room to a Deluxe room left the price unchanged, because both were
priced by the same matched tariff. The rate must follow the room the receptionist
picks, so **the room's own room type wins**, and an occupancy tariff is used only
when that type has no usable rate. `tariffPricesStay()` still stops a client from
pricing a room at another type's cheaper rate.

## Tests executed (actual results)

On this branch, same sandbox, same demo database:

| Check | Command | Result |
| --- | --- | --- |
| Unit + integration suite | `node_modules/.bin/vitest run` | **866 passed, 6 skipped, 0 failed** (58 files) |
| Type check | `node_modules/.bin/tsc --noEmit` | **0 errors** |
| Lint | `next lint` | **No ESLint warnings or errors** |
| Production build | `next build` (with `SAAS_ENVIRONMENT=saas`, `SAAS_DATABASE_IDENTIFIER=hotel_saas_demo_owner`) | **succeeded** |
| Reservation acceptance (HTTP + real Chromium) | `node scripts/verify-reservation-acceptance.mjs` | **13/13 passed** |
| HTTP end-to-end smoke | `node scripts/e2e-smoke.mjs --base http://127.0.0.1:3000` | **55/55 passed** |
| Browser end-to-end | `node scripts/browser-e2e.mjs --base http://127.0.0.1:3000` | **33/33 passed** |
| Owner handover verification | `node scripts/owner-test/verify-handover.mjs` | **69/69 passed** |
| Database integrity | `node scripts/db-integrity.mjs --json` | **49/49, ok: true** |

New regression tests:

* `__tests__/rooms/approved-rate.test.ts` (14) — precedence, room-type fallback,
  per-room pricing, `NO_TARIFF`, zero/negative/NaN/Infinity rejection, and that a
  tariff for another type never prices a stay.
* `__tests__/frontend/create-reservation.test.tsx` (13) — rate shown for a
  “Standard” type, hotel currency label (USD case asserts no `KSh` anywhere),
  re-pricing on room change, nights total, disabled until the guest is typed,
  same-day check-out refused, zero-rate refused with explanation, occupied room
  refused even via a direct `submit()`, correct POST body, server error surfaced
  and the button re-enabled, discount hidden for non-management.
* `__tests__/reservations/reservation-isolation.test.ts` (+3) — API creates at the
  room's own rate for a non-occupancy-named type, refuses an unpriced room
  (nothing written), refuses another room type's tariff in the same hotel.
* `__tests__/tenant-isolation/affected-pages.test.tsx` — asserts the page hands
  the hotel's currency to the client.

Acceptance walkthrough (`scripts/verify-reservation-acceptance.mjs`, 13/13), run
against the demo database with a “Standard” (4,500) and “Deluxe Garden” (8,500)
room type — the shape of hotel that broke owner testing, absent from the seed:

| # | Scenario | Result |
| --- | --- | --- |
| 1 | Receptionist creates a reservation on room 901 (“Standard”) | 201, stored rate 4,500 |
| 2 | Rate is the room type's configured rate, in the active hotel | PASS |
| 3 | Same room and dates sold twice | refused (409, “already booked for part of that date range”) |
| 4 | Room belonging to the other hotel | 404 |
| 5 | Another type's cheaper tariff for this room | 400 |
| 6 | Reservation returned by `GET /api/reservations` | PASS |
| 7 | Owner switches workspace and creates a reservation | 200 / 201 |
| 8 | Form shows a rate for the “Standard” room | `Ksh 4,500.00` |
| 9 | Switching to “Deluxe Garden” re-prices | `Ksh 4,500.00 → Ksh 8,500.00` |
| 10 | Submit disabled until the guest name is entered | disabled → enabled |
| 11 | Submit creates the reservation, rate persisted in PostgreSQL | PASS |
| 12 | Reservation still on the calendar after a reload | PASS |

Screenshots: `docs/evidence/reservations/browser-0*.png`; machine-readable run:
`docs/evidence/reservations/reservation-acceptance.json`.

## Requirements from the brief — status

* Rate auto-populates for a selected room, follows the room/type, uses the
  hotel's own currency, validates positive amounts, never submits an invalid rate
  — PASS (unit, UI, API and browser evidence above; server refuses ≤ 0).
* Button enabled only when the form is complete; server re-validates — PASS.
  Double-booking is prevented by the existing per-hotel advisory lock plus the
  overlap check, verified in scenario 3.
* `hotelId` derived server-side; cross-hotel room/tariff refused; discounts still
  management-only — PASS (unchanged code paths, re-verified).
* No destructive migrations, no changes to auth/authz/subscription controls, demo
  database not reseeded (the only data written is the two acceptance room types,
  two rooms and the reservations the checks create).
* Existing reservation functionality intact — PASS (55/55 HTTP, 33/33 browser,
  69/69 handover, 49/49 integrity).

## Remaining limitations

* **Preview access.** The app runs fine on port 3000 inside the sandbox, but the
  E2B preview URL still answers the browser with `MISSING TRAFFIC ACCESS TOKEN`.
  That is an edge/platform gate outside the application (the app returns 200 to
  proxied host requests); it is unchanged by this work and remains open.
* **Browser checks are local.** “External browser” evidence here is a real
  Chromium driven inside the sandbox against `127.0.0.1`; the sandbox has no route
  to the public preview hostname, so the same flow from your Chrome cannot be
  demonstrated from in here until the preview gate is lifted.
* **Currency display** is proven with `KES` in the browser and `USD` in unit
  tests. Both demo hotels are configured in KES, so no browser run shows a second
  currency; changing a seeded hotel's currency was avoided to keep the demo data
  intact.
* **Native Prisma engine** is still unavailable offline, so the app and these
  checks run on the WASM engine + `pg` adapter shim (`scripts/wasm-runtime-shim.mjs`).
  That is a test harness, not a deployment configuration.
* Not deployed to production; nothing was run against Supabase or the live Axis
  Hotel system.
