#!/usr/bin/env node
/**
 * Owner acceptance-testing environment.
 *
 * Creates and manages a completely separate, disposable PostgreSQL server and
 * demo database for the owner to test against. Nothing here reads or writes the
 * project's `.env.local`, the disposable verification cluster, or any other
 * database: the connection string is built from `.owner-test/` alone and always
 * points at loopback plus a `hotel_saas_demo_*` database name.
 *
 *   node scripts/owner-test-env.mjs setup     # first run: toolchain, cluster, migrate, seed
 *   node scripts/owner-test-env.mjs reset     # wipe the demo data and re-seed (code untouched)
 *   node scripts/owner-test-env.mjs start     # start PostgreSQL if it is stopped
 *   node scripts/owner-test-env.mjs status    # is it running, what is in it
 *   node scripts/owner-test-env.mjs stop      # stop PostgreSQL
 *   node scripts/owner-test-env.mjs url       # print DATABASE_URL for manual use
 *   node scripts/owner-test-env.mjs credentials  # print the demo logins (0600 file)
 *   node scripts/owner-test-env.mjs app       # build if needed, then serve
 *
 * `npm run owner:env -- <command>` does the same thing.
 *
 * Everything it creates lives in `.owner-test/`, which is git-ignored:
 *   .owner-test/postgresql-17.x/  server + client binaries
 *   .owner-test/pgdata/            the cluster
 *   .owner-test/credentials.json   demo logins for this run (0600)
 */

import { execFileSync, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomInt } from "node:crypto";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE = join(ROOT, ".owner-test");
const PG_VERSION = "17.11.0";
const PORT = Number(process.env.OWNER_TEST_PG_PORT ?? 55433);
const DATABASE = (() => {
  const name = process.env.OWNER_TEST_DB ?? "hotel_saas_demo_owner";
  // "reset" drops this database. Refuse anything that is not a demo database by
  // name, so a stray OWNER_TEST_DB cannot point the destructive commands at a
  // real one. The cluster itself only listens on 127.0.0.1.
  if (!/^hotel_saas_demo_[a-z0-9][a-z0-9_-]*$/i.test(name)) {
    process.stderr.write(`\nRefusing to use database "${name}": the owner demo environment only manages databases named hotel_saas_demo_*\n`);
    process.exit(1);
  }
  return name;
})();
const URL = `postgresql://postgres@127.0.0.1:${PORT}/${DATABASE}`;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`\n${message}\n`);
  process.exit(1);
}

function findPgRoot() {
  if (!existsSync(STATE)) return null;
  const entry = readdirSync(STATE).find((name) => /^postgresql-\d+\.\d+/.test(name));
  return entry ? join(STATE, entry) : null;
}

function pgBin(pgRoot, name) {
  return join(pgRoot, "bin", name);
}

function pgEnv(pgRoot) {
  return {
    ...process.env,
    PATH: `${join(pgRoot, "bin")}:${process.env.PATH ?? ""}`,
    LD_LIBRARY_PATH: `${join(pgRoot, "lib")}:${process.env.LD_LIBRARY_PATH ?? ""}`,
  };
}

function run(command, args, extraEnv = {}, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: options.capture ? "pipe" : "inherit",
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0 && !options.allowFailure) {
    fail(`${command} ${args.join(" ")} failed (exit ${result.status ?? "signal"}).`);
  }
  return result;
}

// ---------------------------------------------------------------------------
// PostgreSQL toolchain
// ---------------------------------------------------------------------------

const PYPI = `https://pypi.org/pypi/postgresql-binaries/${PG_VERSION}/json`;

