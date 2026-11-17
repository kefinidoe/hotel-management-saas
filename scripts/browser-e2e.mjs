#!/usr/bin/env node
/**
 * Browser end-to-end harness — the runbook's human checklist, executed by a browser.
 *
 * `scripts/e2e-smoke.mjs` proves the API works. It cannot prove that a person can
 * use the product: hydration, client-side routing, controlled React inputs, modals,
 * the select-hotel page and its invitation buttons, role-dependent navigation and
 * every rendered table are invisible to an HTTP client. This script drives a real
 * Chromium through those pages, screenshots each step and fails loudly.
 *
 * Requirements
 *   * a Chromium build — `CHROME_PATH=/path/to/chrome`, or the bundled
 *     `@sparticuz/chromium` devDependency, which needs no download at install time
 *     and ships its own shared libraries;
 *   * the application running against a **disposable** database;
 *   * `DATABASE_URL` pointing at that same database, for the assertions that must
 *     not trust the UI's own report.
 *
 * Usage
 *   node scripts/browser-e2e.mjs --base http://127.0.0.1:3100 \
 *     --out docs/evidence/browser --json browser-results.json
 *
 * Exit 0 means every step passed. `--only a,b` runs a subset (by step-id prefix).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : argv[index + 1];
};
const has = (name) => argv.includes(`--${name}`);

const BASE = arg("base", "http://127.0.0.1:3100").replace(/\/+$/, "");
const OUT = resolve(ROOT, arg("out", "docs/evidence/browser"));
const JSON_OUT = arg("json", null);
const ONLY = arg("only", null);
const HEADLESS = !has("headed");

const color = (code, value) => (process.stdout.isTTY ? `\u001b[${code}m${value}\u001b[0m` : value);
const log = (message) => console.log(message);

// ---------------------------------------------------------------------------
// Chromium
// ---------------------------------------------------------------------------
async function resolveBrowser() {
  if (process.env.CHROME_PATH) return { executablePath: process.env.CHROME_PATH, args: [] };

  let chromium;
  try {
    chromium = (await import("@sparticuz/chromium")).default;
  } catch {
    throw new Error("No browser available. Set CHROME_PATH, or run: npm i -D @sparticuz/chromium puppeteer-core");
  }

  const executablePath = await chromium.executablePath();
  const libraryDirs = unpackSharedLibraries();
  if (libraryDirs.length) {
    const existing = process.env.LD_LIBRARY_PATH ? `:${process.env.LD_LIBRARY_PATH}` : "";
    process.env.LD_LIBRARY_PATH = libraryDirs.join(":") + existing;
  }
  return { executablePath, args: chromium.args };
}

/**
 * The bundled Chromium links against Amazon Linux 2023 shared libraries that are
 * not on the loader path. They ship inside the package as a brotli'd tarball;
 * unpack them into a temp directory (never system-wide) so the binary can start.
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
// Harness state
// ---------------------------------------------------------------------------
const startedAt = new Date();
const results = [];
const launched = [];
const screenshots = [];
let puppeteer = null;
let executablePath = null;
let browserArgs = [];
let browserVersion = "unknown";
let currentSession = null;

const stamp = Date.now();
const fixtures = {
  hotelA: `Aurora Lodge ${stamp}`,
  hotelB: `Bayside Inn ${stamp}`,
  ownerA: { name: "Amina Owner", email: `owner-a-${stamp}@example.test`, password: "OwnerPass123!" },
  ownerB: { name: "Bram Owner", email: `owner-b-${stamp}@example.test`, password: "OwnerPass123!" },
  receptionist: { name: "Ruth Reception", email: `reception-a-${stamp}@example.test`, password: "Reception123!" },
  guest: { name: `Grace Guest ${stamp}`, phone: "+254711000111" },
  futureGuest: { name: `Felix Future ${stamp}`, phone: "+254711000222" },
  roomNumber: "101",
  menuItem: `Mandazi ${String(stamp).slice(-5)}`,
  menuCategory: `Counter ${String(stamp).slice(-5)}`,
  inventoryItem: `Maize Flour ${String(stamp).slice(-5)}`,
  ticket: `Shower leaking ${String(stamp).slice(-5)}`,
};

// ---------------------------------------------------------------------------
// Sessions: one browser process (and therefore one cookie jar) per person
// ---------------------------------------------------------------------------
async function newSession(label) {
  const instance = await puppeteer.launch({
    args: [...new Set([...browserArgs, "--no-sandbox", "--disable-dev-shm-usage", "--font-render-hinting=none"])],
    executablePath,
    headless: HEADLESS ? "shell" : false,
    userDataDir: mkdtempSync(join(tmpdir(), `hms-browser-${label}-`)),
  });
  launched.push(instance);
  const page = await instance.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (error) => log(color(33, `  [pageerror:${label}] ${String(error.message).slice(0, 160)}`)));
  page.on("response", async (response) => {
    if (!response.url().includes("/api/") || response.status() < 400) return;
    const body = await response.text().catch(() => "");
    log(color(33, `  [api ${response.status()}:${label}] ${response.url().replace(BASE, "")} ${body.slice(0, 160)}`));
  });
  return { label, page, browser: instance };
}

const pageText = (session) => session.page.evaluate(() => document.body.innerText);

async function waitForText(session, needle, timeout = 20_000) {
  try {
    await session.page.waitForFunction(
      (value) => document.body.innerText.toLowerCase().includes(value.toLowerCase()),
      { timeout },
      needle
    );
  } catch {
    const seen = (await pageText(session)).replace(/\s+/g, " ").slice(0, 500);
    throw new Error(`Expected "${needle}" within ${timeout}ms. Page shows: ${seen}`);
  }
}

async function waitForAnyText(session, needles, timeout = 25_000) {
  try {
    await session.page.waitForFunction(
      (values) => values.some((value) => document.body.innerText.toLowerCase().includes(value.toLowerCase())),
      { timeout },
      needles
    );
  } catch {
    const seen = (await pageText(session)).replace(/\s+/g, " ").slice(0, 400);
    throw new Error(`Expected one of ${needles.join(" | ")}: ${seen}`);
  }
}

async function waitForUrl(session, fragment, timeout = 20_000) {
  try {
    await session.page.waitForFunction((value) => location.pathname.includes(value), { timeout }, fragment);
  } catch {
    throw new Error(`Expected URL to contain "${fragment}"; still at ${session.page.url()}`);
  }
}

async function clickText(session, label, { selector = "button, a", exact = true, timeout = 10_000 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const outcome = await session.page.evaluate(
      ({ label, selector, exact }) => {
        const candidates = [...document.querySelectorAll(selector)].filter((element) => {
          const value = (element.textContent || "").trim();
          if (exact) return value === label;
          return value.includes(label) && value.length <= label.length + 60;
        });
        if (candidates.length === 0) return "missing";
        const enabled = candidates.find((element) => !element.disabled);
        if (!enabled) return "disabled";
        enabled.scrollIntoView({ block: "center" });
        enabled.click();
        return "clicked";
      },
      { label, selector, exact }
    );
    if (outcome === "clicked") return;
    if (Date.now() > deadline) {
      throw new Error(`No clickable "${label}" (${selector}) — ${outcome}`);
    }
    await sleep(150);
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Click a control inside the open overlay. Every modal renders as a
 * `div.fixed.inset-0` sheet over the page, and several of them repeat the page's
 * own button label ("Add Room", "Add Item"), so an unscoped click hits the button
 * behind the dialog and silently does nothing.
 */
