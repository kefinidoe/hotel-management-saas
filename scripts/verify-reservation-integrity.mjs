#!/usr/bin/env node
/**
 * Reservation deletion and stay-extension integrity (real PostgreSQL).
 *
 * Everything here runs against the disposable demo database and a real
 * `next start` process with real NextAuth sessions: deletion rules, extension
 * history, audit rollback, duplicate-charge protection under concurrency, and
 * the folio balances that must stay correct throughout.
 *
 * Deletion checks
 *   http-delete-draft            a genuinely unused draft is deleted, audited
 *   http-delete-folio-charge     a folio charge alone blocks deletion
 *   http-delete-pending-payment  a pending payment blocks deletion
 *   http-delete-refunded-payment a refunded payment blocks deletion
 *   http-delete-completed-payment a completed payment blocks deletion
 *   http-delete-repriced         pricing history blocks deletion
 *   http-delete-extended         extension history blocks deletion
 *   http-delete-rejection-atomic a rejected deletion changes nothing
 *   http-delete-cross-hotel      another hotel's manager gets 404
 *
 * Extension checks
 *   http-extend-charge           the folio charge matches nights x agreed rate
 *   http-extend-history          the extension row records the agreement
 *   http-extend-snapshot-frozen  the booking's frozen price is untouched
 *   http-extend-balances         required/paid/balance stay arithmetically correct
 *   http-extend-repeat           repeating the request cannot charge twice
 *   http-extend-concurrent       two simultaneous requests produce one charge
 *   http-extend-audit-rollback   a failing audit rolls back charge and dates
 *   http-extend-conflict         a conflicting booking blocks the extension
 *   http-extend-cross-hotel      another hotel's manager gets 404
 *
 * Usage:
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:55433/hotel_saas_demo_owner \
 *     node scripts/verify-reservation-integrity.mjs \
 *     --base http://127.0.0.1:3000 --json docs/evidence/reservations/deletion-extension-integrity.json
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const BASE = arg("base", "http://127.0.0.1:3000").replace(/\/+$/, "");
const JSON_OUT = arg("json", null);
const OUT = resolve(ROOT, arg("out", "docs/evidence/reservations"));

const PSQL =
  process.env.PSQL_BIN ||
  join(ROOT, ".owner-test/postgresql-17.11.0-x86_64-unknown-linux-gnu/bin/psql");
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL must point at the disposable demo database.");
  process.exit(2);
}

const creds = JSON.parse(readFileSync(join(ROOT, ".owner-test/credentials.json"), "utf8"));
const account = (role, hotel) => {
  const match = creds.accounts.find((entry) => entry.role === role && entry.hotel === hotel);
  if (!match) throw new Error(`No ${role} account for ${hotel} in credentials.json`);
  return match;
};

const color = (code, text) => `\u001b[${code}m${text}\u001b[0m`;
const results = [];

async function checkAsync(id, description, fn) {
  try {
    const detail = await fn();
    results.push({ id, description, status: "PASS", detail: String(detail ?? "") });
    console.log(`${color(32, "  PASS")}  ${id} — ${description}`);
    return detail;
  } catch (error) {
    results.push({
      id,
      description,
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(`${color(31, "  FAIL")}  ${id} — ${description}`);
    console.log(`        ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

function sql(query) {
  return execFileSync(
    PSQL,
    [DATABASE_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query],
    { encoding: "utf8" }
  ).trim();
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------------------
// Fixtures: this script owns room 906 and its room type.
// ---------------------------------------------------------------------------
const HOTEL_NAME = "Riverside Grand Hotel";
const FOREIGN_HOTEL_NAME = "Lakeview Lodge";
const ROOM_TYPE_NAME = "Integrity Standard";
const ROOM_NUMBER = "906";
const NIGHTLY_RATE = 7000;

function hotelIdByName(name) {
  const id = sql(`SELECT id FROM "Hotel" WHERE name = '${name}' LIMIT 1`);
  assert(id, `hotel ${name} not found`);
  return id;
}

function cleanup(hotel, roomId) {
  const ids = sql(
    `SELECT string_agg(DISTINCT "reservationId", ',') FROM "ReservationRoom" WHERE "roomId" = '${roomId}'`
  );
  if (!ids) return 0;
  const list = ids.split(",").map((id) => `'${id}'`).join(",");
  sql(`DELETE FROM "Payment" WHERE "folioId" IN (SELECT id FROM "Folio" WHERE "reservationId" IN (${list}))`);
  sql(`DELETE FROM "FolioItem" WHERE "folioId" IN (SELECT id FROM "Folio" WHERE "reservationId" IN (${list}))`);
  sql(`DELETE FROM "Folio" WHERE "reservationId" IN (${list})`);
  sql(`DELETE FROM "ReservationExtension" WHERE "reservationId" IN (${list})`);
  sql(`DELETE FROM "ReservationPriceChange" WHERE "reservationId" IN (${list})`);
  sql(`DELETE FROM "ReservationPriceSnapshot" WHERE "reservationId" IN (${list})`);
  sql(`DELETE FROM "ReservationRoom" WHERE "reservationId" IN (${list})`);
  sql(`DELETE FROM "Reservation" WHERE id IN (${list})`);
  return list.split(",").length;
}

function ensureFixtures() {
  const hotel = hotelIdByName(HOTEL_NAME);
  sql(
    `INSERT INTO "RoomType" (id, "hotelId", name, "baseRate", "mealPlan", "createdAt", "updatedAt")
     SELECT gen_random_uuid()::text, '${hotel}', '${ROOM_TYPE_NAME}', ${NIGHTLY_RATE}, NULL, now(), now()
     WHERE NOT EXISTS (SELECT 1 FROM "RoomType" WHERE "hotelId" = '${hotel}' AND name = '${ROOM_TYPE_NAME}')`
  );
  const roomTypeId = sql(
    `SELECT id FROM "RoomType" WHERE "hotelId" = '${hotel}' AND name = '${ROOM_TYPE_NAME}' LIMIT 1`
  );
  sql(
    `INSERT INTO "Room" (id, "hotelId", "roomTypeId", number, floor, status, "isActive", "createdAt", "updatedAt")
     SELECT gen_random_uuid()::text, '${hotel}', '${roomTypeId}', '${ROOM_NUMBER}', 9, 'AVAILABLE', true, now(), now()
     WHERE NOT EXISTS (SELECT 1 FROM "Room" WHERE "hotelId" = '${hotel}' AND number = '${ROOM_NUMBER}')`
  );
  sql(
    `UPDATE "Room" SET "roomTypeId" = '${roomTypeId}', status = 'AVAILABLE'
     WHERE "hotelId" = '${hotel}' AND number = '${ROOM_NUMBER}'`
  );
  const roomId = sql(`SELECT id FROM "Room" WHERE "hotelId" = '${hotel}' AND number = '${ROOM_NUMBER}'`);
  cleanup(hotel, roomId);
  return {
    hotel,
    roomId,
    roomTypeId,
    currency: sql(`SELECT currency FROM "Hotel" WHERE id = '${hotel}'`),
    foreignHotel: hotelIdByName(FOREIGN_HOTEL_NAME),
  };
}

// ---------------------------------------------------------------------------
// HTTP client with a real session.
// ---------------------------------------------------------------------------
function createClient() {
  const jar = new Map();
  const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");

  async function request(path, init = {}) {
    const headers = new Headers(init.headers || {});
    if (!headers.has("origin")) headers.set("origin", BASE);
    if (jar.size) headers.set("cookie", cookieHeader());
    const response = await fetch(`${BASE}${path}`, { ...init, headers, redirect: "manual" });
    for (const raw of response.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(";");
      const index = pair.indexOf("=");
      if (index > 0) jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
    return response;
  }

  async function login(email, password) {
    const csrf = await (await request("/api/auth/csrf")).json();
    const body = new URLSearchParams({
      csrfToken: csrf.csrfToken,
      email,
      password,
      callbackUrl: "/login",
      json: "true",
    });
    const response = await request("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    assert(response.status < 400, `login for ${email} failed with ${response.status}`);
    const session = await (await request("/api/auth/session")).json();
    assert(session?.user?.email === email, `no session after login for ${email}`);
    return session;
  }

  async function send(path, method, payload) {
    const response = await request(path, {
      method,
      headers: payload === undefined ? undefined : { "Content-Type": "application/json" },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  return {
    request,
    login,
    get: (path) => send(path, "GET"),
    post: (path, payload) => send(path, "POST", payload),
    patch: (path, payload) => send(path, "PATCH", payload),
    delete: (path) => send(path, "DELETE"),
  };
}

async function signIn(role, hotel) {
  const who = account(role, hotel);
  const client = createClient();
  await client.login(who.email, who.password);
  const selection = await client.post("/api/auth/switch-hotel", { hotelId: hotelIdByName(hotel) });
  assert(selection.status === 200, `switch-hotel returned ${selection.status} for ${who.email}`);
  return client;
}

function isoDay(offsetDays) {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

// State readers.
const exists = (table, id) =>
  Number(sql(`SELECT count(*) FROM "${table}" WHERE id = '${id}'`)) > 0;
const count = (query) => Number(sql(query));
const scalar = (query) => sql(query);

async function createStay(client, fx, { start = 40, nights = 3 } = {}) {
  // The fixture room is left OCCUPIED by the check-in fixture of a previous
  // check; housekeeping would have released it, so do the same.
  sql(`UPDATE "Room" SET status = 'AVAILABLE' WHERE id = '${fx.roomId}'`);
  let last = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await client.post("/api/reservations", {
      guestName: `Integrity Guest ${Math.random().toString(36).slice(2, 8)}`,
      checkInDate: `${isoDay(start)}T12:00:00.000Z`,
      checkOutDate: `${isoDay(start + nights)}T12:00:00.000Z`,
      roomId: fx.roomId,
      // The demo hotel prices from its room type base rate, so the booking
      // carries the legacy occupancy/meal-plan descriptors.
      tariffId: fx.roomTypeId,
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
      adults: 1,
      children: 0,
    });
    last = response;
    if (response.status === 201 && response.body?.id) {
      return { id: response.body.id, total: Number(response.body.total), nights };
    }
    if (response.status !== 409) break;
    await sleep(attempt * 150);
  }
  throw new Error(`reservation creation returned ${last?.status}: ${JSON.stringify(last?.body)}`);
}

/** Create the folio/payment/status a real check-in would have produced. */
function checkInByFixture(fx, stayId, { nights = 3, rate = NIGHTLY_RATE, deposit = 0 } = {}) {
  const guestId = scalar(`SELECT "guestId" FROM "Reservation" WHERE id = '${stayId}'`);
  const folioId = randomUUID();
  sql(
    `INSERT INTO "Folio" (id, "hotelId", "guestId", "reservationId", "isClosed", "createdAt", "updatedAt")
     VALUES ('${folioId}', '${fx.hotel}', '${guestId}', '${stayId}', false, now(), now())`
  );
  sql(
    `INSERT INTO "FolioItem" (id, "folioId", type, description, quantity, "unitPrice", "taxRate", total, "createdAt")
     VALUES ('${randomUUID()}', '${folioId}', 'ROOM_CHARGE', 'Room ${ROOM_NUMBER} — accommodation',
             ${nights}, ${rate}, 0, ${nights * rate}, now())`
  );
  if (deposit > 0) {
    const methodId = scalar(
      `SELECT id FROM "PaymentMethod" WHERE "hotelId" = '${fx.hotel}' ORDER BY name LIMIT 1`
    );
    const cashierId = scalar(
      `SELECT id FROM "User" WHERE email = '${account("CASHIER", HOTEL_NAME).email}'`
    );
    sql(
      `INSERT INTO "Payment" (id, "hotelId", "folioId", "paymentMethodId", amount, status, "cashierId", "createdAt")
       VALUES ('${randomUUID()}', '${fx.hotel}', '${folioId}', '${methodId}', ${deposit}, 'COMPLETED', '${cashierId}', now())`
    );
  }
  sql(`UPDATE "Reservation" SET status = 'CHECKED_IN' WHERE id = '${stayId}'`);
  sql(`UPDATE "Room" SET status = 'OCCUPIED' WHERE id = '${fx.roomId}'`);
  return folioId;
}