async function ensurePostgresBinaries() {
  const existing = findPgRoot();
  if (existing && existsSync(pgBin(existing, "initdb"))) {
    log(`PostgreSQL binaries: ${existing}`);
    return existing;
  }

  mkdirSync(STATE, { recursive: true });
  log(`Downloading PostgreSQL ${PG_VERSION} binaries from PyPI (once)…`);
  const meta = await (await fetch(PYPI)).json();
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  const wheel = meta.urls.find((u) => u.filename.includes(`manylinux_2_17_${arch}`));
  if (!wheel) fail(`No manylinux ${arch} wheel for postgresql-binaries ${PG_VERSION}.`);

  const archive = join(STATE, "postgresql.tar.gz");
  const response = await fetch(wheel.url);
  if (!response.ok) fail(`Download failed: HTTP ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(archive));

  // The wheel is a zip that contains the server tarball.
  execFileSync("python3", ["-c", `import zipfile;zipfile.ZipFile(${JSON.stringify(archive)}).extractall(${JSON.stringify(join(STATE, "wheel"))})`], { stdio: "inherit" });
  const inner = join(STATE, "wheel", "postgresql_binaries", `postgresql-${PG_VERSION}-x86_64-unknown-linux-gnu.tar.gz`);
  const innerArm = join(STATE, "wheel", "postgresql_binaries", `postgresql-${PG_VERSION}-aarch64-unknown-linux-gnu.tar.gz`);
  const tarball = existsSync(inner) ? inner : innerArm;
  if (!existsSync(tarball)) fail("The PostgreSQL tarball was not found inside the downloaded wheel.");

  execFileSync("tar", ["xzf", tarball, "-C", STATE], { stdio: "inherit" });
  rmSync(join(STATE, "wheel"), { recursive: true, force: true });
  rmSync(archive, { force: true });

  const pgRoot = findPgRoot();
  if (!pgRoot) fail("Extraction did not produce a PostgreSQL directory.");
  log(`PostgreSQL binaries: ${pgRoot}`);
  return pgRoot;
}

function clusterIsRunning(pgRoot) {
  const result = spawnSync(pgBin(pgRoot, "pg_isready"), ["-h", "127.0.0.1", "-p", String(PORT)], {
    encoding: "utf8",
    env: pgEnv(pgRoot),
  });
  return result.status === 0;
}

function ensureCluster(pgRoot) {
  const dataDir = join(STATE, "pgdata");
  if (!existsSync(join(dataDir, "PG_VERSION"))) {
    log("Initialising the demo cluster…");
    run(pgBin(pgRoot, "initdb"), ["-D", dataDir, "--auth=trust", "-U", "postgres"], pgEnv(pgRoot));
  }
  if (!clusterIsRunning(pgRoot)) {
    log(`Starting PostgreSQL on 127.0.0.1:${PORT}…`);
    run(
      pgBin(pgRoot, "pg_ctl"),
      ["-D", dataDir, "-o", `-p ${PORT} -c listen_addresses=127.0.0.1 -k ${STATE}`, "-l", join(STATE, "pg.log"), "-w", "start"],
      pgEnv(pgRoot)
    );
  }
  return dataDir;
}

function psql(pgRoot, args, options = {}) {
  return run(pgBin(pgRoot, "psql"), ["-h", "127.0.0.1", "-p", String(PORT), "-U", "postgres", ...args], pgEnv(pgRoot), options);
}

function databaseExists(pgRoot) {
  const result = psql(pgRoot, ["-d", "postgres", "-tAc", `SELECT 1 FROM pg_database WHERE datname = '${DATABASE}'`], {
    capture: true,
    allowFailure: true,
  });
  return (result.stdout ?? "").trim() === "1";
}

// ---------------------------------------------------------------------------
// Schema and demo data
// ---------------------------------------------------------------------------

function applyMigrations(pgRoot) {
  const dir = join(ROOT, "prisma", "migrations");
  const migrations = readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort();
  log(`Applying ${migrations.length} migrations…`);
  for (const name of migrations) {
    const file = join(dir, name, "migration.sql");
    if (!existsSync(file)) continue;
    psql(pgRoot, ["-d", DATABASE, "-v", "ON_ERROR_STOP=1", "-q", "-f", file]);
  }
  const tables = psql(pgRoot, ["-d", DATABASE, "-tAc", "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"], {
    capture: true,
  });
  log(`Schema ready: ${(tables.stdout ?? "").trim()} tables.`);
}

function seedDemo() {
  log("Seeding demo hotels, staff and business data…");
  run("npx", ["tsx", "scripts/owner-test/seed-demo.ts"], {
    DATABASE_URL: URL,
    DIRECT_URL: URL,
    SAAS_ENVIRONMENT: "local",
    SAAS_ALLOW_LOCAL_DEMO_SEED: "true",
    NODE_ENV: "development",
  });
}

function resetDatabase(pgRoot) {
  log(`Re-creating ${DATABASE} (this drops only the demo database)…`);
  psql(pgRoot, ["-d", "postgres", "-c", `DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`]);
  psql(pgRoot, ["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`]);
  applyMigrations(pgRoot);
  seedDemo();
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function commandSetup() {
  const pgRoot = await ensurePostgresBinaries();
  ensureCluster(pgRoot);
  if (!databaseExists(pgRoot)) {
    psql(pgRoot, ["-d", "postgres", "-c", `CREATE DATABASE ${DATABASE}`]);
    applyMigrations(pgRoot);
    seedDemo();
  } else {
    log(`Database ${DATABASE} already exists; leaving its data alone. Use "reset" to re-seed.`);
  }
  randomIntSecret(); // stable session secret for every restart of this environment
  printSummary();
}

