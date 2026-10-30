#!/usr/bin/env node
/**
 * Read-only integrity checks for a restored hotel database.
 *
 * Why this exists
 * ---------------
 * A restore rehearsal proves that the archive loads. It does not prove that what
 * loaded is internally consistent: a tenant-scoped row can point at a hotel that
 * no longer exists, a child row can claim a different hotel from its parent, or a
 * sequence can be behind the table it feeds. Those are the failures that turn a
 * "successful" restore into silent cross-tenant data leakage or duplicate-key
 * errors on the first write.
 *
 * Every check is a single SQL statement the caller can read before running it.
 * The module is split so the statements are testable against a real schema
 * (PGlite, in the tests) without a server, and the CLI runs them through `psql`
 * in a read-only session against a restored database.
 *
 * Safety: the session is opened with `default_transaction_read_only=on`, and a
 * non-loopback target is refused unless `--allow-remote-target` is passed.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { queryJson, queryScalar, PsqlError, resolvePsql } from "./psql.mjs";

/** Every application table the migrations should create. */
export const EXPECTED_TABLES = [
  "AuditLog",
  "Expense",
  "Folio",
  "FolioItem",
  "Guest",
  "Hotel",
  "HotelMembership",
  "HousekeepingTask",
  "InventoryItem",
  "MaintenanceTicket",
  "MenuCategory",
  "MenuItem",
  "Notification",
  "Order",
  "OrderItem",
  "Payment",
  "PaymentMethod",
  "Purchase",
  "Recipe",
  "RecipeIngredient",
  "Reservation",
  "ReservationRoom",
  "Room",
  "RoomType",
  "StockMovement",
  "Subscription",
  "User",
  "Wastage",
];

/**
 * Tables that carry their own `hotelId`.
 *
 * `AuditLog` is nullable on purpose: platform-level events have no hotel.
 * `FolioItem` has no `hotelId` at all — it is scoped through its folio, which is
 * why the cross-tenant checks below join through the parent instead.
 */
export const HOTEL_OWNED_TABLES = [
  "Subscription",
  "HotelMembership",
  "RoomType",
  "Room",
  "Guest",
  "Reservation",
  "ReservationRoom",
  "Folio",
  "PaymentMethod",
  "Payment",
  "HousekeepingTask",
  "MaintenanceTicket",
  "MenuCategory",
  "MenuItem",
  "Order",
  "OrderItem",
  "InventoryItem",
  "Recipe",
  "RecipeIngredient",
  "StockMovement",
  "Purchase",
  "Wastage",
  "Expense",
  "Notification",
];

/** Hotel-owned tables whose `hotelId` may legitimately be null. */
export const NULLABLE_HOTEL_ID = new Set(["AuditLog"]);

/**
 * Child rows that must share their parent's hotel.
 *
 * Each entry is a real foreign key, so a mismatch means either the constraint is
 * missing or the data predates it — both are integrity failures worth reporting.
 */
export const TENANT_RELATIONS = [
  { child: "Room", column: "roomTypeId", parent: "RoomType" },
  { child: "Reservation", column: "guestId", parent: "Guest" },
  { child: "ReservationRoom", column: "reservationId", parent: "Reservation" },
  { child: "ReservationRoom", column: "roomId", parent: "Room" },
  { child: "Folio", column: "guestId", parent: "Guest" },
  { child: "Folio", column: "reservationId", parent: "Reservation" },
  { child: "Payment", column: "folioId", parent: "Folio" },
  { child: "Payment", column: "paymentMethodId", parent: "PaymentMethod" },
  { child: "HousekeepingTask", column: "roomId", parent: "Room" },
  { child: "MaintenanceTicket", column: "roomId", parent: "Room" },
  { child: "MenuItem", column: "categoryId", parent: "MenuCategory" },
  { child: "OrderItem", column: "orderId", parent: "Order" },
  { child: "OrderItem", column: "menuItemId", parent: "MenuItem" },
  { child: "Recipe", column: "menuItemId", parent: "MenuItem" },
  { child: "RecipeIngredient", column: "recipeId", parent: "Recipe" },
  { child: "RecipeIngredient", column: "inventoryItemId", parent: "InventoryItem" },
  { child: "StockMovement", column: "inventoryItemId", parent: "InventoryItem" },
  { child: "Purchase", column: "inventoryItemId", parent: "InventoryItem" },
  { child: "Wastage", column: "inventoryItemId", parent: "InventoryItem" },
  { child: "Order", column: "folioId", parent: "Folio" },
];

const q = (identifier) => `"${identifier}"`;

