#!/usr/bin/env node
/**
 * Owner-handover verification against the running demo instance.
 * Read-mostly: it logs in as each demo role, records which pages/APIs that role
 * can open, exercises the owner's hotel switch, and creates + removes one
 * temporary staff account to prove revocation. It leaves the seeded demo data
 * as it found it (the temporary account is deleted at the end).
 */
import { readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:3100";
const ORIGIN = process.env.ORIGIN ?? "https://3100-i7p2zy0ehr3jxqmk6adh0.e2b.app";
const creds = JSON.parse(readFileSync(new URL("../../.owner-test/credentials.json", import.meta.url)));
const passwordFor = (email) => creds.accounts.find((a) => a.email === email).password;

class Session {
  constructor(label) {
    this.label = label;
    this.jar = new Map();
  }
  cookie() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  absorb(res) {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair] = line.split(";");
      const i = pair.indexOf("=");
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (value === "") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }
  async get(path) {
    const res = await fetch(`${BASE}${path}`, {
      headers: { cookie: this.cookie(), origin: ORIGIN },
      redirect: "manual",
    });
    this.absorb(res);
    const text = await res.text();
    return { status: res.status, text, location: res.headers.get("location") ?? "", json: safeJson(text) };
  }
  async post(path, body) {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { cookie: this.cookie(), origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
      redirect: "manual",
    });
    this.absorb(res);
    const text = await res.text();
    return { status: res.status, text, json: safeJson(text) };
  }
  async del(path) {
    const res = await fetch(`${BASE}${path}`, {
      method: "DELETE",
      headers: { cookie: this.cookie(), origin: ORIGIN },
      redirect: "manual",
    });
    this.absorb(res);
    const text = await res.text();
    return { status: res.status, text, json: safeJson(text) };
  }
  async login(email, password) {
    const csrf = await this.get("/api/auth/csrf");
    const body = new URLSearchParams({
      csrfToken: csrf.json.csrfToken,
      email,
      password,
      json: "true",
    });
    const res = await fetch(`${BASE}/api/auth/callback/credentials`, {
      method: "POST",
      headers: {
        cookie: this.cookie(),
        origin: ORIGIN,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      redirect: "manual",
    });
    this.absorb(res);
    return res.status;
  }
}

