#!/usr/bin/env node
/**
 * End-to-end PostgreSQL rehearsal for the SaaS migration strategy.
 *
 * Everything this script does happens inside disposable databases whose names
 * it generates; it refuses to run against anything that is not a loopback
 * endpoint, and it never reads `.env`, `DATABASE_URL` or `DIRECT_URL` from the
 * environment. That is deliberate: a rehearsal that can reach production is not
 * a rehearsal.
 *
 * Scenarios (see docs/migration-strategy.md and docs/saas-migration-rehearsal.md):
 *
 *   fresh-chain          apply all reviewed migrations to an empty database and
 *                        confirm the result is exactly the approved schema
 *   legacy-upgrade       original single-hotel schema + representative data,
 *                        then adopt + deploy through the tenancy conversion
 *   unmanaged-saas       SaaS schema through migration 17 with no ledger (the
 *                        deployed target's most likely shape), then adopt + deploy
 *   unmanaged-current    full schema with no ledger: adoption must record all
 *                        migrations and deploy nothing
 *   conflict-guard       a cross-tenant join row must abort migration 19 without
 *                        changing the schema, and converge after the repair
 *   empty-adopt          adopt an empty database and let the runner apply all
 *                        migrations through the ledger
 *   partial-rerun        re-applying the newest migrations is idempotent
 *
 * Usage:
 *
 *   REHEARSAL_BASE_URL=postgresql://postgres@127.0.0.1:55432 \
 *     PSQL_BIN=/path/to/psql node scripts/migration-rehearsal.mjs [--keep] [--only <id>]
 *
 * The PostgreSQL client and server should be the same major version as the
 * target (17). The script prints the server and client versions it used.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { queryJson, queryScalar, resolvePsql, psqlVersion, runPsql, PsqlError } from "./psql.mjs";
import {
  buildFeatureQuery,
  crlfWarnings,
  evaluateCheckpoints,
  readMigrations,
  readReleaseManifest,
  repoRoot,
  verifyReleaseManifest,
} from "./migration-ledger.mjs";

const SCRIPT_SOURCE = "scripts/migration-rehearsal.mjs";
const FIXTURE = path.join(repoRoot, "__tests__", "schema", "fixtures", "pre-saas-conversion.sql");

function parseArgs(argv) {
  const options = { keep: false, only: null, baseUrl: process.env.REHEARSAL_BASE_URL ?? null, psql: null, maintenance: "postgres", json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    const value = () => {
      if (inline !== null) return inline;
      index += 1;
      if (index >= argv.length) throw new Error(`${flag} requires a value.`);
      return argv[index];
    };
    switch (flag) {
      case "--keep":
        options.keep = true;
        break;
      case "--only":
        options.only = value();
        break;
      case "--base-url":
        options.baseUrl = value();
        break;
      case "--psql":
        options.psql = value();
        break;
      case "--maintenance-database":
        options.maintenance = value();
        break;
      case "--json":
        options.json = true;
        break;
      default:
        throw new Error(`Unknown option '${arg}'.`);
    }
  }
  return options;
}

class Assertions {
  constructor(scenario) {
    this.scenario = scenario;
    this.results = [];
  }

  equal(actual, expected, message) {
    const pass = JSON.stringify(actual) === JSON.stringify(expected);
    this.results.push({ pass, message, actual, expected });
    return pass;
  }

  ok(condition, message, detail = undefined) {
    this.results.push({ pass: Boolean(condition), message, detail });
    return Boolean(condition);
  }

  get failures() {
    return this.results.filter((result) => !result.pass);
  }
}

function requireLocalBaseUrl(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("REHEARSAL_BASE_URL (or --base-url) must be a valid postgres URL, e.g. postgresql://postgres@127.0.0.1:55432");
  }
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:") {
    throw new Error("REHEARSAL_BASE_URL must use the postgresql:// protocol.");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(
      `Refusing to rehearse against '${host}'. Rehearsals are only allowed on a disposable loopback PostgreSQL endpoint.`
    );
  }
  if (parsed.password) throw new Error("Rehearsal connection strings must not contain a password.");
  return parsed;
}

function databaseUrl(baseUrl, database) {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

function createContext(options, psqlBin) {
  const base = requireLocalBaseUrl(options.baseUrl);
  const prefix = `hotel_saas_rehearsal_${Date.now().toString(36)}`;
  const created = [];
  const migrations = readMigrations();
  for (const warning of crlfWarnings(migrations)) process.stderr.write(`! ${warning}\n`);
  const manifest = readReleaseManifest();

  const maintenanceUrl = databaseUrl(base.toString(), options.maintenance);

  const context = {
    migrations,
    manifest,
    psqlBin,
    baseUrl: base.toString(),
    get databaseNames() {
      return [...created];
    },
    serverVersion: queryScalar({ url: maintenanceUrl, psqlBin, sql: "SELECT current_setting('server_version');" }),
    serverAddress: queryScalar({ url: maintenanceUrl, psqlBin, sql: "SELECT coalesce(inet_server_addr()::text, 'unix-socket');" }),
    clientVersion: psqlVersion(psqlBin),

    async createDatabase(label) {
      const name = `${prefix}_${label}`.toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 60);
      runPsql({ url: maintenanceUrl, psqlBin, sql: `CREATE DATABASE "${name}" TEMPLATE template0;` });
      created.push(name);
      return { name, url: databaseUrl(base.toString(), name) };
    },

    async dropDatabase(name) {
      runPsql({ url: maintenanceUrl, psqlBin, sql: `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);` });
    },

    // Notices are expected on idempotent re-runs ("already exists, skipping");
    // they are suppressed so the rehearsal report only shows real results.
    applyMigration(database, migration, { quiet = true } = {}) {
      runPsql({ url: database.url, psqlBin, file: migration.sqlPath, quiet });
    },

    applyMigrations(database, slice, options = {}) {
      for (const migration of slice) context.applyMigration(database, migration, options);
    },

    query(database, sql) {
      return queryScalar({ url: database.url, psqlBin, sql });
    },

    queryOne(database, sql) {
      return queryJson({ url: database.url, psqlBin, sql });
    },

    features(database) {
      return queryJson({ url: database.url, psqlBin, sql: buildFeatureQuery() });
    },

    ledger(database) {
      const exists = context.query(database, `SELECT to_regclass('public."_prisma_migrations"') IS NOT NULL;`);
      if (exists !== "t") return [];
      const raw = context.query(
        database,
        `SELECT coalesce(json_agg(row_to_json(rows))::text, '[]') FROM (
           SELECT "migration_name", "checksum", "finished_at", "rolled_back_at", "applied_steps_count"
           FROM "_prisma_migrations" ORDER BY "started_at", "migration_name"
         ) rows;`
      );
      return JSON.parse(raw || "[]");
    },

    adopt(database, { execute = false, approvedBy = "rehearsal@localhost", applyPending = false } = {}) {
      const args = ["scripts/migrate-adopt.mjs", "--json"];
      if (execute) args.push("--execute", "--approved-by", approvedBy, "--confirm-database", database.name);
      if (applyPending) args.push("--apply-pending-with-psql");
      const result = spawnSync(process.execPath, args, {
        cwd: repoRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          SAAS_ENVIRONMENT: "saas",
          SAAS_DATABASE_IDENTIFIER: database.name,
          DIRECT_URL: database.url,
          DATABASE_URL: database.url,
          PSQL_BIN: psqlBin,
        },
      });
      let parsed = null;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        parsed = null;
      }
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, report: parsed };
    },

    async cleanup() {
      for (const name of created.reverse()) {
        try {
          await context.dropDatabase(name);
        } catch (error) {
          process.stderr.write(`Could not drop rehearsal database ${name}: ${error.message}\n`);
        }
      }
    },
  };

  return context;
}

const scenarios = [
  {
    id: "fresh-chain",
    description: "All reviewed migrations apply cleanly to an empty database and match the approved schema",
    async run(ctx, assert) {
      const db = await ctx.createDatabase("fresh");
      ctx.applyMigrations(db, ctx.migrations);

      const checkpoints = evaluateCheckpoints(await ctx.features(db));
      assert.equal(checkpoints, ["saas_current"], "fresh chain lands exactly on the saas_current checkpoint");
      assert.equal(ctx.ledger(db).length, 0, "raw psql application leaves no Prisma ledger");

      const dryRun = ctx.adopt(db);
      assert.ok(dryRun.status === 0, "dry-run adoption succeeds", dryRun.stderr);
      assert.equal(dryRun.report?.plan?.checkpoint?.id, "saas_current", "dry-run detects saas_current");
      assert.equal(dryRun.report?.plan?.baseline?.length, ctx.migrations.length, "dry-run plans to baseline every migration");
      assert.equal(dryRun.report?.plan?.pending?.length, 0, "dry-run finds nothing pending");
      assert.equal(ctx.ledger(db).length, 0, "dry-run is read-only (no ledger written)");

      const applied = ctx.adopt(db, { execute: true });
      assert.ok(applied.status === 0, "baseline execution succeeds", applied.stderr);
      const ledger = ctx.ledger(db);
      assert.equal(ledger.length, ctx.migrations.length, "every migration is recorded once");
      assert.equal(ledger.filter((row) => row.finished_at === null).length, 0, "no row is left unfinished");
      assert.equal(
        ledger.filter((row) => row.applied_steps_count !== 1).length,
        0,
        "applied_steps_count matches Prisma's single-step convention"
      );
      const checksums = new Map(ledger.map((row) => [row.migration_name, row.checksum]));
      const mismatches = ctx.migrations.filter((migration) => checksums.get(migration.name) !== migration.checksum);
      assert.equal(mismatches.map((m) => m.name), [], "ledger checksums equal the reviewed file hashes");

      const again = ctx.adopt(db, { execute: true });
      assert.ok(again.status === 0, "re-running adoption is a no-op", again.stderr);
      assert.equal(again.report?.plan?.baseline?.length, 0, "second run baselines nothing");
      assert.equal(ctx.ledger(db).length, ctx.migrations.length, "second run adds no rows");
    },
  },
  {
    id: "legacy-upgrade",
    description: "Single-hotel database with data converts to the SaaS schema without losing ownership",
    async run(ctx, assert) {
      const db = await ctx.createDatabase("legacy");
      const legacy = ctx.migrations.slice(0, 12);
      ctx.applyMigrations(db, legacy);
      runPsql({ url: db.url, psqlBin: ctx.psqlBin, file: FIXTURE, quiet: true });

      assert.equal(evaluateCheckpoints(await ctx.features(db)), ["legacy_single_hotel_through_11"], "legacy schema is recognised");

      const dryRun = ctx.adopt(db);
      assert.equal(dryRun.report?.plan?.checkpoint?.id, "legacy_single_hotel_through_11", "legacy schema is classified through migration 11");
      assert.equal(dryRun.report?.plan?.baseline?.length, 11, "baseline covers the legacy migrations only");
      assert.equal(
        dryRun.report?.plan?.pending?.length,
        8,
        "the data-only tariff migration and every later migration stay pending"
      );

      const upgrade = ctx.adopt(db, { execute: true, applyPending: true });
      assert.ok(upgrade.status === 0, "legacy upgrade succeeds", upgrade.stderr);
      assert.equal(ctx.ledger(db).length, ctx.migrations.length, "full history is recorded");
      assert.equal(evaluateCheckpoints(await ctx.features(db)), ["saas_current"], "upgraded database matches saas_current");

      const membership = ctx.queryOne(
        db,
        `SELECT json_build_object('role', role, 'hotelId', "hotelId", 'department', department)::text
         FROM "HotelMembership" WHERE "userId" = 'legacy-admin';`
      );
      assert.equal(membership, { role: "HOTEL_OWNER", hotelId: "legacy-hotel", department: "Legacy Operations" }, "legacy role and department survive");

      const room = ctx.queryOne(
        db,
        `SELECT json_build_object('hotelId', r."hotelId", 'mealPlan', rt."mealPlan")::text
         FROM "Room" r JOIN "RoomType" rt ON rt.id = r."roomTypeId" WHERE r.id = 'legacy-room';`
      );
      assert.equal(room, { hotelId: "legacy-hotel", mealPlan: "HALF_BOARD" }, "room keeps its hotel and meal plan");

      const category = ctx.queryOne(
        db,
        `SELECT json_build_object('categoryId', item."categoryId", 'count', count(c.id))::text
         FROM "MenuItem" item JOIN "MenuCategory" c ON c.id = item."categoryId"
         WHERE item.id = 'legacy-dessert-item' GROUP BY item."categoryId";`
      );
      assert.equal(category, { categoryId: "legacy-dessert-a", count: 1 }, "duplicate menu categories stay merged");

      const joins = ctx.queryOne(
        db,
        `SELECT json_build_object(
           'reservationRoom', (SELECT "hotelId" FROM "ReservationRoom" WHERE id = 'legacy-reservation-room'),
           'recipe', (SELECT "hotelId" FROM "Recipe" WHERE id = 'legacy-recipe'),
           'recipeIngredient', (SELECT "hotelId" FROM "RecipeIngredient" WHERE id = 'legacy-recipe-ingredient'),
           'orderItem', (SELECT "hotelId" FROM "OrderItem" WHERE id = 'legacy-order-item')
         )::text;`
      );
      assert.equal(
        joins,
        { reservationRoom: "legacy-hotel", recipe: "legacy-hotel", recipeIngredient: "legacy-hotel", orderItem: "legacy-hotel" },
        "join rows inherit the legacy hotel"
      );

      const notification = ctx.queryOne(
        db,
        `SELECT json_build_object('hotelId', "hotelId", 'message', message, 'type', type)::text
         FROM "Notification" WHERE id = 'legacy-notification';`
      );
      assert.equal(notification, { hotelId: "legacy-hotel", message: "Legacy notification body", type: "SYSTEM" }, "legacy notification is converted");

      const audit = ctx.queryOne(
        db,
        `SELECT json_build_object('hotelId', "hotelId", 'entity', entity, 'metadata', metadata)::text
         FROM "AuditLog" WHERE id = 'legacy-audit';`
      );
      assert.equal(audit.hotelId, "legacy-hotel", "legacy audit row is attached to the legacy hotel");
      assert.equal(audit.entity, "Reservation", "legacy audit entity survives the column rename");
      assert.equal(audit.metadata.before, { status: "PENDING" }, "legacy audit 'before' payload is preserved");
      assert.equal(audit.metadata.after, { status: "CONFIRMED" }, "legacy audit 'after' payload is preserved");
      assert.equal(audit.metadata.reason, "migration fixture", "legacy audit reason is preserved");

      const orphanCheck = ctx.query(
        db,
        `SELECT count(*) FROM "ReservationRoom" rr JOIN "Reservation" r ON r.id = rr."reservationId"
         WHERE rr."hotelId" IS DISTINCT FROM r."hotelId";`
      );
      assert.equal(orphanCheck, "0", "no join row disagrees with its parent after the upgrade");
    },
  },
  {
    id: "unmanaged-saas",
    description: "SaaS schema through migration 17 with no ledger adopts and deploys only the missing migrations",
    async run(ctx, assert) {
      const db = await ctx.createDatabase("saas17");
      ctx.applyMigrations(db, ctx.migrations.slice(0, 17));
      assert.equal(evaluateCheckpoints(await ctx.features(db)), ["saas_through_17"], "unmanaged SaaS schema is recognised");

      const dryRun = ctx.adopt(db);
      assert.equal(dryRun.report?.plan?.baseline?.length, 17, "seventeen migrations are baselined");
      assert.equal(
        dryRun.report?.plan?.pending,
        ["20261029120000_add_pos_charge_to_room_idempotency", "20261029130000_add_tenant_composite_join_fks"],
        "only the two new migrations are pending"
      );

      const deploy = ctx.adopt(db, { execute: true, applyPending: true });
      assert.ok(deploy.status === 0, "adopt + deploy succeeds", deploy.stderr);
      assert.equal(ctx.ledger(db).length, ctx.migrations.length, "history is complete after deploy");
      assert.equal(evaluateCheckpoints(await ctx.features(db)), ["saas_current"], "schema reaches saas_current");
      assert.equal(
        ctx.query(db, `SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NULL;`),
        "0",
        "no failed migration rows"
      );
    },
  },
  {
    id: "unmanaged-current",
    description: "Fully current schema with no ledger records history and deploys nothing",
    async run(ctx, assert) {
      const db = await ctx.createDatabase("current");
      ctx.applyMigrations(db, ctx.migrations);
      assert.equal(evaluateCheckpoints(await ctx.features(db)), ["saas_current"], "current schema is recognised");

      const adopt = ctx.adopt(db, { execute: true });
      assert.ok(adopt.status === 0, "adoption succeeds", adopt.stderr);
      assert.equal(adopt.report?.plan?.pending?.length, 0, "nothing is pending");
      assert.equal(ctx.ledger(db).length, ctx.migrations.length, "all migrations are recorded");
      assert.equal(evaluateCheckpoints(await ctx.features(db)), ["saas_current"], "schema is untouched");
    },
  },
  {
    id: "conflict-guard",
    description: "A cross-tenant join row aborts migration 19 without schema changes, then converges after repair",
    async run(ctx, assert) {
      const db = await ctx.createDatabase("conflict");
      ctx.applyMigrations(db, ctx.migrations.slice(0, 17));
      runPsql({
        url: db.url,
        psqlBin: ctx.psqlBin,
        quiet: true,
        input: `INSERT INTO "Hotel" (id, name, slug, "updatedAt") VALUES ('hotel-a', 'Hotel A', 'hotel-a', now()), ('hotel-b', 'Hotel B', 'hotel-b', now());
INSERT INTO "User" (id, name, email, "passwordHash", "updatedAt") VALUES ('staff-a', 'Staff A', 'staff-a@example.test', 'hash', now());
INSERT INTO "RoomType" (id, "hotelId", name, "baseRate", capacity, "updatedAt") VALUES ('rt-a', 'hotel-a', 'Standard', 100, 1, now()), ('rt-b', 'hotel-b', 'Standard', 100, 1, now());
INSERT INTO "Room" (id, "hotelId", number, "roomTypeId", "updatedAt") VALUES ('room-a', 'hotel-a', '101', 'rt-a', now()), ('room-b', 'hotel-b', '201', 'rt-b', now());
INSERT INTO "Guest" (id, "hotelId", "fullName", "updatedAt") VALUES ('guest-a', 'hotel-a', 'Guest A', now());
INSERT INTO "Reservation" (id, "hotelId", code, "guestId", "createdById", "checkInDate", "checkOutDate", "updatedAt")
  VALUES ('res-a', 'hotel-a', 'RES-A', 'guest-a', 'staff-a', now(), now() + interval '1 day', now());
INSERT INTO "ReservationRoom" (id, "reservationId", "roomId", rate) VALUES ('rr-bad', 'res-a', 'room-b', 100);`,
      });

      const deploy = ctx.adopt(db, { execute: true, applyPending: true });
      assert.ok(deploy.status !== 0, "deploy fails on the cross-tenant link");
      const message = `${deploy.report?.plan?.problems?.join(" ") ?? ""} ${deploy.stderr ?? ""}`;
      assert.ok(/ReservationRoom/.test(message), "failure names the offending table", message);

      const ledgerAfterFailure = ctx.ledger(db).map((row) => row.migration_name);
      assert.equal(ledgerAfterFailure.length, 18, "migration 18 is recorded and 19 is not");
      assert.equal(ledgerAfterFailure.includes("20261029130000_add_tenant_composite_join_fks"), false, "migration 19 is not recorded");
      assert.equal(
        ctx.query(db, `SELECT count(*) FROM information_schema.columns
                        WHERE table_schema = 'public' AND table_name = 'ReservationRoom' AND column_name = 'hotelId';`),
        "0",
        "no tenant column was added to ReservationRoom"
      );
      assert.equal(
        ctx.query(db, `SELECT count(*) FROM "ReservationRoom" WHERE id = 'rr-bad' AND "roomId" = 'room-b';`),
        "1",
        "conflicting data is left untouched"
      );

      runPsql({ url: db.url, psqlBin: ctx.psqlBin, sql: `DELETE FROM "ReservationRoom" WHERE id = 'rr-bad';` });
      const repaired = ctx.adopt(db, { execute: true, applyPending: true });
      assert.ok(repaired.status === 0, "deploy succeeds after the repair", repaired.stderr);
      assert.equal(ctx.ledger(db).length, ctx.migrations.length, "history completes after repair");
      assert.equal(evaluateCheckpoints(await ctx.features(db)), ["saas_current"], "schema reaches saas_current");
    },
  },
  {
    id: "empty-adopt",
    description: "An empty database is adopted and every migration is applied through the ledger",
    async run(ctx, assert) {
      const db = await ctx.createDatabase("empty");
      assert.equal(evaluateCheckpoints(await ctx.features(db)), ["empty"], "empty database is recognised");

      const dryRun = ctx.adopt(db);
      assert.equal(dryRun.report?.plan?.baseline?.length, 0, "nothing is baselined on an empty database");
      assert.equal(dryRun.report?.plan?.pending?.length, ctx.migrations.length, "all migrations are pending");

      const deploy = ctx.adopt(db, { execute: true, applyPending: true });
      assert.ok(deploy.status === 0, "empty database deploys", deploy.stderr);
      assert.equal(ctx.ledger(db).length, ctx.migrations.length, "history is complete");
      assert.equal(evaluateCheckpoints(await ctx.features(db)), ["saas_current"], "schema reaches saas_current");
    },
  },
  {
    id: "checkpoint-ladder",
    description: "Every intermediate schema state is classified correctly by the checkpoints",
    async run(ctx, assert) {
      const db = await ctx.createDatabase("ladder");
      // Expected classification after each migration prefix (1..19). Index 0 is
      // the empty database. "none" means the state is deliberately not
      // recognised, so adoption would refuse to guess.
      const expected = [
        "empty",
        "none",
        "none",
        "none",
        "none",
        "none",
        "none",
        "none",
        "none",
        "none",
        "none",
        "legacy_single_hotel_through_11",
        "legacy_single_hotel_through_11",
        "saas_through_081",
        "saas_through_14",
        "saas_through_15",
        "saas_through_16",
        "saas_through_17",
        "saas_through_18",
        "saas_current",
      ];
      assert.equal(expected.length, ctx.migrations.length + 1, "ladder covers every migration prefix");

      for (let applied = 0; applied <= ctx.migrations.length; applied += 1) {
        const detected = evaluateCheckpoints(await ctx.features(db));
        const want = expected[applied];
        assert.equal(
          detected,
          want === "none" ? [] : [want],
          `state after ${applied} migration(s) is classified as ${want}`
        );
        if (applied < ctx.migrations.length) ctx.applyMigration(db, ctx.migrations[applied]);
      }
    },
  },
  {
    id: "partial-rerun",
    description: "The two newest migrations can be re-applied without error after an interrupted deploy",
    async run(ctx, assert) {
      const db = await ctx.createDatabase("rerun");
      ctx.applyMigrations(db, ctx.migrations);
      let failure = null;
      try {
        ctx.applyMigrations(db, ctx.migrations.slice(-2));
      } catch (error) {
        failure = error.message;
      }
      assert.ok(failure === null, "re-applying migrations 18 and 19 is a no-op", failure);
      assert.equal(evaluateCheckpoints(await ctx.features(db)), ["saas_current"], "re-run leaves the approved schema");
    },
  },
];

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }
  if (!options.baseUrl) {
    process.stderr.write("REHEARSAL_BASE_URL (or --base-url) is required, e.g. postgresql://postgres@127.0.0.1:55432\n");
    return 2;
  }

  const psqlBin = resolvePsql(options.psql);
  let ctx;
  try {
    ctx = createContext(options, psqlBin);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 2;
  }

  const manifestCheck = verifyReleaseManifest(ctx.migrations, ctx.manifest);
  const selected = options.only ? scenarios.filter((scenario) => scenario.id === options.only) : scenarios;
  if (selected.length === 0) {
    process.stderr.write(`No scenario named '${options.only}'. Known: ${scenarios.map((s) => s.id).join(", ")}\n`);
    return 2;
  }

  const report = {
    source: SCRIPT_SOURCE,
    startedAt: new Date().toISOString(),
    serverVersion: ctx.serverVersion,
    serverAddress: ctx.serverAddress,
    psqlClient: ctx.clientVersion,
    migrationCount: ctx.migrations.length,
    manifestProblems: manifestCheck.problems,
    scenarios: [],
  };

  if (!options.json) {
    process.stdout.write(`PostgreSQL rehearsal (${SCRIPT_SOURCE})\n`);
    process.stdout.write(`  server : ${ctx.serverVersion} at ${ctx.serverAddress}\n`);
    process.stdout.write(`  client : ${ctx.clientVersion}\n`);
    process.stdout.write(`  files  : ${ctx.migrations.length} reviewed migrations\n`);
    if (manifestCheck.problems.length > 0) {
      process.stdout.write(`  WARNING: release manifest problems: ${manifestCheck.problems.join("; ")}\n`);
    }
    process.stdout.write("\n");
  }

  try {
    for (const scenario of selected) {
      const assert = new Assertions(scenario);
      const started = Date.now();
      let error = null;
      try {
        await scenario.run(ctx, assert);
      } catch (caught) {
        error = caught instanceof PsqlError ? `psql: ${caught.message}` : caught.message;
      }
      const passed = error === null && assert.failures.length === 0;
      report.scenarios.push({
        id: scenario.id,
        description: scenario.description,
        passed,
        durationMs: Date.now() - started,
        error,
        assertions: assert.results,
      });
      if (!options.json) {
        process.stdout.write(`${passed ? "PASS" : "FAIL"}  ${scenario.id} — ${scenario.description}\n`);
        if (error) process.stdout.write(`      error: ${error}\n`);
        for (const failure of assert.failures) {
          process.stdout.write(`      ✗ ${failure.message}\n`);
          if (failure.detail) process.stdout.write(`        detail: ${String(failure.detail).slice(0, 400)}\n`);
          if (failure.actual !== undefined) {
            process.stdout.write(`        actual:   ${JSON.stringify(failure.actual)}\n`);
            process.stdout.write(`        expected: ${JSON.stringify(failure.expected)}\n`);
          }
        }
      }
    }
  } finally {
    if (!options.keep) await ctx.cleanup();
    else process.stdout.write(`\nKept rehearsal databases: ${ctx.databaseNames?.join(", ") ?? "(see names above)"}\n`);
  }

  const failed = report.scenarios.filter((scenario) => !scenario.passed);
  report.passed = failed.length === 0 && manifestCheck.problems.length === 0;
  report.finishedAt = new Date().toISOString();

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const assertions = report.scenarios.reduce((total, scenario) => total + scenario.assertions.length, 0);
    process.stdout.write(
      `\n${report.passed ? "REHEARSAL PASSED" : "REHEARSAL FAILED"}: ` +
        `${report.scenarios.length - failed.length}/${report.scenarios.length} scenarios, ${assertions} assertions\n`
    );
  }

  return report.passed ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    process.stderr.write(`Rehearsal crashed: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  }
);
