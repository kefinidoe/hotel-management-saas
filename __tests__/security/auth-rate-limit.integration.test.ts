import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import path from "node:path";

// Opt-in only: run from a source copy immediately inside a marked disposable
// cluster directory. No test setting depends on the invoking shell's env vars;
// the child applications receive only the explicit environment below.
const root = path.resolve(process.cwd(), "..");
const suite = existsSync(path.join(root, "DISPOSABLE")) ? describe : describe.skip;
const fakePassword = "Fictional-Test-Password-934!";

type Account = { email: string; password: string };
type TestDb = {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<{ data_directory: string; count: number; attempts: number; tasks: number; occupied: number; fingerprint: string }> }>;
};
const { Client } = require("pg") as { Client: new (options: { host: string; port: number; user: string; database: string }) => TestDb };
let db: TestDb;
let apps: ChildProcess[] = [];
let bases: string[] = [];
let fixtures: { accounts: Record<string, Account>; hotels: Record<string, { id: string; reservation: string }> };
let instanceTag: string;
let serverErrors = "";

// Refuse to launch an HTTP app until the loopback database socket is owned by
// the exact postmaster for the marked cluster. This check is Linux-specific and
// intentionally fails closed elsewhere rather than guessing a database target.
function assertDisposableListener(dir: string) {
  const pidFile = readFileSync(path.join(dir, "pgdata", "postmaster.pid"), "utf8").split("\n");
  const pid = Number(pidFile[0]);
  if (!Number.isSafeInteger(pid) || pid < 1 || pidFile[1] !== path.join(dir, "pgdata") || pidFile[3] !== "55434") throw new Error("REFUSED: postmaster identity mismatch");
  const row = readFileSync("/proc/net/tcp", "utf8").split("\n").map((line) => line.trim().split(/\s+/)).find((fields) => fields[1] === "0100007F:D88A" && fields[3] === "0A");
  if (!row) throw new Error("REFUSED: disposable loopback listener missing");
  const sockets = readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
    try { return [readlinkSync(`/proc/${pid}/fd/${fd}`)]; } catch { return []; }
  });
  if (!sockets.includes(`socket:[${row[9]}]`)) throw new Error("REFUSED: loopback listener is not the marked postmaster");
}

function notLimited(response: Response) {
  expect(response.status).not.toBe(429);
  expect(response.status).toBeLessThan(500);
}