/**
 * psql prints rows as text, one tuple per line. Every check is therefore run
 * inside a JSON envelope so the CLI can parse it deterministically, whatever
 * the check returns (a list, a single count, or a UNION of per-table counts).
 */
export function wrapAsJson(sql) {
  return `SELECT coalesce(json_agg(row_to_json(_check)), '[]'::json) AS rows FROM (\n${sql.trim().replace(/;\s*$/, "")}\n) _check`;
}

/**
 * The checks, as data. `kind: "count"` means a non-zero result is a failure;
 * `kind: "list"` returns rows that are reported as-is (missing tables).
 */
export function buildChecks({ expectedTables = EXPECTED_TABLES, hotelOwnedTables = HOTEL_OWNED_TABLES, relations = TENANT_RELATIONS } = {}) {
  const checks = [
    {
      id: "tables.present",
      kind: "list",
      description: "every expected application table exists",
      sql: `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
      expected: expectedTables,
    },
    {
      id: "hotel.orphans",
      kind: "count",
      description: "tenant-scoped rows whose hotel no longer exists",
      sql: hotelOwnedTables
        .map(
          (table) =>
            `SELECT '${table}' AS table_name, count(*)::bigint AS violations FROM ${q(table)} t ` +
            `WHERE NOT EXISTS (SELECT 1 FROM "Hotel" h WHERE h.id = t."hotelId")`
        )
        .join(" UNION ALL "),
      // The union is read row-by-row below; the CLI sums the `violations` column.
      unioned: true,
    },
  ];

  for (const table of hotelOwnedTables) {
    if (NULLABLE_HOTEL_ID.has(table)) continue;
    checks.push({
      id: `hotel.null:${table}`,
      kind: "count",
      description: `${table} rows without a hotel`,
      sql: `SELECT count(*)::bigint FROM ${q(table)} WHERE "hotelId" IS NULL`,
    });
  }

  for (const relation of relations) {
    checks.push({
      id: `tenant.mismatch:${relation.child}.${relation.column}`,
      kind: "count",
      description: `${relation.child}.${relation.column} points at a ${relation.parent} in another hotel`,
      sql:
        `SELECT count(*)::bigint FROM ${q(relation.child)} c JOIN ${q(relation.parent)} p ` +
        `ON p.id = c.${q(relation.column)} WHERE c."hotelId" <> p."hotelId"`,
    });
  }

  // Structural checks: the data checks above can only pass if the schema
  // actually enforces them. Ids are UUID strings, so there are no sequences to
  // inspect; what matters is that every tenant relation is a real foreign key
  // and that hotel-scoped lookups have an index.
  checks.push({
    id: "constraints.tenant-fk",
    kind: "list",
    description: "every tenant relation is enforced by a foreign key",
    sql:
      `SELECT DISTINCT c.conrelid::regclass::text AS child, a.attname AS column ` +
      `FROM pg_constraint c ` +
      `JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey) ` +
      `WHERE c.contype = 'f'`,
    verdict(rows) {
      const present = new Set(
        rows.map((row) => `${String(row.child).replace(/"/g, "")}.${row.column}`)
      );
      const missing = relations
        .filter((relation) => !present.has(`${relation.child}.${relation.column}`))
        .map((relation) => `${relation.child}.${relation.column}`);
      return missing.length
        ? { ok: false, detail: `no foreign key: ${missing.join(", ")}` }
        : { ok: true };
    },
  });

  checks.push({
    id: "indexes.hotelId",
    kind: "list",
    description: "hotel-scoped tables have an index that covers hotelId",
    sql: `SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = 'public'`,
    verdict(rows) {
      const covered = new Set(
        rows.filter((row) => /"hotelId"|hotelId/.test(row.indexdef)).map((row) => row.tablename)
      );
      const missing = hotelOwnedTables.filter((table) => !covered.has(table));
      return missing.length
        ? { ok: false, detail: `no hotelId index: ${missing.join(", ")}` }
        : { ok: true };
    },
  });

  return checks;
}