async function closeModal(session) {
  const closed = await session.page.evaluate(() => {
    const overlay = [...document.querySelectorAll("div.fixed.inset-0")].pop();
    if (!overlay) return "none";
    const buttons = [...overlay.querySelectorAll("button")];
    const close = buttons.find((button) => !(button.textContent || "").trim());
    if (close) {
      close.click();
      return "clicked";
    }
    const cancel = buttons.find((button) => /^(cancel|close|done)$/i.test((button.textContent || "").trim()));
    if (cancel) {
      cancel.click();
      return "clicked";
    }
    return "none";
  });
  if (closed !== "clicked") throw new Error("Could not close the open dialog");
  await session.page.waitForFunction(() => !document.querySelector("div.fixed.inset-0"), { timeout: 10_000 });
}

async function clickInModal(session, label, { exact = true } = {}) {
  await session.page.waitForFunction(() => Boolean(document.querySelector("div.fixed.inset-0")), { timeout: 10_000 });
  const deadline = Date.now() + 15_000;
  for (;;) {
    const outcome = await session.page.evaluate(
      ({ label, exact }) => {
        const overlay = [...document.querySelectorAll("div.fixed.inset-0")].pop();
        const buttons = [...overlay.querySelectorAll("button")];
        const target = buttons.find((button) => {
          const value = (button.textContent || "").trim();
          return exact ? value === label : value.includes(label) && value.length <= label.length + 60;
        });
        if (!target) return "missing";
        if (target.disabled) return "disabled";
        target.scrollIntoView({ block: "center" });
        target.click();
        return "clicked";
      },
      { label, exact }
    );
    if (outcome === "clicked") return;
    if (Date.now() > deadline) throw new Error(`Dialog button "${label}" stayed ${outcome}`);
    await sleep(150);
  }
}

/** Tag the control that belongs to a labelled field so it can be typed into reliably. */
async function fieldByLabel(session, labelText) {
  const marker = `hms-field-${Math.random().toString(36).slice(2, 10)}`;
  const found = await session.page.evaluate(
    ({ labelText, marker }) => {
      const labels = [...document.querySelectorAll("label")];
      const label = labels.find((element) => (element.textContent || "").trim().toLowerCase().startsWith(labelText.toLowerCase()));
      if (!label) return false;
      const container = label.closest("div") ?? label.parentElement;
      const field = container?.querySelector("input, select, textarea");
      if (!field) return false;
      field.setAttribute("data-hms-field", marker);
      return true;
    },
    { labelText, marker }
  );
  if (!found) throw new Error(`No field labelled "${labelText}"`);
  return `[data-hms-field="${marker}"]`;
}

async function fillField(session, labelText, value) {
  const selector = await fieldByLabel(session, labelText);
  const handle = await session.page.$(selector);
  await replaceValue(session, handle, value);
  await handle.dispose?.();
}

/** Replace a controlled input's contents the way a user does (select-all, then type). */
async function replaceValue(session, handle, value) {
  await handle.click();
  await session.page.keyboard.down("Control");
  await session.page.keyboard.press("KeyA");
  await session.page.keyboard.up("Control");
  await session.page.keyboard.press("Backspace");
  if (value !== "") await handle.type(value);
}

async function fillSelector(session, selector, value, index = 0) {
  const handles = await session.page.$$(selector);
  if (!handles[index]) throw new Error(`No element ${selector}` + (index ? `[${index}]` : ""));
  await replaceValue(session, handles[index], value);
}

/** Pick a <select> option by its visible label. */
async function selectField(session, labelText, optionLabel) {
  const selector = await fieldByLabel(session, labelText);
  const handle = await session.page.$(selector);
  const options = await handle.$$eval("option", (nodes) => nodes.map((node) => ({ value: node.value, label: node.textContent.trim() })));
  const match = options.find((option) => option.label === optionLabel) ?? options.find((option) => option.label.includes(optionLabel));
  if (!match) throw new Error(`No option "${optionLabel}" for "${labelText}"; have: ${options.map((o) => o.label).join(" | ")}`);
  await handle.select(match.value);
}

/** Date inputs cannot be typed into reliably; set the value and fire React's events. */
async function setDateField(session, labelText, isoDate) {
  const selector = await fieldByLabel(session, labelText);
  await session.page.$eval(
    selector,
    (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(element, value);
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
    },
    isoDate
  );
}

/**
 * /select-hotel renders each workspace as a clickable card with an "Enter"
 * button — not a link — so name-based clicking has to target the card itself.
 */
async function workspaceNames(session) {
  return session.page.evaluate(() =>
    [...document.querySelectorAll("div.cursor-pointer")]
      .map((card) => (card.querySelector("h3")?.textContent || "").trim())
      .filter(Boolean)
  );
}

async function enterWorkspace(session, name) {
  const clicked = await session.page.evaluate((value) => {
    const card = [...document.querySelectorAll("div.cursor-pointer")].find((element) =>
      (element.querySelector("h3")?.textContent || "").trim() === value
    );
    if (!card) return false;
    card.click();
    return true;
  }, name);
  if (!clicked) {
    const available = await workspaceNames(session);
    throw new Error(`No workspace card "${name}"; have: ${available.join(" | ")}`);
  }
}