/**
 * Write the frozen booking agreement (snapshot version 1) the way reservation
 * creation does for a hotel that prices from configuration. The demo hotel uses
 * its room type rate, which writes no snapshot, so extension checks need the
 * agreement to exist explicitly to prove the extension never touches it.
 */
function freezeBookingSnapshot(stay, { nights, rate }) {
  const total = nights * rate;
  const user = scalar(`SELECT "createdById" FROM "Reservation" WHERE id = '${stay.id}'`);
  sql(
    `INSERT INTO "ReservationPriceSnapshot"
       (id, "hotelId", "reservationId", version, "pricingModel", currency, "nightlyRate", nights,
        "roomTotal", "mealsTotal", "extrasTotal", "adjustmentsTotal", "discountTotal", "taxTotal",
        "grandTotal", breakdown, "createdById", "createdAt")
     SELECT gen_random_uuid()::text, r."hotelId", r.id, 1, 'LEGACY_BASE_RATE',
            (SELECT currency FROM "Hotel" WHERE id = r."hotelId"),
            ${rate}, ${nights}, ${total}, 0, 0, 0, 0, 0, ${total},
            jsonb_build_object('kind', 'booking agreement', 'nights', ${nights}, 'nightlyRate', ${rate}),
            '${user}', now()
     FROM "Reservation" r WHERE r.id = '${stay.id}'`
  );
  return total;
}