function response429(response: Response) {
  expect(response.status).toBe(429);
  const retry = Number(response.headers.get("retry-after"));
  expect(Number.isInteger(retry)).toBe(true);
  expect(retry).toBeGreaterThan(0);
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("No local port"));
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function startApp(useTrustedHeader = true, schema?: string): Promise<string> {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  // A fixed, non-owner role is provisioned only in the marked CI cluster.
  // Administrative setup remains on the separate verified socket connection.
  const dbUrl = "postgresql://hotel_saas_runtime@127.0.0.1:55434/hotel_saas_disposable_audit" + (schema ? `?schema=${schema}` : "");
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/tmp", NODE_ENV: "production",
      DATABASE_URL: dbUrl, DIRECT_URL: dbUrl,
      SAAS_ENVIRONMENT: "saas", SAAS_DATABASE_IDENTIFIER: "hotel_saas_disposable_audit",
      NEXTAUTH_URL: base, NEXTAUTH_SECRET: "fictional-disposable-test-secret-only",
      ...(useTrustedHeader ? { TRUSTED_IP_HEADER: "x-platform-client-ip" } : {}),
      NEXT_TELEMETRY_DISABLED: "1",
      PRISMA_QUERY_ENGINE_LIBRARY: path.resolve("node_modules/.prisma/client/libquery_engine.so.node"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  apps.push(child);
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk; });
  // The server and its database contain fictional CI fixtures only. Expose
  // errors so failed end-to-end workflows are diagnosable in CI logs.
  child.stderr?.on("data", (chunk) => { output += chunk; serverErrors += String(chunk); console.error(String(chunk)); });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`Test server exited: ${output.slice(-1000)}`);
    try { if ((await fetch(`${base}/api/auth/csrf`)).ok) return base; } catch { /* startup */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Test server did not start: ${output.slice(-1000)}`);
}

function cookieJar() {
  const cookies = new Map<string, string>();
  return {
    save(response: Response) {
      for (const raw of response.headers.getSetCookie()) {
        const pair = raw.split(";")[0];
        const at = pair.indexOf("=");
        cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
    },
    header() { return [...cookies].map(([key, value]) => `${key}=${value}`).join("; "); },
  };
}

async function signIn(account: Account) {
  const base = bases[0];
  const jar = cookieJar();
  let response = await fetch(`${base}/api/auth/csrf`);
  jar.save(response);
  const { csrfToken } = await response.json();
  response = await fetch(`${base}/api/auth/callback/credentials`, {
    method: "POST", redirect: "manual",
    headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrfToken, email: account.email, password: account.password, json: "true" }),
  });
  jar.save(response);
  const session = await fetch(`${base}/api/auth/session`, { headers: { cookie: jar.header() } });
  expect((await session.json()).user?.email).toBe(account.email);
  return jar.header();
}

function post(base: string, url: string, data: unknown, headers: Record<string, string> = {}) {
  return fetch(base + url, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(data), redirect: "manual" });
}

async function newAccount(label: string, owner = false): Promise<Account> {
  const email = `${label}-${instanceTag}@example.invalid`;
  const response = await post(bases[0], "/api/auth/register", { name: "Fictional Test", email, password: fakePassword });
  expect(response.status).toBe(201);
  const { user } = await response.json();
  if (owner) {
    await db.query('INSERT INTO "HotelMembership" ("id", "userId", "hotelId", "role", "status", "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)', [randomUUID(), user.id, fixtures.hotels.a.id, "HOTEL_OWNER", "ACTIVE"]);
  }
  return { email, password: fakePassword };
}

suite("real Postgres HTTP authentication rate limiting", () => {
  beforeAll(async () => {
    if (!root || readFileSync(path.join(root, "DISPOSABLE"), "utf8").trim() !== "DISPOSABLE_HOTEL_SAAS_ONLY") throw new Error("REFUSED: missing disposable marker");
    assertDisposableListener(root);
    // The socket directory is marked before connecting; the server's actual
    // data directory is checked before any application process or write.
    db = new Client({ host: root, port: 55434, user: "postgres", database: "hotel_saas_disposable_audit" });
    await db.connect();
    const actual = await db.query("SHOW data_directory");
    if (actual.rows[0].data_directory !== path.join(root, "pgdata")) throw new Error("REFUSED: disposable cluster identity mismatch");
    fixtures = JSON.parse(readFileSync(path.join(root, "fixtures.json"), "utf8"));
    instanceTag = randomUUID();
    bases = [await startApp(), await startApp(), await startApp(false)];
  }, 60_000);

  afterAll(async () => {
    for (const app of apps) app.kill("SIGTERM");
    if (db) await db.end();
  });

  it("rolls back the native-engine audit probe under append-only protections", async () => {
    const { PrismaClient } = await import("@prisma/client");
    const { probeAuditRollback } = await import("../../scripts/native-engine-audit-probe.mjs");
    const previousEngine = process.env.PRISMA_QUERY_ENGINE_LIBRARY;
    process.env.PRISMA_QUERY_ENGINE_LIBRARY = path.resolve("node_modules/.prisma/client/libquery_engine.so.node");
    const client = new PrismaClient({ datasources: { db: { url: "postgresql://hotel_saas_runtime@127.0.0.1:55434/hotel_saas_disposable_audit" } } });
    const probe = `ci-native-probe-${instanceTag}`;
    try {
      expect(await probeAuditRollback(client, probe)).toBe(true);
      const rows = await db.query('SELECT count(*)::int AS count FROM "AuditLog" WHERE "entityId"=$1', [probe]);
      expect(rows.rows[0].count).toBe(0);
    } finally {
      await client.$disconnect();
      if (previousEngine === undefined) delete process.env.PRISMA_QUERY_ENGINE_LIBRARY;
      else process.env.PRISMA_QUERY_ENGINE_LIBRARY = previousEngine;
    }
  }, 30_000);

  it("runs hotel booking, check-in, payment and audited pricing with the non-owner role", async () => {
    const owner = await signIn(await newAccount("runtime-workflow-owner", true));
    const base = bases[0];
    const headers = { cookie: owner };
    const expectJson = async (response: Response, status: number) => {
      const body = await response.json();
      expect(response.status, `${JSON.stringify(body)} ${serverErrors.slice(-2500)}`).toBe(status);
      return body;
    };
    await expectJson(await fetch(base + "/api/subscription", { headers }), 200);
    // Rehearse the exact migration with legacy duplicate rows on an isolated
    // temporary table in the already-verified disposable PostgreSQL cluster.
    await db.query("BEGIN");
    try {
      await db.query('CREATE SCHEMA ci_payment_migration_fixture');
      await db.query('SET LOCAL search_path = ci_payment_migration_fixture');
      await db.query(`CREATE TABLE "Payment" (id text PRIMARY KEY, "hotelId" text NOT NULL, reference text, amount numeric(10,2) NOT NULL, status text NOT NULL, UNIQUE(id,"hotelId"))`);
      await db.query(`INSERT INTO "Payment" (id,"hotelId",reference,amount,status) VALUES
        ('duplicate-a','fixture-hotel',' Receipt ',10,'COMPLETED'),('duplicate-b','fixture-hotel','receipt',20,'COMPLETED'),
        ('unique-c','fixture-hotel',E' \tOt her ',30,'COMPLETED'),('blank-d','fixture-hotel',' ',40,'COMPLETED')`);
      const migration = readFileSync(path.resolve("prisma/migrations/20261116120000_payment_reference_reversals/migration.sql"), "utf8");
      await db.query(migration);
      const preserved = await db.query(`SELECT count(*)::int AS count FROM "Payment" WHERE
        (id='duplicate-a' AND reference=' Receipt ' AND amount=10 AND status='COMPLETED' AND "normalizedReference" IS NULL) OR
        (id='duplicate-b' AND reference='receipt' AND amount=20 AND status='COMPLETED' AND "normalizedReference" IS NULL) OR
        (id='unique-c' AND reference=E' \tOt her ' AND amount=30 AND status='COMPLETED' AND "normalizedReference"='OTHER') OR
        (id='blank-d' AND reference=' ' AND amount=40 AND status='COMPLETED' AND "normalizedReference" IS NULL)`);
      expect(preserved.rows[0].count).toBe(4);
      await db.query(`INSERT INTO "Payment" (id,"hotelId",reference,amount,status) VALUES ('trigger-e','other-hotel',E' \tOt her ',50,'COMPLETED')`);
      const same = await db.query(`SELECT count(*)::int AS count FROM "Payment" WHERE id IN ('unique-c','trigger-e') AND "normalizedReference"='OTHER'`);
      expect(same.rows[0].count).toBe(2);
      const { DUPLICATE_REFERENCE_SQL } = await import("../../scripts/payment-reference-duplicates.mjs");
      const duplicateGroup = await db.query(DUPLICATE_REFERENCE_SQL);
      expect(duplicateGroup.rows).toEqual([{ hotelId: "fixture-hotel", reference: "RECEIPT", paymentIds: ["duplicate-a", "duplicate-b"] }]);
    } finally { await db.query("ROLLBACK"); }
    const report = spawnSync(process.execPath, ["scripts/payment-reference-duplicates.mjs"], {
      cwd: process.cwd(), encoding: "utf8", env: { ...process.env,
        SAAS_ENVIRONMENT: "saas", SAAS_DATABASE_IDENTIFIER: "hotel_saas_disposable_audit",
        DATABASE_URL: "postgresql://postgres@127.0.0.1:55434/hotel_saas_disposable_audit",
        DIRECT_URL: "postgresql://postgres@127.0.0.1:55434/hotel_saas_disposable_audit" },
    });
    expect(report.status, report.stderr).toBe(0);
    expect(JSON.parse(report.stdout)).toEqual({ duplicateGroups: [] });
    console.log(`::notice::Disposable duplicate-report output: ${JSON.stringify(JSON.parse(report.stdout))}`);
    const rate = await expectJson(await post(base, "/api/room-types", {
      name: `CI room ${instanceTag}`, baseRate: 1500, capacity: 2, mealPlan: "BED_ONLY",
    }, headers), 201);
    const room = await expectJson(await post(base, "/api/rooms", {
      number: `CI-${instanceTag.slice(0, 8)}`, roomTypeId: rate.id,
    }, headers), 201);
    const mealResponse = await fetch(base + "/api/settings/meals", { method: "PUT", headers: { ...headers, origin: base, "content-type": "application/json" },
      body: JSON.stringify({ mealPlan: "BED_BREAKFAST", adultSurcharge: 120, childSurcharge: 60, isActive: true }) });
    await expectJson(mealResponse, 200);
    const audit = await db.query('SELECT count(*)::int AS count FROM "AuditLog" WHERE "hotelId"=$1 AND action=$2', [fixtures.hotels.a.id, "MEAL_PRICING_UPDATED"]);
    expect(audit.rows[0].count).toBeGreaterThan(0);

    const start = new Date(Date.now() + 10 * 86400000);
    const end = new Date(start.getTime() + 2 * 86400000);
    const stay = await expectJson(await post(base, "/api/reservations", {
      guestName: "Fictional CI Guest", checkInDate: start.toISOString(), checkOutDate: end.toISOString(),
      roomId: room.id, tariffId: rate.id, occupancy: "SINGLE", mealPlan: "BED_ONLY", adults: 1, children: 0,
    }, headers), 201);
    expect(stay.id).toBeTruthy();

    // This legacy-rate booking has no frozen snapshot by default. Seed a
    // fictional agreement so this exercises the priced-reservation branch.
    await db.query(`INSERT INTO "ReservationPriceSnapshot"
      (id, "hotelId", "reservationId", version, "pricingModel", currency, "nightlyRate", nights, "roomTotal", "grandTotal", breakdown, "createdById")
      VALUES ($1,$2,$3,1,'LEGACY_BASE_RATE','KES',1500,2,3000,3000,$4::jsonb,$5)`,
      [randomUUID(), fixtures.hotels.a.id, stay.id, JSON.stringify({ lines: [] }), "fictional-ci-user"]);

    // A schedule change to a priced reservation must not commit without its
    // rate-review audit. Permission changes here affect only the disposable CI cluster.
    const scheduleUrl = `/api/reservations/${stay.id}`;
    const shiftedStart = new Date(start.getTime() + 86400000);
    const shiftedEnd = new Date(end.getTime() + 86400000);
    const changeSchedule = () => fetch(base + scheduleUrl, {
      method: "PUT", headers: { ...headers, origin: base, "content-type": "application/json" },
      body: JSON.stringify({ checkInDate: shiftedStart.toISOString(), checkOutDate: shiftedEnd.toISOString() }),
    });
    await db.query('REVOKE INSERT ON "AuditLog" FROM hotel_saas_runtime');
    try {
      expect((await changeSchedule()).status).toBe(500);
    } finally {
      await db.query('GRANT INSERT ON "AuditLog" TO hotel_saas_runtime');
    }
    const originalSchedule = await db.query(`SELECT count(*)::int AS count FROM "Reservation" WHERE id=$1 AND "hotelId"=$2 AND "checkInDate"=$3 AND "checkOutDate"=$4`, [stay.id, fixtures.hotels.a.id, start.toISOString(), end.toISOString()]);
    expect(originalSchedule.rows[0].count).toBe(1);
    const moved = await expectJson(await changeSchedule(), 200);
    expect(moved.pricingNeedsReview).toBe(true);
    const reviewAudit = await db.query(`SELECT count(*)::int AS count FROM "AuditLog" WHERE "hotelId"=$1 AND action='RESERVATION_RATE_REVIEW_REQUIRED' AND "entityId"=$2`, [fixtures.hotels.a.id, stay.id]);
    expect(reviewAudit.rows[0].count).toBe(1);

    const checkedIn = await expectJson(await post(base, `/api/reservations/${stay.id}/check-in`, {}, headers), 201);
    expect(checkedIn.folioId).toBeTruthy();
    const methodId = randomUUID();
    await db.query('INSERT INTO "PaymentMethod" (id, "hotelId", name, "isActive") VALUES ($1,$2,$3,true)', [methodId, fixtures.hotels.a.id, `CI-${instanceTag}`]);
    const request = { folioId: checkedIn.folioId, paymentMethodId: methodId, amount: 100, reference: "CI-ONLY", idempotencyKey: `ci-payment-${instanceTag}` };
    const payment = await expectJson(await post(base, "/api/payments", request, headers), 201);
    const replay = await post(base, "/api/payments", request, headers);
    expect([200, 201]).toContain(replay.status);
    expect((await replay.json()).id).toBe(payment.id);
    const paymentCount = await db.query('SELECT count(*)::int AS count FROM "Payment" WHERE "hotelId"=$1 AND "idempotencyKey"=$2', [fixtures.hotels.a.id, request.idempotencyKey]);
    expect(paymentCount.rows[0].count).toBe(1);
    const auditCount = await db.query(`SELECT count(*)::int AS count FROM "AuditLog" WHERE "hotelId"=$1 AND action='PAYMENT_RECORDED' AND "entityId"=$2 AND (metadata->>'amount')::numeric=100 AND metadata->>'reference'='CI-ONLY'`, [fixtures.hotels.a.id, payment.id]);
    expect(auditCount.rows[0].count).toBe(1);

    // This grant change is confined to the verified disposable cluster. Restore
    // it even when an assertion fails so the other test workflows remain usable.
    const deniedRequest = { ...request, reference: `ci-denied-ref-${instanceTag.slice(0, 12)}`, idempotencyKey: `ci-denied-${instanceTag}` };
    await db.query('REVOKE INSERT ON "AuditLog" FROM hotel_saas_runtime');
    try {
      const denied = await post(base, "/api/payments", deniedRequest, headers);
      expect(denied.status).toBe(500);
    } finally {
      await db.query('GRANT INSERT ON "AuditLog" TO hotel_saas_runtime');
    }
    const rolledBack = await db.query('SELECT count(*)::int AS count FROM "Payment" WHERE "hotelId"=$1 AND "idempotencyKey"=$2', [fixtures.hotels.a.id, deniedRequest.idempotencyKey]);
    expect(rolledBack.rows[0].count).toBe(0);
    const retried = await expectJson(await post(base, "/api/payments", deniedRequest, headers), 201);
    const retriedAudit = await db.query(`SELECT count(*)::int AS count FROM "AuditLog" WHERE "hotelId"=$1 AND action='PAYMENT_RECORDED' AND "entityId"=$2`, [fixtures.hotels.a.id, retried.id]);
    expect(retriedAudit.rows[0].count).toBe(1);

    const concurrentRequest = { ...request, amount: 50, reference: `ci-race-ref-${instanceTag.slice(0, 12)}`, idempotencyKey: `ci-race-${instanceTag}` };
    const concurrent = await Promise.all([post(base, "/api/payments", concurrentRequest, headers), post(base, "/api/payments", concurrentRequest, headers)]);
    expect(concurrent.some(response => response.status === 201)).toBe(true);
    expect(concurrent.every(response => [201, 409].includes(response.status))).toBe(true);
    const winner = await expectJson(await post(base, "/api/payments", concurrentRequest, headers), 201);
    const raceCounts = await db.query(`SELECT (SELECT count(*) FROM "Payment" WHERE "hotelId"=$1 AND "idempotencyKey"=$2)::int AS count, (SELECT count(*) FROM "AuditLog" WHERE "hotelId"=$1 AND action='PAYMENT_RECORDED' AND "entityId"=$3)::int AS attempts`, [fixtures.hotels.a.id, concurrentRequest.idempotencyKey, winner.id]);
    expect(raceCounts.rows[0]).toMatchObject({ count: 1, attempts: 1 });

    const receipt = `CI-RECEIPT-${instanceTag.slice(0, 12)}`;
    const duplicateRequests = [0, 1].map(i => post(base, "/api/payments", {
      ...request, amount: 25, reference: i ? ` \t${receipt.toLowerCase().slice(0, 5)} \t${receipt.toLowerCase().slice(5)}  ` : receipt,
      idempotencyKey: `ci-receipt-${instanceTag}-${i}`,
    }, headers));
    const duplicateResponses = await Promise.all(duplicateRequests);
    expect(duplicateResponses.map(r => r.status).sort()).toEqual([201, 409]);
    const receiptPayment = await duplicateResponses.find(r => r.status === 201)!.json();
    expect((await duplicateResponses.find(r => r.status === 409)!.json()).error).toMatch(/reference/i);
    for (let i = 0; i < 2; i++) {
      const blank = await expectJson(await post(base, "/api/payments", { ...request, amount: 10, reference: i ? " \t " : "  ", idempotencyKey: `ci-blank-${instanceTag}-${i}` }, headers), 201);
      const stored = await db.query('SELECT count(*)::int AS count FROM "Payment" WHERE id=$1 AND reference IS NULL AND "normalizedReference" IS NULL', [blank.id]);
      expect(stored.rows[0].count).toBe(1);
    }
    expect((await post(base, "/api/payments", { ...request, reference: "référence", idempotencyKey: `ci-invalid-ref-${instanceTag}` }, headers)).status).toBe(400);

    const checkOutUrl = `/api/reservations/${stay.id}/check-out`;
    await db.query('REVOKE INSERT ON "AuditLog" FROM hotel_saas_runtime');
    try {
      const denied = await post(base, checkOutUrl, { allowOutstandingBalance: true }, headers);
      expect(denied.status).toBe(500);
    } finally {
      await db.query('GRANT INSERT ON "AuditLog" TO hotel_saas_runtime');
    }
    const unchanged = await db.query(`SELECT
      (SELECT count(*) FROM "Reservation" WHERE id=$1 AND status='CHECKED_IN')::int AS count,
      (SELECT count(*) FROM "Folio" WHERE id=$2 AND "isClosed"=false)::int AS attempts,
      (SELECT count(*) FROM "HousekeepingTask" WHERE "roomId"=$3)::int AS tasks,
      (SELECT count(*) FROM "Room" WHERE id=$3 AND status='OCCUPIED')::int AS occupied`, [stay.id, checkedIn.folioId, room.id]);
    expect(unchanged.rows[0]).toMatchObject({ count: 1, attempts: 1, tasks: 0, occupied: 1 });
    await expectJson(await post(base, checkOutUrl, { allowOutstandingBalance: true }, headers), 200);
    const checkoutAudit = await db.query(`SELECT count(*)::int AS count FROM "AuditLog" WHERE "hotelId"=$1 AND action='CHECK_OUT_WITH_BALANCE' AND "entityId"=$2`, [fixtures.hotels.a.id, stay.id]);
    expect(checkoutAudit.rows[0].count).toBe(1);

    const reverse = (paymentId: string, key: string, cookie = owner) => post(base, `/api/payments/${paymentId}/reverse`, { reason: "Incorrect receipt", idempotencyKey: key }, { cookie });
    const receptionist = await newAccount("reversal-receptionist");
    await db.query(`INSERT INTO "HotelMembership" (id, "userId", "hotelId", role, status, "createdAt", "updatedAt")
      SELECT $1, id, $2, 'RECEPTIONIST', 'ACTIVE', now(), now() FROM "User" WHERE email=$3`, [randomUUID(), fixtures.hotels.a.id, receptionist.email]);
    const receptionistCookie = await signIn(receptionist);
    expect((await reverse(receiptPayment.id, `ci-reception-${instanceTag}`, receptionistCookie)).status).toBe(403);
    const otherHotel = randomUUID(), otherGuest = randomUUID(), otherFolio = randomUUID(), otherMethod = randomUUID(), otherPayment = randomUUID();
    await db.query(`INSERT INTO "Hotel" (id,name,slug,"updatedAt") VALUES ($1,'Fictional other hotel',$2,now())`, [otherHotel, `ci-other-${instanceTag}`]);
    await db.query(`INSERT INTO "Guest" (id,"hotelId","fullName","updatedAt") VALUES ($1,$2,'Fictional guest',now())`, [otherGuest, otherHotel]);
    await db.query(`INSERT INTO "Folio" (id,"hotelId","guestId","updatedAt") VALUES ($1,$2,$3,now())`, [otherFolio, otherHotel, otherGuest]);
    await db.query(`INSERT INTO "PaymentMethod" (id,"hotelId",name,"isActive") VALUES ($1,$2,'Fictional method',true)`, [otherMethod, otherHotel]);
    await db.query(`INSERT INTO "Payment" (id,"hotelId","folioId","paymentMethodId",amount,status,"cashierId")
      SELECT $1,$2,$3,$4,10,'COMPLETED',id FROM "User" WHERE email=$5`, [otherPayment, otherHotel, otherFolio, otherMethod, receptionist.email]);
    expect((await reverse(otherPayment, `ci-cross-${instanceTag}`)).status).toBe(404);
    const beforeReverse = await expectJson(await fetch(base + `/api/folios/${checkedIn.folioId}`, { headers }), 200);
    const reversalRace = await Promise.all([0, 1].map(i => reverse(receiptPayment.id, `ci-reverse-${instanceTag}-${i}`)));
    expect(reversalRace.map(r => r.status).sort()).toEqual([201, 409]);
    const reversal = await reversalRace.find(r => r.status === 201)!.json();
    expect((await reverse(reversal.id, `ci-reverse-reversal-${instanceTag}`)).status).toBe(409);
    const afterReverse = await expectJson(await fetch(base + `/api/folios/${checkedIn.folioId}`, { headers }), 200);
    expect(afterReverse.isClosed).toBe(true);
    expect(afterReverse.balance).toBe(beforeReverse.balance + 25);
    const reversalRow = await db.query(`SELECT count(*)::int AS count FROM "Payment" WHERE id=$1 AND "reversalOfId"=$2 AND amount=-25 AND reference IS NULL`, [reversal.id, receiptPayment.id]);
    expect(reversalRow.rows[0].count).toBe(1);
    const reversalAudit = await db.query(`SELECT count(*)::int AS count FROM "AuditLog" WHERE "hotelId"=$1 AND action='PAYMENT_REVERSED' AND "entityId"=$2 AND metadata->>'folioWasClosed'='true' AND (metadata->>'balanceAfter')::numeric=$3`, [fixtures.hotels.a.id, reversal.id, afterReverse.balance]);
    expect(reversalAudit.rows[0].count).toBe(1);
    await expectJson(await fetch(base + "/api/guests", { headers }), 200);
    await expectJson(await fetch(base + "/api/inventory", { headers }), 200);
    await expectJson(await fetch(base + "/api/reservations", { headers }), 200);

    // Exercise create/update/delete and the bulk rate write against a real
    // non-owner role, including failure after business writes have happened.
    const entityUrl = "/api/pricing/occupancy-types";
    const occupancyName = `CI occupancy ${instanceTag}`;
    const pricingRequest = (method: string, url: string, body?: unknown) => fetch(base + url, {
      method, headers: { ...headers, origin: base, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const rejectAudit = async (request: () => Promise<Response>) => {
      await db.query('REVOKE INSERT ON "AuditLog" FROM hotel_saas_runtime');
      try { expect((await request()).status).toBe(500); }
      finally { await db.query('GRANT INSERT ON "AuditLog" TO hotel_saas_runtime'); }
    };
    const newOccupancy = { name: occupancyName, minAdults: 1, maxAdults: 2, maxChildren: 0 };
    await rejectAudit(() => pricingRequest("POST", entityUrl, newOccupancy));
    const noOccupancy = await db.query('SELECT count(*)::int AS count FROM "OccupancyType" WHERE "hotelId"=$1 AND name=$2', [fixtures.hotels.a.id, occupancyName]);
    expect(noOccupancy.rows[0].count).toBe(0);
    const occupancy = (await expectJson(await pricingRequest("POST", entityUrl, newOccupancy), 201)).record;
    const renameOccupancy = { id: occupancy.id, name: `${occupancyName} updated` };
    await rejectAudit(() => pricingRequest("PATCH", entityUrl, renameOccupancy));
    const originalOccupancy = await db.query('SELECT count(*)::int AS count FROM "OccupancyType" WHERE id=$1 AND name=$2', [occupancy.id, occupancyName]);
    expect(originalOccupancy.rows[0].count).toBe(1);
    await expectJson(await pricingRequest("PATCH", entityUrl, renameOccupancy), 200);
    const rateBody = { roomTypeId: rate.id, rates: [{ occupancyTypeId: occupancy.id, nightlyRate: 1800 }] };
    await rejectAudit(() => pricingRequest("POST", "/api/pricing/room-rates", rateBody));
    const absentRate = await db.query('SELECT count(*)::int AS count FROM "RoomTypeOccupancy" WHERE "roomTypeId"=$1 AND "occupancyTypeId"=$2', [rate.id, occupancy.id]);
    expect(absentRate.rows[0].count).toBe(0);
    const oldBaseRate = await db.query('SELECT count(*)::int AS count FROM "RoomType" WHERE id=$1 AND "baseRate"=1500', [rate.id]);
    expect(oldBaseRate.rows[0].count).toBe(1);
    await expectJson(await pricingRequest("POST", "/api/pricing/room-rates", rateBody), 200);
    // An invalid later row must not leave the earlier deletion behind.
    await expectJson(await pricingRequest("POST", "/api/pricing/room-rates", { roomTypeId: rate.id, rates: [
      { occupancyTypeId: occupancy.id, nightlyRate: null }, { occupancyTypeId: "not-a-real-id", nightlyRate: 20 },
    ] }), 404);
    const rateRemains = await db.query('SELECT count(*)::int AS count FROM "RoomTypeOccupancy" WHERE "roomTypeId"=$1 AND "occupancyTypeId"=$2 AND "nightlyRate"=1800', [rate.id, occupancy.id]);
    expect(rateRemains.rows[0].count).toBe(1);
    await expectJson(await pricingRequest("POST", "/api/pricing/room-rates", { roomTypeId: rate.id, rates: [{ occupancyTypeId: occupancy.id, nightlyRate: null }] }), 200);
    const deleteUrl = `${entityUrl}?id=${encodeURIComponent(occupancy.id)}`;
    await rejectAudit(() => pricingRequest("DELETE", deleteUrl));
    const retainedOccupancy = await db.query('SELECT count(*)::int AS count FROM "OccupancyType" WHERE id=$1', [occupancy.id]);
    expect(retainedOccupancy.rows[0].count).toBe(1);
    await expectJson(await pricingRequest("DELETE", deleteUrl), 200);
    const entityAudits = await db.query(`SELECT count(*)::int AS count FROM "AuditLog" WHERE "hotelId"=$1 AND "entityId"=$2 AND action IN ('PRICING_OCCUPANCY_TYPES_CREATED','PRICING_OCCUPANCY_TYPES_UPDATED','PRICING_OCCUPANCY_TYPES_DELETED')`, [fixtures.hotels.a.id, occupancy.id]);
    expect(entityAudits.rows[0].count).toBe(3);

    const pricingFingerprint = async () => (await db.query(`SELECT md5(COALESCE(
      (SELECT row_to_json(p)::text FROM "HotelPricingSettings" p WHERE "hotelId"=$1), ''
    )) AS fingerprint`, [fixtures.hotels.a.id])).rows[0].fingerprint;
    const beforePricing = await pricingFingerprint();
    const updatePricing = () => fetch(base + "/api/pricing", {
      method: "PATCH", headers: { ...headers, origin: base, "content-type": "application/json" },
      body: JSON.stringify({ useWeekendPricing: true }),
    });
    await db.query('REVOKE INSERT ON "AuditLog" FROM hotel_saas_runtime');
    try {
      expect((await updatePricing()).status).toBe(500);
    } finally {
      await db.query('GRANT INSERT ON "AuditLog" TO hotel_saas_runtime');
    }
    expect(await pricingFingerprint()).toBe(beforePricing);
    await expectJson(await updatePricing(), 200);
    const pricingAudit = await db.query(`SELECT count(*)::int AS count FROM "AuditLog" WHERE "hotelId"=$1 AND action='PRICING_SETTINGS_UPDATED'`, [fixtures.hotels.a.id]);
    expect(pricingAudit.rows[0].count).toBe(1);

    const staffEmail = `runtime-new-staff-${instanceTag}@example.invalid`;
    const staffBody = { name: "Fictional New Staff", email: staffEmail, password: fakePassword, role: "ACCOUNTANT" };
    await rejectAudit(() => post(base, "/api/staff", staffBody, headers));
    const noUser = await db.query('SELECT count(*)::int AS count FROM "User" WHERE email=$1', [staffEmail]);
    expect(noUser.rows[0].count).toBe(0);
    const staff = await expectJson(await post(base, "/api/staff", staffBody, headers), 201);
    const staffAudit = await db.query(`SELECT count(*)::int AS count FROM "AuditLog" WHERE "hotelId"=$1 AND action='STAFF_MEMBER_ADDED' AND "entityId"=$2`, [fixtures.hotels.a.id, staff.id]);
    expect(staffAudit.rows[0].count).toBe(1);
    const staffUrl = `/api/staff/${staff.id}`;
    await rejectAudit(() => pricingRequest("PATCH", staffUrl, { department: "Fictional Finance" }));
    const originalStaff = await db.query('SELECT count(*)::int AS count FROM "HotelMembership" WHERE id=$1 AND department IS NULL', [staff.id]);
    expect(originalStaff.rows[0].count).toBe(1);
    await expectJson(await pricingRequest("PATCH", staffUrl, { department: "Fictional Finance" }), 200);
    const staffUpdateAudit = await db.query(`SELECT count(*)::int AS count FROM "AuditLog" WHERE "hotelId"=$1 AND action='STAFF_MEMBERSHIP_UPDATED' AND "entityId"=$2`, [fixtures.hotels.a.id, staff.id]);
    expect(staffUpdateAudit.rows[0].count).toBe(1);
    // Existing activity requires suspension rather than deletion, and both
    // branches must roll back if the audit insert is unavailable.
    await db.query('UPDATE "HousekeepingTask" SET "assigneeId"=$1 WHERE "roomId"=$2 AND "hotelId"=$3', [staff.userId, room.id, fixtures.hotels.a.id]);
    await rejectAudit(() => pricingRequest("DELETE", staffUrl));
    const activeStaff = await db.query(`SELECT count(*)::int AS count FROM "HotelMembership" WHERE id=$1 AND status='ACTIVE'`, [staff.id]);
    expect(activeStaff.rows[0].count).toBe(1);
    expect((await expectJson(await pricingRequest("DELETE", staffUrl), 200)).mode).toBe("suspended");
    const suspensionAudit = await db.query(`SELECT count(*)::int AS count FROM "AuditLog" WHERE action='STAFF_MEMBERSHIP_SUSPENDED' AND "hotelId"=$1 AND "entityId"=$2`, [fixtures.hotels.a.id, staff.id]);
    expect(suspensionAudit.rows[0].count).toBe(1);
    await db.query('UPDATE "HousekeepingTask" SET "assigneeId"=NULL WHERE "assigneeId"=$1 AND "hotelId"=$2', [staff.userId, fixtures.hotels.a.id]);
    await rejectAudit(() => pricingRequest("DELETE", staffUrl));
    const retainedStaff = await db.query('SELECT count(*)::int AS count FROM "HotelMembership" WHERE id=$1', [staff.id]);
    expect(retainedStaff.rows[0].count).toBe(1);
    expect((await expectJson(await pricingRequest("DELETE", staffUrl), 200)).mode).toBe("deleted");
    const removalAudit = await db.query(`SELECT count(*)::int AS count FROM "AuditLog" WHERE action='STAFF_MEMBERSHIP_REMOVED' AND "hotelId"=$1 AND "entityId"=$2`, [fixtures.hotels.a.id, staff.id]);
    expect(removalAudit.rows[0].count).toBe(1);

    // Denying the room update after the ticket write proves both operations
    // roll back together. The grant change is limited to the disposable cluster.
    const ticketTitle = `CI repair ${instanceTag}`;
    const createTicket = () => post(base, "/api/maintenance", { title: ticketTitle, roomId: room.id, takeOutOfService: true }, headers);
    await db.query('REVOKE UPDATE ON "Room" FROM hotel_saas_runtime');
    try { expect((await createTicket()).status).toBe(500); }
    finally { await db.query('GRANT UPDATE ON "Room" TO hotel_saas_runtime'); }
    const noTicket = await db.query('SELECT count(*)::int AS count FROM "MaintenanceTicket" WHERE "hotelId"=$1 AND title=$2', [fixtures.hotels.a.id, ticketTitle]);
    expect(noTicket.rows[0].count).toBe(0);
    const ticket = await expectJson(await createTicket(), 201);
    const finishTicket = () => pricingRequest("PUT", `/api/maintenance/${ticket.id}`, { status: "COMPLETED" });
    await db.query('REVOKE UPDATE ON "Room" FROM hotel_saas_runtime');
    try { expect((await finishTicket()).status).toBe(500); }
    finally { await db.query('GRANT UPDATE ON "Room" TO hotel_saas_runtime'); }
    const rollbackTicket = await db.query(`SELECT (SELECT count(*) FROM "MaintenanceTicket" WHERE id=$1 AND status='OPEN')::int AS count,
      (SELECT count(*) FROM "Room" WHERE id=$2 AND status='MAINTENANCE')::int AS attempts`, [ticket.id, room.id]);
    expect(rollbackTicket.rows[0]).toMatchObject({ count: 1, attempts: 1 });
    await expectJson(await finishTicket(), 200);
    const finishedTicket = await db.query(`SELECT (SELECT count(*) FROM "MaintenanceTicket" WHERE id=$1 AND status='COMPLETED')::int AS count,
      (SELECT count(*) FROM "Room" WHERE id=$2 AND status='AVAILABLE')::int AS attempts`, [ticket.id, room.id]);
    expect(finishedTicket.rows[0]).toMatchObject({ count: 1, attempts: 1 });

    const settingsFingerprint = async () => (await db.query(`SELECT md5(
      (SELECT row_to_json(h)::text FROM "Hotel" h WHERE id=$1) ||
      COALESCE((SELECT row_to_json(s)::text FROM "Subscription" s WHERE "hotelId"=$1), '')
    ) AS fingerprint`, [fixtures.hotels.a.id])).rows[0].fingerprint;
    const beforeSettings = await settingsFingerprint();
    const updateSettings = () => fetch(base + "/api/hotel/settings", {
      method: "PATCH", headers: { ...headers, origin: base, "content-type": "application/json" },
      body: JSON.stringify({ name: `Fictional CI Hotel ${instanceTag}`, currency: "USD" }),
    });
    await db.query('REVOKE INSERT ON "AuditLog" FROM hotel_saas_runtime');
    try {
      expect((await updateSettings()).status).toBe(500);
    } finally {
      await db.query('GRANT INSERT ON "AuditLog" TO hotel_saas_runtime');
    }
    expect(await settingsFingerprint()).toBe(beforeSettings);
    await expectJson(await updateSettings(), 200);
    const settingsAudit = await db.query(`SELECT count(*)::int AS count FROM "AuditLog" WHERE "hotelId"=$1 AND action='HOTEL_SETTINGS_UPDATED'`, [fixtures.hotels.a.id]);
    expect(settingsAudit.rows[0].count).toBe(1);
  }, 60_000);

  it("limits normalized login accounts atomically across two server instances with unknown IP", async () => {
    const email = `race-${instanceTag}@example.invalid`;
    const responses = await Promise.all(Array.from({ length: 20 }, (_, i) => post(bases[i % 2], "/api/auth/callback/credentials", { email: i % 2 ? `  ${email.toUpperCase()}  ` : email, password: fakePassword }, { "x-forwarded-for": `203.0.113.${i + 1}` })));
    expect(responses.filter((r) => r.status === 429)).toHaveLength(15);
    responses.filter((r) => r.status === 429).forEach(response429);
    responses.filter((r) => r.status !== 429).forEach(notLimited);
    const unrelated = await post(bases[0], "/api/auth/callback/credentials", { email: `other-${instanceTag}@example.invalid`, password: fakePassword });
    notLimited(unrelated);
    const ips = await db.query('SELECT count(*)::int AS count FROM "AuthRateLimitBucket" WHERE "key" = $1', [`login:ip:${createHash("sha256").update("unknown").digest("hex")}`]);
    expect(ips.rows[0].count).toBe(0);
  });

  it("expires and cleans up its own stale account counter", async () => {
    const email = `expiry-${instanceTag}@example.invalid`;
    for (let i = 0; i < 5; i++) notLimited(await post(bases[0], "/api/auth/callback/credentials", { email, password: fakePassword }));
    response429(await post(bases[0], "/api/auth/callback/credentials", { email, password: fakePassword }));
    const key = `login:account:${createHash("sha256").update(email).digest("hex")}`;
    await db.query('UPDATE "AuthRateLimitBucket" SET "expiresAt" = CURRENT_TIMESTAMP - INTERVAL \'1 second\' WHERE "key" = $1', [key]);
    notLimited(await post(bases[0], "/api/auth/callback/credentials", { email, password: fakePassword }));
    const row = await db.query('SELECT "attempts" FROM "AuthRateLimitBucket" WHERE "key" = $1', [key]);
    expect(row.rows[0].attempts).toBe(1);
  });

  it("ignores all IP headers when the trusted header is not configured", async () => {
    const before = await db.query('SELECT count(*)::int AS count FROM "AuthRateLimitBucket" WHERE "key" LIKE $1', ["login:ip:%"]);
    const email = `unset-header-${instanceTag}@example.invalid`;
    const headers = { "x-platform-client-ip": "192.0.2.50", "x-forwarded-for": "198.51.100.22" };
    for (let i = 0; i < 5; i++) notLimited(await post(bases[2], "/api/auth/callback/credentials", { email, password: fakePassword }, headers));
    response429(await post(bases[2], "/api/auth/callback/credentials", { email, password: fakePassword }, headers));
    const after = await db.query("SELECT count(*)::int AS count FROM \"AuthRateLimitBucket\" WHERE \"key\" LIKE 'login:ip:%'");
    expect(after.rows[0].count).toBeLessThanOrEqual(before.rows[0].count);
  });

  it("limits registration by normalized email without sharing an unknown-IP bucket", async () => {
    const email = `signup-${instanceTag}@example.invalid`;
    for (let i = 0; i < 5; i++) {
      const r = await post(bases[0], "/api/auth/register", { name: "Fictional Person", email: i % 2 ? ` ${email.toUpperCase()} ` : email, password: fakePassword }, { "x-forwarded-for": "198.51.100.1" });
      expect(r.status).toBe(i === 0 ? 201 : 409);
    }
    response429(await post(bases[0], "/api/auth/register", { name: "Fictional Person", email, password: fakePassword }));
    const other = await post(bases[0], "/api/auth/register", { name: "Fictional Other", email: `signup-other-${instanceTag}@example.invalid`, password: fakePassword });
    expect(other.status).toBe(201);
  });

  it("counts invalid registration attempts for the supplied account", async () => {
    const email = `invalid-signup-${instanceTag}@example.invalid`;
    for (let i = 0; i < 5; i++) {
      const response = await post(bases[0], "/api/auth/register", { name: "", email, password: fakePassword });
      expect(response.status).toBe(400);
    }
    response429(await post(bases[0], "/api/auth/register", { name: "", email, password: fakePassword }));
  });

  it("limits password changes per authenticated account even when IP is unknown", async () => {
    const first = await signIn(await newAccount("password-first"));
    const second = await signIn(await newAccount("password-second"));
    for (let i = 0; i < 5; i++) {
      const r = await post(bases[0], "/api/profile/password", { currentPassword: "wrong", newPassword: fakePassword }, { cookie: first });
      expect(r.status).toBe(400);
    }
    response429(await post(bases[0], "/api/profile/password", { currentPassword: "wrong", newPassword: fakePassword }, { cookie: first }));
    expect((await post(bases[0], "/api/profile/password", { currentPassword: "wrong", newPassword: fakePassword }, { cookie: second })).status).toBe(400);
  });

  it("limits invitation decisions per authenticated account with unknown IP", async () => {
    const first = await signIn(await newAccount("invite-first"));
    const second = await signIn(await newAccount("invite-second"));
    const route = `/api/auth/invitations/${randomUUID()}`;
    for (let i = 0; i < 10; i++) expect((await post(bases[0], route, { action: "accept" }, { cookie: first })).status).toBe(404);
    response429(await post(bases[0], route, { action: "accept" }, { cookie: first }));
    expect((await post(bases[0], route, { action: "accept" }, { cookie: second })).status).toBe(404);
  });

  it("limits staff invitation creation by normalized target and actor with unknown IP", async () => {
    const owner = await signIn(await newAccount("invite-owner", true));
    const email = (await newAccount("invite-target")).email;
    for (let i = 0; i < 10; i++) {
      const r = await post(bases[0], "/api/staff", { name: "Fictional Invitee", email: i % 2 ? email.toUpperCase() : email, role: "ACCOUNTANT" }, { cookie: owner });
      expect([202, 409]).toContain(r.status);
    }
    response429(await post(bases[0], "/api/staff", { name: "Fictional Invitee", email, role: "ACCOUNTANT" }, { cookie: owner }));
  });

  it("fails closed when the shared limiter table is unavailable", async () => {
    const schema = `rate_limit_empty_${instanceTag.replace(/-/g, "")}`;
    await db.query(`CREATE SCHEMA "${schema}"`);
    const isolated = await startApp(true, schema);
    const response = await post(isolated, "/api/auth/callback/credentials", { email: `unavailable-${instanceTag}@example.invalid`, password: fakePassword });
    expect(response.status).toBe(503);
    expect((await response.json()).error).toBe("RATE_LIMIT_UNAVAILABLE");
  }, 30_000);

  it("limits an invitation creator across different target accounts", async () => {
    const owner = await signIn(await newAccount("actor-owner", true));
    for (let i = 0; i < 30; i++) {
      const r = await post(bases[0], "/api/staff", { name: "Fictional Invitee", email: `actor-target-${instanceTag}-${i}@example.invalid`, role: "ACCOUNTANT" }, { cookie: owner });
      notLimited(r);
    }
    response429(await post(bases[0], "/api/staff", { name: "Fictional Invitee", email: `actor-target-${instanceTag}-last@example.invalid`, role: "ACCOUNTANT" }, { cookie: owner }));
  });

  it("applies the configured IP layer only to valid trusted addresses, ignoring spoofed forwarded headers", async () => {
    const uniqueIp = `2001:db8:${instanceTag.slice(0, 4)}:${instanceTag.slice(4, 8)}::1`;
    const hdr = { "x-platform-client-ip": uniqueIp, "x-forwarded-for": "198.51.100.1" };
    for (let i = 0; i < 100; i++) {
      const r = await post(bases[0], "/api/auth/callback/credentials", { email: `ip-${instanceTag}-${i}@example.invalid`, password: fakePassword }, hdr);
      notLimited(r);
    }
    response429(await post(bases[1], "/api/auth/callback/credentials", { email: `ip-last-${instanceTag}@example.invalid`, password: fakePassword }, { ...hdr, "x-forwarded-for": "198.51.100.99" }));
    notLimited(await post(bases[0], "/api/auth/callback/credentials", { email: `ip-other-${instanceTag}@example.invalid`, password: fakePassword }, { "x-platform-client-ip": `2001:db8:${instanceTag.slice(0, 4)}:${instanceTag.slice(4, 8)}::2` }));
    notLimited(await post(bases[0], "/api/auth/callback/credentials", { email: `ip-unknown-${instanceTag}@example.invalid`, password: fakePassword }, { "x-platform-client-ip": `${uniqueIp}, 203.0.113.1` }));
  }, 60_000);
});
