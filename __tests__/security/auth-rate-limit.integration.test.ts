import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
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
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<{ data_directory: string; count: number; attempts: number }> }>;
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
    await expectJson(await fetch(base + "/api/guests", { headers }), 200);
    await expectJson(await fetch(base + "/api/inventory", { headers }), 200);
    await expectJson(await fetch(base + "/api/reservations", { headers }), 200);
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