/** Remove a fixture reservation and its children (test teardown of our own rows). */
function destroyFixture(stayId) {
  sql(`DELETE FROM "Payment" WHERE "folioId" IN (SELECT id FROM "Folio" WHERE "reservationId" = '${stayId}')`);
  sql(`DELETE FROM "FolioItem" WHERE "folioId" IN (SELECT id FROM "Folio" WHERE "reservationId" = '${stayId}')`);
  sql(`DELETE FROM "Folio" WHERE "reservationId" = '${stayId}'`);
  sql(`DELETE FROM "ReservationExtension" WHERE "reservationId" = '${stayId}'`);
  sql(`DELETE FROM "ReservationPriceChange" WHERE "reservationId" = '${stayId}'`);
  sql(`DELETE FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${stayId}'`);
  sql(`DELETE FROM "ReservationRoom" WHERE "reservationId" = '${stayId}'`);
  sql(`DELETE FROM "Reservation" WHERE id = '${stayId}'`);
}

/** A check-out date `nights` after the reservation's current check-out. */
function checkOutAfter(stayId, nights) {
  const current = new Date(scalar(`SELECT "checkOutDate" FROM "Reservation" WHERE id = '${stayId}'`));
  current.setUTCHours(12, 0, 0, 0);
  current.setUTCDate(current.getUTCDate() + nights);
  return current.toISOString();
}

function addFolioCharge(fx, stayId, { type = "ROOM_CHARGE", amount = 2000 } = {}) {
  const guestId = scalar(`SELECT "guestId" FROM "Reservation" WHERE id = '${stayId}'`);
  let folioId = scalar(
    `SELECT id FROM "Folio" WHERE "reservationId" = '${stayId}' AND "hotelId" = '${fx.hotel}' LIMIT 1`
  );
  if (!folioId) {
    folioId = randomUUID();
    sql(
      `INSERT INTO "Folio" (id, "hotelId", "guestId", "reservationId", "isClosed", "createdAt", "updatedAt")
       VALUES ('${folioId}', '${fx.hotel}', '${guestId}', '${stayId}', false, now(), now())`
    );
  }
  sql(
    `INSERT INTO "FolioItem" (id, "folioId", type, description, quantity, "unitPrice", "taxRate", total, "createdAt")
     VALUES ('${randomUUID()}', '${folioId}', '${type}', 'fixture charge', 1, ${amount}, 0, ${amount}, now())`
  );
  return folioId;
}

function addPayment(fx, stayId, status, amount = 1500) {
  const folioId =
    scalar(
      `SELECT id FROM "Folio" WHERE "reservationId" = '${stayId}' AND "hotelId" = '${fx.hotel}' LIMIT 1`
    ) || addFolioCharge(fx, stayId, { amount: 0 });
  const methodId = scalar(
    `SELECT id FROM "PaymentMethod" WHERE "hotelId" = '${fx.hotel}' ORDER BY name LIMIT 1`
  );
  const cashierId = scalar(`SELECT id FROM "User" WHERE email = '${account("CASHIER", HOTEL_NAME).email}'`);
  sql(
    `INSERT INTO "Payment" (id, "hotelId", "folioId", "paymentMethodId", amount, status, "cashierId", "createdAt")
     VALUES ('${randomUUID()}', '${fx.hotel}', '${folioId}', '${methodId}', ${amount}, '${status}', '${cashierId}', now())`
  );
  return folioId;
}

// ---------------------------------------------------------------------------

