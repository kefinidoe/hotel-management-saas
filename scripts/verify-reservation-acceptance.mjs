#!/usr/bin/env node
/**
 * Reservation acceptance check — the workflow the owner reported broken.
 *
 * Two failures were reported from owner testing: "Approved rate per night (KSh)"
 * showed "--" and "Create Reservation" was permanently disabled. Both came from
 * pricing the stay by matching tariff *names* against Single/Double/Twin, which
 * a hotel that names its room types "Standard"/"Deluxe" never satisfies.
 *
 * This script proves the repair the way a receptionist experiences it:
 *
 *   Phase A (HTTP, real session cookies)
 *     1. receptionist signs in and creates a reservation on a room whose type is
 *        named "Standard" with no meal plan  -> 201, rate persisted
 *     2. the same room/dates again           -> refused (no double booking)
 *     3. a room from the other hotel         -> refused (tenant isolation)
 *     4. another type's tariff for this room -> refused (no price swapping)
 *     5. the created reservation is listed   -> persisted
 *     6. the owner can create one too        -> 201
 *
 *   Phase B (real Chromium)
 *     7. the reservations calendar opens the form with the rate populated
 *     8. switching room updates the rate
 *     9. the submit button is disabled until the form is complete
 *    10. submitting creates the reservation and the calendar shows it after a
 *        reload (persistence, not just an optimistic UI update)
 *
 * Requirements: the app running against the disposable demo database, `psql`
 * (PSQL_BIN) and Chromium (CHROME_PATH or @sparticuz/chromium).
 *
 * Usage: node scripts/verify-reservation-acceptance.mjs --base http://127.0.0.1:3000 \
 *          --json docs/evidence/reservations/reservation-acceptance.json
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
const OUT = resolve(ROOT, arg("out", "docs/evidence/reservations"));

const PSQL = process.env.PSQL_BIN || join(
  ROOT,
  ".owner-test/postgresql-17.11.0-x86_64-unknown-linux-gnu/bin/psql"
);
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL must point at the disposable demo database.");
  process.exit(2);
}

const creds = JSON.parse(
  readFileSync(join(ROOT, ".owner-test/credentials.json"), "utf8")
);
const account = (role, hotel) => {
  const match = creds.accounts.find((a) => a.role === role && a.hotel === hotel);
  if (!match) throw new Error(`No ${role} account for ${hotel} in credentials.json`);
  return match;
};

const results = [];
const color = (code, value) => (process.stdout.isTTY ? `\u001b[${code}m${value}\u001b[0m` : value);

function check(id, description, fn) {
  const started = Date.now();
  try {
    const detail = fn();
    results.push({ id, description, status: "PASS", ms: Date.now() - started, detail });
    console.log(`${color(32, "  PASS")}  ${id} — ${description}`);
    return detail;
  } catch (error) {
    results.push({
      id,
      description,
      status: "FAIL",
      ms: Date.now() - started,
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
// Fixtures: a hotel that names its room types after itself, not an occupancy.
// This is the shape that broke owner testing and is not in the seed data.
// ---------------------------------------------------------------------------
const HOTEL = "Riverside Grand Hotel";
const FOREIGN_HOTEL = "Lakeview Lodge";
const STANDARD = { number: "901", type: "Standard", rate: 4500 };
const DELUXE = { number: "902", type: "Deluxe Garden", rate: 8500 };

function hotelId(name) {
  const id = sql(`SELECT id FROM "Hotel" WHERE name = '${name}' LIMIT 1`);
  assert(id, `Hotel ${name} not found in the demo database`);
  return id;
}

function clearPreviousRuns(hotel) {
  // Rooms 901/902 exist only for this check. Clear the reservations earlier runs
  // of this script left behind so the same dates can be sold again; nothing the
  // demo seed created is touched.
  const ids = sql(
    `SELECT string_agg(DISTINCT rr."reservationId", ',') FROM "ReservationRoom" rr
     JOIN "Room" r ON r.id = rr."roomId"
     WHERE r."hotelId" = '${hotel}' AND r.number IN ('${STANDARD.number}', '${DELUXE.number}')`
  );
  if (!ids) return 0;
  const list = ids.split(",").map((id) => `'${id}'`).join(",");
  sql(`DELETE FROM "ReservationRoom" WHERE "reservationId" IN (${list})`);
  sql(`DELETE FROM "Reservation" WHERE id IN (${list})`);
  return list.split(",").length;
}

function ensureRoomTypes() {
  const hotel = hotelId(HOTEL);
  clearPreviousRuns(hotel);
  for (const spec of [STANDARD, DELUXE]) {
    sql(
      `INSERT INTO "RoomType" (id, "hotelId", name, "baseRate", "mealPlan", "createdAt", "updatedAt")
       SELECT gen_random_uuid()::text, '${hotel}', '${spec.type}', ${spec.rate}, NULL, now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM "RoomType" WHERE "hotelId" = '${hotel}' AND name = '${spec.type}'
       )`
    );
    const typeId = sql(
      `SELECT id FROM "RoomType" WHERE "hotelId" = '${hotel}' AND name = '${spec.type}' LIMIT 1`
    );
    sql(
      `INSERT INTO "Room" (id, "hotelId", "roomTypeId", number, floor, status, "isActive", "createdAt", "updatedAt")
       SELECT gen_random_uuid()::text, '${hotel}', '${typeId}', '${spec.number}', 9, 'AVAILABLE', true, now(), now()
       WHERE NOT EXISTS (
         SELECT 1 FROM "Room" WHERE "hotelId" = '${hotel}' AND number = '${spec.number}'
       )`
    );
    sql(
      `UPDATE "Room" SET "roomTypeId" = '${typeId}', status = 'AVAILABLE'
       WHERE "hotelId" = '${hotel}' AND number = '${spec.number}'`
    );
  }
  return {
    hotel,
    standardRoomId: sql(
      `SELECT id FROM "Room" WHERE "hotelId" = '${hotel}' AND number = '${STANDARD.number}'`
    ),
    standardTypeId: sql(
      `SELECT id FROM "RoomType" WHERE "hotelId" = '${hotel}' AND name = '${STANDARD.type}'`
    ),
    deluxeRoomId: sql(
      `SELECT id FROM "Room" WHERE "hotelId" = '${hotel}' AND number = '${DELUXE.number}'`
    ),
    deluxeTypeId: sql(
      `SELECT id FROM "RoomType" WHERE "hotelId" = '${hotel}' AND name = '${DELUXE.type}'`
    ),
    foreignRoomId: sql(
      `SELECT r.id FROM "Room" r JOIN "Hotel" h ON h.id = r."hotelId"
       WHERE h.name = '${FOREIGN_HOTEL}' ORDER BY r.number LIMIT 1`
    ),
    currency: sql(`SELECT currency FROM "Hotel" WHERE name = '${HOTEL}'`),
    foreignCurrency: sql(`SELECT currency FROM "Hotel" WHERE name = '${FOREIGN_HOTEL}'`),
  };
}

// ---------------------------------------------------------------------------
// Minimal cookie-carrying HTTP client so the API is exercised with a real
// NextAuth session, exactly as the browser would.
// ---------------------------------------------------------------------------
function createClient() {
  const jar = new Map();
  const cookieHeader = () =>
    [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");

  async function request(path, init = {}) {
    const headers = new Headers(init.headers || {});
    // Mutating routes enforce same-origin; assert it the way a browser would.
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
    const csrfResponse = await request("/api/auth/csrf");
    const { csrfToken } = await csrfResponse.json();
    const body = new URLSearchParams({ csrfToken, email, password, callbackUrl: "/login", json: "true" });
    const response = await request("/api/auth/callback/credentials", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    assert(response.status < 400, `Login for ${email} failed with ${response.status}`);
    const session = await request("/api/auth/session");
    const payload = await session.json();
    assert(payload?.user?.email === email, `No session after login for ${email}`);
    return payload;
  }

  async function postJson(path, payload) {
    const response = await request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    return { status: response.status, body };
  }

  return { request, login, postJson };
}

function isoDay(offsetDays = 0) {
  const date = new Date();
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

const stay = { checkInDate: `${isoDay(20)}T12:00:00.000Z`, checkOutDate: `${isoDay(23)}T12:00:00.000Z` };

/**
 * The bundled Chromium links against Amazon Linux 2023 shared libraries that are
 * not on the loader path. `@sparticuz/chromium` ships them brotli'd; unpack them
 * into a temp directory (never system-wide) so the binary can start.
 */
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