async function commandReset() {
  const pgRoot = await ensurePostgresBinaries();
  ensureCluster(pgRoot);
  resetDatabase(pgRoot);
  randomIntSecret(); // sessions survive a reset if the secret is unchanged
  printSummary();
}

async function commandStart() {
  const pgRoot = await ensurePostgresBinaries();
  ensureCluster(pgRoot);
  printSummary();
}

async function commandStop() {
  const pgRoot = findPgRoot();
  if (!pgRoot) fail("Nothing to stop: the demo cluster has not been created yet.");
  if (clusterIsRunning(pgRoot)) {
    run(pgBin(pgRoot, "pg_ctl"), ["-D", join(STATE, "pgdata"), "-m", "fast", "stop"], pgEnv(pgRoot));
  }
  log("Demo PostgreSQL stopped. Your code and data are untouched.");
}

async function commandStatus() {
  const pgRoot = findPgRoot();
  if (!pgRoot) {
    log("Demo environment: not created yet. Run: node scripts/owner-test-env.mjs setup");
    return;
  }
  const running = clusterIsRunning(pgRoot);
  log(`PostgreSQL: ${running ? `running on 127.0.0.1:${PORT}` : "stopped"}`);
  if (!running) return;
  if (!databaseExists(pgRoot)) {
    log(`Database ${DATABASE}: missing. Run "reset".`);
    return;
  }
  const counts = psql(
    pgRoot,
    ["-d", DATABASE, "-tAc", 'SELECT (SELECT count(*) FROM "Hotel"), (SELECT count(*) FROM "User"), (SELECT count(*) FROM "Reservation"), (SELECT count(*) FROM "Payment")'],
    { capture: true }
  );
  const [hotels, users, reservations, payments] = (counts.stdout ?? "").trim().split("|");
  log(`Database ${DATABASE}: ${hotels} hotels, ${users} users, ${reservations} reservations, ${payments} payments`);
  printSummary();
}

