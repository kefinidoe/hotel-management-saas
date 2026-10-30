# Owner acceptance testing

This guide is for testing HotelFlow yourself. You do not need to read the code, run a command, or
understand Prisma. Work through the sections in order — each one builds on the state the previous one
leaves behind.

Everything here runs against a **separate demo database** with two invented hotels. It is not connected
to the live Axis Hotel system, to production, or to any Supabase project, and it contains no real
customer or financial data.

---

## 1. How to reach the test environment

**Option A — the hosted preview (nothing to install).**

```
https://3100-ilwxtdget5jfcl1k2xd0q.e2b.app
```

The preview runs while this workspace is running. That hostname contains the sandbox id, so it
changes whenever the workspace is restarted — use whatever link the workspace shows you. If it does
not load, use option B.

**Option B — run it on your own machine.**

```bash
git clone https://github.com/kefinidoe/hotel-management-saas
cd hotel-management-saas
git checkout main && git pull
npm ci                             # installs dependencies (needs network for Prisma's engine)
node scripts/owner-test-env.mjs setup   # downloads PostgreSQL 17, creates + seeds the demo database
node scripts/owner-test-env.mjs app     # builds (first run) and starts on http://localhost:3000
```

`setup` is safe to re-run: it reuses an existing demo database and leaves its data alone. Everything it
creates lives in `.owner-test/`, which Git ignores.

---

## 2. Signing in

Two hotels, each with a staff account for every role, plus a platform administrator.

| Hotel | Role | Name | Email |
|---|---|---|---|
| Riverside Grand Hotel | Owner | Grace Wanjiku | `owner@riverside-grand.demo` |
| Riverside Grand Hotel | Administrator | Peter Kariuki | `admin@riverside-grand.demo` |
| Riverside Grand Hotel | Manager | Naomi Chebet | `manager@riverside-grand.demo` |
| Riverside Grand Hotel | Receptionist | Brian Otieno | `receptionist@riverside-grand.demo` |
| Riverside Grand Hotel | Accountant | Faith Njeri | `accountant@riverside-grand.demo` |
| Riverside Grand Hotel | Waiter | Kevin Mwangi | `waiter@riverside-grand.demo` |
| Riverside Grand Hotel | Cashier | Lucy Achieng | `cashier@riverside-grand.demo` |
| Riverside Grand Hotel | Housekeeper | Janet Wairimu | `housekeeping@riverside-grand.demo` |
| Riverside Grand Hotel | Technician | Samuel Kiptoo | `technician@riverside-grand.demo` |
| Lakeview Lodge | Owner | Daniel ole Saitoti | `owner@lakeview-lodge.demo` |
| Lakeview Lodge | Administrator | Wanjiru Kamau | `admin@lakeview-lodge.demo` |
| Lakeview Lodge | Manager | Ahmed Hassan | `manager@lakeview-lodge.demo` |
| Lakeview Lodge | Receptionist | Cynthia Nafula | `receptionist@lakeview-lodge.demo` |
| Lakeview Lodge | Accountant | Robert Wafula | `accountant@lakeview-lodge.demo` |
| Lakeview Lodge | Waiter | Judy Nyambura | `waiter@lakeview-lodge.demo` |
| Lakeview Lodge | Cashier | Elvis Wekesa | `cashier@lakeview-lodge.demo` |
| Lakeview Lodge | Housekeeper | Mary Wambui | `housekeeping@lakeview-lodge.demo` |
| Lakeview Lodge | Technician | Peter Omondi | `technician@lakeview-lodge.demo` |
| *(platform)* | Super admin | Demo Platform Admin | `platform@demo.test` |

**The password is not written in this document on purpose** — this file is committed to a public
repository. It is in the chat message that delivered this build, and on the machine you run it on it is
in `.owner-test/CREDENTIALS.md` (file mode 600, Git-ignored). One password covers every demo account,
generated per environment; if you reset the environment, a new one is issued and the old one stops
working.

---

## 3. Switching between the two hotels

1. Sign in as `owner@riverside-grand.demo`.
2. Click the **building icon** in the top bar (next to the notification bell) — or go to `/select-hotel`.
3. You see a card per workspace. Click **Enter** on *Lakeview Lodge*.
4. The sidebar, dashboard, guests, rooms, reservations and reports are now Lakeview's. Nothing from
   Riverside is visible.

The demo owner accounts belong to one hotel each. To test switching *within one account*, accept an
invitation: see §5, which invites `receptionist@riverside-grand.demo` into Lakeview as well.

To see the platform console, sign in as `platform@demo.test` and open the shield icon in the top bar. The
console lists a third hotel, **Legacy Hotel** — it is a fixture created by a database migration with no
staff and no data. Ignore it; it is not one of your test hotels.