/** Turn raw check results into a verdict. Pure, so it can be unit-tested. */
export function evaluateResults(results) {
  const failures = [];
  const warnings = [];

  for (const result of results) {
    if (typeof result.verdict === "function") {
      const outcome = result.verdict(result.rows);
      if (!outcome.ok) {
        failures.push({ id: result.id, description: result.description, detail: outcome.detail ?? "failed" });
      }
      continue;
    }

    if (result.kind === "list") {
      // `list` checks without `expected` are inventories (row counts), not
      // completeness assertions: they are reported, never failed on.
      if (!Array.isArray(result.expected)) continue;
      const present = new Set(result.rows.map((row) => row.table_name));
      const missing = result.expected.filter((table) => !present.has(table));
      if (missing.length) {
        failures.push({ id: result.id, description: result.description, detail: `missing: ${missing.join(", ")}` });
      }
      continue;
    }

    if (result.unioned) {
      const offenders = result.rows.filter((row) => Number(row.violations) > 0);
      if (offenders.length) {
        failures.push({
          id: result.id,
          description: result.description,
          detail: offenders.map((row) => `${row.table_name}=${row.violations}`).join(", "),
        });
      }
      continue;
    }

    const violations = Number(result.rows[0]?.count ?? result.value ?? 0);
    if (violations > 0) {
      failures.push({ id: result.id, description: result.description, detail: `${violations} row(s)` });
    }
  }

  return { ok: failures.length === 0, failures, warnings, checked: results.length };
}

const formatBytes = (n) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

export function formatReport({ target, results, verdict }) {
  const lines = [];
  lines.push("");
  lines.push("Database integrity check (read-only)");
  lines.push("------------------------------------");
  lines.push(`Target            : ${target}`);
  lines.push(`Checks run        : ${verdict.checked}`);
  const rowCounts = results.find((r) => r.id === "row.counts");
  if (rowCounts) {
    const populated = rowCounts.rows.filter((row) => Number(row.rows) > 0);
    lines.push(`Tables with data  : ${populated.length} of ${rowCounts.rows.length}`);
  }
  if (verdict.failures.length === 0) {
    lines.push("Result            : PASS — no integrity violations found");
  } else {
    lines.push(`Result            : FAIL — ${verdict.failures.length} check(s) failed`);
    for (const failure of verdict.failures) {
      lines.push(`  ! ${failure.id}: ${failure.description} (${failure.detail})`);
    }
  }
  return `${lines.join("\n")}\n`;
}

/** Row counts for the operator's checklist. */
export function buildRowCountCheck(tables = EXPECTED_TABLES) {
  return {
    id: "row.counts",
    kind: "list",
    description: "row counts per application table",
    sql: tables.map((table) => `SELECT '${table}' AS table_name, count(*)::bigint AS rows FROM ${q(table)}`).join(" UNION ALL "),
  };
}

const USAGE = `Usage: node scripts/db-integrity.mjs [options]

Runs read-only integrity checks against a restored hotel database: expected
tables, tenant orphans, cross-hotel relationships, and a row-count inventory.

Options:
  --url <postgres-url>       Database to check. Default: DIRECT_URL, then
                             DATABASE_URL.
  --json                     Print machine-readable output.
  --allow-remote-target      Permit a non-loopback host. Only for a disposable
                             restored copy — never the live database.
  --psql <path>              psql binary (default PSQL_BIN, then PATH).
  --help, -h                 Show this text.
`;

function main(argv) {
  const options = {
    url: null,
    json: false,
    allowRemote: false,
    help: false,
    psql: process.env.PSQL_BIN || undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--url":
        options.url = argv[++i] ?? null;
        if (!options.url) return fail("--url requires a value.", 2);
        break;
      case "--json":
        options.json = true;
        break;
      case "--allow-remote-target":
        options.allowRemote = true;
        break;
      case "--psql":
        options.psql = argv[++i] ?? null;
        if (!options.psql) return fail("--psql requires a value.", 2);
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        return fail(`Unknown option '${arg}'.\n\n${USAGE}`, 2);
    }
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const raw = options.url || process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (!raw) {
    return fail("No database configured: pass --url or set DIRECT_URL / DATABASE_URL.\n", 1);
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return fail("The database URL is not a valid URL (it is never echoed, since it may hold a password).\n", 1);
  }
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
  if (!loopback && !options.allowRemote) {
    return fail(
      `Refusing to inspect '${parsed.hostname}': these checks are for a restored, disposable copy.\n` +
        "If that host really is disposable, re-run with --allow-remote-target.\n",
      1
    );
  }

  const psqlArgs = { url: raw, psqlBin: resolvePsql(options.psql), singleTransaction: true };

  try {
    const results = [];
    const checks = [...buildChecks(), buildRowCountCheck()];
    for (const check of checks) {
      const document = queryJson({ ...psqlArgs, sql: wrapAsJson(check.sql) });
      results.push({ ...check, rows: Array.isArray(document) ? document : document.rows ?? [] });
    }

    const verdict = evaluateResults(results);
    const report = { target: `${parsed.hostname}/${parsed.pathname.replace(/^\//, "")}`, results, verdict };

    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report)
    );
    return verdict.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof PsqlError) {
      return fail(`${error.message}\n`, 1);
    }
    throw error;
  }
}

function fail(message, code) {
  process.stderr.write(message);
  return code;
}

const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