// ---------------------------------------------------------------------------
// Phase B: browser
// ---------------------------------------------------------------------------
async function runBrowser(fixtures) {
  let puppeteer;
  let chromium;
  try {
    puppeteer = (await import("puppeteer-core")).default;
    chromium = (await import("@sparticuz/chromium")).default;
  } catch {
    throw new Error("puppeteer-core/@sparticuz/chromium not installed");
  }
  const executablePath = process.env.CHROME_PATH || (await chromium.executablePath());
  if (!process.env.CHROME_PATH) {
    const libraryDirs = unpackSharedLibraries();
    if (libraryDirs.length) {
      const existing = process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : "";
      process.env.LD_LIBRARY_PATH = libraryDirs.join(":") + existing;
    }
  }
  const browser = await puppeteer.launch({
    executablePath,
    args: [...(process.env.CHROME_PATH ? [] : chromium.args), "--no-sandbox"],
    headless: true,
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const receptionist = account("RECEPTIONIST", HOTEL);

  try {
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
    await page.type('input[type="email"]', receptionist.email);
    await page.type('input[type="password"]', receptionist.password);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {}),
      page.click("form button[type=submit]"),
    ]);
    await page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 30_000 });
    if (page.url().includes("/select-hotel")) {
      await page.evaluate(() => {
        const card = [...document.querySelectorAll("div.cursor-pointer")].find((element) =>
          (element.querySelector("h3")?.textContent || "").includes("Riverside")
        );
        card?.click();
      });
      await page.waitForFunction(() => !location.pathname.includes("/select-hotel"), { timeout: 30_000 });
    }

    await page.goto(`${BASE}/dashboard/reservations`, { waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label^="Room "]', { timeout: 30_000 });

    const openFormFor = async (roomNumber) => {
      const opened = await page.evaluate((number) => {
        const cell = document.querySelector(`[aria-label^="Room ${number}, "]`);
        if (!cell) return false;
        cell.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      }, roomNumber);
      assert(opened, `Room ${roomNumber} is not on the reservations calendar`);
      await page.waitForSelector('[data-testid="approved-rate"]', { timeout: 15_000 });
      // The rate panel sits at the bottom of a scrolling modal; bring it into
      // frame so the screenshot shows what the receptionist actually reads.
      await page.evaluate(() => {
        document
          .querySelector('[data-testid="approved-rate"]')
          ?.scrollIntoView({ block: "center" });
      });
      await new Promise((resolve) => setTimeout(resolve, 150));
    };

    const rateText = () => page.$eval('[data-testid="approved-rate"]', (element) => element.textContent.trim());
    const buttonDisabled = () =>
      page.$eval("button[type=submit]", (element) => element.disabled);

    const shots = [];
    const shot = async (name) => {
      mkdirSync(OUT, { recursive: true });
      const file = join(OUT, `${name}.png`);
      await page.screenshot({ path: file, fullPage: true });
      shots.push(file);
    };

    // 7. rate populated for a custom-named room type
    await openFormFor(STANDARD.number);
    const standardRate = await rateText();
    check("browser-rate-populated", `form shows a rate for room ${STANDARD.number} (${STANDARD.type})`, () => {
      assert(standardRate !== "--", "approved rate still renders as --");
      assert(
        standardRate.includes("4,500"),
        `expected 4,500 in "${standardRate}"`
      );
      return standardRate;
    });
    await shot("browser-01-rate-populated");

    // 8. switching room updates the rate
    const deluxeRate = await (async () => {
      await page.evaluate((number) => {
        const chip = [...document.querySelectorAll("button")].find(
          (element) => (element.textContent || "").trim().startsWith(`Room ${number}`)
        );
        chip?.click();
      }, DELUXE.number);
      await new Promise((r) => setTimeout(r, 300));
      return rateText();
    })();
    check("browser-rate-updates", "choosing another room re-prices the stay", () => {
      assert(deluxeRate.includes("8,500"), `expected 8,500 in "${deluxeRate}"`);
      return `${standardRate} -> ${deluxeRate}`;
    });

    // 9. incomplete form keeps the button disabled
    const beforeTyping = await buttonDisabled();
    check("browser-button-guarded", "submit stays disabled until the guest is entered", () => {
      assert(beforeTyping === true, "submit button was enabled with an empty guest name");
      return "disabled";
    });
    await shot("browser-02-button-guarded");

    // 10. create it for real and prove it survives a reload
    const guestName = `Acceptance Guest ${Date.now()}`;
    await page.evaluate((name) => {
      const input = document.querySelector("form input:not([type])");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(input, name);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, guestName);
    await new Promise((r) => setTimeout(r, 200));
    assert((await buttonDisabled()) === false, "submit stayed disabled with a complete form");
    await shot("browser-03-ready-to-submit");

    await Promise.all([
      page.waitForFunction(() => !document.querySelector('[data-testid="approved-rate"]'), {
        timeout: 30_000,
      }),
      page.click("button[type=submit]"),
    ]);
    await shot("browser-04-created");

    check("browser-created", "reservation created from the form", () => {
      const row = sql(
        `SELECT r.code || '|' || rr.rate FROM "Reservation" r
         JOIN "ReservationRoom" rr ON rr."reservationId" = r.id
         JOIN "Guest" g ON g.id = r."guestId"
         WHERE g."fullName" = '${guestName}'`
      );
      assert(row, "no reservation row for the guest created in the browser");
      const [code, rate] = row.split("|");
      assert(Number(rate) === DELUXE.rate, `persisted rate ${rate} != ${DELUXE.rate}`);
      return `${code} @ ${rate}`;
    });

    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector('[aria-label^="Room "]', { timeout: 30_000 });
    const visibleAfterReload = await page.evaluate(
      (name) => (document.body.innerText || "").includes(name),
      guestName
    );
    check("browser-persisted", "reservation is still on the calendar after a reload", () => {
      assert(visibleAfterReload, "reservation disappeared after the page reloaded");
      return "visible";
    });
    await shot("browser-05-after-reload");

    return shots;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
async function main() {
  const health = await fetch(`${BASE}/login`).catch(() => null);
  assert(health && health.ok, `App is not reachable at ${BASE}`);
  assert(
    psqlVersion(),
    "psql is required for the persistence assertions"
  );

  const fixtures = (() => {
    try {
      return ensureRoomTypes();
    } catch (error) {
      console.error(`Could not prepare fixtures: ${error.message}`);
      process.exit(1);
    }
  })();
  console.log(`Hotel ${HOTEL}: currency ${fixtures.currency}, room ${STANDARD.number} @ ${STANDARD.rate}`);
  console.log(`Foreign hotel ${FOREIGN_HOTEL}: currency ${fixtures.foreignCurrency}`);

  // ---- Phase A ------------------------------------------------------------
  const receptionist = createClient();
  await receptionist.login(
    account("RECEPTIONIST", HOTEL).email,
    account("RECEPTIONIST", HOTEL).password
  );

  const payload = {
    guestName: `API Guest ${Date.now()}`,
    guestPhone: "+254712000001",
    checkInDate: stay.checkInDate,
    checkOutDate: stay.checkOutDate,
    roomId: fixtures.standardRoomId,
    tariffId: fixtures.standardTypeId,
    occupancy: "DOUBLE",
    mealPlan: "BED_ONLY",
  };

  const created = await receptionist.postJson("/api/reservations", payload);
  const createdDetail = check("api-receptionist-create", "receptionist creates a reservation on a 'Standard' room type", () => {
    assert(created.status === 201, `status ${created.status}: ${JSON.stringify(created.body)}`);
    assert(created.body?.id, "no reservation id returned");
    return created.body.code;
  });

  if (createdDetail) {
    check("api-rate-persisted", "stored nightly rate is the room type's configured rate", () => {
      const rate = sql(
        `SELECT rr.rate FROM "ReservationRoom" rr WHERE rr."reservationId" = '${created.body.id}'`
      );
      assert(Number(rate) === STANDARD.rate, `stored rate ${rate} != ${STANDARD.rate}`);
      const hotel = sql(`SELECT "hotelId" FROM "Reservation" WHERE id = '${created.body.id}'`);
      assert(hotel === fixtures.hotel, "reservation was not written to the active hotel");
      return `${rate} in ${hotel}`;
    });
  }

  const duplicate = await receptionist.postJson("/api/reservations", {
    ...payload,
    guestName: `Duplicate Guest ${Date.now()}`,
  });
  check("api-no-double-booking", "the same room and dates cannot be sold twice", () => {
    assert(duplicate.status >= 400, `expected a refusal, got ${duplicate.status}`);
    return `${duplicate.status} ${duplicate.body?.error ?? ""}`.trim();
  });

  const foreign = await receptionist.postJson("/api/reservations", {
    ...payload,
    roomId: fixtures.foreignRoomId,
    guestName: `Foreign Guest ${Date.now()}`,
  });
  check("api-tenant-isolation", "a room in another hotel is refused", () => {
    assert(foreign.status === 404, `expected 404, got ${foreign.status}`);
    return `${foreign.status} ${foreign.body?.error ?? ""}`.trim();
  });

  const swapped = await receptionist.postJson("/api/reservations", {
    ...payload,
    roomId: fixtures.deluxeRoomId,
    tariffId: fixtures.standardTypeId,
    guestName: `Swapped Guest ${Date.now()}`,
  });
  check("api-no-price-swap", "another type's cheaper tariff cannot price this room", () => {
    assert(swapped.status === 400, `expected 400, got ${swapped.status}`);
    return `${swapped.status} ${swapped.body?.error ?? ""}`.trim();
  });

  const listed = await receptionist.request(
    `/api/reservations?from=${isoDay(-1)}&to=${isoDay(30)}`
  );
  const listBody = await listed.json();
  check("api-persisted", "the new reservation is returned by the list endpoint", () => {
    assert(Array.isArray(listBody), "list endpoint did not return an array");
    if (!createdDetail) return "skipped (creation failed)";
    assert(
      listBody.some((row) => row.code === createdDetail),
      `${createdDetail} missing from the calendar data`
    );
    return createdDetail;
  });

  const owner = createClient();
  await owner.login(account("HOTEL_OWNER", HOTEL).email, account("HOTEL_OWNER", HOTEL).password);
  // The demo owner belongs to both demo hotels, so the app (correctly) refuses to
  // guess which one is active: select the workspace exactly as the UI does.
  const selection = await owner.postJson("/api/auth/switch-hotel", { hotelId: fixtures.hotel });
  check("api-owner-hotel-selected", "owner selects the Riverside workspace explicitly", () => {
    assert(selection.status === 200, `switch-hotel returned ${selection.status}: ${JSON.stringify(selection.body)}`);
    return "active hotel set";
  });
  const ownerCreate = await owner.postJson("/api/reservations", {
    ...payload,
    roomId: fixtures.deluxeRoomId,
    tariffId: fixtures.deluxeTypeId,
    guestName: `Owner Guest ${Date.now()}`,
  });
  check("api-owner-create", "the owner can create a reservation too", () => {
    assert(ownerCreate.status === 201, `status ${ownerCreate.status}: ${JSON.stringify(ownerCreate.body)}`);
    return ownerCreate.body.code;
  });

  // ---- Phase B ------------------------------------------------------------
  let shots = [];
  try {
    shots = await runBrowser(fixtures);
  } catch (error) {
    results.push({
      id: "browser-harness",
      description: "browser phase",
      status: "FAIL",
      error: error instanceof Error ? error.message : String(error),
    });
    console.log(`${color(31, "  FAIL")}  browser phase — ${error.message}`);
  }

  const failed = results.filter((row) => row.status === "FAIL");
  const summary = {
    base: BASE,
    generatedAt: new Date().toISOString(),
    hotel: HOTEL,
    currency: fixtures.currency,
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

function psqlVersion() {
  try {
    return execFileSync(PSQL, ["--version"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