---

## 4. Checklist — work through in this order

Each section states what you should see. Times are approximate. If something differs, note the section
number — that is the bug report reference.

### A. Sign in and orientation (2 minutes)

| # | Do this | Expect |
|---|---|---|
| A1 | Sign in as the Riverside owner | Dashboard with KPI cards, today's arrivals, occupancy, and a setup checklist |
| A2 | Look at the top bar | The **bell** shows a red count (three seeded notifications: low stock, a maintenance ticket, a subscription renewal) |
| A3 | Click the bell | A panel lists them newest first; **Mark all read** clears the count |
| A4 | Note the sidebar | Dashboard, Front Desk, Reservations, Rooms, Guests, Housekeeping, Maintenance, Restaurant, Inventory, Expenses, Reports, Staff, Subscription, Settings, Audit Trail |

### B. Hotel profile and settings

| # | Do this | Expect |
|---|---|---|
| B1 | Settings → change the hotel phone and save | Saved confirmation; the value persists after a refresh |
| B2 | Settings → change the currency to USD and save | Money labels switch to `$`; switch back to KES afterwards |
| B3 | Change your own password from the key icon, sign out, sign in with the new one | Works; the old password is refused. Reset the environment when you are done (§8) |

### C. Rooms, tariffs and meal plans

| # | Do this | Expect |
|---|---|---|
| C1 | Rooms → **Room Types** | Three tariffs per occupancy, e.g. *Single - Bed Only*, *Double - Bed & Breakfast*, *Double - Half Board* |
| C2 | Add a room type `Single - Half Board`, rate 7 500, capacity 1, meal plan **Half Board** | It appears in the list with its meal plan |
| C3 | Edit it: change the rate to 8 000 | The new rate shows; existing reservations keep their original rate |
| C4 | Add a room `105` on floor 1 of that type | Appears in the room grid |
| C5 | Try to add a second room numbered `105` | Refused — room numbers are unique per hotel, and the same number is allowed in the other hotel |

### D. Guests and reservations

| # | Do this | Expect |
|---|---|---|
| D1 | Reservations → click an empty cell for room 103 | A *New Reservation* dialog with dates prefilled from the cell |
| D2 | Fill **Full Name** = `Test Guest One`, phone `+254700111222`, leave the prefill, **Create Reservation** | The booking appears in the calendar across its nights, status *Confirmed* |
| D3 | Click the booking | It asks **"Cancel this reservation?"** — this is the cancellation path |
| D4 | Cancel it | The bar disappears; the room is free for those dates again; no folio is left open |
| D5 | Book room 103 again for the same guest, then go to Front Desk | It appears under arrivals |
| D6 | Try booking room 103 for overlapping dates | Refused with a message naming the conflict |

### E. Check-in, folio, payments, check-out (the money path)

| # | Do this | Expect |
|---|---|---|
| E1 | Front Desk → **Check In** on the booking from D5 | A *Check In Guest* dialog with the room, the balance and an amount-paid field |
| E2 | Type `999999` in **Amount paid now** | The browser refuses it — the maximum is the outstanding balance |
| E3 | Enter 2 000, method **M-Pesa**, reference `TEST123`, **Confirm Check-in** | Stay becomes *In-house*; the folio opens showing a room charge and your 2 000 payment, with the balance still due |
| E4 | In the folio, **Record Payment** the remaining balance | Balance becomes 0; the folio offers **Complete Checkout** |
| E5 | Try to complete checkout *before* settling the balance (start another booking to see this) | Refused: "KSh … is still due before checkout" |
| E6 | Complete checkout on the settled folio | Stay becomes *Checked out*, the room turns *Dirty*, and a housekeeping task appears |
| E7 | Reports → check *Cash Collected by Method* | Your M-Pesa payment is included for today |
| E8 | Settings/Audit Trail → **Audit Trail** | Rows for *Payment recorded* and *Guest checked out*, with your name as the actor |

### F. Restaurant and POS

| # | Do this | Expect |
|---|---|---|
| F1 | Restaurant → add an order (e.g. 2 × Nyama Choma Platter) → **Pay Now** → Cash | Payment recorded; the menu stock for its recipe ingredients drops |
| F2 | Repeat the same payment (double-click **Take Payment** or submit twice quickly) | Only **one** payment is recorded — duplicate submissions are rejected by the idempotency key |
| F3 | Charge an order **to room** for an in-house guest | The charge lands on that guest's folio as a restaurant item |
| F4 | Restaurant → **Manage Menu** → add category `Desserts`, then item `Tilapia Special` at 1 200 | Both appear immediately; no page reload needed |

### G. Inventory, purchases, recipes, wastage