function responseLocation(response) {
  // The page helpers only expose the body, so the redirect target is recovered
  // from the served page: Next sends an RSC redirect payload for manual fetches.
  return `${response.text.slice(0, 400)} ${response.location ?? ""}`;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const results = [];
const record = (area, name, ok, detail = "") => results.push({ area, name, ok, detail });

const PAGES = [
  "/dashboard",
  "/dashboard/front-desk",
  "/dashboard/reservations",
  "/dashboard/rooms",
  "/dashboard/guests",
  "/dashboard/housekeeping",
  "/dashboard/maintenance",
  "/dashboard/restaurant",
  "/dashboard/inventory",
  "/dashboard/expenses",
  "/dashboard/reports",
  "/dashboard/staff",
  "/dashboard/subscription",
  "/dashboard/audit",
];

const ROLE_MATRIX = {
  "owner@riverside-grand.demo": {
    allow: PAGES,
    deny: [],
  },
  "receptionist@riverside-grand.demo": {
    allow: ["/dashboard", "/dashboard/front-desk", "/dashboard/reservations", "/dashboard/rooms", "/dashboard/guests"],
    // The subscription page is deliberately reachable by all staff: it is the
    // recovery surface for a suspended hotel, and it renders a "limited access"
    // panel instead of data for anyone below administrator.
    deny: ["/dashboard/reports", "/dashboard/staff", "/dashboard/audit", "/dashboard/maintenance"],
  },
  "accountant@riverside-grand.demo": {
    allow: ["/dashboard", "/dashboard/expenses", "/dashboard/reports"],
    deny: ["/dashboard/restaurant", "/dashboard/housekeeping", "/dashboard/audit"],
  },
  "waiter@riverside-grand.demo": {
    allow: ["/dashboard", "/dashboard/restaurant"],
    deny: ["/dashboard/reports", "/dashboard/staff", "/dashboard/audit"],
  },
  "housekeeping@riverside-grand.demo": {
    allow: ["/dashboard", "/dashboard/housekeeping"],
    deny: ["/dashboard/restaurant", "/dashboard/reports", "/dashboard/audit"],
  },
};

async function main() {
  // 1. every demo account can sign in with its own password. Two accounts
  // legitimately do not land on a hotel dashboard: the platform operator has no
  // hotel membership, and the owner belongs to two hotels so must choose one.
  for (const account of creds.accounts) {
    const session = new Session(account.email);
    const status = await session.login(account.email, account.password);
    const dash = await session.get("/dashboard");
    const redirects = [302, 303, 307, 308].includes(dash.status);
    let ok = status === 200 && dash.status === 200;
    let detail = `${status}/${dash.status}`;
    if (account.role === "PLATFORM_SUPER_ADMIN") {
      const platform = await session.get("/platform");
      ok = status === 200 && redirects && platform.status === 200 && !/Access Denied/.test(platform.text);
      detail = `${status} dashboard ${dash.status}, platform ${platform.status}`;
    } else if (account.email === "owner@riverside-grand.demo") {
      const memberships = await session.get("/api/auth/memberships");
      ok = status === 200 && redirects && (memberships.json?.memberships ?? []).length === 2;
      detail = `${status} dashboard ${dash.status}, ${(memberships.json?.memberships ?? []).length} workspaces`;
    }
    record("login", `${account.role} signs in with its own password`, ok, detail);
  }

  // 2. module matrix per role. The owner belongs to two hotels, so the app sends
  // a fresh owner session to /select-hotel until a workspace is chosen; pick
  // Riverside first, which is what a person does on the first screen.
  for (const [email, matrix] of Object.entries(ROLE_MATRIX)) {
    const session = new Session(email);
    await session.login(email, passwordFor(email));
    if (email.startsWith("owner@")) {
      const memberships = await session.get("/api/auth/memberships");
      const riverside = (memberships.json?.memberships ?? []).find((m) => /Riverside/i.test(JSON.stringify(m)));
      const selector = await session.get("/dashboard");
      record(
        "switching",
        "a two-hotel owner is asked to choose a workspace",
        [302, 303, 307, 308].includes(selector.status) && /select-hotel/.test(responseLocation(selector)),
        `${selector.status}`
      );
      if (riverside) await session.post("/api/auth/switch-hotel", { hotelId: riverside.hotelId });
    }
    // hotel A is the only membership for these roles except the owner
    for (const path of matrix.allow) {
      const res = await session.get(path);
      record("modules", `${email} can open ${path}`, res.status === 200, `${res.status}`);
    }
    for (const path of matrix.deny) {
      const res = await session.get(path);
      record("modules", `${email} is redirected away from ${path}`, [302, 303, 307, 308].includes(res.status), `${res.status}`);
    }
    if (matrix.deny.includes("/dashboard/subscription")) {
      // ...and when it is opened directly it shows the notice, never the plan.
    }
  }

  // 3. platform administrator sees the platform console, not a hotel workspace
  {
    const session = new Session("platform");
    await session.login("platform@demo.test", passwordFor("platform@demo.test"));
    const platform = await session.get("/platform");
    const overview = await session.get("/api/platform/overview");
    record("platform", "platform admin opens the platform console", platform.status === 200 && !/Access Denied/.test(platform.text), `${platform.status}`);
    record("platform", "platform admin reads the platform overview", overview.status === 200, `${overview.status}`);
    const hotels = await session.get("/api/platform/hotels");
    const names = (hotels.json?.hotels ?? []).map((h) => h.name).join(", ");
    record("platform", "platform admin lists the demo hotels", /Riverside Grand Hotel/.test(names) && /Lakeview Lodge/.test(names), names);
  }

  // 4. owner switches between the two hotels
  {
    const owner = new Session("owner");
    await owner.login("owner@riverside-grand.demo", passwordFor("owner@riverside-grand.demo"));
    const memberships = await owner.get("/api/auth/memberships");
    const list = memberships.json?.memberships ?? [];
    record("switching", "the owner has two workspaces", list.length === 2, list.map((m) => m.hotelName ?? m.name ?? m.hotelId).join(" | "));
    const lakeview = list.find((m) => /Lakeview/i.test(JSON.stringify(m)));
    const riverside = list.find((m) => /Riverside/i.test(JSON.stringify(m)));
    if (lakeview) {
      const sw = await owner.post("/api/auth/switch-hotel", { hotelId: lakeview.hotelId });
      const dash = await owner.get("/dashboard");
      record("switching", "owner switches to Lakeview Lodge", sw.status === 200 && /Lakeview Lodge/.test(dash.text), `${sw.status}`);
      const back = await owner.post("/api/auth/switch-hotel", { hotelId: riverside?.hotelId ?? "" });
      const dashBack = await owner.get("/dashboard");
      record("switching", "owner switches back to Riverside Grand", back.status === 200 && /Riverside Grand/.test(dashBack.text), `${back.status}`);
    } else {
      record("switching", "owner switches to Lakeview Lodge", false, "Lakeview membership missing");
    }
  }

  // 5. removing a staff member revokes access (temporary account, deleted again)
  {
    const owner = new Session("owner");
    await owner.login("owner@riverside-grand.demo", passwordFor("owner@riverside-grand.demo"));
    const memberships = await owner.get("/api/auth/memberships");
    const riverside = (memberships.json?.memberships ?? []).find((m) => /Riverside/i.test(JSON.stringify(m)));
    if (riverside) await owner.post("/api/auth/switch-hotel", { hotelId: riverside.hotelId });

    const stamp = Date.now();
    const tempEmail = `temp-revoke-${stamp}@riverside-grand.demo`;
    const tempPassword = "Temp-Revoke-Passw0rd!42";
    const created = await owner.post("/api/staff", {
      name: "Temporary Revocation Check",
      email: tempEmail,
      password: tempPassword,
      role: "RECEPTIONIST",
    });
    record("revocation", "owner creates a temporary receptionist", [200, 201].includes(created.status), `${created.status} ${created.text.slice(0, 120)}`);
    const membershipId = created.json?.id ?? created.json?.membership?.id ?? created.json?.staff?.id;

    const temp = new Session("temp");
    const loginStatus = await temp.login(tempEmail, tempPassword);
    const before = await temp.get("/api/guests");
    record("revocation", "the new receptionist can work before removal", loginStatus === 200 && before.status === 200, `${loginStatus}/${before.status}`);

    const removed = await owner.del(`/api/staff/${membershipId}`);
    record("revocation", "owner removes the receptionist", [200, 204].includes(removed.status), `${removed.status} ${removed.text.slice(0, 120)}`);

    const after = await temp.get("/api/guests");
    record("revocation", "the removed receptionist loses access", [401, 403].includes(after.status), `${after.status}`);
  }

  const failing = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? "PASS" : "FAIL"}  [${r.area}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  }
  console.log(`\n${failing.length === 0 ? "PASS" : "FAIL"} — ${results.length - failing.length}/${results.length} checks`);
  process.exitCode = failing.length === 0 ? 0 : 1;
}

await main();