async function main() {
  const fx = ensureFixtures();
  const owner = await signIn("HOTEL_OWNER", HOTEL_NAME);
  const manager = await signIn("MANAGER", HOTEL_NAME);
  const receptionist = await signIn("RECEPTIONIST", HOTEL_NAME);
  const foreignManager = await signIn("MANAGER", FOREIGN_HOTEL_NAME);

  const restoreLegacy = () =>
    owner.patch?.("/api/pricing", {
      pricingModel: "LEGACY_BASE_RATE",
      useOccupancyRates: false,
      useMealPlans: false,
      useSeasonalPricing: false,
      useWeekendPricing: false,
      useChildPricing: false,
      useExtraBeds: false,
      useTaxes: false,
      pricesIncludeTax: false,
    }) ?? Promise.resolve();

  // The demo hotel prices from its room type base rate, which is exactly the
  // path this script needs: the agreed rate is the frozen booking rate.
  await restoreLegacy();

  // -------------------------------------------------------------------------
  // Task A — deletion
  // -------------------------------------------------------------------------
  await checkAsync("delete-draft", "an unused draft is deleted and audited", async () => {
    const stay = await createStay(receptionist, fx, { start: 40, nights: 2 });
    const snapshotBefore = count(
      `SELECT count(*) FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${stay.id}'`
    );
    const response = await manager.delete(`/api/reservations/${stay.id}`);
    assert(response.status === 200, `expected 200, got ${response.status}: ${JSON.stringify(response.body)}`);
    assert(!exists("Reservation", stay.id), "the reservation row survived");
    assert(
      count(`SELECT count(*) FROM "ReservationRoom" WHERE "reservationId" = '${stay.id}'`) === 0,
      "the room block survived"
    );
    assert(
      count(`SELECT count(*) FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${stay.id}'`) === 0,
      "the draft's frozen quote survived"
    );
    assert(
      count(
        `SELECT count(*) FROM "AuditLog" WHERE "entityId" = '${stay.id}' AND action = 'RESERVATION_DELETED'`
      ) === 1,
      "no RESERVATION_DELETED audit row was written"
    );
    return `200; draft removed with ${snapshotBefore} quote row(s); audit row written`;
  });

  let deletionWindow = 45;
  const deletionBlocked = async (label, { setup, expectMatch }) => {
    const stay = await createStay(receptionist, fx, { start: deletionWindow, nights: 2 });
    deletionWindow += 3;
    await setup(stay.id);
    const before = {
      reservation: exists("Reservation", stay.id),
      items: count(
        `SELECT count(*) FROM "FolioItem" fi JOIN "Folio" f ON f.id = fi."folioId" WHERE f."reservationId" = '${stay.id}'`
      ),
      payments: count(
        `SELECT count(*) FROM "Payment" p JOIN "Folio" f ON f.id = p."folioId" WHERE f."reservationId" = '${stay.id}'`
      ),
      snapshots: count(
        `SELECT count(*) FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${stay.id}'`
      ),
      audits: count(
        `SELECT count(*) FROM "AuditLog" WHERE "entityId" = '${stay.id}' AND action = 'RESERVATION_DELETED'`
      ),
    };
    const response = await manager.delete(`/api/reservations/${stay.id}`);
    assert(response.status === 409, `${label}: expected 409, got ${response.status}: ${JSON.stringify(response.body)}`);
    assert(
      response.body?.code === "RESERVATION_HAS_FINANCIAL_RECORDS",
      `${label}: unexpected code ${response.body?.code}`
    );
    assert(expectMatch.test(String(response.body?.error)), `${label}: message was "${response.body?.error}"`);
    assert(exists("Reservation", stay.id), `${label}: the reservation was deleted anyway`);
    assert(
      count(
        `SELECT count(*) FROM "FolioItem" fi JOIN "Folio" f ON f.id = fi."folioId" WHERE f."reservationId" = '${stay.id}'`
      ) === before.items,
      `${label}: folio lines changed`
    );
    assert(
      count(
        `SELECT count(*) FROM "Payment" p JOIN "Folio" f ON f.id = p."folioId" WHERE f."reservationId" = '${stay.id}'`
      ) === before.payments,
      `${label}: payments changed`
    );
    assert(
      count(`SELECT count(*) FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${stay.id}'`) ===
        before.snapshots,
      `${label}: pricing evidence changed`
    );
    assert(
      count(
        `SELECT count(*) FROM "AuditLog" WHERE "entityId" = '${stay.id}' AND action = 'RESERVATION_DELETED'`
      ) === before.audits,
      `${label}: a deletion audit row was written for a refused deletion`
    );
    destroyFixture(stay.id);
    return stay.id;
  };

  await checkAsync("delete-folio-charge", "a folio charge alone blocks deletion", async () => {
    await deletionBlocked("folio charge", {
      setup: (id) => addFolioCharge(fx, id, { type: "ROOM_CHARGE", amount: 2500 }),
      expectMatch: /folio charge/i,
    });
    return "409 RESERVATION_HAS_FINANCIAL_RECORDS, records unchanged";
  });

  await checkAsync("delete-pending-payment", "a pending payment blocks deletion", async () => {
    await deletionBlocked("pending payment", {
      setup: (id) => addPayment(fx, id, "PENDING"),
      expectMatch: /payment/i,
    });
    return "409, records unchanged";
  });

  await checkAsync("delete-refunded-payment", "a refunded payment blocks deletion", async () => {
    await deletionBlocked("refunded payment", {
      setup: (id) => addPayment(fx, id, "REFUNDED"),
      expectMatch: /refunded/i,
    });
    return "409, message names the refunded payment";
  });

  await checkAsync("delete-completed-payment", "a completed payment blocks deletion", async () => {
    await deletionBlocked("completed payment", {
      setup: (id) => addPayment(fx, id, "COMPLETED"),
      expectMatch: /payment/i,
    });
    return "409, records unchanged";
  });

  await checkAsync("delete-repriced", "pricing history blocks deletion", async () => {
    const stay = await createStay(receptionist, fx, { start: 60, nights: 2 });
    // A repricing is exactly "a second version plus its change row". The demo
    // hotel prices from its room type rate, which does not write a snapshot at
    // creation, so the two versions are written here in the exact shape the
    // reprice endpoint produces.
    freezeBookingSnapshot(stay, { nights: 2, rate: NIGHTLY_RATE });
    sql(
      `INSERT INTO "ReservationPriceSnapshot"
         (id, "hotelId", "reservationId", version, "pricingModel", currency, "nightlyRate", nights,
          "roomTotal", "mealsTotal", "extrasTotal", "adjustmentsTotal", "discountTotal", "taxTotal",
          "grandTotal", breakdown, "createdById", "createdAt")
       SELECT gen_random_uuid()::text, "hotelId", "reservationId", 2, "pricingModel", currency,
              "nightlyRate", nights, "roomTotal", "mealsTotal", "extrasTotal", "adjustmentsTotal",
              "discountTotal", "taxTotal", "grandTotal", breakdown, "createdById", now()
       FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${stay.id}' AND version = 1`
    );
    sql(
      `INSERT INTO "ReservationPriceChange"
         (id, "hotelId", "reservationId", "previousTotal", "newTotal", "previousVersion", "newVersion",
          reason, breakdown, "changedById", "createdAt")
       SELECT gen_random_uuid()::text, "hotelId", "reservationId", "grandTotal", "grandTotal", 1, 2,
              'integrity check', breakdown, "createdById", now()
       FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${stay.id}' AND version = 1`
    );
    const response = await manager.delete(`/api/reservations/${stay.id}`);
    assert(response.status === 409, `expected 409, got ${response.status}`);
    assert(/repricing/i.test(String(response.body?.error)), `message was "${response.body?.error}"`);
    assert(
      count(`SELECT count(*) FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${stay.id}'`) === 2,
      "versions were removed by the refused deletion"
    );
    assert(
      count(`SELECT count(*) FROM "ReservationPriceChange" WHERE "reservationId" = '${stay.id}'`) === 1,
      "the price-change row was removed by the refused deletion"
    );
    return "409, both versions and the change row intact";
  });

  await checkAsync("delete-extended", "extension history blocks deletion", async () => {
    const stay = await createStay(receptionist, fx, { start: 63, nights: 2 });
    const folioId = addFolioCharge(fx, stay.id, { amount: 0 });
    // An approved extension recorded by the real endpoint lives on a checked-in
    // stay; this reservation stays PENDING so the *extension rule* is what
    // refuses the delete rather than the status rule.
    sql(
      `INSERT INTO "ReservationExtension"
         (id, "hotelId", "reservationId", "previousCheckOut", "newCheckOut", "additionalNights",
          "nightlyRate", "additionalCharge", currency, rooms, "folioId", "folioItemIds", "priceVersion",
          "approvedById", "createdAt")
       VALUES ('${randomUUID()}', '${fx.hotel}', '${stay.id}',
               (SELECT "checkOutDate" FROM "Reservation" WHERE id = '${stay.id}'),
               (SELECT "checkOutDate" FROM "Reservation" WHERE id = '${stay.id}') + interval '1 day',
               1, ${NIGHTLY_RATE}, ${NIGHTLY_RATE}, '${fx.currency}',
               '[]'::jsonb, '${folioId}', '[]'::jsonb, 1,
               '${scalar(`SELECT id FROM "User" WHERE email = '${account("MANAGER", HOTEL_NAME).email}'`)}',
               now())`
    );
    const response = await manager.delete(`/api/reservations/${stay.id}`);
    assert(response.status === 409, `expected 409, got ${response.status}`);
    assert(/extension/i.test(String(response.body?.error)), `message was "${response.body?.error}"`);
    assert(
      count(`SELECT count(*) FROM "ReservationExtension" WHERE "reservationId" = '${stay.id}'`) === 1,
      "the extension row was removed by the refused deletion"
    );
    destroyFixture(stay.id);
    return "409, message names the extension, row intact";
  });

  await checkAsync("delete-cross-hotel", "another hotel's manager cannot delete", async () => {
    const stay = await createStay(receptionist, fx, { start: 66, nights: 2 });
    const response = await foreignManager.delete(`/api/reservations/${stay.id}`);
    assert(response.status === 404, `expected 404, got ${response.status}`);
    assert(exists("Reservation", stay.id), "a foreign hotel deleted the reservation");
    destroyFixture(stay.id);
    return "404, reservation intact";
  });

  // -------------------------------------------------------------------------
  // Task B — extensions
  // -------------------------------------------------------------------------
  const extensionSetup = async (start, nights = 3, deposit = 0) => {
    const stay = await createStay(receptionist, fx, { start, nights });
    freezeBookingSnapshot(stay, { nights, rate: NIGHTLY_RATE });
    const folioId = checkInByFixture(fx, stay.id, { nights, rate: NIGHTLY_RATE, deposit });
    return { ...stay, folioId };
  };

  const extension = await checkAsync(
    "extend-charge",
    "the extension posts exactly nights x agreed rate to the folio",
    async () => {
      const stay = await extensionSetup(70, 2, 5000);
      const before = {
        required: count(
          `SELECT coalesce(sum(total), 0) FROM "FolioItem" WHERE "folioId" = '${stay.folioId}'`
        ),
        items: count(`SELECT count(*) FROM "FolioItem" WHERE "folioId" = '${stay.folioId}'`),
      };
      const response = await manager.post(`/api/reservations/${stay.id}/extend`, {
        checkOutDate: checkOutAfter(stay.id, 2),
        note: "guest staying two more nights",
      });
      assert(response.status === 200, `expected 200, got ${response.status}: ${JSON.stringify(response.body)}`);
      assert(response.body.additionalNights === 2, `additionalNights ${response.body.additionalNights}`);
      assert(
        Number(response.body.additionalCharge) === NIGHTLY_RATE * 2,
        `additionalCharge ${response.body.additionalCharge}`
      );
      const after = {
        required: count(
          `SELECT coalesce(sum(total), 0) FROM "FolioItem" WHERE "folioId" = '${stay.folioId}'`
        ),
        items: count(`SELECT count(*) FROM "FolioItem" WHERE "folioId" = '${stay.folioId}'`),
      };
      assert(after.items === before.items + 1, `folio line count ${before.items} -> ${after.items}`);
      assert(
        after.required === before.required + NIGHTLY_RATE * 2,
        `folio total ${before.required} -> ${after.required}`
      );
      assert(
        Number(response.body.required) === after.required,
        `response required ${response.body.required} != folio total ${after.required}`
      );
      const line = sql(
        `SELECT quantity || '|' || "unitPrice" || '|' || total FROM "FolioItem"
         WHERE "folioId" = '${stay.folioId}' ORDER BY "createdAt" DESC LIMIT 1`
      );
      assert(line === `2|${NIGHTLY_RATE}.00|${NIGHTLY_RATE * 2}.00` || line === `2|${NIGHTLY_RATE}|${NIGHTLY_RATE * 2}`, `charge line was ${line}`);
      state.extension = { ...stay, extensionId: response.body.extensionId, response };
      return `2 nights x ${NIGHTLY_RATE} = ${NIGHTLY_RATE * 2}; folio ${before.required} -> ${after.required}`;
    }
  );

  await checkAsync("extend-history", "the extension records the whole agreement", async () => {
    assert(state.extension, "the extension check did not run");
    const row = sql(
      `SELECT "previousCheckOut" || '|' || "newCheckOut" || '|' || "additionalNights" || '|' ||
              "nightlyRate" || '|' || "additionalCharge" || '|' || currency || '|' ||
              coalesce("priceVersion"::text, 'null') || '|' || "folioId" || '|' ||
              ("rooms"->0->>'number') || '|' || ("rooms"->0->>'nights') || '|' || "approvedById"
       FROM "ReservationExtension" WHERE id = '${state.extension.extensionId}'`
    );
    assert(row, "no extension row was written");
    const [previous, next, nights, rate, charge, currency, priceVersion, folioId, roomNumber, roomNights, approvedBy] =
      row.split("|");
    assert(nights === "2", `nights ${nights}`);
    assert(Number(rate) === NIGHTLY_RATE, `rate ${rate}`);
    assert(Number(charge) === NIGHTLY_RATE * 2, `charge ${charge}`);
    assert(currency === fx.currency, `currency ${currency}`);
    assert(priceVersion === "1", `priceVersion ${priceVersion}`);
    assert(folioId === state.extension.folioId, "folio id mismatch");
    assert(roomNumber === ROOM_NUMBER, `room number ${roomNumber}`);
    assert(roomNights === "2", `room nights ${roomNights}`);
    const managerId = scalar(`SELECT id FROM "User" WHERE email = '${account("MANAGER", HOTEL_NAME).email}'`);
    assert(approvedBy === managerId, "approver is not the manager who extended the stay");
    assert(new Date(next).getTime() > new Date(previous).getTime(), "checkout did not move forward");
    const audit = sql(
      `SELECT metadata->>'extensionId' || '|' || (metadata->>'additionalNights')
       FROM "AuditLog" WHERE action = 'RESERVATION_EXTENDED' AND "entityId" = '${state.extension.id}'
       ORDER BY "createdAt" DESC LIMIT 1`
    );
    assert(audit === `${state.extension.extensionId}|2`, `audit metadata was "${audit}"`);
    return `${previous.slice(0, 10)} -> ${next.slice(0, 10)}, ${nights} nights, room ${roomNumber}, ${charge} ${currency}, approver + audit recorded`;
  });

  await checkAsync("extend-snapshot-frozen", "the booking's frozen price is untouched", async () => {
    assert(state.extension, "the extension check did not run");
    const rows = sql(
      `SELECT version || '|' || "grandTotal" || '|' || nights || '|' || "nightlyRate" || '|' ||
              "roomTotal" || '|' || "discountTotal" || '|' || "createdById"
       FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${state.extension.id}' ORDER BY version`
    );
    const creator = scalar(`SELECT "createdById" FROM "Reservation" WHERE id = '${state.extension.id}'`);
    assert(
      rows === `1|${NIGHTLY_RATE * 2}.00|2|${NIGHTLY_RATE}.00|${NIGHTLY_RATE * 2}.00|0.00|${creator}`,
      `snapshots were ${rows}`
    );
    assert(
      count(`SELECT count(*) FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${state.extension.id}'`) === 1,
      "the extension appended a price version"
    );
    assert(
      count(`SELECT count(*) FROM "ReservationPriceChange" WHERE "reservationId" = '${state.extension.id}'`) === 0,
      "the extension wrote a repricing record"
    );
    return `version 1 unchanged (${NIGHTLY_RATE * 2} for 2 nights); no new version, no repricing row`;
  });

  await checkAsync("extend-balances", "required, paid and balance stay arithmetically correct", async () => {
    assert(state.extension, "the extension check did not run");
    const required = count(
      `SELECT coalesce(sum(total), 0) FROM "FolioItem" WHERE "folioId" = '${state.extension.folioId}'`
    );
    const paid = count(
      `SELECT coalesce(sum(amount), 0) FROM "Payment"
       WHERE "folioId" = '${state.extension.folioId}' AND status = 'COMPLETED'`
    );
    const body = state.extension.response.body;
    assert(Number(body.required) === required, `required ${body.required} != ${required}`);
    assert(Number(body.paid) === paid, `paid ${body.paid} != ${paid}`);
    assert(Number(body.balance) === required - paid, `balance ${body.balance} != ${required - paid}`);
    return `required ${required}, paid ${paid}, balance ${required - paid}`;
  });

  await checkAsync("extend-repeat", "repeating the request cannot charge twice", async () => {
    assert(state.extension, "the extension check did not run");
    const itemsBefore = count(
      `SELECT count(*) FROM "FolioItem" WHERE "folioId" = '${state.extension.folioId}'`
    );
    const response = await manager.post(`/api/reservations/${state.extension.id}/extend`, {
      checkOutDate: checkOutAfter(state.extension.id, 0),
    });
    assert(String(response.body?.code) === "EXTENSION_ALREADY_APPLIED", `repeating without moving the date should be refused`);
    assert(
      response.body?.code === "EXTENSION_ALREADY_APPLIED",
      `unexpected code ${response.body?.code}`
    );
    assert(
      count(`SELECT count(*) FROM "FolioItem" WHERE "folioId" = '${state.extension.folioId}'`) === itemsBefore,
      "the repeated request added a folio line"
    );
    assert(
      count(`SELECT count(*) FROM "ReservationExtension" WHERE "reservationId" = '${state.extension.id}'`) === 1,
      "the repeated request wrote a second extension"
    );
    return "409 EXTENSION_ALREADY_APPLIED, one extension, no extra charge";
  });

  await checkAsync("extend-concurrent", "two simultaneous extensions produce one charge", async () => {
    const stay = await extensionSetup(80, 2, 0);
    const target = { checkOutDate: checkOutAfter(stay.id, 2) };
    const [first, second] = await Promise.all([
      manager.post(`/api/reservations/${stay.id}/extend`, target),
      manager.post(`/api/reservations/${stay.id}/extend`, target),
    ]);
    const statuses = [first.status, second.status].sort((a, b) => a - b);
    assert(!statuses.includes(500), `a request failed with 500: ${JSON.stringify([first.body, second.body])}`);
    assert(statuses[0] === 200 && statuses[1] === 409, `statuses were ${statuses.join("+")}`);
    assert(
      count(`SELECT count(*) FROM "ReservationExtension" WHERE "reservationId" = '${stay.id}'`) === 1,
      "duplicate extension rows were written"
    );
    const nights = count(
      `SELECT coalesce(sum(quantity), 0) FROM "FolioItem" WHERE "folioId" = '${stay.folioId}'`
    );
    assert(nights === 4, `expected 2 booked + 2 extended nights, found ${nights}`);
    return `200+409, one extension, ${nights} nights charged in total (2 booked + 2 extended)`;
  });

  await checkAsync("extend-audit-rollback", "a failing audit rolls back charge and dates", async () => {
    const stay = await extensionSetup(90, 2, 0);
    const before = {
      items: count(`SELECT count(*) FROM "FolioItem" WHERE "folioId" = '${stay.folioId}'`),
      total: count(`SELECT coalesce(sum(total), 0) FROM "FolioItem" WHERE "folioId" = '${stay.folioId}'`),
      checkOut: scalar(`SELECT "checkOutDate" FROM "Reservation" WHERE id = '${stay.id}'`),
      extensions: count(`SELECT count(*) FROM "ReservationExtension" WHERE "reservationId" = '${stay.id}'`),
    };
    sql(
      `CREATE OR REPLACE FUNCTION arena_simulate_extension_audit_outage() RETURNS trigger AS $$
       BEGIN
         IF NEW."entityId" = '${stay.id}' AND NEW.action = 'RESERVATION_EXTENDED' THEN
           RAISE EXCEPTION 'simulated audit outage';
         END IF;
         RETURN NEW;
       END;
       $$ LANGUAGE plpgsql`
    );
    sql(
      `CREATE TRIGGER arena_simulate_extension_audit_outage BEFORE INSERT ON "AuditLog"
       FOR EACH ROW EXECUTE FUNCTION arena_simulate_extension_audit_outage()`
    );
    let response = null;
    try {
      response = await manager.post(`/api/reservations/${stay.id}/extend`, {
        checkOutDate: checkOutAfter(stay.id, 2),
      });
    } finally {
      sql(`DROP TRIGGER arena_simulate_extension_audit_outage ON "AuditLog"`);
      sql(`DROP FUNCTION arena_simulate_extension_audit_outage()`);
    }
    assert(response.status === 500, `expected 500, got ${response.status}`);
    assert(response.body?.code === "AUDIT_UNAVAILABLE", `unexpected body ${JSON.stringify(response.body)}`);
    assert(
      count(`SELECT count(*) FROM "FolioItem" WHERE "folioId" = '${stay.folioId}'`) === before.items,
      "a folio line survived the rollback"
    );
    assert(
      count(`SELECT coalesce(sum(total), 0) FROM "FolioItem" WHERE "folioId" = '${stay.folioId}'`) === before.total,
      "the folio total changed despite the rollback"
    );
    assert(
      scalar(`SELECT "checkOutDate" FROM "Reservation" WHERE id = '${stay.id}'`) === before.checkOut,
      "the check-out date changed despite the rollback"
    );
    assert(
      count(`SELECT count(*) FROM "ReservationExtension" WHERE "reservationId" = '${stay.id}'`) ===
        before.extensions,
      "an extension row survived the rollback"
    );
    return "500 AUDIT_UNAVAILABLE; folio, dates and history unchanged";
  });

  await checkAsync("extend-conflict", "a conflicting booking blocks the extension", async () => {
    const blocker = await createStay(receptionist, fx, { start: 103, nights: 2 });
    assert(blocker.id, "the blocking reservation was not created");
    const stay = await extensionSetup(100, 2, 0);
    const before = count(`SELECT count(*) FROM "FolioItem" WHERE "folioId" = '${stay.folioId}'`);
    const response = await manager.post(`/api/reservations/${stay.id}/extend`, {
      checkOutDate: checkOutAfter(stay.id, 2),
    });
    assert(response.status === 409, `expected 409, got ${response.status}: ${JSON.stringify(response.body)}`);
    assert(/booked from/i.test(String(response.body?.error)), `message was "${response.body?.error}"`);
    assert(
      count(`SELECT count(*) FROM "FolioItem" WHERE "folioId" = '${stay.folioId}'`) === before,
      "the refused extension still charged the folio"
    );
    assert(
      count(`SELECT count(*) FROM "ReservationExtension" WHERE "reservationId" = '${stay.id}'`) === 0,
      "the refused extension wrote history"
    );
    return `409 blocked by ${blocker.id ? "the overlapping booking" : "conflict"}, no charge`;
  });

  await checkAsync("extend-cross-hotel", "another hotel's manager cannot extend", async () => {
    const stay = await extensionSetup(110, 2, 0);
    const response = await foreignManager.post(`/api/reservations/${stay.id}/extend`, {
      checkOutDate: checkOutAfter(stay.id, 2),
    });
    assert(response.status === 404, `expected 404, got ${response.status}`);
    assert(
      count(`SELECT count(*) FROM "ReservationExtension" WHERE "reservationId" = '${stay.id}'`) === 0,
      "a foreign hotel wrote an extension"
    );
    return "404, nothing written";
  });

  await checkAsync(
    "extend-real-checkin",
    "a genuine check-in followed by an extension keeps the folio consistent",
    async () => {
      sql(`UPDATE "Room" SET status = 'AVAILABLE' WHERE id = '${fx.roomId}'`);
      const stay = await createStay(receptionist, fx, { start: 0, nights: 2 });
      const checkIn = await receptionist.post("/api/check-in", {
        reservationId: stay.id,
        amountPaid: 0,
      });
      assert(checkIn.status === 201, `check-in returned ${checkIn.status}: ${JSON.stringify(checkIn.body)}`);
      assert(Number(checkIn.body.required) === NIGHTLY_RATE * 2, `check-in required ${checkIn.body.required}`);
      const folioId = checkIn.body.folioId;

      const extended = await manager.post(`/api/reservations/${stay.id}/extend`, {
        checkOutDate: checkOutAfter(stay.id, 1),
      });
      assert(extended.status === 200, `extension returned ${extended.status}: ${JSON.stringify(extended.body)}`);
      assert(extended.body.additionalNights === 1, `additionalNights ${extended.body.additionalNights}`);

      const required = count(
        `SELECT coalesce(sum(total), 0) FROM "FolioItem" WHERE "folioId" = '${folioId}'`
      );
      assert(required === NIGHTLY_RATE * 3, `folio now requires ${required}`);
      assert(Number(extended.body.required) === required, `response required ${extended.body.required}`);
      assert(Number(extended.body.balance) === required, `balance ${extended.body.balance}`);
      assert(
        count(`SELECT count(*) FROM "ReservationExtension" WHERE "reservationId" = '${stay.id}'`) === 1,
        "no extension history row was written"
      );
      const checkout = scalar(`SELECT "checkOutDate" FROM "Reservation" WHERE id = '${stay.id}'`);
      assert(new Date(checkout).getTime() === new Date(extended.body.checkOutDate).getTime(), "check-out not moved");
      destroyFixture(stay.id);
      return `check-in required ${NIGHTLY_RATE * 2}, extension added ${NIGHTLY_RATE} -> ${required}`;
    }
  );

  await checkAsync("extend-history-api", "the reservation detail exposes the extension history", async () => {
    assert(state.extension, "the extension check did not run");
    const detail = await manager.get(`/api/reservations/${state.extension.id}`);
    assert(detail.status === 200, `detail returned ${detail.status}`);
    const rows = detail.body?.stayExtensions ?? [];
    assert(rows.length === 1, `detail listed ${rows.length} extension(s)`);
    assert(rows[0].additionalNights === 2, `additionalNights ${rows[0].additionalNights}`);
    assert(Number(rows[0].additionalCharge) === NIGHTLY_RATE * 2, `charge ${rows[0].additionalCharge}`);
    assert(rows[0].approvedBy?.name, "the approver's name is not exposed");
    return `1 extension, ${rows[0].additionalNights} nights, ${rows[0].additionalCharge} ${rows[0].currency}, approved by ${rows[0].approvedBy.name}`;
  });

  await restoreLegacy();
  const removed = cleanup(fx.hotel, fx.roomId);

  const failed = results.filter((result) => result.status !== "PASS");
  const summary = {
    generatedAt: new Date().toISOString(),
    base: BASE,
    database: DATABASE_URL.replace(/\/\/[^@]*@/, "//"),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    fixturesRemoved: removed,
    results,
  };
  console.log(
    `\n${summary.passed}/${summary.total} checks passed${failed.length ? `, ${failed.length} FAILED` : ""}`
  );
  if (JSON_OUT) {
    mkdirSync(OUT, { recursive: true });
    writeFileSync(resolve(ROOT, JSON_OUT), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`Evidence written to ${JSON_OUT}`);
  }
  process.exit(failed.length ? 1 : 0);
}

const state = { extension: null };

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