| # | Do this | Expect |
|---|---|---|
| G1 | Inventory → **Purchases** → **Record Purchase** → item *Beef Sirloin*, supplier `Test Supplier`, qty 5, unit cost 620, **Record Purchase** | Stock rises by 5 kg; **Stock Movements** shows a `PURCHASE` row |
| G2 | Inventory → **Recipes** → **Create Recipe** → pick a menu item, *Add Ingredient* (Beef Sirloin, 200), **Create Recipe** | The recipe card shows cost per portion, profit and *available portions* computed from stock |
| G3 | Inventory → **Wastage** → **Record Wastage** → item, quantity 1, reason, **Person accountable** = a staff member → **Record Wastage** | Stock drops by 1; the row shows the accountable person's name; a `WASTAGE` movement is logged |
| G4 | Set an item's reorder level above its stock (Adjust Stock) | The bell raises a **Low stock** notification; the dashboard KPI *Low Stock Items* increases |

### H. Housekeeping and maintenance

| # | Do this | Expect |
|---|---|---|
| H1 | Housekeeping → move the dirty room through `In progress` → `Ready for inspection` → `Ready` | Each move sticks after a refresh |
| H2 | Maintenance → **New Ticket** (room 102, priority high, take room out of service) | The ticket appears under *Open*; room 102 turns *Maintenance* and disappears from bookable inventory; the bell raises a **Maintenance** notification |
| H3 | Assign the ticket to Samuel Kiptoo and move it to *In progress* | Assignee and status persist |
| H4 | Complete the ticket and set room 102 back to *Available* from Rooms | The room is bookable again |

### I. Expenses and reports

| # | Do this | Expect |
|---|---|---|
| I1 | Expenses → log an expense as the receptionist | It is created as *Pending approval*, not approved |
| I2 | Sign in as the owner and approve it | Status becomes *Approved*; the receptionist cannot approve their own |
| I3 | Reports → set a date range, check revenue, occupancy and collection panels | Numbers match the bookings you made |
| I4 | Reports → **Download Excel** | A spreadsheet downloads with the same figures |

### J. Staff, roles and permissions

| # | Do this | Expect |
|---|---|---|
| J1 | Staff → **Add Staff Member** with a brand-new email, role *Housekeeper*, leave the password blank | Refused: a new account needs an initial password |
| J2 | Add with a password | The account appears as *Active* |
| J3 | Add an existing account (e.g. `owner@lakeview-lodge.demo`) as *Receptionist* | It appears as **Invitation pending**, not active, and the message says access begins when they accept |
| J4 | Sign in as that account, go to `/select-hotel` | A pending invitation for Riverside with **Accept** / **Decline**. No access before accepting |
| J5 | Accept, then switch into Riverside | Now it works, and the staff row becomes *Active* |
| J6 | Suspend a staff member from the staff table | They can no longer sign in (`MembershipSuspended`), and the row says *Suspended* |
| J7 | Remove a staff member, then sign in as them | Sign-in fails; their old password does not work |
| J8 | Sign in as the receptionist and open `/dashboard/audit` by typing the URL | Redirected — the audit trail is owner/admin only |

### K. Subscription, limits and plans

| # | Do this | Expect |
|---|---|---|
| K1 | Subscription page (owner) | Current plan, status, renewal date, room band, rooms used vs the limit |
| K2 | Add rooms until you pass the plan's room limit | The app refuses new rooms and says the plan limit is reached |
| K3 | Sign in as `platform@demo.test`, open the shield icon | Platform console: hotels, subscriptions, status changes |
| K4 | Suspend Riverside from the platform console, then sign in as its owner | The dashboard redirects to the subscription page with a suspension message; operational writes are refused |
| K5 | Reactivate Riverside | Everything works again — no data was lost |

### L. Multi-hotel isolation (do this last)

| # | Do this | Expect |
|---|---|---|
| L1 | Sign in as the Lakeview owner | Dashboard shows Lakeview's rooms, guests and revenue only |
| L2 | Open Guests, Reservations, Rooms, Reports | None of Riverside's guests or bookings appear anywhere |
| L3 | Open `/api/guests` directly in the browser address bar | Only Lakeview's guests, in JSON |
| L4 | Sign in as the Riverside owner and open the Audit Trail | Only Riverside's entries — never Lakeview's |
| L5 | As the Lakeview owner, open the bell | Only Lakeview's notifications |

---

## 5. Expected permission restrictions