function printSummary() {
  log("");
  log("─".repeat(64));
  log(`Database URL : ${URL}`);
  log(`Credentials  : ${join(STATE, "credentials.json")} (one password per account)`);
  log(`Print them   : node scripts/owner-test-env.mjs credentials`);
  log("");
  log("Start the app against this environment with:");
  log(`  DATABASE_URL="${URL}" \\`);
  log(`  DIRECT_URL="${URL}" \\`);
  log(`  SAAS_ENVIRONMENT=saas SAAS_DATABASE_IDENTIFIER=${DATABASE} \\`);
  log("  npx next start -p 3000 -H 0.0.0.0");
  log("");
  log("Or simply: node scripts/owner-test-env.mjs app   (builds if needed, then starts)");
  log("─".repeat(64));
}

async function commandApp() {
  const pgRoot = await ensurePostgresBinaries();
  ensureCluster(pgRoot);
  if (!databaseExists(pgRoot)) fail(`Database ${DATABASE} does not exist yet. Run "setup" first.`);

  const baseUrl = process.env.OWNER_TEST_BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
  if (!existsSync(join(ROOT, ".next", "BUILD_ID"))) {
    build();
  }

  log(`Starting the app on ${baseUrl} …`);
  const child = spawnSync(
    "npx",
    ["next", "start", "-p", String(process.env.PORT ?? 3000), "-H", "0.0.0.0"],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        DATABASE_URL: URL,
        DIRECT_URL: URL,
        SAAS_ENVIRONMENT: "saas",
        SAAS_DATABASE_IDENTIFIER: DATABASE,
        NEXTAUTH_URL: baseUrl,
        NEXTAUTH_SECRET: process.env.NEXTAUTH_SECRET ?? randomIntSecret(),
        // The demo may be reached through a tunnel/preview host that is not
        // NEXTAUTH_URL. Without this the app answers its own fetch() calls with
        // 403 and hotel switching looks broken. It is a demo-only setting and is
        // not set by the production checklist.
        SAAS_ALLOW_REQUEST_HOST_ORIGIN: "true",
      },
    }
  );
  process.exitCode = child.status ?? 0;
}

/**
 * Build the production bundle. `npm run build` runs `prisma generate`, which
 * downloads the native query engine; on an offline workstation that download
 * fails. The fallback generates the client against the WASM runtime shim (fine
 * for testing, never for production) and builds directly, which is what the
 * verification runs in this repository use.
 */
function build() {
  log("No production build found; building first…");
  const full = run("npm", ["run", "build"], { DATABASE_URL: URL, DIRECT_URL: URL }, { allowFailure: true });
  if (full.status === 0) return;
  log("The full build could not fetch Prisma engines; falling back to the offline build path…");
  run("node", ["scripts/wasm-runtime-shim.mjs"], { DATABASE_URL: URL, DIRECT_URL: URL });
  run("npx", ["next", "build"], {
    DATABASE_URL: URL,
    DIRECT_URL: URL,
    SAAS_ENVIRONMENT: "saas",
    SAAS_DATABASE_IDENTIFIER: DATABASE,
  });
}

function commandCredentials() {
  const file = join(STATE, "CREDENTIALS.md");
  if (!existsSync(file)) fail(`No credentials yet. Run "setup" or "reset" first.`);
  process.stdout.write(readFileSync(file, "utf8"));
}

function randomIntSecret() {
  // A stable secret per environment keeps sessions valid across restarts.
  const file = join(STATE, "nextauth-secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  const secret = Array.from({ length: 48 }, () => randomInt(16).toString(16)).join("");
  mkdirSync(STATE, { recursive: true });
  execFileSync("sh", ["-c", `printf %s ${JSON.stringify(secret)} > ${JSON.stringify(file)} && chmod 600 ${JSON.stringify(file)}`]);
  return secret;
}

const commands = {
  setup: commandSetup,
  reset: commandReset,
  start: commandStart,
  stop: commandStop,
  status: commandStatus,
  app: commandApp,
  credentials: commandCredentials,
  url: async () => log(URL),
};

const command = process.argv[2] ?? "status";
if (!commands[command]) {
  fail(`Unknown command "${command}". Use one of: ${Object.keys(commands).join(", ")}.`);
}
await commands[command]();
