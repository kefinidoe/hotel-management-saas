#!/usr/bin/env node
/**
 * Pricing engine acceptance check.
 *
 * Proves the flexible pricing engine the way a hotel experiences it: the owner
 * configures occupancy rates and a meal plan, the receptionist is quoted a
 * server-priced breakdown, the reservation freezes that price, and later
 * configuration edits never rewrite it.
 *
 *   Phase A (HTTP, real NextAuth sessions, real database)
 *     1. the owner reads the pricing configuration
 *     2. a receptionist may not write configuration (403)
 *     3. occupancies are created with the hotel's own names
 *     4. per-occupancy nightly rates are saved for a room type
 *     5. a meal plan is created with an explicit pricing basis
 *     6. the pricing model is switched to occupancy rates
 *     7. the quote endpoint prices room + occupancy + meal plan (per person/night)
 *     8. an omitted occupancy is defaulted server-side (form bootstrap)
 *     9. an occupancy this room type is not sold as is refused
 *    10. another hotel's occupancy is refused
 *    11. the reservation stores the quoted total and freezes a snapshot
 *    12. raising the rate afterwards leaves the sold reservation unchanged
 *    13. client-supplied totals are ignored
 *    14. a receptionist may not discount; a manager may
 *    15. another hotel's receptionist cannot quote this hotel's room
 *    16. a meal plan cannot reference another hotel's room type
 *
 *   Phase B (real Chromium)
 *    17. the Pricing & Rates page renders the hotel's currency and tabs
 *    18. editing a rate in the UI persists across a reload
 *    19. the reservation form shows a server-computed breakdown
 *    20. changing the occupancy re-prices the stay
 *    21. changing the meal plan re-prices the stay
 *    22. changing the dates re-prices the stay
 *    23. submitting stores the snapshot and it survives a reload
 *    24. editing configuration afterwards leaves the sold reservation's price
 *
 * Usage:
 *   DATABASE_URL=postgresql://... node scripts/verify-pricing-acceptance.mjs \
 *     --base http://127.0.0.1:3000 --json docs/evidence/pricing/pricing-acceptance.json
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const match = creds.accounts.find((a) => a.role === role && a.hotel === hotel);
  if (!match) throw new Error(`No ${role} account for ${hotel} in credentials.json`);
  return match;
};

const color = (code, text) => `\u001b[${code}m${text}\u001b[0m`;
const results = [];

function check(id, description, fn) {
  try {
    const detail = fn();
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

// ---------------------------------------------------------------------------
// Fixtures. Room 903 / 904 exist only for this check, with their own room types
// so the demo data's own prices are never edited.
// ---------------------------------------------------------------------------
const HOTEL = "Riverside Grand Hotel";
const FOREIGN = "Lakeview Lodge";
const STANDARD = { number: "903", type: "Pricing Standard", single: 4500, double: 5500, family: 9000 };
const TWIN = { number: "904", type: "Pricing Twin", single: 3900 };
const MEAL = { name: "Pricing Breakfast", charge: 700 };

function hotelId(name) {
  const id = sql(`SELECT id FROM "Hotel" WHERE name = '${name}' LIMIT 1`);
  assert(id, `Hotel ${name} not found in the demo database`);
  return id;
}

function clearPreviousRuns(hotel) {
  const ids = sql(
    `SELECT string_agg(DISTINCT rr."reservationId", ',') FROM "ReservationRoom" rr
     JOIN "Room" r ON r.id = rr."roomId"
     WHERE r."hotelId" = '${hotel}' AND r.number IN ('${STANDARD.number}', '${TWIN.number}')`
  );
  if (!ids) return 0;
  const list = ids.split(",").map((id) => `'${id}'`).join(",");
  sql(`DELETE FROM "ReservationRoom" WHERE "reservationId" IN (${list})`);
  sql(`DELETE FROM "ReservationPriceSnapshot" WHERE "reservationId" IN (${list})`);
  sql(`DELETE FROM "Reservation" WHERE id IN (${list})`);
  return list.split(",").length;
}

function ensureFixtures() {
  const hotel = hotelId(HOTEL);
  clearPreviousRuns(hotel);
  const rooms = {};
  for (const spec of [STANDARD, TWIN]) {
    sql(
      `INSERT INTO "RoomType" (id, "hotelId", name, "baseRate", "mealPlan", "createdAt", "updatedAt")
       SELECT gen_random_uuid()::text, '${hotel}', '${spec.type}', ${spec.single}, NULL, now(), now()
       WHERE NOT EXISTS (SELECT 1 FROM "RoomType" WHERE "hotelId" = '${hotel}' AND name = '${spec.type}')`
    );
    const typeId = sql(
      `SELECT id FROM "RoomType" WHERE "hotelId" = '${hotel}' AND name = '${spec.type}' LIMIT 1`
    );
    sql(
      `INSERT INTO "Room" (id, "hotelId", "roomTypeId", number, floor, status, "isActive", "createdAt", "updatedAt")
       SELECT gen_random_uuid()::text, '${hotel}', '${typeId}', '${spec.number}', 9, 'AVAILABLE', true, now(), now()
       WHERE NOT EXISTS (SELECT 1 FROM "Room" WHERE "hotelId" = '${hotel}' AND number = '${spec.number}')`
    );
    sql(
      `UPDATE "Room" SET "roomTypeId" = '${typeId}', status = 'AVAILABLE'
       WHERE "hotelId" = '${hotel}' AND number = '${spec.number}'`
    );
    rooms[spec.number] = {
      roomId: sql(`SELECT id FROM "Room" WHERE "hotelId" = '${hotel}' AND number = '${spec.number}'`),
      roomTypeId: typeId,
    };
  }
  return {
    hotel,
    currency: sql(`SELECT currency FROM "Hotel" WHERE id = '${hotel}'`),
    standard: rooms[STANDARD.number],
    twin: rooms[TWIN.number],
    foreignHotel: hotelId(FOREIGN),
    foreignRoomId: sql(
      `SELECT r.id FROM "Room" r WHERE r."hotelId" = '${hotelId(FOREIGN)}' ORDER BY r.number LIMIT 1`
    ),
    foreignRoomTypeId: sql(
      `SELECT id FROM "RoomType" WHERE "hotelId" = '${hotelId(FOREIGN)}' ORDER BY name LIMIT 1`
    ),
  };
}

// ---------------------------------------------------------------------------
// Cookie-carrying HTTP client with a real NextAuth session.
// ---------------------------------------------------------------------------
function createClient() {
  const jar = new Map();
  const cookieHeader = () =>
    [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");

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
    assert(response.status < 400, `Login for ${email} failed with ${response.status}`);
    const session = await (await request("/api/auth/session")).json();
    assert(session?.user?.email === email, `No session after login for ${email}`);
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
    patch: (path, payload) => send(path, "PATCH", payload),
  };
}

async function signIn(role, hotel, { selectHotel = false } = {}) {
  const who = account(role, hotel);
  const client = createClient();
  await client.login(who.email, who.password);
  if (selectHotel) {
    const target = hotelId(hotel);
    const selection = await client.post("/api/auth/switch-hotel", { hotelId: target });
    assert(selection.status === 200, `switch-hotel returned ${selection.status}`);
  }
  return client;
}

function isoDay(offsetDays = 0) {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

const stay = {
  checkInDate: `${isoDay(40)}T12:00:00.000Z`,
  checkOutDate: `${isoDay(43)}T12:00:00.000Z`,
};

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------
function unpackSharedLibraries() {
  const bundle = resolve(ROOT, "node_modules", "@sparticuz", "chromium", "bin", "al2023.tar.br");
  if (!existsSync(bundle)) return [];
  const target = join(tmpdir(), "chromium-shared-libs");
  const marker = join(target, ".unpacked");
  if (!existsSync(marker)) {
    mkdirSync(target, { recursive: true });
    const script = `
      const fs = require("node:fs");
      const zlib = require("node:zlib");
      const { execFileSync } = require("node:child_process");
      const tarPath = ${JSON.stringify(join(target, "libs.tar"))};
      fs.writeFileSync(tarPath, zlib.brotliDecompressSync(fs.readFileSync(${JSON.stringify(bundle)})));
      execFileSync("tar", ["-xf", tarPath, "-C", ${JSON.stringify(target)}]);
      fs.writeFileSync(${JSON.stringify(marker)}, "ok");
    `;
    execFileSync(process.execPath, ["-e", script], { stdio: "inherit" });
  }
  return [join(target, "lib"), join(target, "usr", "lib64")].filter(existsSync);
}

async function launchBrowser() {
  const puppeteer = (await import("puppeteer-core")).default;
  const chromium = (await import("@sparticuz/chromium")).default;
  const executablePath = process.env.CHROME_PATH || (await chromium.executablePath());
  if (!process.env.CHROME_PATH) {
    const libraryDirs = unpackSharedLibraries();
    if (libraryDirs.length) {
      const existing = process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : "";
      process.env.LD_LIBRARY_PATH = libraryDirs.join(":") + existing;
    }
  }
  return puppeteer.launch({
    executablePath,
    args: [...(process.env.CHROME_PATH ? [] : chromium.args), "--no-sandbox"],
    headless: true,
  });
}

async function ensureWorkspace(page, hotel) {
  if (!page.url().includes("/select-hotel")) return;
  await page.waitForSelector("div.cursor-pointer", { timeout: 30_000 });
  const picked = await page.evaluate((name) => {
    const card = [...document.querySelectorAll("div.cursor-pointer")].find((element) =>
      (element.querySelector("h3")?.textContent || "").includes(name)
    );
    card?.click();
    return Boolean(card);
  }, hotel.split(" ")[0]);
  assert(picked, `hotel ${hotel} is not offered on the selection screen`);
  await page.waitForFunction(() => location.pathname.startsWith("/dashboard"), {
    timeout: 30_000,
  });
  // The workspace switch is a POST followed by a client-side push; let it land
  // before navigating somewhere else, or the next request still sees no choice.
  await new Promise((resolve) => setTimeout(resolve, 500));
}

/** Navigate, re-selecting the workspace if the app sends us back to the picker. */
async function gotoDashboard(page, path, hotel) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.goto(`${BASE}${path}`, { waitUntil: "networkidle0" });
    if (!page.url().includes("/select-hotel")) return;
    await ensureWorkspace(page, hotel);
  }
  throw new Error(`could not reach ${path}: still on ${page.url()}`);
}