async function screenshot(session, name) {
  mkdirSync(OUT, { recursive: true });
  const file = join(OUT, `${name}.png`);
  await session.page.screenshot({ path: file, fullPage: true });
  screenshots.push(file);
  return file;
}

async function login(session, email, password) {
  await session.page.goto(`${BASE}/login`, { waitUntil: "networkidle0" });
  await fillSelector(session, 'input[type="email"]', email);
  await fillSelector(session, 'input[type="password"]', password);
  await Promise.all([
    session.page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {}),
    clickText(session, "Sign in", { exact: false }),
  ]);
  await session.page.waitForFunction(() => !location.pathname.startsWith("/login"), { timeout: 25_000 });
}

async function registerOwner(session, person, hotelName) {
  await session.page.goto(`${BASE}/register`, { waitUntil: "networkidle0" });
  await fillSelector(session, 'input[placeholder="e.g. Jane Doe"]', person.name);
  await fillSelector(session, 'input[type="email"]', person.email);
  await fillSelector(session, 'input[type="tel"]', "+254700000123");
  const passwords = await session.page.$$('input[type="password"]');
  await replaceValue(session, passwords[0], person.password);
  await replaceValue(session, passwords[1], person.password);
  await Promise.all([
    session.page.waitForNavigation({ waitUntil: "networkidle0" }).catch(() => {}),
    clickText(session, "Create Account & Continue"),
  ]);
  await waitForUrl(session, "/onboarding");
  await fillSelector(session, 'input[type="text"]', hotelName);
  await clickText(session, "Complete Setup & Enter Workspace");
  await waitForUrl(session, "/dashboard", 30_000);
  await waitForText(session, hotelName);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------
let stepIndex = 0;

async function step(id, description, fn) {
  if (ONLY && !ONLY.split(",").some((prefix) => id.startsWith(prefix.trim()))) return null;
  stepIndex += 1;
  const name = `${String(stepIndex).padStart(2, "0")}-${id}`;
  const started = Date.now();
  try {
    const session = await fn();
    const shot = session ? await screenshot(session, name).catch(() => null) : null;
    results.push({ id, description, status: "PASS", ms: Date.now() - started, screenshot: shot });
    log(`${color(32, "  PASS")}  ${id} — ${description}`);
    return session;
  } catch (error) {
    let shot = null;
    if (currentSession) {
      shot = await screenshot(currentSession, `${name}-FAILURE`).catch(() => null);
      const html = await currentSession.page.content().catch(() => "");
      mkdirSync(OUT, { recursive: true });
      writeFileSync(join(OUT, `${name}-FAILURE.html`), html);
    }
    results.push({
      id,
      description,
      status: "FAIL",
      ms: Date.now() - started,
      screenshot: shot,
      error: String(error?.message ?? error),
    });
    log(`${color(31, "  FAIL")}  ${id} — ${description}\n        ${error?.message}`);
    return null;
  } finally {
    currentSession = null;
  }
}

const using = (session, fn) => async () => {
  currentSession = session;
  await fn(session);
  return session;
};

// ---------------------------------------------------------------------------
// Database assertions
// ---------------------------------------------------------------------------
function dbQuery(sql) {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    return execFileSync(process.env.PSQL_BIN || "psql", ["-d", url, "-Atc", sql], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function expectDb(sql, expected, description) {
  const value = dbQuery(sql);
  if (value === null) return; // psql unavailable: the browser assertions still ran
  if (String(value) !== String(expected)) throw new Error(`${description}: expected ${expected}, database says ${value}`);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
async function run() {
  const resolved = await resolveBrowser();
  executablePath = resolved.executablePath;
  browserArgs = resolved.args;
  puppeteer = (await import("puppeteer-core")).default;

  const probe = await puppeteer.launch({
    args: [...new Set([...browserArgs, "--no-sandbox", "--disable-dev-shm-usage"])],
    executablePath,
    headless: HEADLESS ? "shell" : false,
  });
  browserVersion = await probe.version();
  await probe.close();

  log(`Browser: ${executablePath} (${browserVersion})`);
  log(`Target : ${BASE}`);
  log(`Screenshots: ${OUT}\n`);

  const ownerA = await newSession("ownerA");

  await step(
    "hotel-a-register",
    "register Hotel A's owner and create the workspace through the UI",
    using(ownerA, async (session) => {
      await registerOwner(session, fixtures.ownerA, fixtures.hotelA);
    })
  );

  await step(
    "hotel-a-dashboard",
    "the dashboard shows the hotel, the owner and the setup checklist",
    using(ownerA, async (session) => {
      await waitForText(session, "Overview");
      await waitForText(session, fixtures.hotelA);
      await waitForText(session, "Hotel Owner");
      const nav = await session.page.$$eval("a[href^='/dashboard']", (links) => links.map((link) => link.getAttribute("href")));
      for (const required of ["/dashboard/reservations", "/dashboard/rooms", "/dashboard/staff", "/dashboard/reports"]) {
        if (!nav.includes(required)) throw new Error(`Navigation is missing ${required}`);
      }
    })
  );

  await step(
    "rooms-create-type",
    "create a room type from the Rooms page",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/rooms`, { waitUntil: "networkidle0" });
      await clickText(session, "Room Types");
      await fillSelector(session, 'input[placeholder^="Name (e.g."]', "Single — Bed Only");
      await fillSelector(session, 'input[placeholder^="Rate"]', "5000");
      await fillSelector(session, 'input[placeholder^="Capacity"]', "1");
      await clickInModal(session, "Add Room Type");
      await waitForText(session, "Single — Bed Only");
    })
  );

  await step(
    "rooms-create-room",
    "create room 101 of that type and see it listed",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/rooms`, { waitUntil: "networkidle0" });
      await clickText(session, "Add Room");
      await fillField(session, "Room Number", fixtures.roomNumber);
      await fillField(session, "Floor", "1");
      await selectField(session, "Room Type", "Single");
      await clickInModal(session, "Add Room");
      await sleep(400);
      await waitForText(session, fixtures.roomNumber);
      expectDb(
        `SELECT count(*) FROM "Room" r JOIN "Hotel" h ON h.id = r."hotelId" WHERE h.name = '${fixtures.hotelA}' AND r.number = '${fixtures.roomNumber}'`,
        "1",
        "room row"
      );
    })
  );

  await step(
    "staff-add-new-account",
    "add a receptionist who has no account yet",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/staff`, { waitUntil: "networkidle0" });
      await clickText(session, "Add Staff Member");
      await fillSelector(session, 'input[placeholder="e.g. Samuel Mutiso"]', fixtures.receptionist.name);
      await fillSelector(session, 'input[placeholder="samuel@yourhotel.com"]', fixtures.receptionist.email);
      await fillSelector(session, 'input[placeholder^="At least 8"]', fixtures.receptionist.password);
      await selectField(session, "Hotel Role", "Receptionist");
      await clickInModal(session, "Add to Hotel");
      await waitForText(session, fixtures.receptionist.email);
      expectDb(
        `SELECT count(*) FROM "HotelMembership" m JOIN "Hotel" h ON h.id = m."hotelId" JOIN "User" u ON u.id = m."userId" WHERE h.name = '${fixtures.hotelA}' AND u.email = '${fixtures.receptionist.email}' AND m.status = 'ACTIVE'`,
        "1",
        "receptionist ACTIVE membership"
      );
    })
  );

  const ownerB = await newSession("ownerB");
  await step(
    "hotel-b-register",
    "a second hotel is created by a different owner in a separate browser",
    using(ownerB, async (session) => {
      await registerOwner(session, fixtures.ownerB, fixtures.hotelB);
    })
  );

  await step(
    "tenant-isolation-a",
    "Hotel A's owner sees no trace of Hotel B",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/guests`, { waitUntil: "networkidle0" });
      if ((await pageText(session)).includes(fixtures.hotelB)) throw new Error("Hotel A's guests page mentions Hotel B");
      await session.page.goto(`${BASE}/dashboard/staff`, { waitUntil: "networkidle0" });
      if ((await pageText(session)).includes(fixtures.ownerB.email)) throw new Error("Hotel A's staff page lists Hotel B's owner");
    })
  );

  await step(
    "invitation-sent",
    "Hotel A invites an existing account from the Staff page",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/staff`, { waitUntil: "networkidle0" });
      await clickText(session, "Add Staff Member");
      await fillSelector(session, 'input[placeholder="e.g. Samuel Mutiso"]', fixtures.ownerB.name);
      await fillSelector(session, 'input[placeholder="samuel@yourhotel.com"]', fixtures.ownerB.email);
      await selectField(session, "Hotel Role", "Manager");
      await clickInModal(session, "Add to Hotel");
      await waitForText(session, "pending", 20_000).catch(async () => {
        const text = await pageText(session);
        if (!/invitation|pending/i.test(text)) throw new Error(`No invitation indication after adding an existing account: ${text.replace(/\s+/g, " ").slice(0, 400)}`);
      });
      expectDb(
        `SELECT m.status FROM "HotelMembership" m JOIN "Hotel" h ON h.id = m."hotelId" JOIN "User" u ON u.id = m."userId" WHERE h.name = '${fixtures.hotelA}' AND u.email = '${fixtures.ownerB.email}'`,
        "SUSPENDED",
        "invited membership status"
      );
    })
  );

  await step(
    "invitation-not-yet-access",
    "the invitee is offered the invitation but not the workspace",
    using(ownerB, async (session) => {
      await session.page.goto(`${BASE}/select-hotel`, { waitUntil: "networkidle0" });
      await waitForText(session, "Pending invitations");
      const text = await pageText(session);
      const names = await workspaceNames(session);
      if (!names.includes(fixtures.hotelB)) throw new Error(`Hotel B is not offered to its own owner: ${names.join(" | ")}`);
      if (names.includes(fixtures.hotelA)) throw new Error("An unaccepted invitation already appears as a workspace");
      if (!text.includes(fixtures.hotelA)) throw new Error("The pending invitation does not name the inviting hotel");
    })
  );

  await step(
    "invitation-accepted",
    "the invitee accepts from /select-hotel",
    using(ownerB, async (session) => {
      const clicked = await session.page.evaluate(() => {
        const button = [...document.querySelectorAll("button")].find((element) => /accept/i.test(element.textContent || ""));
        if (!button) return false;
        button.click();
        return true;
      });
      if (!clicked) throw new Error("No Accept button in the pending-invitation block");
      await session.page.waitForFunction(
        () => !/pending invitations/i.test(document.body.innerText),
        { timeout: 25_000 },
      );
      await session.page.waitForFunction(
        (name) =>
          [...document.querySelectorAll("div.cursor-pointer")].some(
            (card) => (card.querySelector("h3")?.textContent || "").trim() === name
          ),
        { timeout: 25_000 },
        fixtures.hotelA
      );
      expectDb(
        `SELECT m.status FROM "HotelMembership" m JOIN "Hotel" h ON h.id = m."hotelId" JOIN "User" u ON u.id = m."userId" WHERE h.name = '${fixtures.hotelA}' AND u.email = '${fixtures.ownerB.email}'`,
        "ACTIVE",
        "accepted membership status"
      );
    })
  );

  await step(
    "hotel-switch",
    "the invitee switches into Hotel A and back to Hotel B",
    using(ownerB, async (session) => {
      await session.page.goto(`${BASE}/select-hotel`, { waitUntil: "networkidle0" });
      await waitForText(session, "Select Hotel Workspace");
      await enterWorkspace(session, fixtures.hotelA);
      await waitForUrl(session, "/dashboard");
      await waitForText(session, fixtures.hotelA);
      await session.page.goto(`${BASE}/select-hotel`, { waitUntil: "networkidle0" });
      await waitForText(session, "Select Hotel Workspace");
      await enterWorkspace(session, fixtures.hotelB);
      await waitForUrl(session, "/dashboard");
      await waitForText(session, fixtures.hotelB);
    })
  );

  const receptionist = await newSession("receptionist");
  await step(
    "role-sign-in",
    "the receptionist signs in and sees their hotel",
    using(receptionist, async (session) => {
      await login(session, fixtures.receptionist.email, fixtures.receptionist.password);
      await waitForText(session, fixtures.hotelA);
    })
  );

  await step(
    "role-navigation",
    "the receptionist's navigation hides administration pages",
    using(receptionist, async (session) => {
      const nav = await session.page.$$eval("a[href^='/dashboard']", (links) => links.map((link) => link.getAttribute("href")));
      if (nav.includes("/dashboard/staff")) throw new Error("Staff link is visible to a receptionist");
      if (nav.includes("/dashboard/subscription")) throw new Error("Subscription link is visible to a receptionist");
      if (!nav.includes("/dashboard/reservations")) throw new Error("Receptionist cannot reach reservations");
    })
  );

  await step(
    "role-direct-url-denied",
    "typing the admin URL directly is refused, not merely hidden",
    using(receptionist, async (session) => {
      await session.page.goto(`${BASE}/dashboard/staff`, { waitUntil: "networkidle0" });
      const text = await pageText(session);
      if (text.includes(fixtures.receptionist.email)) throw new Error("The staff list rendered for a receptionist");
      const refused =
        /not authoris|not authoriz|permission|denied|restricted|access/i.test(text) ||
        !session.page.url().includes("/dashboard/staff");
      if (!refused) throw new Error(`/dashboard/staff neither refused nor redirected: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
    })
  );

  await step(
    "reservation-create",
    "the owner books a guest into room 101 through the UI",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/reservations`, { waitUntil: "networkidle0" });
      await waitForText(session, fixtures.roomNumber, 25_000);
      // Reservations are created by clicking an empty cell in the room grid.
      const cells = await session.page.$$('[role="gridcell"]');
      const usable = [];
      for (const cell of cells) {
        const label = await cell.evaluate((element) => element.getAttribute("aria-label") || "");
        if (label.startsWith(`Room ${fixtures.roomNumber}`)) usable.push(cell);
      }
      if (usable.length === 0) throw new Error(`No grid cell for room ${fixtures.roomNumber}`);
      await usable[0].click();
      await waitForText(session, "New Reservation");
      await fillField(session, "Full Name", fixtures.guest.name);
      await fillField(session, "Phone", fixtures.guest.phone);
      const today = new Date();
      const tomorrow = new Date(today.getTime() + 86_400_000);
      await setDateField(session, "Check-in", today.toISOString().slice(0, 10));
      await setDateField(session, "Check-out", tomorrow.toISOString().slice(0, 10));
      await clickInModal(session, "Create Reservation");
      await waitForText(session, fixtures.guest.name, 25_000);
      expectDb(
        `SELECT count(*) FROM "Reservation" r JOIN "Hotel" h ON h.id = r."hotelId" JOIN "Guest" g ON g.id = r."guestId" WHERE h.name = '${fixtures.hotelA}' AND g.\"fullName\" = '${fixtures.guest.name}'`,
        "1",
        "reservation row"
      );
    })
  );

  await step(
    "check-in",
    "front desk checks the guest in and opens the folio",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/front-desk`, { waitUntil: "networkidle0" });
      await waitForText(session, fixtures.guest.name, 25_000);
      await clickText(session, "Check In", { exact: true });
      await waitForText(session, "Check In Guest");
      // Check in without collecting payment: the folio must then carry the balance.
      const amountInput = await session.page.$('div.fixed.inset-0 input[type="number"]');
      if (!amountInput) throw new Error("No amount field in the check-in dialog");
      await replaceValue(session, amountInput, "0");
      await clickInModal(session, "Confirm Check-in");
      // The folio opens automatically; with a balance it offers "Collect Payment",
      // once settled it offers "Complete Checkout".
      await waitForAnyText(session, ["Collect Payment", "Complete Checkout"]);
      expectDb(
        `SELECT r.status FROM "Reservation" r JOIN "Hotel" h ON h.id = r."hotelId" JOIN "Guest" g ON g.id = r."guestId" WHERE h.name = '${fixtures.hotelA}' AND g.\"fullName\" = '${fixtures.guest.name}'`,
        "CHECKED_IN",
        "reservation status after check-in"
      );
    })
  );

  await step(
    "folio-payment-checkout",
    "settle the folio and check the guest out",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/front-desk`, { waitUntil: "networkidle0" });
      await clickText(session, "View Folio", { exact: false });
      await session.page.waitForSelector('div.fixed.inset-0 input[placeholder^="Amount (KSh)"]', { timeout: 25_000 });
      const balanceText = await session.page.evaluate(() => {
        const match = document.body.innerText.match(/Balance[^\n]*\n\s*KSh\s*([\d,]+(?:\.\d+)?)/);
        return match ? match[1] : null;
      });
      if (balanceText) {
        await fillSelector(session, 'input[placeholder^="Amount (KSh)"]', balanceText.replace(/,/g, ""));
        await clickText(session, "Record Payment");
        await waitForText(session, "Payment recorded", 25_000);
      }
      await clickText(session, "Complete Checkout", { exact: false });
      await sleep(1200);
      const text = await pageText(session);
      if (/still due|outstanding balance/i.test(text)) throw new Error(`Check-out refused: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
      expectDb(
        `SELECT r.status FROM "Reservation" r JOIN "Hotel" h ON h.id = r."hotelId" JOIN "Guest" g ON g.id = r."guestId" WHERE h.name = '${fixtures.hotelA}' AND g.\"fullName\" = '${fixtures.guest.name}'`,
        "CHECKED_OUT",
        "reservation status after check-out"
      );
    })
  );

  await step(
    "housekeeping-task",
    "the checked-out room appears in housekeeping and can be moved along",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/housekeeping`, { waitUntil: "networkidle0" });
      await waitForText(session, fixtures.roomNumber, 25_000);
      await clickText(session, "Move to: Cleaning in Progress", { exact: false }).catch(async () => {
        const text = await pageText(session);
        if (!/Needs Cleaning|Cleaning in Progress/i.test(text)) throw new Error(`No housekeeping task for ${fixtures.roomNumber}`);
      });
      await sleep(500);
      await waitForText(session, fixtures.roomNumber);
    })
  );

  await step(
    "maintenance-ticket",
    "raise a maintenance ticket and see it under Open",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/maintenance`, { waitUntil: "networkidle0" });
      await clickText(session, "New Ticket");
      await fillSelector(session, 'input[placeholder^="e.g. Shower leaking"]', fixtures.ticket);
      await clickInModal(session, "Create Ticket");
      await waitForText(session, fixtures.ticket, 25_000);
      expectDb(
        `SELECT count(*) FROM "MaintenanceTicket" t JOIN "Hotel" h ON h.id = t."hotelId" WHERE h.name = '${fixtures.hotelA}' AND t.title = '${fixtures.ticket}'`,
        "1",
        "maintenance ticket row"
      );
    })
  );

  await step(
    "inventory-item",
    "add an inventory item and see its stock",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/inventory`, { waitUntil: "networkidle0" });
      await clickText(session, "Add Item");
      await fillSelector(session, 'input[placeholder="e.g. Maize Flour"]', fixtures.inventoryItem);
      await fillSelector(session, 'input[placeholder="e.g. Dry Goods"]', "Dry Goods");
      await clickInModal(session, "Add Item");
      await waitForText(session, fixtures.inventoryItem, 25_000);
      expectDb(
        `SELECT count(*) FROM "InventoryItem" i JOIN "Hotel" h ON h.id = i."hotelId" WHERE h.name = '${fixtures.hotelA}' AND i.name = '${fixtures.inventoryItem}'`,
        "1",
        "inventory row"
      );
    })
  );

  await step(
    "pos-sale",
    "add a menu item and take a counter payment in the restaurant POS",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/restaurant`, { waitUntil: "networkidle0" });
      await clickText(session, "Manage Menu");

      // A new hotel may have no menu category yet, and the item form is tied to
      // one; add the category through the same dialog first.
      const categoryCount = await session.page.$$eval("div.fixed.inset-0 select option", (options) => options.length);
      if (categoryCount === 0) {
        await fillSelector(session, 'input[placeholder="e.g. Desserts"]', fixtures.menuCategory);
        await clickInModal(session, "Add Category");
        await session.page.waitForFunction(
          (name) =>
            [...document.querySelectorAll("div.fixed.inset-0 select option")].some((option) =>
              (option.textContent || "").includes(name)
            ),
          { timeout: 20_000 },
          fixtures.menuCategory
        );
      }

      await fillSelector(session, 'input[placeholder="Item name"]', fixtures.menuItem);
      await fillSelector(session, 'input[placeholder^="Price"]', "250");
      await clickInModal(session, "Add Item");
      await sleep(600);
      await closeModal(session);
      await sleep(500);

      // The item lands in the category that was selected in the dialog.
      if (categoryCount === 0) await clickText(session, fixtures.menuCategory, { exact: false }).catch(() => {});
      await clickText(session, fixtures.menuItem, { exact: false });
      await fillSelector(session, 'input[placeholder="e.g. 4"]', "4");
      await clickText(session, "Pay Now");
      await clickText(session, "Take Payment", { exact: false });
      await sleep(2000);
      const text = await pageText(session);
      if (/error|failed|could not/i.test(text) && !/0 error/i.test(text)) {
        // Only fail when a visible error banner is present.
        if (/text-danger/.test(await session.page.content())) {
          throw new Error(`POS payment reported an error: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
        }
      }
      const payments = dbQuery(
        `SELECT count(*) FROM "Payment" p JOIN "Hotel" h ON h.id = p."hotelId" WHERE h.name = '${fixtures.hotelA}' AND p.amount = 250`
      );
      if (payments !== null && Number(payments) < 1) throw new Error("No 250-unit POS payment row in the database");
    })
  );

  await step(
    "reservation-create-future",
    "a second, future-dated booking is created for the cancellation test",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/reservations`, { waitUntil: "networkidle0" });
      await waitForText(session, fixtures.roomNumber, 25_000);
      // Next week: the current week is already occupied by today's booking, and
      // the calendar only renders one week at a time.
      await session.page.click('button[aria-label="Next week"]');
      await sleep(1200);
      const cells = await session.page.$$('[role="gridcell"]');
      const usable = [];
      for (const cell of cells) {
        const label = await cell.evaluate((element) => element.getAttribute("aria-label") || "");
        if (label.startsWith(`Room ${fixtures.roomNumber}`)) usable.push(cell);
      }
      if (usable.length === 0) throw new Error(`No grid cell for room ${fixtures.roomNumber} next week`);
      await usable[0].click();
      await waitForText(session, "New Reservation");
      await fillField(session, "Full Name", fixtures.futureGuest.name);
      await fillField(session, "Phone", fixtures.futureGuest.phone);
      await clickInModal(session, "Create Reservation");
      await waitForText(session, fixtures.futureGuest.name, 25_000);
    })
  );

  await step(
    "reservation-cancel",
    "cancelling a reservation releases the room and records the cancellation",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/reservations`, { waitUntil: "networkidle0" });
      await session.page.click('button[aria-label="Next week"]');
      await sleep(1200);
      await waitForText(session, fixtures.futureGuest.name, 25_000);

      // A pending/confirmed booking is cancelled by clicking its bar in the grid,
      // and the app asks for confirmation first.
      session.page.once("dialog", (dialog) => void dialog.accept());
      const clicked = await session.page.evaluate((guest) => {
        const bars = [...document.querySelectorAll("div[title]")];
        const bar = bars.find(
          (candidate) =>
            (candidate.textContent || "").trim() === guest && /click to cancel/i.test(candidate.getAttribute("title") || "")
        );
        if (!bar) return false;
        bar.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        return true;
      }, fixtures.futureGuest.name);
      if (!clicked) throw new Error(`No cancellable booking bar for ${fixtures.futureGuest.name}`);
      await sleep(2000);
      expectDb(
        `SELECT r.status FROM "Reservation" r JOIN "Guest" g ON g.id = r."guestId" WHERE g."fullName" = '${fixtures.futureGuest.name}'`,
        "CANCELLED",
        "reservation status after cancel"
      );
      // The cancelled stay must not keep the room blocked for those dates.
      expectDb(
        `SELECT count(*) FROM "ReservationRoom" rr
         JOIN "Reservation" r ON r.id = rr."reservationId"
         JOIN "Guest" g ON g.id = r."guestId"
         WHERE g."fullName" = '${fixtures.futureGuest.name}' AND r.status IN ('PENDING','CONFIRMED','CHECKED_IN')`,
        "0",
        "active room allocations after cancel"
      );
    })
  );

  await step(
    "inventory-recipe",
    "creating a recipe from stock links the menu item to its ingredients",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/inventory`, { waitUntil: "networkidle0" });
      await clickText(session, "Recipes");
      await clickText(session, "Create Recipe");
      await session.page.waitForSelector("div.fixed.inset-0 select", { timeout: 15_000 });

      // The menu list is fetched when the dialog opens, so wait for it before
      // choosing an item; selecting from an empty list submits nothing.
      await session.page.waitForFunction(
        () => {
          const select = document.querySelector("div.fixed.inset-0 select");
          return !!select && [...select.options].some((option) => option.value);
        },
        { timeout: 20_000 }
      );
      await session.page.select("div.fixed.inset-0 select", (
        await session.page.$$eval("div.fixed.inset-0 select option", (options) =>
          options.find((option) => option.value)?.value ?? ""
        )
      ));
      await session.page.waitForFunction(
        () => {
          const selects = [...document.querySelectorAll("div.fixed.inset-0 select")];
          return selects.length > 1;
        },
        { timeout: 10_000 }
      );
      const selects = await session.page.$$("div.fixed.inset-0 select");
      const ingredientSelect = selects[selects.length - 1];
      const ingredientValue = await ingredientSelect.evaluate((select) =>
        [...select.options].find((option) => option.value)?.value ?? ""
      );
      await ingredientSelect.select(ingredientValue);
      await session.page.evaluate(() => {
        const input = [...document.querySelectorAll("div.fixed.inset-0 input[type=number]")].find(
          (element) => element.getAttribute("step") === "0.01"
        );
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
          setter.call(input, "150");
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      });
      await sleep(300);
      await clickInModal(session, "Create Recipe");
      await sleep(1500);
      expectDb(
        `SELECT count(*) FROM "Recipe" r JOIN "Hotel" h ON h.id = r."hotelId" WHERE h.name = '${fixtures.hotelA}'`,
        "1",
        "recipe row"
      );
      expectDb(
        `SELECT count(*) FROM "RecipeIngredient" ri JOIN "Hotel" h ON h.id = ri."hotelId" WHERE h.name = '${fixtures.hotelA}'`,
        "1",
        "recipe ingredient row"
      );
    })
  );

  await step(
    "staff-suspend-and-reactivate",
    "suspending a staff member and reactivating them persists",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/staff`, { waitUntil: "networkidle0" });
      await waitForText(session, fixtures.receptionist.name);

      // The status pill is a button only for editable members; click the one in
      // the receptionist's row, not the first row on the page.
      const suspended = await session.page.evaluate((name) => {
        const rows = [...document.querySelectorAll("tr")];
        const row = rows.find((candidate) => (candidate.textContent || "").includes(name));
        const button = row?.querySelector("button");
        if (!button) return false;
        if (!/active/i.test(button.textContent || "")) return false;
        button.click();
        return true;
      }, fixtures.receptionist.name);
      if (!suspended) throw new Error("Could not find the suspend control for the receptionist");

      await session.page.waitForFunction(
        (name) => {
          const rows = [...document.querySelectorAll("tr")];
          const row = rows.find((candidate) => (candidate.textContent || "").includes(name));
          return !!row && /suspended/i.test(row.textContent || "");
        },
        { timeout: 20_000 },
        fixtures.receptionist.name
      );
      expectDb(
        `SELECT m.status FROM "HotelMembership" m JOIN "User" u ON u.id = m."userId" JOIN "Hotel" h ON h.id = m."hotelId"
         WHERE h.name = '${fixtures.hotelA}' AND u.email = '${fixtures.receptionist.email}'`,
        "SUSPENDED",
        "membership status after suspend"
      );

      await session.page.evaluate((name) => {
        const rows = [...document.querySelectorAll("tr")];
        const row = rows.find((candidate) => (candidate.textContent || "").includes(name));
        row?.querySelector("button")?.click();
      }, fixtures.receptionist.name);
      await session.page.waitForFunction(
        (name) => {
          const rows = [...document.querySelectorAll("tr")];
          const row = rows.find((candidate) => (candidate.textContent || "").includes(name));
          return !!row && /active/i.test(row.textContent || "") && !/suspended/i.test(row.textContent || "");
        },
        { timeout: 20_000 },
        fixtures.receptionist.name
      );
      expectDb(
        `SELECT m.status FROM "HotelMembership" m JOIN "User" u ON u.id = m."userId" JOIN "Hotel" h ON h.id = m."hotelId"
         WHERE h.name = '${fixtures.hotelA}' AND u.email = '${fixtures.receptionist.email}'`,
        "ACTIVE",
        "membership status after reactivate"
      );
    })
  );

  await step(
    "notifications-bell",
    "raising a maintenance ticket raises a notification the owner can read and dismiss",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
      // The maintenance step above ran as this owner, so a MAINTENANCE
      // notification exists by now.
      await session.page.waitForSelector('[data-testid="notification-badge"]', { timeout: 20_000 });
      await session.page.click('[title="Notifications"]');
      await waitForText(session, "Notifications");
      await waitForText(session, fixtures.ticket, 20_000);
      await clickText(session, "Mark all read", { exact: false });
      await session.page.waitForFunction(
        () => !document.querySelector('[data-testid="notification-badge"]'),
        { timeout: 20_000 }
      );
      expectDb(
        `SELECT count(*) FROM "Notification" n JOIN "Hotel" h ON h.id = n."hotelId"
         WHERE h.name = '${fixtures.hotelA}' AND n."isRead" = false`,
        "0",
        "unread notifications after marking all read"
      );
    })
  );

  await step(
    "audit-trail",
    "the owner's audit trail shows the payment and check-out recorded earlier",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/audit`, { waitUntil: "networkidle0" });
      await waitForText(session, "Audit trail");
      await waitForAnyText(
        session,
        ["Payment recorded", "Guest checked out", "Checked out with a balance"],
        25_000
      );
      const rows = await session.page.$$eval("tbody tr", (trs) => trs.length);
      if (rows < 1) throw new Error("Audit trail rendered no rows after a payment");
    })
  );

  await step(
    "inventory-purchase-and-movement",
    "recording a purchase raises the stock and writes a stock movement",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/inventory`, { waitUntil: "networkidle0" });
      await clickText(session, "Purchases");
      await clickText(session, "Record Purchase");
      await session.page.waitForSelector("div.fixed.inset-0 select", { timeout: 15_000 });
      await session.page.select("div.fixed.inset-0 select", (
        await session.page.$$eval("div.fixed.inset-0 select option", (options) =>
          options.find((option) => (option.textContent || "").includes("Maize"))?.value ?? options[2]?.value
        )
      ));
      await fillField(session, "Supplier", "Nakuru Millers");
      await fillField(session, "Quantity", "25");
      await fillField(session, "Unit Cost (KSh)", "70");
      await clickInModal(session, "Record Purchase");
      await sleep(1500);
      expectDb(
        `SELECT count(*) FROM "Purchase" p JOIN "Hotel" h ON h.id = p."hotelId" WHERE h.name = '${fixtures.hotelA}'`,
        "1",
        "purchase row"
      );
      await clickText(session, "Stock Movements");
      await waitForText(session, "PURCHASE", 20_000);
    })
  );

  await step(
    "inventory-wastage",
    "logging wastage reduces stock, records the reason and writes a movement",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/inventory`, { waitUntil: "networkidle0" });
      await clickText(session, "Wastage");
      await clickText(session, "Record Wastage");
      await session.page.waitForSelector("div.fixed.inset-0 select", { timeout: 15_000 });

      // Item select.
      await session.page.select("div.fixed.inset-0 select", (
        await session.page.$$eval("div.fixed.inset-0 select option", (options) =>
          options.find((option) => (option.textContent || "").includes("Maize"))?.value ?? options[2]?.value
        )
      ));
      await fillField(session, "Quantity", "2");

      // "Person accountable" is required and is populated from the staff list.
      // Wait for that list, then drive the select through Puppeteer so React's
      // onChange runs exactly as it would for a real click.
      await session.page.waitForFunction(
        () => {
          const selects = [...document.querySelectorAll("div.fixed.inset-0 select")];
          const accountable = selects.find((select) =>
            [...select.options].some((option) => /Select staff member/.test(option.textContent || ""))
          );
          return !!accountable && [...accountable.options].some((option) => option.value);
        },
        { timeout: 20_000 }
      );
      const modalSelects = await session.page.$$("div.fixed.inset-0 select");
      const accountableSelect = modalSelects[modalSelects.length - 1];
      const accountableValue = await accountableSelect.evaluate((select) =>
        [...select.options].find((option) => option.value)?.value ?? ""
      );
      await accountableSelect.select(accountableValue);
      await sleep(400);
      await clickInModal(session, "Record Wastage");
      await sleep(1500);
      expectDb(
        `SELECT count(*) FROM "Wastage" w JOIN "Hotel" h ON h.id = w."hotelId" WHERE h.name = '${fixtures.hotelA}'`,
        "1",
        "wastage row"
      );
      expectDb(
        `SELECT count(*) FROM "StockMovement" m JOIN "Hotel" h ON h.id = m."hotelId"
         WHERE h.name = '${fixtures.hotelA}' AND m.type = 'WASTAGE'`,
        "1",
        "wastage stock movement"
      );
    })
  );

  await step(
    "reports-render",
    "the reports page renders revenue and collection panels",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/reports`, { waitUntil: "networkidle0" });
      await waitForText(session, "Billed Revenue Mix");
      await waitForText(session, "Cash Collected by Method");
      await waitForText(session, "Download Excel");
      const numbers = await session.page.evaluate(() => document.body.innerText.match(/KSh\s?[\d,]+/g) ?? []);
      if (numbers.length === 0) throw new Error("Reports page shows no currency values");
    })
  );

  await step(
    "subscription-render",
    "the subscription page shows the plan band and its limits",
    using(ownerA, async (session) => {
      await session.page.goto(`${BASE}/dashboard/subscription`, { waitUntil: "networkidle0" });
      await waitForText(session, "Subscription");
      await waitForText(session, "Monthly");
      const text = await pageText(session);
      if (!/band|room/i.test(text)) throw new Error(`Subscription page shows no plan information: ${text.replace(/\s+/g, " ").slice(0, 300)}`);
    })
  );

  await step(
    "tenant-isolation-b",
    "the second owner's workspace shows its own data only",
    using(ownerB, async (session) => {
      await session.page.goto(`${BASE}/dashboard/guests`, { waitUntil: "networkidle0" });
      const text = await pageText(session);
      if (text.includes(fixtures.guest.name)) throw new Error("Hotel B can see Hotel A's guest");
    })
  );

  await step(
    "sign-out",
    "signing out ends the session and protects the dashboard",
    using(ownerA, async (session) => {
      const status = await session.page.evaluate(async () => {
        const csrf = await fetch("/api/auth/csrf").then((response) => response.json());
        const body = new URLSearchParams({ csrfToken: csrf.csrfToken, callbackUrl: "/login", json: "true" });
        return (await fetch("/api/auth/signout", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } })).status;
      });
      if (status !== 200) throw new Error(`sign-out returned ${status}`);
      await session.page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle0" });
      await session.page.waitForFunction(() => location.pathname.startsWith("/login") || /sign in/i.test(document.body.innerText), { timeout: 20_000 });
    })
  );

  for (const instance of launched) await instance.close().catch(() => {});
  launched.length = 0;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
function finish() {
  const passed = results.filter((entry) => entry.status === "PASS").length;
  const failed = results.length - passed;
  const document = {
    target: BASE,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    browser: browserVersion,
    databaseAssertions: process.env.DATABASE_URL ? "enabled (psql)" : "disabled (no DATABASE_URL)",
    fixtures,
    totals: { steps: results.length, passed, failed },
    screenshots,
    steps: results,
  };
  if (JSON_OUT) writeFileSync(resolve(ROOT, JSON_OUT), JSON.stringify(document, null, 2));

  log("");
  if (failed) {
    log(color(31, `Result: FAIL — ${passed}/${results.length} browser steps passed`));
    for (const entry of results.filter((item) => item.status === "FAIL")) log(`  ${entry.id}: ${entry.error}`);
    process.exitCode = 1;
  } else {
    log(color(32, `Result: PASS — ${passed}/${results.length} browser steps passed`));
  }
  log(`Screenshots: ${OUT}`);
}

run()
  .then(finish)
  .catch(async (error) => {
    log(color(31, `Harness error: ${error.message}`));
    for (const instance of launched) await instance.close().catch(() => {});
    finish();
    process.exitCode = 1;
  });
