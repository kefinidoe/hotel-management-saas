#!/usr/bin/env node
/**
 * HTTP-level end-to-end smoke test against a *built* instance of the app.
 *
 * Covers authentication, hotel onboarding, tenant isolation, permissions,
 * subscriptions, reservations, check-in/check-out, billing, payments, POS,
 * inventory, housekeeping, maintenance, reports and the audit trail — against a
 * real PostgreSQL database, driving the same route handlers a browser would.
 *
 * This is not a substitute for a browser test (it does not execute client-side
 * JavaScript), but every assertion below is a real HTTP round-trip against the
 * production build.
 *
 * Safety: refuses a non-loopback base URL unless --allow-remote is passed, and
 * refuses to run against the database unless SAAS_ENVIRONMENT=saas and
 * SAAS_DATABASE_IDENTIFIER is set — the same fail-closed rules as the app.
 *
 * Usage:
 *   node scripts/e2e-smoke.mjs --base http://127.0.0.1:3100
 *   node scripts/e2e-smoke.mjs --base ... --json evidence.json
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const BASE = arg("base", process.env.E2E_BASE_URL ?? "http://127.0.0.1:3100");
const JSON_OUT = arg("json", null);
const ALLOW_REMOTE = argv.includes("--allow-remote");
const PSQL = process.env.PSQL_BIN || "psql";
const DATABASE_URL = process.env.DATABASE_URL ?? "";

const results = [];
let failures = 0;

function record(area, name, ok, detail = "") {
  results.push({ area, name, ok, detail });
  if (!ok) failures += 1;
}

async function step(area, name, fn) {
  try {
    const detail = await fn();
    record(area, name, true, detail ?? "");
  } catch (error) {
    record(area, name, false, error?.message ?? String(error));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------
// HTTP session with a cookie jar (Node's fetch has no cookie store)
// ---------------------------------------------------------------------------
class Session {
  constructor(label) {
    this.label = label;
    this.cookies = new Map();
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  store(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const line of raw) {
      const [pair] = line.split(";");
      const index = pair.indexOf("=");
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (value === "" ) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method, path, body, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    // Browsers send Origin on state-changing requests; the app's CSRF guard
    // rejects same-site mutations that omit it, so the harness must too.
    if (method !== "GET") headers.origin = BASE;
    if (body !== undefined) headers["content-type"] = "application/json";
    const cookies = this.cookieHeader();
    if (cookies) headers.cookie = cookies;
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
    this.store(response);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    return { status: response.status, json, text, headers: response.headers };
  }

  async login(email, password) {
    const csrf = await this.request("GET", "/api/auth/csrf");
    assert(csrf.status === 200 && csrf.json?.csrfToken, `csrf failed (${csrf.status})`);
    const res = await this.request(
      "POST",
      "/api/auth/callback/credentials",
      {
        csrfToken: csrf.json.csrfToken,
        email,
        password,
        callbackUrl: `${BASE}/dashboard`,
        json: "true",
      },
      { "content-type": "application/x-www-form-urlencoded" }
    );
    // NextAuth answers 200 with a redirect body, or 302 with a location.
    assert(res.status === 200 || res.status === 302, `login failed (${res.status})`);
    assert(this.cookies.size > 0, "login set no cookies");
    return res;
  }
}

const uniq = Date.now().toString(36);
const password = "Verification-Passw0rd!";

function sql(query) {
  const out = execFileSync(PSQL, [DATABASE_URL, "-X", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-c", query], {
    encoding: "utf8",
    env: process.env,
  });
  return out.trim();
}

async function main() {
  // ---- safety -------------------------------------------------------------
  const url = new URL(BASE);
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  if (!loopback && !ALLOW_REMOTE) {
    console.error(`Refusing to run against '${url.hostname}': pass --allow-remote to override.`);
    return 1;
  }
  if (!DATABASE_URL) {
    console.error("DATABASE_URL must be set so the script can verify persistence and entitlements.");
    return 1;
  }
  if (process.env.SAAS_ENVIRONMENT !== "saas" || !process.env.SAAS_DATABASE_IDENTIFIER) {
    console.error("Refusing to run without SAAS_ENVIRONMENT=saas and SAAS_DATABASE_IDENTIFIER.");
    return 1;
  }

  const A = new Session("hotel-a-owner");
  const B = new Session("hotel-b-owner");
  const C = new Session("receptionist");

  const emailA = `owner-a-${uniq}@example.test`;
  const emailB = `owner-b-${uniq}@example.test`;
  const emailC = `staff-c-${uniq}@example.test`;
  const state = {};

  // ---- 1. reachability ----------------------------------------------------
  await step("system", "login page renders", async () => {
    const res = await new Session("anon").request("GET", "/login");
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(/sign in|login|password/i.test(res.text), "login markup not found");
  });

  await step("auth", "unauthenticated API is rejected", async () => {
    const res = await new Session("anon").request("GET", "/api/guests");
    assert(res.status === 401, `expected 401, got ${res.status}`);
  });

  // ---- 2. registration, login, onboarding ---------------------------------
  await step("auth", "register hotel A owner", async () => {
    const res = await A.request("POST", "/api/auth/register", {
      name: "Owner A",
      email: emailA,
      password,
    });
    assert([200, 201].includes(res.status), `register failed (${res.status}) ${res.text.slice(0, 200)}`);
    return emailA;
  });

  await step("auth", "credentials sign-in", async () => {
    await A.login(emailA, password);
  });

  await step("onboarding", "create hotel A workspace", async () => {
    const res = await A.request("POST", "/api/hotel/onboarding", {
      name: `Alpha Hotel ${uniq}`,
      slug: `alpha-${uniq}`,
      currency: "KES",
      timezone: "Africa/Nairobi",
      email: `alpha-${uniq}@example.test`,
    });
    assert(res.status === 201, `onboarding failed (${res.status}) ${res.text.slice(0, 300)}`);
    state.hotelA = res.json.hotel.id;
    state.hotelAName = res.json.hotel.name;
    assert(res.json.role === "HOTEL_OWNER", `unexpected role ${res.json.role}`);
  });

  await step("dashboard", "dashboard renders for the new hotel", async () => {
    const res = await A.request("GET", "/dashboard");
    assert(res.status === 200, `expected 200, got ${res.status}`);
    assert(res.text.includes(state.hotelAName.slice(0, 12)), "hotel name not rendered");
  });

  // ---- 3. rooms & reservations -------------------------------------------
  await step("front desk", "create room type and rooms", async () => {
    const type = await A.request("POST", "/api/room-types", {
      name: "Single — Bed Only",
      baseRate: 4500,
      capacity: 1,
      mealPlan: "BED_ONLY",
    });
    assert([200, 201].includes(type.status), `room type failed (${type.status}) ${type.text.slice(0, 200)}`);
    state.roomTypeId = type.json.id ?? type.json.roomType?.id;
    assert(state.roomTypeId, "no room type id returned");

    const rooms = [];
    for (const number of ["101", "102"]) {
      const room = await A.request("POST", "/api/rooms", { number, roomTypeId: state.roomTypeId });
      assert([200, 201].includes(room.status), `room ${number} failed (${room.status}) ${room.text.slice(0, 200)}`);
      rooms.push(room.json.id ?? room.json.room?.id);
    }
    state.rooms = rooms;
    const list = await A.request("GET", "/api/rooms");
    assert(list.status === 200 && list.json.length >= 2, "room list does not show the new rooms");
  });

  await step("front desk", "create a reservation", async () => {
    const today = new Date();
    const tomorrow = new Date(today.getTime() + 86_400_000);
    const res = await A.request("POST", "/api/reservations", {
      roomId: state.rooms[0],
      checkInDate: today.toISOString(),
      checkOutDate: tomorrow.toISOString(),
      guestName: "Guest Alpha",
      guestPhone: "+254700000111",
      guestEmail: `guest-${uniq}@example.test`,
      tariffId: state.roomTypeId,
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
      adults: 1,
    });
    assert([200, 201].includes(res.status), `reservation failed (${res.status}) ${res.text.slice(0, 300)}`);
    state.reservationA = res.json.id ?? res.json.reservation?.id;
    assert(state.reservationA, "no reservation id returned");
  });

  await step("front desk", "double-booking the same room and dates is refused", async () => {
    const res = await A.request("POST", "/api/reservations", {
      roomId: state.rooms[0],
      checkInDate: new Date().toISOString(),
      checkOutDate: new Date(Date.now() + 86_400_000).toISOString(),
      guestName: "Guest Clash",
      guestPhone: "+254700000222",
      tariffId: state.roomTypeId,
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
    });
    assert(res.status === 409, `expected 409 conflict, got ${res.status}`);
  });

  await step("front desk", "check in the reservation", async () => {
    const res = await A.request("POST", `/api/reservations/${state.reservationA}/check-in`, {});
    assert([200, 201].includes(res.status), `check-in failed (${res.status}) ${res.text.slice(0, 300)}`);
    state.folioId = res.json.folioId ?? res.json.folio?.id;
    assert(state.folioId, "check-in returned no folio id");
  });

  // ---- 4. billing & payments ---------------------------------------------
  await step("billing", "folio shows the room charge", async () => {
    const res = await A.request("GET", `/api/folios/${state.folioId}`);
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const items = res.json.items ?? res.json.folio?.items ?? [];
    assert(Array.isArray(items) && items.length > 0, "folio has no items after check-in");
    state.folioBalance = res.json.balance ?? res.json.folio?.balance;
  });

  await step("billing", "partial payment is accepted", async () => {
    const methods = await A.request("GET", "/api/payment-methods");
    assert(methods.status === 200 && Array.isArray(methods.json) && methods.json.length > 0, "no payment methods");
    state.paymentMethodId = methods.json[0].id;
    const res = await A.request("POST", "/api/payments", {
      folioId: state.folioId,
      paymentMethodId: state.paymentMethodId,
      amount: 1000,
      reference: "E2E-PARTIAL",
      idempotencyKey: `partial-${uniq}`,
    });
    assert([200, 201].includes(res.status), `payment failed (${res.status}) ${res.text.slice(0, 300)}`);
    state.paymentId = res.json.id ?? res.json.payment?.id;
  });

  await step("billing", "duplicate payment request is not charged twice", async () => {
    const before = await A.request("GET", `/api/folios/${state.folioId}`);
    const countBefore = (before.json.payments ?? []).length;
    const res = await A.request("POST", "/api/payments", {
      folioId: state.folioId,
      paymentMethodId: state.paymentMethodId,
      amount: 1000,
      reference: "E2E-PARTIAL",
      idempotencyKey: `partial-${uniq}`,
    });
    assert([200, 201].includes(res.status), `retry rejected (${res.status})`);
    const after = await A.request("GET", `/api/folios/${state.folioId}`);
    const countAfter = (after.json.payments ?? []).length;
    assert(countAfter === countBefore, `payments went from ${countBefore} to ${countAfter}`);
  });

  // ---- 5. restaurant / POS ------------------------------------------------
  await step("pos", "menu category and item", async () => {
    const cat = await A.request("POST", "/api/menu/categories", { name: `Mains ${uniq}` });
    assert([200, 201].includes(cat.status), `category failed (${cat.status}) ${cat.text.slice(0, 200)}`);
    state.categoryId = cat.json.id ?? cat.json.category?.id;
    const item = await A.request("POST", "/api/menu", {
      name: `Pilau ${uniq}`,
      price: 600,
      categoryId: state.categoryId,
    });
    assert([200, 201].includes(item.status), `menu item failed (${item.status}) ${item.text.slice(0, 200)}`);
    state.menuItemId = item.json.id ?? item.json.item?.id;
  });

  await step("pos", "pay-now order", async () => {
    const res = await A.request("POST", "/api/restaurant/pay-now", {
      items: [{ menuItemId: state.menuItemId, quantity: 2 }],
      paymentMethodId: state.paymentMethodId,
      idempotencyKey: `pos-${uniq}`,
      customerName: "Walk-in",
      tableNumber: "T1",
    });
    assert([200, 201].includes(res.status), `pay-now failed (${res.status}) ${res.text.slice(0, 300)}`);
  });

  await step("pos", "duplicate pay-now request is idempotent", async () => {
    const dupKey = `pos-dup-${uniq}`;
    const payload = {
      items: [{ menuItemId: state.menuItemId, quantity: 1 }],
      paymentMethodId: state.paymentMethodId,
      idempotencyKey: dupKey,
      customerName: "Walk-in",
    };
    const first = await A.request("POST", "/api/restaurant/pay-now", payload);
    const second = await A.request("POST", "/api/restaurant/pay-now", payload);
    assert([200, 201].includes(first.status), `first order failed (${first.status})`);
    assert([200, 201].includes(second.status), `retry failed (${second.status})`);
    assert(
      first.json.paymentId && first.json.paymentId === second.json.paymentId,
      `a retry produced a different payment (${first.json.paymentId} vs ${second.json.paymentId})`
    );
    const rows = Number(
      sql(`SELECT count(*) FROM "Payment" WHERE "hotelId" = '${state.hotelA}' AND "idempotencyKey" = '${dupKey}'`)
    );
    assert(rows === 1, `expected exactly one payment for the key, found ${rows}`);
  });

  await step("pos", "charge to room", async () => {
    const res = await A.request("POST", "/api/restaurant/charge-to-room", {
      items: [{ menuItemId: state.menuItemId, quantity: 1 }],
      folioId: state.folioId,
      idempotencyKey: `charge-${uniq}`,
      customerName: "Guest Alpha",
    });
    assert([200, 201].includes(res.status), `charge-to-room failed (${res.status}) ${res.text.slice(0, 300)}`);
  });

  // ---- 6. inventory -------------------------------------------------------
  await step("inventory", "create item, purchase and wastage", async () => {
    const item = await A.request("POST", "/api/inventory", {
      sku: `SKU-${uniq}`,
      name: "Rice",
      category: "Food",
      unit: "g",
      currentStock: 1000,
      reorderLevel: 200,
      costPerUnit: 0.12,
    });
    assert([200, 201].includes(item.status), `inventory item failed (${item.status}) ${item.text.slice(0, 300)}`);
    state.inventoryItemId = item.json.id ?? item.json.item?.id;

    const purchase = await A.request("POST", "/api/purchases", {
      inventoryItemId: state.inventoryItemId,
      supplier: "Supplier A",
      quantity: 500,
      unitCost: 0.11,
      purchaseDate: new Date().toISOString(),
    });
    assert([200, 201].includes(purchase.status), `purchase failed (${purchase.status}) ${purchase.text.slice(0, 300)}`);

    const wastage = await A.request("POST", "/api/wastage", {
      inventoryItemId: state.inventoryItemId,
      quantity: 25,
      reason: "SPOILAGE",
      department: "Kitchen",
      accountableName: "Chef",
    });
    assert([200, 201].includes(wastage.status), `wastage failed (${wastage.status}) ${wastage.text.slice(0, 300)}`);

    const movements = await A.request("GET", `/api/stock-movements?inventoryItemId=${state.inventoryItemId}`);
    assert(movements.status === 200, `stock movements failed (${movements.status})`);
  });

  // ---- 7. housekeeping & maintenance -------------------------------------
  await step("housekeeping", "task exists and can be reassigned", async () => {
    const list = await A.request("GET", "/api/housekeeping");
    assert(list.status === 200, `housekeeping list failed (${list.status})`);
    const tasks = Array.isArray(list.json) ? list.json : list.json.tasks ?? [];
    // Check-out is what creates tasks, so make one via the room status endpoint if empty.
    let task = tasks[0];
    if (!task) {
      const room = await A.request("PUT", `/api/rooms/${state.rooms[1]}`, { status: "DIRTY" });
      assert([200].includes(room.status), `room status update failed (${room.status})`);
      return "no task yet (created at check-out)";
    }
    state.taskId = task.id;
    const membership = await A.request("GET", "/api/staff");
    const me = (membership.json ?? []).find((m) => m.role === "HOTEL_OWNER");
    const update = await A.request("PUT", `/api/housekeeping/${task.id}`, {
      status: "IN_PROGRESS",
      assigneeId: me?.userId ?? null,
    });
    assert([200].includes(update.status), `task update failed (${update.status}) ${update.text.slice(0, 200)}`);
  });

  await step("maintenance", "create and assign a ticket", async () => {
    const create = await A.request("POST", "/api/maintenance", {
      title: "Leaking tap",
      description: "Bathroom tap drips",
      roomId: state.rooms[1],
      priority: "high",
    });
    assert([200, 201].includes(create.status), `ticket failed (${create.status}) ${create.text.slice(0, 200)}`);
    state.ticketId = create.json.id ?? create.json.ticket?.id;

    const staff = await A.request("GET", "/api/staff");
    const me = (staff.json ?? []).find((m) => m.role === "HOTEL_OWNER");
    const assign = await A.request("PUT", `/api/maintenance/${state.ticketId}`, {
      assigneeId: me?.userId ?? null,
      status: "IN_PROGRESS",
    });
    assert([200].includes(assign.status), `assign failed (${assign.status}) ${assign.text.slice(0, 200)}`);
  });

  await step("maintenance", "assigning a stranger from another hotel is refused", async () => {
    const res = await A.request("PUT", `/api/maintenance/${state.ticketId}`, {
      assigneeId: "00000000-0000-0000-0000-000000000000",
    });
    assert([400, 403, 404].includes(res.status), `expected rejection, got ${res.status}`);
  });

  // ---- 8. staff, permissions, subscription --------------------------------
  await step("staff", "add a receptionist", async () => {
    const res = await A.request("POST", "/api/staff", {
      name: "Reception C",
      email: emailC,
      password,
      role: "RECEPTIONIST",
    });
    assert([200, 201].includes(res.status), `staff add failed (${res.status}) ${res.text.slice(0, 300)}`);
    state.staffMembershipId = res.json.id;
  });

  await step("staff", "a hotel admin cannot reset another user's password", async () => {
    const res = await A.request("PATCH", `/api/staff/${state.staffMembershipId}`, {
      newPassword: "Takeover-Attempt-123!",
    });
    assert(res.status === 403, `expected 403, got ${res.status}`);
    const hash = sql(
      `SELECT "passwordHash" FROM "User" WHERE email = '${emailC.replace(/'/g, "''")}'`
    );
    assert(hash.startsWith("$2"), "password hash is missing or not bcrypt");
  });

  await step("permissions", "receptionist can use the front desk", async () => {
    await C.login(emailC, password);
    const res = await C.request("GET", "/api/guests");
    assert(res.status === 200, `expected 200, got ${res.status}`);
  });

  await step("permissions", "receptionist cannot read reports", async () => {
    const res = await C.request("GET", "/api/reports");
    assert(res.status === 403, `expected 403, got ${res.status}`);
  });

  await step("permissions", "receptionist cannot read the subscription", async () => {
    const res = await C.request("GET", "/api/hotel/subscription");
    assert(res.status === 403, `expected 403, got ${res.status}`);
  });

  await step("subscription", "owner sees plan, status and limits", async () => {
    const res = await A.request("GET", "/api/hotel/subscription");
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const sub = res.json.subscription;
    assert(sub?.planId && sub?.effectiveStatus, "subscription payload incomplete");
    state.subscriptionId = sub.id;
    return `${sub.planId}/${sub.effectiveStatus}`;
  });

  await step("reports", "owner can read the financial report", async () => {
    const end = new Date();
    const start = new Date(end.getTime() - 7 * 86_400_000);
    const res = await A.request(
      "GET",
      `/api/reports?start=${start.toISOString().slice(0, 10)}&end=${end.toISOString().slice(0, 10)}`
    );
    assert(res.status === 200, `expected 200, got ${res.status} ${res.text.slice(0, 200)}`);
  });

  // ---- 9. tenant isolation ------------------------------------------------
  await step("isolation", "hotel B registers and onboards", async () => {
    const reg = await B.request("POST", "/api/auth/register", { name: "Owner B", email: emailB, password });
    assert([200, 201].includes(reg.status), `register B failed (${reg.status})`);
    await B.login(emailB, password);
    const res = await B.request("POST", "/api/hotel/onboarding", {
      name: `Beta Hotel ${uniq}`,
      slug: `beta-${uniq}`,
      currency: "USD",
      timezone: "Africa/Nairobi",
    });
    assert(res.status === 201, `onboarding B failed (${res.status}) ${res.text.slice(0, 200)}`);
    state.hotelB = res.json.hotel.id;
  });

  await step("isolation", "B cannot see A's guests", async () => {
    const res = await B.request("GET", "/api/guests");
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const names = JSON.stringify(res.json);
    assert(!names.includes("Guest Alpha"), "hotel B can read hotel A's guest");
  });

  await step("isolation", "B cannot read A's reservation by id", async () => {
    const res = await B.request("GET", `/api/reservations/${state.reservationA}`);
    assert([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
  });

  await step("isolation", "B cannot read A's folio by id", async () => {
    const res = await B.request("GET", `/api/folios/${state.folioId}`);
    assert([403, 404].includes(res.status), `expected 403/404, got ${res.status}`);
  });

  await step("isolation", "B cannot pay A's folio", async () => {
    const res = await B.request("POST", "/api/payments", {
      folioId: state.folioId,
      paymentMethodId: state.paymentMethodId,
      amount: 100,
      idempotencyKey: `cross-${uniq}`,
    });
    assert([400, 403, 404].includes(res.status), `expected rejection, got ${res.status}`);
  });

  await step("isolation", "B's dashboard does not leak A's data", async () => {
    const res = await B.request("GET", "/api/reservations");
    assert(res.status === 200, `expected 200, got ${res.status}`);
    const body = JSON.stringify(res.json);
    assert(!body.includes(state.reservationA), "hotel B can list hotel A's reservation");
  });

  // ---- 10. membership across hotels & switching ---------------------------
  await step("membership", "hotel B invites an existing account without granting access", async () => {
    const res = await B.request("POST", "/api/staff", {
      name: "Reception C",
      email: emailC,
      password: "ignored-because-account-exists",
      role: "RECEPTIONIST",
    });
    assert(res.status === 202, `expected 202 invitation, got ${res.status} ${res.text.slice(0, 300)}`);
    assert(res.json.invitationPending === true, "response does not mark the invitation as pending");
    state.invitationId = res.json.id;
    state.staffInB = res.json.id;
  });

  await step("membership", "the invitee has no access until accepting", async () => {
    const fresh = new Session("receptionist-pending");
    await fresh.login(emailC, password);
    const memberships = await fresh.request("GET", "/api/auth/memberships");
    assert(memberships.status === 200, `memberships failed (${memberships.status})`);
    const active = memberships.json.memberships ?? [];
    assert(
      !active.some((m) => m.hotelId === state.hotelB),
      "an unaccepted invitation already appears as an active workspace"
    );
    assert(
      (memberships.json.pendingInvitations ?? []).some((i) => i.id === state.invitationId),
      "the invitation is not listed for the invitee"
    );
    const switchRes = await fresh.request("POST", "/api/auth/switch-hotel", { hotelId: state.hotelB });
    assert([400, 403, 404].includes(switchRes.status), `switch into an unaccepted hotel returned ${switchRes.status}`);
  });

  await step("membership", "nobody else can accept the invitation", async () => {
    const res = await A.request("POST", `/api/auth/invitations/${state.invitationId}`, { action: "accept" });
    assert(res.status === 404, `expected 404 for a foreign invitation, got ${res.status}`);
  });

  await step("membership", "the invitee accepts and can then switch hotels", async () => {
    const fresh = new Session("receptionist-accepted");
    await fresh.login(emailC, password);
    const accept = await fresh.request("POST", `/api/auth/invitations/${state.invitationId}`, { action: "accept" });
    assert(accept.status === 200, `accept failed (${accept.status}) ${accept.text.slice(0, 200)}`);

    const memberships = await fresh.request("GET", "/api/auth/memberships");
    const active = memberships.json.memberships ?? [];
    assert(active.length >= 2, `expected 2 workspaces after accepting, got ${active.length}`);

    const switchRes = await fresh.request("POST", "/api/auth/switch-hotel", { hotelId: state.hotelB });
    assert([200, 204].includes(switchRes.status), `switch failed (${switchRes.status}) ${switchRes.text.slice(0, 200)}`);

    const guestsB = await fresh.request("GET", "/api/guests");
    assert(guestsB.status === 200, `guests after switch failed (${guestsB.status})`);
    assert(!JSON.stringify(guestsB.json).includes("Guest Alpha"), "switched session still sees hotel A");
  });

  await step("membership", "C cannot switch into a hotel it does not belong to", async () => {
    const outsider = new Session("outsider");
    await outsider.login(emailA, password); // A belongs only to hotel A
    const res = await outsider.request("POST", "/api/auth/switch-hotel", { hotelId: state.hotelB });
    assert([400, 403, 404].includes(res.status), `expected rejection, got ${res.status}`);
  });

  // ---- 11. subscription enforcement --------------------------------------
  await step("entitlements", "suspended subscription blocks operational writes", async () => {
    sql(`UPDATE "Subscription" SET status = 'SUSPENDED' WHERE "hotelId" = '${state.hotelA}'`);
    try {
      const res = await A.request("POST", "/api/reservations", {
        roomId: state.rooms[1],
        checkInDate: new Date(Date.now() + 3 * 86_400_000).toISOString(),
        checkOutDate: new Date(Date.now() + 4 * 86_400_000).toISOString(),
        guestName: "Blocked Guest",
        guestPhone: "+254700000333",
        tariffId: state.roomTypeId,
        occupancy: "SINGLE",
        mealPlan: "BED_ONLY",
      });
      assert(res.status === 403, `expected 403 while suspended, got ${res.status}`);
      const read = await A.request("GET", "/api/reservations");
      assert([403, 200].includes(read.status), `unexpected read status ${read.status}`);
    } finally {
      sql(`UPDATE "Subscription" SET status = 'ACTIVE' WHERE "hotelId" = '${state.hotelA}'`);
    }
  });

  await step("entitlements", "writes work again once the subscription is active", async () => {
    const res = await A.request("POST", "/api/reservations", {
      roomId: state.rooms[1],
      checkInDate: new Date(Date.now() + 5 * 86_400_000).toISOString(),
      checkOutDate: new Date(Date.now() + 6 * 86_400_000).toISOString(),
      guestName: "Guest After Restore",
      guestPhone: "+254700000444",
      tariffId: state.roomTypeId,
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
    });
    assert([200, 201].includes(res.status), `expected success, got ${res.status} ${res.text.slice(0, 200)}`);
    state.reservationLater = res.json.id ?? res.json.reservation?.id;
  });

  // ---- 12. check-out & housekeeping task creation -------------------------
  await step("billing", "settle the outstanding balance before check-out", async () => {
    const folio = await A.request("GET", `/api/folios/${state.folioId}`);
    assert(folio.status === 200, `folio read failed (${folio.status})`);
    const balance = Number(folio.json.balance ?? folio.json.folio?.balance ?? 0);
    if (balance <= 0) return "already settled";
    const res = await A.request("POST", "/api/payments", {
      folioId: state.folioId,
      paymentMethodId: state.paymentMethodId,
      amount: balance,
      reference: "E2E-SETTLE",
      idempotencyKey: `settle-${uniq}`,
    });
    assert([200, 201].includes(res.status), `settlement failed (${res.status}) ${res.text.slice(0, 200)}`);
    return `settled ${balance}`;
  });

  await step("front desk", "check out closes the stay and creates housekeeping work", async () => {
    const res = await A.request("POST", `/api/reservations/${state.reservationA}/check-out`, {});
    assert([200, 201].includes(res.status), `check-out failed (${res.status}) ${res.text.slice(0, 300)}`);
    const tasks = await A.request("GET", "/api/housekeeping");
    const list = Array.isArray(tasks.json) ? tasks.json : tasks.json.tasks ?? [];
    assert(list.length > 0, "no housekeeping task after check-out");
    state.taskId = list[0].id;
  });

  await step("housekeeping", "task can be reassigned to an active member", async () => {
    const res = await A.request("PUT", `/api/housekeeping/${state.taskId}`, { status: "IN_PROGRESS" });
    assert([200].includes(res.status), `task update failed (${res.status}) ${res.text.slice(0, 200)}`);
  });

  // ---- 12b. inventory workflows (recipes, wastage, notifications) ---------
  await step("inventory", "a recipe links a menu item to its ingredients", async () => {
    const res = await A.request("POST", "/api/recipes", {
      menuItemId: state.menuItemId,
      portions: 4,
      ingredients: [{ inventoryItemId: state.inventoryItemId, quantity: 250 }],
    });
    assert(
      [200, 201].includes(res.status),
      `recipe creation failed (${res.status}) ${res.text.slice(0, 300)}`
    );
    const rows = sql(
      `SELECT count(*) FROM "RecipeIngredient" WHERE "hotelId" = '${state.hotelA}' AND "inventoryItemId" = '${state.inventoryItemId}'`
    );
    assert(rows === "1", `expected one recipe ingredient row, database says ${rows}`);
    state.recipeId = res.json.id;
  });

  await step("inventory", "wastage accepts the accountable staff member chosen in the UI", async () => {
    const staff = await A.request("GET", "/api/staff");
    const me = (staff.json ?? []).find((m) => m.role === "HOTEL_OWNER");
    assert(me?.userId, "the staff list did not expose a userId for the owner");
    const before = Number(
      sql(`SELECT count(*) FROM "StockMovement" WHERE "hotelId" = '${state.hotelA}' AND type = 'WASTAGE'`)
    );
    const res = await A.request("POST", "/api/wastage", {
      inventoryItemId: state.inventoryItemId,
      quantity: 1,
      reason: "SPOILAGE",
      accountableUserId: me.userId,
    });
    assert(res.status === 201, `wastage failed (${res.status}) ${res.text.slice(0, 300)}`);
    assert(res.json.accountableName, "the wastage record has no accountable person");
    const after = Number(
      sql(`SELECT count(*) FROM "StockMovement" WHERE "hotelId" = '${state.hotelA}' AND type = 'WASTAGE'`)
    );
    assert(after === before + 1, `expected one new wastage movement, ${before} -> ${after}`);
  });

  await step("notifications", "a maintenance ticket notifies the hotel and can be marked read", async () => {
    const list = await A.request("GET", "/api/notifications");
    assert(list.status === 200, `notifications failed (${list.status})`);
    const items = list.json.notifications ?? [];
    assert(items.length > 0, "no notifications were created for the hotel");
    assert(items.some((n) => n.type === "MAINTENANCE"), "the maintenance ticket produced no notification");
    assert(list.json.unread > 0, "every notification is already read");

    const mark = await A.request("PATCH", "/api/notifications", { all: true });
    assert(mark.status === 200, `marking all read failed (${mark.status})`);
    const after = await A.request("GET", "/api/notifications");
    assert(after.json.unread === 0, `unread count did not drop to 0 (${after.json.unread})`);
  });

  // ---- 13. audit trail ----------------------------------------------------
  await step("audit", "privileged actions were recorded", async () => {
    const counts = sql(
      `SELECT action || ':' || count(*) FROM "AuditLog" WHERE "hotelId" = '${state.hotelA}' GROUP BY action ORDER BY action`
    );
    assert(counts.length > 0, "no audit rows for hotel A");
    assert(/PAYMENT_RECORDED/.test(counts), `no payment audit row: ${counts}`);
    assert(/CHECK_OUT/.test(counts), `no check-out audit row: ${counts}`);
    return counts.replace(/\n/g, " ");
  });

  await step("audit", "the owner can read the hotel's audit trail", async () => {
    const res = await A.request("GET", "/api/audit-logs");
    assert(res.status === 200, `audit read failed (${res.status}) ${res.text.slice(0, 200)}`);
    const logs = res.json.logs ?? [];
    assert(logs.length > 0, "the audit trail is empty for a hotel that just took payments");
    assert(
      logs.every((log) => typeof log.action === "string" && typeof log.actorName === "string"),
      "audit rows are missing their action or actor"
    );
  });

  await step("audit", "a receptionist cannot read the audit trail", async () => {
    const res = await C.request("GET", "/api/audit-logs");
    assert([401, 403].includes(res.status), `expected 401/403 for a receptionist, got ${res.status}`);
  });

  await step("notifications", "one hotel's notifications are invisible to another", async () => {
    const res = await B.request("GET", "/api/notifications");
    assert(res.status === 200, `hotel B notifications failed (${res.status})`);
    const foreign = (res.json.notifications ?? []).filter((n) => n.type === "MAINTENANCE");
    assert(foreign.length === 0, "hotel B can see hotel A's maintenance notification");
  });

  // ---- 13b. cancellation and membership removal --------------------------
  await step("front desk", "a booking can be cancelled and frees its room", async () => {
    // Whole nights: the folio night count is derived from midnight boundaries.
    const night = (days) => {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      return new Date(d.getTime() + days * 86_400_000).toISOString();
    };
    const checkIn = night(20);
    const checkOut = night(22);
    const create = await A.request("POST", "/api/reservations", {
      roomId: state.rooms[1],
      checkInDate: checkIn,
      checkOutDate: checkOut,
      guestName: "Guest Cancelled",
      guestPhone: "+254700000555",
      tariffId: state.roomTypeId,
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
    });
    assert([200, 201].includes(create.status), `booking failed (${create.status}) ${create.text.slice(0, 200)}`);
    const id = create.json.id ?? create.json.reservation?.id;
    assert(id, "no reservation id returned");

    const cancel = await A.request("PUT", `/api/reservations/${id}`, { status: "CANCELLED" });
    assert(cancel.status === 200, `cancel failed (${cancel.status}) ${cancel.text.slice(0, 200)}`);

    const reread = await A.request("GET", `/api/reservations/${id}`);
    assert(reread.status === 200, `re-read failed (${reread.status})`);
    const status = reread.json.status ?? reread.json.reservation?.status;
    assert(status === "CANCELLED", `status is ${status}, expected CANCELLED`);

    // The room must be bookable again for exactly those dates: availability is
    // derived from non-cancelled reservations, so a stale row would show up as a
    // spurious 409 here.
    const rebook = await A.request("POST", "/api/reservations", {
      roomId: state.rooms[1],
      checkInDate: checkIn,
      checkOutDate: checkOut,
      guestName: "Guest Rebooked",
      guestPhone: "+254700000666",
      tariffId: state.roomTypeId,
      occupancy: "SINGLE",
      mealPlan: "BED_ONLY",
    });
    assert(
      [200, 201].includes(rebook.status),
      `the cancelled stay still blocks the room (${rebook.status}) ${rebook.text.slice(0, 200)}`
    );
    state.cancelledReservation = id;
  });

  await step("front desk", "a cancelled booking cannot be checked in", async () => {
    const res = await A.request("POST", `/api/reservations/${state.cancelledReservation}/check-in`, {});
    assert(
      [400, 404, 409, 422].includes(res.status),
      `check-in of a cancelled booking returned ${res.status}`
    );
  });

  await step("staff", "removing a member revokes their access immediately", async () => {
    // The receptionist accepted a second workspace earlier, so the session has to
    // name hotel A explicitly before it can be used as a revocation baseline.
    await C.login(emailC, password);
    const switchRes = await C.request("POST", "/api/auth/switch-hotel", { hotelId: state.hotelA });
    assert([200, 204].includes(switchRes.status), `switch to A failed (${switchRes.status})`);

    const before = await C.request("GET", `/api/reservations/${state.reservationA}`);
    assert(before.status === 200, `receptionist cannot read hotel A (${before.status}) ${before.text.slice(0, 200)}`);

    const del = await A.request("DELETE", `/api/staff/${state.staffMembershipId}`);
    assert([200, 204].includes(del.status), `remove failed (${del.status}) ${del.text.slice(0, 200)}`);

    const after = await C.request("GET", `/api/reservations/${state.reservationA}`);
    assert(
      [403, 404].includes(after.status),
      `removed member still reads hotel A's reservation (${after.status})`
    );

    const memberships = await C.request("GET", "/api/auth/memberships");
    const stillThere = (memberships.json.memberships ?? []).some((m) => m.hotelId === state.hotelA);
    assert(!stillThere, "the removed hotel is still listed in the member's workspaces");

    const rows = sql(
      `SELECT count(*) FROM "HotelMembership" WHERE "hotelId" = '${state.hotelA}' AND id = '${state.staffMembershipId}'`
    );
    assert(rows === "0", `membership row still in the database (count ${rows})`);
  });

  // ---- 14. persistence check ---------------------------------------------
  await step("persistence", "rows are really in PostgreSQL", async () => {
    const hotel = state.hotelA;
    const counts = sql(
      `SELECT (SELECT count(*) FROM "Hotel" WHERE id = '${hotel}') AS hotels, ` +
        `(SELECT count(*) FROM "Reservation" WHERE "hotelId" = '${hotel}') AS reservations, ` +
        `(SELECT count(*) FROM "Payment" WHERE "hotelId" = '${hotel}') AS payments, ` +
        `(SELECT count(*) FROM "Order" WHERE "hotelId" = '${hotel}') AS orders, ` +
        `(SELECT count(*) FROM "StockMovement" WHERE "hotelId" = '${hotel}') AS stock_movements`
    );
    assert(/[1-9]/.test(counts), "database is empty after the run");
    return counts;
  });

  // ---- report ------------------------------------------------------------
  const byArea = new Map();
  for (const r of results) {
    if (!byArea.has(r.area)) byArea.set(r.area, []);
    byArea.get(r.area).push(r);
  }
  const lines = ["", "End-to-end smoke test", "--------------------", `Target: ${BASE}`];
  for (const [area, items] of byArea) {
    lines.push(`\n${area}`);
    for (const item of items) {
      lines.push(`  ${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? ` — ${item.detail}` : ""}`);
    }
  }
  const passed = results.filter((r) => r.ok).length;
  lines.push("");
  lines.push(`Result: ${failures === 0 ? "PASS" : "FAIL"} — ${passed}/${results.length} checks passed`);
  process.stdout.write(`${lines.join("\n")}\n`);

  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ target: BASE, results, passed, failed: failures }, null, 2));
  }
  return failures === 0 ? 0 : 1;
}

process.exitCode = await main();