async function signInThroughUi(page, role, hotel) {
  const who = account(role, hotel);
  await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
  await page.type('input[type="email"]', who.email);
  await page.type('input[type="password"]', who.password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {}),
    page.click("form button[type=submit]"),
  ]);
  await page.waitForFunction(
    () => location.pathname === "/select-hotel" || location.pathname.startsWith("/dashboard"),
    { timeout: 30_000 }
  );
  await ensureWorkspace(page, hotel);
}

const money = (value) => Number(value).toLocaleString("en-US");

// ---------------------------------------------------------------------------
async function main() {
  const health = await fetch(`${BASE}/login`).catch(() => null);
  assert(health && health.ok, `App is not reachable at ${BASE}`);
  execFileSync(PSQL, ["--version"], { encoding: "utf8" });

  const fx = ensureFixtures();
  console.log(`Hotel ${HOTEL}: currency ${fx.currency}`);
  console.log(`Rooms: ${STANDARD.number} (${STANDARD.type}), ${TWIN.number} (${TWIN.type})`);

  const owner = await signIn("HOTEL_OWNER", HOTEL, { selectHotel: true });
  const receptionist = await signIn("RECEPTIONIST", HOTEL);
  const manager = await signIn("MANAGER", HOTEL);
  const foreignReceptionist = await signIn("RECEPTIONIST", FOREIGN);

  // ---- Phase A ------------------------------------------------------------
  let bundleBody = null;
  let originalSettings = null;
  await checkAsync("api-config-read", "the owner reads the pricing configuration", async () => {
    const { status, body } = await owner.get("/api/pricing");
    assert(status === 200, `status ${status}`);
    bundleBody = body;
    originalSettings = body.settings;
    assert(body.hotelName === HOTEL, `bundle describes ${body.hotelName}`);
    assert(body.currency === fx.currency, `bundle currency ${body.currency}`);
    return `${body.roomTypes.length} room types, ${body.occupancies.length} occupancies`;
  });

  await checkAsync("api-config-write-forbidden", "a receptionist cannot write pricing configuration", async () => {
    const { status } = await receptionist.post("/api/pricing/occupancy-types", {
      name: "Sneaky",
      minAdults: 1,
      maxAdults: 2,
    });
    assert(status === 403, `expected 403, got ${status}`);
    const rows = sql(
      `SELECT count(*) FROM "OccupancyType" WHERE "hotelId" = '${fx.hotel}' AND name = 'Sneaky'`
    );
    assert(rows === "0", "the refused write still created a row");
    return "403 and nothing written";
  });

  const existing = bundleBody ?? { occupancies: [], mealPlans: [] };
  const occupancyId = async (name, spec) => {
    const found = existing.occupancies.find((row) => row.name === name);
    if (found) return found.id;
    const created = await owner.post("/api/pricing/occupancy-types", spec);
    assert(created.status === 201, `creating ${name} returned ${created.status}: ${JSON.stringify(created.body)}`);
    return created.body.record.id;
  };

  const ids = { single: "", double: "", family: "" };
  await checkAsync("api-occupancy-created", "occupancy options carry the hotel's own names", async () => {
    ids.single = await occupancyId("Pricing Single", {
      name: "Pricing Single",
      minAdults: 1,
      maxAdults: 1,
      maxChildren: 0,
      sortOrder: 1,
    });
    ids.double = await occupancyId("Pricing Double", {
      name: "Pricing Double",
      minAdults: 2,
      maxAdults: 2,
      maxChildren: 1,
      sortOrder: 2,
    });
    // A hotel-defined option that is nobody's built-in default, to prove the
    // occupancy list is data rather than a fixed enum.
    ids.family = await occupancyId("Pricing Family", {
      name: "Pricing Family",
      minAdults: 1,
      maxAdults: 4,
      maxChildren: 2,
      sortOrder: 3,
    });
    assert(ids.single && ids.double && ids.family, "occupancies were not created");
    const stored = sql(
      `SELECT string_agg(name, ', ' ORDER BY name) FROM "OccupancyType"
       WHERE "hotelId" = '${fx.hotel}' AND name LIKE 'Pricing %'`
    );
    assert(stored.includes("Pricing Single") && stored.includes("Pricing Double"), `stored: ${stored}`);
    return stored;
  });
  const singleId = ids.single;
  const doubleId = ids.double;
  const familyId = ids.family;

  await checkAsync("api-rates-saved", "per-occupancy nightly rates are stored per room type", async () => {
    const { status, body } = await owner.post("/api/pricing/room-rates", {
      roomTypeId: fx.standard.roomTypeId,
      rates: [
        { occupancyTypeId: singleId, nightlyRate: STANDARD.single },
        { occupancyTypeId: doubleId, nightlyRate: STANDARD.double },
        { occupancyTypeId: familyId, nightlyRate: STANDARD.family },
      ],
    });
    assert(status === 200 || status === 201, `status ${status}: ${JSON.stringify(body)}`);
    const stored = sql(
      `SELECT string_agg("nightlyRate"::text, ',' ORDER BY "nightlyRate")
       FROM "RoomTypeOccupancy" WHERE "roomTypeId" = '${fx.standard.roomTypeId}' AND "isActive"`
    )
      .split(",")
      .map((value) => Number(value));
    assert(
      stored.includes(STANDARD.single) && stored.includes(STANDARD.double),
      `stored rates ${stored.join(",")}`
    );
    return `${STANDARD.single}/${STANDARD.double}`;
  });

  await checkAsync("api-twin-only-single", "a room type sold only as a single has exactly one rate", async () => {
    const { status } = await owner.post("/api/pricing/room-rates", {
      roomTypeId: fx.twin.roomTypeId,
      rates: [{ occupancyTypeId: singleId, nightlyRate: TWIN.single }],
    });
    assert(status === 200 || status === 201, `status ${status}`);
    const rows = sql(
      `SELECT count(*) FROM "RoomTypeOccupancy" WHERE "roomTypeId" = '${fx.twin.roomTypeId}' AND "isActive"`
    );
    assert(Number(rows) >= 1, "no rate stored for the twin");
    return `${rows} active rate(s)`;
  });

  const mealPlanId = await checkAsync("api-meal-plan-created", "a meal plan is created with an explicit pricing basis", async () => {
    const existingPlan = sql(
      `SELECT id FROM "MealPlanConfig" WHERE "hotelId" = '${fx.hotel}' AND name = '${MEAL.name}' LIMIT 1`
    );
    if (existingPlan) {
      await manager.patch("/api/pricing/meal-plans", {
        id: existingPlan,
        charge: MEAL.charge,
        isActive: true,
      });
      return existingPlan;
    }
    const { status, body } = await manager.post("/api/pricing/meal-plans", {
      name: MEAL.name,
      description: "Demo breakfast plan",
      includedItems: ["Breakfast"],
      pricingBasis: "PER_PERSON_PER_NIGHT",
      charge: MEAL.charge,
      isActive: true,
      roomTypeIds: [],
    });
    assert(status === 201, `status ${status}: ${JSON.stringify(body)}`);
    return body.record.id;
  });

  await checkAsync("api-settings-updated", "the hotel switches to occupancy-based pricing", async () => {
    const { status, body } = await owner.patch("/api/pricing", {
      pricingModel: "ROOM_TYPE_OCCUPANCY",
      useOccupancyRates: true,
      useMealPlans: true,
      useSeasonalPricing: false,
      useWeekendPricing: false,
      useChildPricing: false,
      useExtraBeds: false,
      useTaxes: false,
      pricesIncludeTax: false,
    });
    assert(status === 200, `status ${status}: ${JSON.stringify(body)}`);
    assert(body.settings.pricingModel === "ROOM_TYPE_OCCUPANCY", "model did not change");
    return body.settings.pricingModel;
  });

  const expected = STANDARD.double * 3 + MEAL.charge * 2 * 3;
  const quote = await checkAsync("api-quote-configured", "the quote endpoint prices occupancy + meal plan per person/night", async () => {
    const { status, body } = await receptionist.post("/api/reservations/quote", {
      roomId: fx.standard.roomId,
      occupancyTypeId: doubleId,
      mealPlanId,
      adults: 2,
      children: 0,
      ...stay,
    });
    assert(status === 200, `status ${status}: ${JSON.stringify(body)}`);
    assert(body.totals.grandTotal === expected, `total ${body.totals.grandTotal} != ${expected}`);
    assert(body.currency === fx.currency, `currency ${body.currency}`);
    assert(body.mealPlanBasis === "PER_PERSON_PER_NIGHT", `basis ${body.mealPlanBasis}`);
    assert(body.occupancyName === "Pricing Double", `occupancy ${body.occupancyName}`);
    return `${money(body.totals.grandTotal)} ${body.currency} (${body.lines.length} lines)`;
  });

  await checkAsync("api-quote-defaults-occupancy", "an omitted occupancy is defaulted server-side so the form can open", async () => {
    const { status, body } = await receptionist.post("/api/reservations/quote", {
      roomId: fx.standard.roomId,
      adults: 2,
      ...stay,
    });
    assert(status === 200, `status ${status}: ${JSON.stringify(body)}`);
    assert(body.occupancyTypeId, "no occupancy was chosen for the form");
    assert(
      body.availableOccupancies.some((option) => option.id === body.occupancyTypeId),
      "defaulted occupancy is not in the offered list"
    );
    assert(body.totals.grandTotal > 0, "defaulted quote priced at zero");
    return `${body.occupancyName} @ ${money(body.effectiveNightlyRate)}`;
  });

  await checkAsync("api-unsupported-occupancy-refused", "an occupancy this room type is not sold as is refused", async () => {
    const { status, body } = await receptionist.post("/api/reservations/quote", {
      roomId: fx.twin.roomId,
      occupancyTypeId: doubleId,
      adults: 2,
      ...stay,
    });
    assert(status === 400, `expected 400, got ${status}: ${JSON.stringify(body)}`);
    return `${status} ${body.error}`;
  });

  const foreignOccupancyId = (() => {
    const id = sql(
      `SELECT id FROM "OccupancyType" WHERE "hotelId" = '${fx.foreignHotel}' LIMIT 1`
    );
    if (id) return id;
    sql(
      `INSERT INTO "OccupancyType" (id, "hotelId", name, "minAdults", "maxAdults", "maxChildren", "sortOrder", "isActive", "createdAt", "updatedAt")
       VALUES (gen_random_uuid()::text, '${fx.foreignHotel}', 'Foreign Occupancy', 1, 2, 0, 1, true, now(), now())`
    );
    return sql(`SELECT id FROM "OccupancyType" WHERE "hotelId" = '${fx.foreignHotel}' LIMIT 1`);
  })();

  await checkAsync("api-foreign-occupancy-refused", "another hotel's occupancy option is refused", async () => {
    const { status } = await receptionist.post("/api/reservations/quote", {
      roomId: fx.standard.roomId,
      occupancyTypeId: foreignOccupancyId,
      adults: 1,
      ...stay,
    });
    assert(status === 400, `expected 400, got ${status}`);
    return status;
  });

  const created = await checkAsync("api-reservation-priced", "the reservation stores the quoted total", async () => {
    const { status, body } = await receptionist.post("/api/reservations", {
      guestName: `Pricing Guest ${Date.now()}`,
      checkInDate: stay.checkInDate,
      checkOutDate: stay.checkOutDate,
      roomId: fx.standard.roomId,
      occupancyTypeId: doubleId,
      mealPlanId,
      adults: 2,
      children: 0,
    });
    assert(status === 201, `status ${status}: ${JSON.stringify(body)}`);
    assert(body.total === expected, `stored total ${body.total} != ${expected}`);
    assert(body.currency === fx.currency, `currency ${body.currency}`);
    return { id: body.id, code: body.code, total: body.total };
  });

  await checkAsync("api-snapshot-frozen", "a price snapshot is written with the reservation", async () => {
    assert(created?.id, "reservation was not created");
    const row = sql(
      `SELECT "grandTotal" || '|' || currency || '|' || "occupancyName" || '|' || "mealPlanName" || '|' || nights
       FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${created.id}'`
    );
    assert(row, "no snapshot row");
    const [total, currency, occupancyName, mealPlanName, nights] = row.split("|");
    assert(Number(total) === expected, `snapshot total ${total} != ${expected}`);
    assert(currency === fx.currency, `snapshot currency ${currency}`);
    assert(occupancyName === "Pricing Double", `snapshot occupancy ${occupancyName}`);
    assert(mealPlanName === MEAL.name, `snapshot meal plan ${mealPlanName}`);
    assert(nights === "3", `snapshot nights ${nights}`);
    return `${money(total)} ${currency}, ${nights} nights`;
  });

  const raised = STANDARD.double + 900;
  await checkAsync("api-config-change-keeps-sold-price", "raising the rate does not re-price a sold reservation", async () => {
    const { status } = await owner.post("/api/pricing/room-rates", {
      roomTypeId: fx.standard.roomTypeId,
      rates: [
        { occupancyTypeId: singleId, nightlyRate: STANDARD.single },
        { occupancyTypeId: doubleId, nightlyRate: raised },
        { occupancyTypeId: familyId, nightlyRate: STANDARD.family },
      ],
    });
    assert(status === 200 || status === 201, `status ${status}`);

    const snapshot = sql(
      `SELECT "grandTotal" FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${created.id}'`
    );
    assert(Number(snapshot) === expected, `snapshot changed to ${snapshot}`);
    // The reservation keeps the room rate it was sold at; the total lives in the
    // snapshot that the assertion above just read.
    const soldRate = sql(
      `SELECT rate FROM "ReservationRoom" WHERE "reservationId" = '${created.id}'`
    );
    assert(Number(soldRate) === STANDARD.double, `sold room rate changed to ${soldRate}`);

    const fresh = await receptionist.post("/api/reservations/quote", {
      roomId: fx.standard.roomId,
      occupancyTypeId: doubleId,
      adults: 2,
      checkInDate: `${isoDay(60)}T12:00:00.000Z`,
      checkOutDate: `${isoDay(61)}T12:00:00.000Z`,
    });
    assert(fresh.status === 200, `quote status ${fresh.status}`);
    assert(
      fresh.body.totals.grandTotal === raised,
      `new quote ${fresh.body.totals.grandTotal} != ${raised}`
    );
    return `sold ${money(expected)} → new ${money(raised)}`;
  });

  await checkAsync("api-manipulated-total-ignored", "a client-supplied total is ignored", async () => {
    const { status, body } = await receptionist.post("/api/reservations", {
      guestName: `Manipulated Guest ${Date.now()}`,
      checkInDate: `${isoDay(50)}T12:00:00.000Z`,
      checkOutDate: `${isoDay(51)}T12:00:00.000Z`,
      roomId: fx.standard.roomId,
      occupancyTypeId: doubleId,
      adults: 2,
      total: 1,
      grandTotal: 1,
      rate: 1,
      nightlyRate: 1,
    });
    assert(status === 201, `status ${status}: ${JSON.stringify(body)}`);
    assert(body.total === raised, `stored total ${body.total} != ${raised}`);
    const snapshot = sql(
      `SELECT "grandTotal" FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${body.id}'`
    );
    assert(Number(snapshot) === raised, `snapshot ${snapshot} != ${raised}`);
    return `${money(body.total)}`;
  });

  await checkAsync("api-reprice-permission", "a receptionist may not reprice a sold reservation", async () => {
    const { status } = await receptionist.post(`/api/reservations/${created.id}/reprice`, {
      reason: "should be refused",
    });
    assert(status === 403, `expected 403, got ${status}`);
    const changes = sql(
      `SELECT count(*) FROM "ReservationPriceChange" WHERE "reservationId" = '${created.id}'`
    );
    assert(changes === "0", "the refused repricing still wrote a price change");
    return status;
  });

  await checkAsync("api-reprice-applied-and-audited", "repricing is explicit, audited and keeps the old price on record", async () => {
    const expectedReprice = raised * 3 + MEAL.charge * 2 * 3;
    const { status, body } = await owner.post(`/api/reservations/${created.id}/reprice`, {
      reason: "acceptance: rates raised after booking",
    });
    assert(status === 200, `status ${status}: ${JSON.stringify(body)}`);
    assert(body.previousTotal === expected, `previousTotal ${body.previousTotal} != ${expected}`);
    assert(body.total === expectedReprice, `new total ${body.total} != ${expectedReprice}`);

    const snapshot = sql(
      `SELECT "grandTotal" FROM "ReservationPriceSnapshot" WHERE "reservationId" = '${created.id}'`
    );
    assert(Number(snapshot) === expectedReprice, `snapshot ${snapshot} != ${expectedReprice}`);

    const change = sql(
      `SELECT "previousTotal" || '|' || "newTotal" || '|' || coalesce(reason, '') || '|' || "changedById"
       FROM "ReservationPriceChange" WHERE "reservationId" = '${created.id}'
       ORDER BY "createdAt" DESC LIMIT 1`
    );
    const [previousTotal, newTotal, reason, changedBy] = change.split("|");
    assert(Number(previousTotal) === expected, `change row previous ${previousTotal}`);
    assert(Number(newTotal) === expectedReprice, `change row new ${newTotal}`);
    assert(/acceptance/.test(reason), `change row reason "${reason}"`);
    assert(changedBy.length > 0, "change row has no actor");

    const audit = sql(
      `SELECT count(*) FROM "AuditLog"
       WHERE action = 'RESERVATION_REPRICED' AND "entityId" = '${created.id}'`
    );
    assert(Number(audit) >= 1, "no audit entry for the repricing");
    return `${money(expected)} → ${money(expectedReprice)} (audited)`;
  });

  await checkAsync("api-discount-permission", "only management may discount a stay", async () => {
    const refused = await receptionist.post("/api/reservations", {
      guestName: `Discount Guest ${Date.now()}`,
      checkInDate: `${isoDay(52)}T12:00:00.000Z`,
      checkOutDate: `${isoDay(53)}T12:00:00.000Z`,
      roomId: fx.standard.roomId,
      occupancyTypeId: doubleId,
      adults: 2,
      discount: 500,
    });
    assert(refused.status === 403, `receptionist discount returned ${refused.status}`);

    const allowed = await manager.post("/api/reservations", {
      guestName: `Manager Discount Guest ${Date.now()}`,
      checkInDate: `${isoDay(52)}T12:00:00.000Z`,
      checkOutDate: `${isoDay(53)}T12:00:00.000Z`,
      roomId: fx.standard.roomId,
      occupancyTypeId: doubleId,
      adults: 2,
      discount: 500,
    });
    assert(allowed.status === 201, `manager discount returned ${allowed.status}: ${JSON.stringify(allowed.body)}`);
    assert(allowed.body.total === raised - 500, `discounted total ${allowed.body.total}`);
    return `403 for receptionist, ${money(allowed.body.total)} for manager`;
  });

  await checkAsync("api-tenant-isolation", "another hotel's receptionist cannot quote this hotel's room", async () => {
    const { status } = await foreignReceptionist.post("/api/reservations/quote", {
      roomId: fx.standard.roomId,
      adults: 1,
      ...stay,
    });
    assert(status === 404, `expected 404, got ${status}`);
    return status;
  });

  await checkAsync("api-cross-tenant-meal-plan-refused", "a meal plan cannot reference another hotel's room type", async () => {
    const before = Number(
      sql(`SELECT count(*) FROM "MealPlanConfig" WHERE "hotelId" = '${fx.hotel}' AND name = 'Foreign Plan'`)
    );
    const { status } = await owner.post("/api/pricing/meal-plans", {
      name: "Foreign Plan",
      pricingBasis: "PER_ROOM_PER_NIGHT",
      charge: 100,
      roomTypeIds: [fx.foreignRoomTypeId],
    });
    assert(status === 404, `expected 404, got ${status}`);
    const after = Number(
      sql(`SELECT count(*) FROM "MealPlanConfig" WHERE "hotelId" = '${fx.hotel}' AND name = 'Foreign Plan'`)
    );
    assert(after === before, "a partial meal plan was written");
    return "404 and no partial row";
  });

  // ---- Phase B ------------------------------------------------------------
  const shots = [];
  let browser = null;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    const shot = async (name) => {
      mkdirSync(OUT, { recursive: true });
      const file = join(OUT, `${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push(file);
      return file;
    };

    // 17. The pricing page renders the hotel's own currency and sections.
    await signInThroughUi(page, "HOTEL_OWNER", HOTEL);
    await gotoDashboard(page, "/dashboard/settings/pricing", HOTEL);
    try {
      await page.waitForFunction(
        () => (document.body.innerText || "").includes("Pricing & Rates"),
        { timeout: 30_000 }
      );
    } catch (error) {
      throw new Error(`pricing page did not render at ${page.url()}: ${error.message}`);
    }
    await checkAsync("browser-settings-page", "the Pricing & Rates page shows the hotel currency and sections", async () => {
      const text = await page.evaluate(() => document.body.innerText || "");
      assert(text.includes(fx.currency), `currency ${fx.currency} is not shown`);
      for (const tab of ["Room rates", "Occupancy options", "Meal plans", "Taxes & service"]) {
        assert(text.includes(tab), `missing section ${tab}`);
      }
      await shot("pricing-01-settings-overview");
      return `${fx.currency} labelled`;
    });

    // 18. Editing a rate in the UI persists.
    const uiRate = raised + 100;
    await checkAsync("browser-rate-edit-persists", "editing a rate in the UI persists across a reload", async () => {
      const opened = await page.evaluate((typeName) => {
        const button = [...document.querySelectorAll("button")].find((element) =>
          (element.textContent || "").includes(typeName)
        );
        button?.click();
        return Boolean(button);
      }, STANDARD.type);
      assert(opened, `room type ${STANDARD.type} is not listed`);
      await new Promise((r) => setTimeout(r, 300));

      const typed = await page.evaluate(
        ({ id, value }) => {
          const selects = [...document.querySelectorAll("input[type=number]")];
          const input = selects.find((element) => element.closest("label")?.textContent?.includes("Pricing Double")) || selects[1];
          if (!input) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(input, String(value));
          input.dispatchEvent(new Event("input", { bubbles: true }));
          return true;
        },
        { id: doubleId, value: uiRate }
      );
      assert(typed, "the Double rate field was not found");
      await shot("pricing-02-rate-edit");

      await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((element) =>
          /save rates/i.test(element.textContent || "")
        );
        button?.click();
      });
      await page.waitForFunction(
        () => (document.body.innerText || "").includes("Rates saved for"),
        { timeout: 20_000 }
      );

      const stored = sql(
        `SELECT "nightlyRate" FROM "RoomTypeOccupancy"
         WHERE "roomTypeId" = '${fx.standard.roomTypeId}' AND "occupancyTypeId" = '${doubleId}'`
      );
      assert(Number(stored) === uiRate, `stored rate ${stored} != ${uiRate}`);

      await page.reload({ waitUntil: "networkidle0" });
      await page.waitForFunction(() => (document.body.innerText || "").includes("Pricing & Rates"), {
        timeout: 30_000,
      });
      await page.evaluate((typeName) => {
        const button = [...document.querySelectorAll("button")].find((element) =>
          (element.textContent || "").includes(typeName)
        );
        button?.click();
      }, STANDARD.type);
      await new Promise((r) => setTimeout(r, 300));
      const shown = await page.evaluate(() => {
        const inputs = [...document.querySelectorAll("input[type=number]")];
        const input = inputs.find((element) => element.closest("label")?.textContent?.includes("Pricing Double"));
        return input ? input.value : null;
      });
      assert(Number(shown) === uiRate, `field shows ${shown} after reload`);
      await shot("pricing-03-rate-persisted");
      return `${money(uiRate)} ${fx.currency}`;
    });

    // 19-22. The reservation form renders a server-computed breakdown.
    await signInThroughUi(page, "RECEPTIONIST", HOTEL);
    await gotoDashboard(page, "/dashboard/reservations", HOTEL);
    await page.waitForSelector('[aria-label^="Room "]', { timeout: 30_000 });
    const openForm = async (number) => {
      const opened = await page.evaluate((roomNumber) => {
        const cell = document.querySelector(`[aria-label^="Room ${roomNumber}, "]`);
        cell?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return Boolean(cell);
      }, number);
      assert(opened, `room ${number} is not on the calendar`);
      await page.waitForSelector('[data-testid="price-breakdown"]', { timeout: 20_000 });
      await page.evaluate(() => {
        document.querySelector('[data-testid="price-breakdown"]')?.scrollIntoView({ block: "center" });
      });
      await new Promise((r) => setTimeout(r, 200));
    };
    const totalText = () =>
      page.$eval('[data-testid="price-total"]', (element) => element.textContent.trim());
    const totalNumber = async () => Number((await totalText()).replace(/[^0-9.]/g, ""));

    // A party of two: the server should default to the cheapest option that
    // actually fits, which is "Pricing Double" at the edited rate.
    const setAdults = async (value) => {
      await page.evaluate((adults) => {
        const input = document.querySelector('[data-testid="adults"]');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, String(adults));
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, value);
    };
    const waitForTotal = (expected) =>
      page.waitForFunction(
        (value) => {
          const element = document.querySelector('[data-testid="price-total"]');
          return element && Math.abs(Number(element.textContent.replace(/[^0-9.]/g, "")) - value) < 0.01;
        },
        { timeout: 25_000 },
        expected
      );

    await checkAsync("browser-quote-breakdown", "the form shows a server-computed breakdown", async () => {
      await openForm(STANDARD.number);
      await setAdults(2);
      await waitForTotal(uiRate);
      const text = await page.$eval('[data-testid="price-breakdown"]', (element) => element.textContent);
      assert(/Price breakdown/.test(text), "no breakdown");
      assert(text.includes("Pricing Standard"), "the room type is not named in the breakdown");
      assert(text.includes("Pricing Double"), `the occupancy is not named in the breakdown: ${text}`);
      const source = await page.$eval('[data-testid="approved-rate-source"]', (element) => element.textContent);
      assert(/Pricing Double/.test(source), `rate source was "${source}"`);
      await shot("pricing-04-modal-breakdown");
      return `${money(uiRate)} ${fx.currency} (2 adults, 1 night, default occupancy)`;
    });

    await checkAsync("browser-occupancy-reprices", "choosing a hotel-defined occupancy re-prices the stay", async () => {
      const before = await totalNumber();
      await page.select('[data-testid="occupancy-select"]', familyId);
      await waitForTotal(STANDARD.family);
      const after = await totalNumber();
      assert(after === STANDARD.family, `expected ${STANDARD.family} for the family option, got ${after}`);
      await shot("pricing-05-occupancy-repriced");
      return `${money(before)} → ${money(after)} (Pricing Family)`;
    });

    await checkAsync("browser-meal-plan-reprices", "choosing a meal plan adds its per-person charge", async () => {
      const before = await totalNumber();
      await page.select('[data-testid="meal-plan-select"]', mealPlanId);
      const expected = STANDARD.family + MEAL.charge * 2;
      await waitForTotal(expected);
      const after = await totalNumber();
      assert(after === expected, `expected ${expected}, got ${after}`);
      const basis = await page.$eval('[data-testid="meal-plan-basis"]', (element) => element.textContent);
      assert(/per person \/ night/.test(basis), `basis label was "${basis}"`);
      await shot("pricing-06-meal-plan-repriced");
      return `${money(before)} → ${money(after)} (${basis?.trim()})`;
    });

    const nightlyWithMeals = STANDARD.family + MEAL.charge * 2;
    const threeNights = nightlyWithMeals * 3;
    await checkAsync("browser-dates-reprice", "changing the dates re-prices the stay per night", async () => {
      // Move the check-out three nights after whatever check-in the calendar
      // opened with, so the assertion is about nights, not about today's date.
      const checkIn = await page.$eval('input[type="date"]', (element) => element.value);
      const target = new Date(`${checkIn}T12:00:00.000Z`);
      target.setUTCDate(target.getUTCDate() + 3);
      const iso = target.toISOString().slice(0, 10);
      await page.evaluate((value) => {
        const input = document.querySelectorAll('input[type="date"]')[1];
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, iso);
      await waitForTotal(threeNights);
      await shot("pricing-07-dates-repriced");
      return `${money(threeNights)} ${fx.currency} for 3 nights`;
    });

    const guestName = `Pricing Browser Guest ${Date.now()}`;
    await checkAsync("browser-created", "submitting stores the snapshot for the sold stay", async () => {
      await page.evaluate((name) => {
        const input = document.querySelector("form input:not([type])");
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        setter.call(input, name);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }, guestName);
      await new Promise((r) => setTimeout(r, 300));
      await shot("pricing-08-ready-to-submit");
      await Promise.all([
        page.waitForFunction(() => !document.querySelector('[data-testid="price-breakdown"]'), {
          timeout: 30_000,
        }),
        page.click("button[type=submit]"),
      ]);
      await shot("pricing-09-created");
      const row = sql(
        `SELECT s."grandTotal" || '|' || s.currency || '|' || s."occupancyName"
         FROM "ReservationPriceSnapshot" s
         JOIN "Reservation" r ON r.id = s."reservationId"
         JOIN "Guest" g ON g.id = r."guestId"
         WHERE g.id IN (SELECT id FROM "Guest" WHERE "fullName" = '${guestName}')`
      );
      assert(row, "no snapshot for the reservation created in the browser");
      const [total, currency, occupancy] = row.split("|");
      assert(Number(total) === threeNights, `snapshot total ${total} != ${threeNights}`);
      assert(currency === fx.currency, `snapshot currency ${currency}`);
      assert(occupancy === "Pricing Family", `snapshot occupancy ${occupancy}`);
      return `${money(total)} ${currency}`;
    });

    await checkAsync("browser-persisted", "the reservation is still there after a reload", async () => {
      await page.reload({ waitUntil: "networkidle0" });
      await page.waitForSelector('[aria-label^="Room "]', { timeout: 30_000 });
      const visible = await page.evaluate(
        (name) => (document.body.innerText || "").includes(name),
        guestName
      );
      assert(visible, "the reservation disappeared after the reload");
      await shot("pricing-10-after-reload");
      return "visible";
    });

    // A same-day arrival, so the Front Desk has something to reprice below.
    const arrivalGuest = `Reprice Arrival ${Date.now()}`;
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const arrival = await receptionist.post("/api/reservations", {
      guestName: arrivalGuest,
      checkInDate: `${today}T12:00:00.000Z`,
      checkOutDate: `${tomorrow}T12:00:00.000Z`,
      roomId: fx.twin.roomId,
      occupancyTypeId: singleId,
      mealPlanId,
      adults: 1,
    });
    check("api-arrival-created", "a same-day arrival is booked for the Front Desk", () => {
      assert(arrival.status === 201, `status ${arrival.status}: ${JSON.stringify(arrival.body)}`);
      assert(
        arrival.body.total === TWIN.single + MEAL.charge,
        `total ${arrival.body.total} != ${TWIN.single + MEAL.charge}`
      );
      return `${arrival.body.code} @ ${money(arrival.body.total)}`;
    });

    // 24. A later configuration edit leaves the sold price alone.
    await checkAsync("browser-config-edit-keeps-sold-price", "editing rates afterwards cannot re-price a sold stay", async () => {
      const before = sql(
        `SELECT s."grandTotal" FROM "ReservationPriceSnapshot" s
         JOIN "Reservation" r ON r.id = s."reservationId"
         JOIN "Guest" g ON g.id = r."guestId"
         WHERE g."fullName" = '${guestName}'`
      );
      const higher = uiRate + 2500;
      const saved = await owner.post("/api/pricing/room-rates", {
        roomTypeId: fx.standard.roomTypeId,
        rates: [
        { occupancyTypeId: singleId, nightlyRate: STANDARD.single },
        { occupancyTypeId: doubleId, nightlyRate: higher },
        { occupancyTypeId: familyId, nightlyRate: STANDARD.family },
      ],
      });
      assert(saved.status === 200 || saved.status === 201, `status ${saved.status}`);
      const twinSaved = await owner.post("/api/pricing/room-rates", {
        roomTypeId: fx.twin.roomTypeId,
        rates: [{ occupancyTypeId: singleId, nightlyRate: TWIN.single + 1000 }],
      });
      assert(twinSaved.status === 200 || twinSaved.status === 201, `twin status ${twinSaved.status}`);
      const after = sql(
        `SELECT s."grandTotal" FROM "ReservationPriceSnapshot" s
         JOIN "Reservation" r ON r.id = s."reservationId"
         JOIN "Guest" g ON g.id = r."guestId"
         WHERE g."fullName" = '${guestName}'`
      );
      assert(after === before, `snapshot moved from ${before} to ${after}`);
      return `${money(before)} unchanged after raising to ${money(higher)}`;
    });

    // 25. Repricing is a deliberate, management-only workflow in the UI.
    await checkAsync("browser-reprice-workflow", "the owner reprices an arrival from the Front Desk", async () => {
      await signInThroughUi(page, "HOTEL_OWNER", HOTEL);
      await gotoDashboard(page, "/dashboard/front-desk", HOTEL);
      await page.waitForFunction((name) => (document.body.innerText || "").includes(name), { timeout: 30_000 }, arrivalGuest);

      const opened = await page.evaluate((name) => {
        const card = [...document.querySelectorAll("div")].find(
          (element) =>
            (element.className || "").includes("rounded-2xl") &&
            (element.textContent || "").includes(name)
        );
        const button = [...(card?.querySelectorAll("button") ?? [])].find((element) =>
          /reprice/i.test(element.textContent || "")
        );
        button?.click();
        return Boolean(button);
      }, arrivalGuest);
      assert(opened, "no Reprice action on the arrival card");
      await page.waitForSelector('[data-testid="reprice-dialog"]', { timeout: 15_000 });
      await shot("pricing-11-reprice-dialog");

      await page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((element) =>
          /reprice at current rates/i.test(element.textContent || "")
        );
        button?.click();
      });
      await page.waitForSelector('[data-testid="reprice-result"]', { timeout: 30_000 });
      const result = await page.$eval('[data-testid="reprice-result"]', (element) => element.textContent);
      await shot("pricing-12-repriced");

      const expectedNew = TWIN.single + 1000 + MEAL.charge;
      const stored = sql(
        `SELECT s."grandTotal" || '|' || c."newTotal"
         FROM "ReservationPriceSnapshot" s
         JOIN "Reservation" r ON r.id = s."reservationId"
         JOIN "Guest" g ON g.id = r."guestId"
         LEFT JOIN "ReservationPriceChange" c ON c."reservationId" = r.id
         WHERE g."fullName" = '${arrivalGuest}' LIMIT 1`
      );
      const [snapshotTotal, changeTotal] = stored.split("|");
      assert(Number(snapshotTotal) === expectedNew, `snapshot after reprice ${snapshotTotal} != ${expectedNew}`);
      assert(Number(changeTotal) === expectedNew, `change row ${changeTotal}`);
      assert(result.includes(money(expectedNew)), `dialog showed "${result}"`);
      return result.trim();
    });

    // Leave the demo rates where the next run expects them.
    await owner.post("/api/pricing/room-rates", {
      roomTypeId: fx.twin.roomTypeId,
      rates: [{ occupancyTypeId: singleId, nightlyRate: TWIN.single }],
    });
    await owner.post("/api/pricing/room-rates", {
      roomTypeId: fx.standard.roomTypeId,
      rates: [
        { occupancyTypeId: singleId, nightlyRate: STANDARD.single },
        { occupancyTypeId: doubleId, nightlyRate: STANDARD.double },
        { occupancyTypeId: familyId, nightlyRate: STANDARD.family },
      ],
    });
  } catch (error) {
    results.push({
      id: "browser-harness",
      description: "browser phase",
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(`${color(31, "  FAIL")}  browser phase — ${error.message}`);
  } finally {
    if (browser) await browser.close();
  }

  // Leave the demo hotel configured the way this run found it: the pricing
  // engine is proven above, and the demo tenant keeps the pricing model its own
  // rooms were sold under.
  if (originalSettings) {
    const restore = await owner.patch("/api/pricing", {
      pricingModel: String(originalSettings.pricingModel ?? "LEGACY_BASE_RATE"),
      useOccupancyRates: Boolean(originalSettings.useOccupancyRates),
      useMealPlans: Boolean(originalSettings.useMealPlans),
      useSeasonalPricing: Boolean(originalSettings.useSeasonalPricing),
      useWeekendPricing: Boolean(originalSettings.useWeekendPricing),
      useChildPricing: Boolean(originalSettings.useChildPricing),
      useExtraBeds: Boolean(originalSettings.useExtraBeds),
      useTaxes: Boolean(originalSettings.useTaxes),
      pricesIncludeTax: Boolean(originalSettings.pricesIncludeTax),
    });
    console.log(
      `\nRestored the demo hotel's pricing model (${originalSettings.pricingModel}) — status ${restore.status}`
    );
  }

  const failed = results.filter((row) => row.status === "FAIL");
  const summary = {
    base: BASE,
    generatedAt: new Date().toISOString(),
    hotel: HOTEL,
    currency: fx.currency,
    passed: results.length - failed.length,
    failed: failed.length,
    screenshots: shots,
    results,
  };
  if (JSON_OUT) {
    const target = resolve(ROOT, JSON_OUT);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`\nJSON: ${target}`);
  }
  console.log(
    `\n${failed.length === 0 ? color(32, "PASS") : color(31, "FAIL")}  ${summary.passed} passed, ${failed.length} failed`
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
