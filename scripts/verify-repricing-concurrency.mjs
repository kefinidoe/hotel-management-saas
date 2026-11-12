#!/usr/bin/env node
/**
 * Repricing concurrency and financial-state verification (real PostgreSQL).
 *
 * The fake-database unit tests prove the logic. They cannot prove what happens
 * when two requests reach the same reservation through different connections,
 * so every check here runs against the disposable demo PostgreSQL server plus a
 * real `next start` process, real NextAuth sessions and real transactions.
 *
 *   http-race-two-managers         two managers reprice the same reservation at
 *                                  the same time: no lost version, no duplicate
 *                                  version, one change row and one audit row per
 *                                  successful repricing.
 *   http-race-reschedule-blocked   a repricing that is waiting for the hotel
 *                                  lock prices the dates committed while it
 *                                  waited, not the ones it could read earlier.
 *   http-race-reschedule-concurrent  a reschedule and a reprice fired together
 *                                  never produce a price that disagrees with the
 *                                  booking without the review flag + audit row.
 *   http-race-payment-blocks       a payment committing while a repricing waits
 *                                  makes the repricing refuse instead of
 *                                  changing a price money was taken against.
 *   http-payment-refused           committed financial activity refuses
 *                                  repricing with 409 and writes nothing.
 *   http-audit-outage-rolls-back   a failing audit insert rolls the whole
 *                                  repricing back (no version, no change row).
 *   http-tenant-isolation          another hotel's manager cannot reprice.
 *
 * Usage:
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:55433/hotel_saas_demo_owner \
 *     node scripts/verify-repricing-concurrency.mjs \
 *     --base http://127.0.0.1:3000 --json docs/evidence/pricing/repricing-concurrency.json
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Client } from "pg";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};

const BASE = arg("base", "http://127.0.0.1:3000").replace(/\/+$/, "");
const JSON_OUT = arg("json", null);
const OUT = resolve(ROOT, arg("out", "docs/evidence/pricing"));

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
// Fixtures: a room type, a room, an occupancy and one nightly rate that belong
// to this script only, so the demo catalogue is never edited.
// ---------------------------------------------------------------------------
const HOTEL_NAME = "Riverside Grand Hotel";
const FOREIGN_HOTEL_NAME = "Lakeview Lodge";
const ROOM_TYPE_NAME = "Concurrency Standard";
const ROOM_NUMBER = "905";
const OCCUPANCY_NAME = "Concurrency Double";
const NIGHTLY_RATE = 6000;

function hotelIdByName(name) {
  const id = sql(`SELECT id FROM "Hotel" WHERE name = '${name}' LIMIT 1`);
  assert(id, `hotel ${name} not found`);
  return id;
}

function cleanupReservations(hotel, roomId) {
  const ids = sql(
    `SELECT string_agg(DISTINCT "reservationId", ',') FROM "ReservationRoom"
     WHERE "roomId" = '${roomId}'`
  );
  if (!ids) return 0;
  const list = ids.split(",").map((id) => `'${id}'`).join(",");
  // Children first: the schema restricts cascades from reservations to pricing
  // and folio history, so a deliberate purge has to name them.
  sql(`DELETE FROM "Payment" WHERE "folioId" IN (SELECT id FROM "Folio" WHERE "reservationId" IN (${list}))`);
  sql(`DELETE FROM "FolioItem" WHERE "folioId" IN (SELECT id FROM "Folio" WHERE "reservationId" IN (${list}))`);
  sql(`DELETE FROM "Folio" WHERE "reservationId" IN (${list})`);
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
  cleanupReservations(hotel, roomId);
  return {
    hotel,
    roomTypeId,
    roomId,
    currency: sql(`SELECT currency FROM "Hotel" WHERE id = '${hotel}'`),
    foreignHotel: hotelIdByName(FOREIGN_HOTEL_NAME),
  };
}

// ---------------------------------------------------------------------------
// Cookie-carrying HTTP client with a real NextAuth session.
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
      headers: { "Content-Type": "application/json" },
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
    put: (path, payload) => send(path, "PUT", payload),
    patch: (path, payload) => send(path, "PATCH", payload),
  };
}

async function signIn(role, hotel) {
  const who = account(role, hotel);
  const client = createClient();
  await client.login(who.email, who.password);
  // Demo accounts can belong to more than one hotel; pin the session explicitly
  // so every request is made in the tenant under test.
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

const stay = (start, nights) => ({
  checkInDate: `${isoDay(start)}T12:00:00.000Z`,
  checkOutDate: `${isoDay(start + nights)}T12:00:00.000Z`,
});

// Direct SQL helpers for asserting on committed state.
const snapshotRows = (reservationId) =>
  sql(
    `SELECT version || ':' || "grandTotal" || ':' || nights FROM "ReservationPriceSnapshot"
     WHERE "reservationId" = '${reservationId}' ORDER BY version`
  )
    .split("\n")
    .filter(Boolean);
const changeCount = (reservationId) =>
  Number(sql(`SELECT count(*) FROM "ReservationPriceChange" WHERE "reservationId" = '${reservationId}'`));
const auditCount = (reservationId) =>
  Number(
    sql(
      `SELECT count(*) FROM "AuditLog" WHERE "entityId" = '${reservationId}' AND action = 'RESERVATION_REPRICED'`
    )
  );
const latestSnapshot = (reservationId) =>
  sql(
    `SELECT version || ':' || "grandTotal" || ':' || nights || ':' || "occupancyName"
     FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${reservationId}'
     ORDER BY version DESC LIMIT 1`
  );
const reservationNights = (reservationId) =>
  Number(
    sql(
      `SELECT ("checkOutDate"::date - "checkInDate"::date) FROM "Reservation" WHERE id = '${reservationId}'`
    )
  );

async function createStay(receptionist, fx, nights = 3, start = 60) {
  const window = stay(start, nights);
  let last = null;
  // Creation runs at serializable isolation too; a concurrent fixture write can
  // legitimately lose the race, in which case the API answers 409 and the
  // caller is expected to try again.
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await receptionist.post("/api/reservations", {
      guestName: `Concurrency Guest ${Math.random().toString(36).slice(2, 8)}`,
      checkInDate: window.checkInDate,
      checkOutDate: window.checkOutDate,
      roomId: fx.roomId,
      occupancyTypeId: fx.occupancyId,
      adults: 2,
      children: 0,
    });
    last = response;
    if (response.status === 201 && response.body?.id) {
      return { id: response.body.id, total: response.body.total, nights, window };
    }
    if (response.status !== 409) break;
    await sleep(attempt * 150);
  }
  throw new Error(`reservation creation returned ${last?.status}: ${JSON.stringify(last?.body)}`);
}

// ---------------------------------------------------------------------------

async function main() {
  const fx = ensureFixtures();
  const owner = await signIn("HOTEL_OWNER", HOTEL_NAME);
  const manager = await signIn("MANAGER", HOTEL_NAME);
  const admin = await signIn("HOTEL_ADMIN", HOTEL_NAME);
  const receptionist = await signIn("RECEPTIONIST", HOTEL_NAME);
  const foreignManager = await signIn("MANAGER", FOREIGN_HOTEL_NAME);

  // The script owns the hotel's pricing model while it runs; the demo default is
  // restored at the end so the environment is left exactly as it was found.
  const restoreLegacy = async () => {
    await owner.patch("/api/pricing", {
      pricingModel: "LEGACY_BASE_RATE",
      useOccupancyRates: false,
      useMealPlans: false,
      useSeasonalPricing: false,
      useWeekendPricing: false,
      useChildPricing: false,
      useExtraBeds: false,
      useTaxes: false,
      pricesIncludeTax: false,
    });
  };

  await checkAsync("fixture-pricing-configured", "the hotel sells the fixture room by occupancy rate", async () => {
    const occupancy = sql(
      `SELECT id FROM "OccupancyType" WHERE "hotelId" = '${fx.hotel}' AND name = '${OCCUPANCY_NAME}' LIMIT 1`
    );
    if (occupancy) {
      fx.occupancyId = occupancy;
    } else {
      const created = await owner.post("/api/pricing/occupancy-types", {
        name: OCCUPANCY_NAME,
        minAdults: 2,
        maxAdults: 2,
        maxChildren: 0,
        sortOrder: 9,
      });
      assert(created.status === 201, `occupancy returned ${created.status}: ${JSON.stringify(created.body)}`);
      fx.occupancyId = created.body?.record?.id;
    }
    assert(fx.occupancyId, "occupancy was not created");
    const rates = await owner.post("/api/pricing/room-rates", {
      roomTypeId: fx.roomTypeId,
      rates: [{ occupancyTypeId: fx.occupancyId, nightlyRate: NIGHTLY_RATE }],
    });
    assert(rates.status === 200, `room rates returned ${rates.status}: ${JSON.stringify(rates.body)}`);
    const settings = await owner.patch("/api/pricing", {
      pricingModel: "ROOM_TYPE_OCCUPANCY",
      useOccupancyRates: true,
      useMealPlans: false,
      useSeasonalPricing: false,
      useWeekendPricing: false,
      useChildPricing: false,
      useExtraBeds: false,
      useTaxes: false,
      pricesIncludeTax: false,
    });
    assert(settings.status === 200, `settings returned ${settings.status}`);
    return `${NIGHTLY_RATE} per night, occupancy ${OCCUPANCY_NAME}`;
  });

  // -------------------------------------------------------------------------
  // 1. Two managers reprice the same reservation at the same time.
  // -------------------------------------------------------------------------
  await checkAsync(
    "http-race-two-managers",
    "two managers repricing at once never share a version or lose a change row",
    async () => {
      const created = await createStay(receptionist, fx, 2, 70);
      const [first, second] = await Promise.all([
        manager.post(`/api/reservations/${created.id}/reprice`, { discount: 300, reason: "manager A" }),
        admin.post(`/api/reservations/${created.id}/reprice`, { discount: 600, reason: "manager B" }),
      ]);

      const statuses = [first.status, second.status];
      assert(!statuses.includes(500), `a repricing failed with 500: ${JSON.stringify([first.body, second.body])}`);
      assert(statuses.every((code) => code === 200 || code === 409), `unexpected statuses ${statuses}`);

      const winners = [first, second].filter((response) => response.status === 200);
      assert(winners.length >= 1, "both concurrent repricings were refused");

      const rows = snapshotRows(created.id);
      const versions = rows.map((row) => Number(row.split(":")[0]));
      assert(
        versions.every((version, index) => version === index + 1),
        `versions are not 1..n: ${versions.join(",")}`
      );
      assert(
        versions.length === 1 + winners.length,
        `expected ${1 + winners.length} versions, found ${versions.length}`
      );
      assert(changeCount(created.id) === winners.length, `change rows ${changeCount(created.id)} != ${winners.length}`);
      assert(auditCount(created.id) === winners.length, `audit rows ${auditCount(created.id)} != ${winners.length}`);

      // The newest version is the one the winner reported, and it is contiguous
      // with the previous one: no manager's repricing overwrote the other's.
      const latest = latestSnapshot(created.id).split(":");
      const reported = winners.map((response) => Number(response.body.version)).sort((a, b) => a - b);
      assert(
        reported[reported.length - 1] === Number(latest[0]),
        `reported version ${reported.join(",")} does not match latest ${latest[0]}`
      );
      const changes = sql(
        `SELECT "previousVersion" || '>' || "newVersion" FROM "ReservationPriceChange"
         WHERE "reservationId" = '${created.id}' ORDER BY "newVersion"`
      )
        .split("\n")
        .filter(Boolean);
      assert(changes.length === winners.length, `unexpected change rows: ${changes.join(" ")}`);
      return `${statuses.join("+")}; versions ${versions.join(",")}; ${winners.length} recorded change(s)`;
    }
  );

  // -------------------------------------------------------------------------
  // 2. A repricing that waits for the hotel lock prices the committed state.
  // -------------------------------------------------------------------------
  await checkAsync(
    "http-race-reschedule-blocked",
    "a repricing waiting on the lock prices the dates committed while it waited",
    async () => {
      const created = await createStay(receptionist, fx, 3, 80);
      assert(latestSnapshot(created.id).split(":")[2] === "3", "fixture is not a three-night stay");

      const holder = new Client({ connectionString: DATABASE_URL });
      await holder.connect();
      let settled = false;
      let response = null;
      try {
        await holder.query("BEGIN");
        await holder.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `hotel-${fx.hotel}-reservation-create`,
        ]);

        const pending = manager
          .post(`/api/reservations/${created.id}/reprice`, { reason: "waiting behind the lock" })
          .then((result) => {
            settled = true;
            response = result;
            return result;
          });

        await sleep(400);
        assert(!settled, "the repricing did not wait for the hotel lock");

        // A reschedule commits while the repricing is queued.
        await holder.query(
          `UPDATE "Reservation"
           SET "checkInDate" = $1::timestamptz,
               "checkOutDate" = ($1::timestamptz + interval '5 days')
           WHERE id = $2`,
          [created.window.checkInDate, created.id]
        );
        await holder.query("COMMIT");
        await pending;
      } finally {
        await holder.end().catch(() => {});
      }

      assert(response && response.status === 200, `repricing returned ${response?.status}`);
      const latest = latestSnapshot(created.id).split(":");
      const nights = reservationNights(created.id);
      assert(nights === 5, `the reschedule did not commit: ${nights} nights`);
      assert(Number(latest[2]) === 5, `the snapshot priced ${latest[2]} nights, the stay is ${nights}`);
      assert(
        Number(latest[1]) === NIGHTLY_RATE * 5,
        `priced ${latest[1]} for 5 nights at ${NIGHTLY_RATE} per night`
      );
      assert(Number(response.body.total) === Number(latest[1]), "response total does not match the stored version");
      return `waited for the lock, then priced ${latest[2]} nights at ${latest[1]}`;
    }
  );

  // -------------------------------------------------------------------------
  // 3. A reschedule and a repricing fired together stay consistent.
  // -------------------------------------------------------------------------
  await checkAsync(
    "http-race-reschedule-concurrent",
    "a reschedule racing a repricing never disagrees silently",
    async () => {
      const created = await createStay(receptionist, fx, 2, 90);
      const window = stay(90, 4);
      const [rescheduled, repriced] = await Promise.all([
        manager.put(`/api/reservations/${created.id}`, {
          checkInDate: window.checkInDate,
          checkOutDate: window.checkOutDate,
        }),
        admin.post(`/api/reservations/${created.id}/reprice`, { reason: "racing the reschedule" }),
      ]);

      assert(![rescheduled.status, repriced.status].includes(500), "a 500 was returned during the race");
      assert(rescheduled.status === 200, `reschedule returned ${rescheduled.status}`);
      assert(
        [200, 409].includes(repriced.status),
        `repricing returned ${repriced.status}: ${JSON.stringify(repriced.body)}`
      );

      const nights = reservationNights(created.id);
      assert(nights === 4, `the reschedule did not commit: ${nights} nights`);
      const latest = latestSnapshot(created.id).split(":");

      if (repriced.status === 200) {
        // Whichever order the two transactions got, the price and the booking
        // agree; if the reschedule landed afterwards the endpoint says so.
        const consistent = Number(latest[2]) === nights;
        const flagged =
          rescheduled.body?.pricingNeedsReview === true &&
          Number(
            sql(
              `SELECT count(*) FROM "AuditLog" WHERE "entityId" = '${created.id}'
               AND action = 'RESERVATION_RATE_REVIEW_REQUIRED'`
            )
          ) > 0;
        assert(
          consistent || flagged,
          `price covers ${latest[2]} nights while the stay is ${nights} nights, and no review was flagged`
        );
        return consistent
          ? `priced ${nights} nights, booking unchanged afterwards`
          : "rescheduled after the repricing: flagged for review and audited";
      }

      assert(changeCount(created.id) === 0, "a refused repricing still wrote a change row");
      return `repricing refused (${repriced.status}), no change recorded`;
    }
  );

  // -------------------------------------------------------------------------
  // 4. A payment committing while a repricing waits makes it refuse.
  // -------------------------------------------------------------------------
  await checkAsync(
    "http-race-payment-blocks",
    "money recorded while a repricing waits stops the repricing",
    async () => {
      const created = await createStay(receptionist, fx, 2, 100);
      const guestId = sql(`SELECT "guestId" FROM "Reservation" WHERE id = '${created.id}'`);
      const methodId = sql(
        `SELECT id FROM "PaymentMethod" WHERE "hotelId" = '${fx.hotel}' ORDER BY name LIMIT 1`
      );
      const cashierId = sql(
        `SELECT id FROM "User" WHERE email = '${account("CASHIER", HOTEL_NAME).email}'`
      );
      assert(methodId && cashierId, "no payment method or cashier for the fixture");
      const folioId = randomUUID();
      sql(
        `INSERT INTO "Folio" (id, "hotelId", "guestId", "reservationId", "isClosed", "createdAt", "updatedAt")
         VALUES ('${folioId}', '${fx.hotel}', '${guestId}', '${created.id}', false, now(), now())`
      );

      const payer = new Client({ connectionString: DATABASE_URL });
      await payer.connect();
      let settled = false;
      let response = null;
      try {
        await payer.query("BEGIN");
        await payer.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
          `hotel-${fx.hotel}-reservation-create`,
        ]);

        const pending = manager
          .post(`/api/reservations/${created.id}/reprice`, { reason: "racing a deposit" })
          .then((result) => {
            settled = true;
            response = result;
            return result;
          });

        await sleep(400);
        assert(!settled, "the repricing did not wait for the hotel lock");

        // Exactly what POST /api/payments does, under the same lock.
        await payer.query(
          `INSERT INTO "Payment" (id, "hotelId", "folioId", "paymentMethodId", amount, status, "cashierId", "createdAt")
           VALUES (gen_random_uuid()::text, $1, $2, $3, 3000, 'COMPLETED', $4, now())`,
          [fx.hotel, folioId, methodId, cashierId]
        );
        await payer.query("COMMIT");
        await pending;
      } finally {
        await payer.end().catch(() => {});
      }

      assert(response && response.status === 409, `repricing returned ${response?.status}, expected 409`);
      assert(
        response.body?.code === "RESERVATION_HAS_FINANCIAL_ACTIVITY",
        `unexpected code ${response.body?.code}`
      );
      const versions = snapshotRows(created.id);
      assert(versions.length === 1, `a refused repricing appended a version: ${versions.join(",")}`);
      assert(changeCount(created.id) === 0, "a refused repricing wrote a change row");
      assert(auditCount(created.id) === 0, "a refused repricing wrote an audit row");
      return `payment committed first, repricing refused (${response.body.code})`;
    }
  );

  // -------------------------------------------------------------------------
  // 5. Committed financial activity refuses repricing outright.
  // -------------------------------------------------------------------------
  await checkAsync(
    "http-payment-refused",
    "a reservation that already has a completed payment cannot be repriced",
    async () => {
      const created = await createStay(receptionist, fx, 2, 110);
      const guestId = sql(`SELECT "guestId" FROM "Reservation" WHERE id = '${created.id}'`);
      const methodId = sql(
        `SELECT id FROM "PaymentMethod" WHERE "hotelId" = '${fx.hotel}' ORDER BY name LIMIT 1`
      );
      const cashierId = sql(`SELECT id FROM "User" WHERE email = '${account("CASHIER", HOTEL_NAME).email}'`);
      const folioId = randomUUID();
      sql(
        `INSERT INTO "Folio" (id, "hotelId", "guestId", "reservationId", "isClosed", "createdAt", "updatedAt")
         VALUES ('${folioId}', '${fx.hotel}', '${guestId}', '${created.id}', false, now(), now())`
      );
      sql(
        `INSERT INTO "Payment" (id, "hotelId", "folioId", "paymentMethodId", amount, status, "cashierId", "createdAt")
         VALUES (gen_random_uuid()::text, '${fx.hotel}', '${folioId}', '${methodId}', 2000, 'COMPLETED', '${cashierId}', now())`
      );

      const refused = await manager.post(`/api/reservations/${created.id}/reprice`, { reason: "too late" });
      assert(refused.status === 409, `expected 409, got ${refused.status}`);
      assert(
        refused.body?.code === "RESERVATION_HAS_FINANCIAL_ACTIVITY",
        `unexpected body ${JSON.stringify(refused.body)}`
      );
      assert(snapshotRows(created.id).length === 1, "a version was appended anyway");
      assert(changeCount(created.id) === 0, "a change row was written anyway");
      assert(auditCount(created.id) === 0, "an audit row was written anyway");
      return `${refused.status} ${refused.body.code}`;
    }
  );

  // -------------------------------------------------------------------------
  // 6. A failing audit insert rolls the entire repricing back.
  // -------------------------------------------------------------------------
  await checkAsync(
    "http-audit-outage-rolls-back",
    "a failing audit insert leaves no version, change row or price edit",
    async () => {
      const created = await createStay(receptionist, fx, 2, 120);
      const before = {
        snapshots: snapshotRows(created.id).join("|"),
        changes: changeCount(created.id),
        rate: sql(
          `SELECT rate FROM "ReservationRoom" WHERE "reservationId" = '${created.id}' LIMIT 1`
        ),
        discount: sql(`SELECT coalesce(discount::text, 'null') FROM "Reservation" WHERE id = '${created.id}'`),
        audits: auditCount(created.id),
      };

      sql(
        `CREATE OR REPLACE FUNCTION arena_simulate_audit_outage() RETURNS trigger AS $$
         BEGIN
           IF NEW."entityId" = '${created.id}' AND NEW.action = 'RESERVATION_REPRICED' THEN
             RAISE EXCEPTION 'simulated audit outage';
           END IF;
           RETURN NEW;
         END;
         $$ LANGUAGE plpgsql`
      );
      sql(
        `CREATE TRIGGER arena_simulate_audit_outage BEFORE INSERT ON "AuditLog"
         FOR EACH ROW EXECUTE FUNCTION arena_simulate_audit_outage()`
      );

      let response = null;
      try {
        response = await manager.post(`/api/reservations/${created.id}/reprice`, {
          discount: 250,
          reason: "audit outage",
        });
      } finally {
        sql(`DROP TRIGGER arena_simulate_audit_outage ON "AuditLog"`);
        sql(`DROP FUNCTION arena_simulate_audit_outage()`);
      }

      assert(response.status === 500, `expected 500, got ${response.status}`);
      assert(response.body?.code === "AUDIT_UNAVAILABLE", `unexpected body ${JSON.stringify(response.body)}`);
      assert(
        snapshotRows(created.id).join("|") === before.snapshots,
        "a price version survived the failed repricing"
      );
      assert(changeCount(created.id) === before.changes, "a change row survived the failed repricing");
      assert(
        sql(`SELECT rate FROM "ReservationRoom" WHERE "reservationId" = '${created.id}' LIMIT 1`) === before.rate,
        "the room rate was changed despite the rollback"
      );
      assert(
        sql(`SELECT coalesce(discount::text, 'null') FROM "Reservation" WHERE id = '${created.id}'`) ===
          before.discount,
        "the reservation discount was changed despite the rollback"
      );
      assert(auditCount(created.id) === before.audits, "an audit row was written");
      return "500 AUDIT_UNAVAILABLE, nothing persisted";
    }
  );

  // -------------------------------------------------------------------------
  // 7. Tenant isolation survives the new locking.
  // -------------------------------------------------------------------------
  await checkAsync(
    "http-tenant-isolation",
    "another hotel's manager cannot reprice this hotel's reservation",
    async () => {
      const created = await createStay(receptionist, fx, 2, 130);
      const refused = await foreignManager.post(`/api/reservations/${created.id}/reprice`, {
        reason: "cross tenant",
      });
      assert(refused.status === 404, `expected 404, got ${refused.status}`);
      assert(snapshotRows(created.id).length === 1, "a foreign hotel appended a version");
      assert(changeCount(created.id) === 0, "a foreign hotel wrote a change row");
      return "404, nothing written";
    }
  );

  // Leave the demo hotel exactly as it was found.
  await restoreLegacy();
  const removed = cleanupReservations(fx.hotel, fx.roomId);

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

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