| Area | Allowed roles | Everyone else |
|---|---|---|
| Front Desk, Guests, Reservations, check-in/out | Owner, Admin, Manager, Receptionist | Not in the menu; the URL redirects, the API answers 403 |
| Payments, folio settlement | Owner, Admin, Manager, Receptionist, Cashier | 403 |
| Restaurant / POS | Owner, Admin, Manager, Waiter, Cashier | 403 |
| Inventory, purchases, recipes, wastage | Owner, Admin, Manager | 403 |
| Expenses: submit | Any staff member | — |
| Expenses: approve | Owner, Admin, Manager | 403 |
| Reports and Excel export | Owner, Admin, Manager, Accountant | 403 |
| Staff management | Owner, Admin, Manager (view), Owner/Admin (edit) | 403 |
| Subscription, Settings, Audit Trail | Owner, Admin | Redirect / 403 |
| Platform console | Platform super admin only | 404 / redirect |

Housekeeping staff can move their tasks but cannot see the revenue reports. A waiter cannot read the
audit trail. The receptionist cannot approve expenses. **All of these are intentional.**

---

## 6. Multi-hotel isolation scenarios

1. **Data isolation** — Lakeview's guest list, reservations and reports never contain a Riverside name
   (and the reverse). Check Guests, Reservations and Reports in both workspaces.
2. **Identity isolation** — `owner@riverside-grand.demo` cannot switch into Lakeview; the switch is
   refused and no cookie is set.
3. **Invitation isolation** — a pending invitation grants nothing: before accepting, the invitee cannot
   switch into that hotel even by calling the switch endpoint directly.
4. **Notification isolation** — the bell only ever shows the active hotel's notifications.
5. **Audit isolation** — the audit trail is always the active hotel's, never another's.
6. **Inventory isolation** — an inventory item from one hotel cannot be used in the other hotel's
   recipe or wastage; the API refuses (404).

---

## 7. Reporting a bug

Send me, for each issue:

1. The section and step number from this guide (e.g. `E4`).
2. What you expected, and what happened instead — the exact wording of any error message helps.
3. The screenshot (every step of my automated suite produces one; yours is just as useful).
4. The hotel and role you were signed in as, and the rough time (server logs are timestamped).
5. Whether it happened once or every time.

One issue per message, please — it makes it much easier to fix and to prove the fix.

---

## 8. Resetting the test data

The demo database can be reset at any time without touching code, the other environments, or
production:

```bash
node scripts/owner-test-env.mjs reset
```

That drops only `hotel_saas_demo_owner`, re-applies the 19 migrations and re-seeds both hotels with a
fresh password (written to `.owner-test/CREDENTIALS.md`).

Useful companions:

| Command | Effect |
|---|---|
| `node scripts/owner-test-env.mjs status` | Is the database running, and how much data is in it |
| `node scripts/owner-test-env.mjs stop` | Stop the demo database (data kept) |
| `node scripts/owner-test-env.mjs start` | Start it again |
| `node scripts/owner-test-env.mjs url` | Print the demo database URL |

If restoring just the two hotels' *data* is enough, `reset` is the safe way; it never runs against any
database whose name does not start with `hotel_saas_demo_`.

---

## 9. Defect or expected restriction?

Before reporting, check these — they are design decisions, not bugs:

| What you see | Why |
|---|---|
| A menu item is missing from the sidebar | Your role does not have that module |
| Typing a forbidden URL redirects you to the dashboard | Server-side page guard, by design |
| An API call returns 403 with a JSON `error` code | The same guard at the API level |
| A new staff member shows **Invitation pending** | An existing account must consent before it gains access |
| An invited account cannot sign in to that hotel yet | Same reason — accept the invitation first |
| A suspended hotel shows the subscription page | Billing recovery is the only thing open while suspended |
| Check-out is refused with an outstanding balance | Unless you are an Owner/Admin/Manager using *Manager Override* |
| Wastage asks who is accountable | Accountability is required by design; you can pick a staff member or type a name |
| The payment amount is capped at the balance | Over-payment is not allowed; the message states the balance |
| Two rooms in different hotels can have the same number | Room numbers are unique per hotel, not globally |
| **The app shows a message I did not expect, or a page fails** | That *is* a defect — report it with the step number |

---

## 10. What has already been proven automatically

These are covered by the automated suite, so you do not have to re-test them — but you are welcome to:

* 833 unit/integration tests, 55 HTTP end-to-end checks and 33 browser steps across two hotels and
  every role, all green on this build (see `docs/production-readiness-report-round14.md`).
* Sign-up, onboarding, invitations, acceptance, hotel switching, role denial by direct URL.
* A reservation driven from creation through check-in, partial payment, settlement and check-out.
* Cancellation, purchases, stock movements, recipes, wastage, notifications, the audit trail.
* POS payment with duplicate-submission protection, reports and the subscription gate.

What no automated test can tell you is whether the *workflow feels right* for a hotel — that is what
this pass is for.
