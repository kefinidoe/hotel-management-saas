#!/usr/bin/env node
/**
 * Shared, side-effect-free model of the Prisma migration ledger and the
 * approved schema checkpoints used to adopt a database that has no
 * `_prisma_migrations` table.
 *
 * Why this exists
 * ---------------
 * The deployed SaaS database has no Prisma ledger (confirmed in
 * docs/saas-migration-rehearsal.md). Running `prisma migrate deploy` against it
 * would try to replay migration 1 (`CREATE TABLE "User" ...`) on top of live
 * tables and fail. The supported reconciliation is to record the migrations
 * whose effects are already present as applied, then deploy only what is
 * genuinely missing.
 *
 * This module holds the two pieces of knowledge that reconciliation needs, kept
 * out of any CLI so they can be unit-tested without a database:
 *
 *   1. the exact migration list plus the SHA-256 checksum Prisma would record
 *      for each file (Prisma's ledger checksum is the SHA-256 hex digest of the
 *      migration file's bytes);
 *   2. the approved *checkpoints* -- recognisable schema end-states, each with
 *      a probe expressed only in durable schema features, so a target can be
 *      classified without guessing.
 *
 * Everything here is pure: no connection, no SQL execution, no filesystem
 * writes except the explicit `--write` manifest command.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const MIGRATIONS_DIR = path.join(repoRoot, "prisma", "migrations");
export const RELEASE_MANIFEST_PATH = path.join(repoRoot, "prisma", "migration-release-manifest.json");

/**
 * Prisma's own ledger table definition (`schema-engine` migration persistence).
 * Kept byte-compatible so a database baselined by scripts/migrate-adopt.mjs is
 * later readable and extendable by `prisma migrate deploy` without repair.
 */
export const PRISMA_LEDGER_DDL = `CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    VARCHAR(36) PRIMARY KEY NOT NULL,
    "checksum"              VARCHAR(64) NOT NULL,
    "finished_at"           TIMESTAMPTZ,
    "migration_name"        VARCHAR(255) NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        TIMESTAMPTZ,
    "started_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
    "applied_steps_count"   INTEGER NOT NULL DEFAULT 0
)`;

export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Migration directories in Prisma's apply order (timestamp prefix order). */
export function readMigrations(migrationsRoot = MIGRATIONS_DIR) {
  return fs
    .readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(migrationsRoot, name, "migration.sql")))
    .sort()
    .map((name) => {
      const sqlPath = path.join(migrationsRoot, name, "migration.sql");
      const sql = fs.readFileSync(sqlPath);
      return { name, sqlPath, sql, checksum: sha256Hex(sql) };
    });
}

/**
 * Schema features used by the checkpoint probes.
 *
 * Each entry is a self-contained SQL predicate returning a boolean, evaluated
 * in one round trip. Only features that survive later migrations may be used
 * here: migration 081 drops several dashboard indexes from migration 8 and
 * migration 10 drops the column added by migration 5, so those migrations are
 * recognised through other effects.
 */
const table = (name) => `to_regclass('public."${name}"') IS NOT NULL`;
const column = (tableName, columnName) =>
  `EXISTS (SELECT 1 FROM information_schema.columns ` +
  `WHERE table_schema = 'public' AND table_name = '${tableName}' AND column_name = '${columnName}')`;
const index = (name) =>
  `EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = '${name}')`;
const constraint = (name) =>
  `EXISTS (SELECT 1 FROM pg_constraint WHERE conname = '${name}')`;
const enumLabel = (typeName, label) =>
  `EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid ` +
  `JOIN pg_namespace n ON n.oid = t.typnamespace ` +
  `WHERE n.nspname = 'public' AND t.typname = '${typeName}' AND e.enumlabel = '${label}')`;

export const SCHEMA_FEATURES = {
  // Base single-hotel schema (migration 1) and later additions that persist.
  table_User: table("User"),
  table_Guest: table("Guest"),
  table_Room: table("Room"),
  table_ReservationRoom: table("ReservationRoom"),
  table_Order: table("Order"),
  table_OrderItem: table("OrderItem"),
  table_Recipe: table("Recipe"),
  table_RecipeIngredient: table("RecipeIngredient"),
  table_InventoryItem: table("InventoryItem"),
  table_Wastage: table("Wastage"),
  column_User_role: column("User", "role"),
  column_Guest_isArchived: column("Guest", "isArchived"),
  column_InventoryItem_isActive: column("InventoryItem", "isActive"),
  column_Room_isActive: column("Room", "isActive"),
  column_Room_isTwin: column("Room", "isTwin"),
  column_Wastage_accountableUserId: column("Wastage", "accountableUserId"),
  index_Reservation_status_checkInDate: index("Reservation_status_checkInDate_idx"),
  enum_MealPlan_HALF_BOARD: enumLabel("MealPlan", "HALF_BOARD"),

  // Tenancy conversion (migration 081 / 13) and the SaaS follow-ups.
  table_Hotel: table("Hotel"),
  table_HotelMembership: table("HotelMembership"),
  table_Subscription: table("Subscription"),
  column_HotelMembership_department: column("HotelMembership", "department"),
  column_Payment_idempotencyKey: column("Payment", "idempotencyKey"),
  column_Payment_requestFingerprint: column("Payment", "requestFingerprint"),

  // Charge-to-room idempotency (migration 18).
  column_Order_idempotencyOperation: column("Order", "idempotencyOperation"),
  column_Order_idempotencyKey: column("Order", "idempotencyKey"),
  column_Order_requestFingerprint: column("Order", "requestFingerprint"),
  index_Order_charge_to_room_key: index("Order_hotelId_idempotencyOperation_idempotencyKey_key"),

  // Composite tenant join keys (migration 19).
  column_ReservationRoom_hotelId: column("ReservationRoom", "hotelId"),
  column_Recipe_hotelId: column("Recipe", "hotelId"),
  column_RecipeIngredient_hotelId: column("RecipeIngredient", "hotelId"),
  column_OrderItem_hotelId: column("OrderItem", "hotelId"),
  fk_ReservationRoom_reservation: constraint("ReservationRoom_reservationId_hotelId_fkey"),
  fk_ReservationRoom_room: constraint("ReservationRoom_roomId_hotelId_fkey"),
  fk_Recipe_menuItem: constraint("Recipe_menuItemId_hotelId_fkey"),
  fk_RecipeIngredient_recipe: constraint("RecipeIngredient_recipeId_hotelId_fkey"),
  fk_RecipeIngredient_inventoryItem: constraint("RecipeIngredient_inventoryItemId_hotelId_fkey"),
  fk_OrderItem_order: constraint("OrderItem_orderId_hotelId_fkey"),

  // Configurable pricing engine (migration 20).
  table_HotelPricingSettings: table("HotelPricingSettings"),
  table_OccupancyType: table("OccupancyType"),
  table_MealPlanConfig: table("MealPlanConfig"),
  table_ReservationPriceSnapshot: table("ReservationPriceSnapshot"),
  column_ReservationPriceSnapshot_grandTotal: column("ReservationPriceSnapshot", "grandTotal"),
  fk_OrderItem_menuItem: constraint("OrderItem_menuItemId_hotelId_fkey"),
};

/** One SQL statement that returns the whole feature map as JSON. */
export function buildFeatureQuery(features = SCHEMA_FEATURES) {
  const entries = Object.entries(features)
    .map(([name, sql]) => `'${name}', (${sql})`)
    .join(",\n    ");
  return `SELECT json_build_object(
    ${entries}
  )::text AS features;`;
}

/**
 * Approved checkpoints, ordered by schema progress.
 *
 * Each checkpoint declares the features it *requires* and the features it
 * *forbids*. Declarative lists keep the JavaScript predicate and the SQL guard
 * used inside the baseline transaction identical, so the state cannot be
 * verified one way at detection time and another way at write time.
 *
 * `appliedThrough` is the last migration whose effects the checkpoint asserts.
 * Keeping the list explicit (rather than inferring a prefix from individual
 * probes) means an unrecognised state is a hard stop instead of a guess: it is
 * always safe to refuse to baseline, never safe to baseline optimistically.
 */
export const CHECKPOINTS = [
  {
    id: "empty",
    label: "Empty database (no application tables)",
    appliedThrough: null,
    require: [],
    forbid: ["table_User", "table_Hotel", "table_ReservationRoom"],
  },
  {
    // Deliberately stops at migration 11. Migration 12 only inserts three
    // Half Board tariff rows with ON CONFLICT DO NOTHING, and those rows are
    // legitimate for an operator to delete, so row presence can never be used
    // as schema evidence. It is therefore always re-deployed (harmless and
    // idempotent) instead of being baselined.
    id: "legacy_single_hotel_through_11",
    label: "Original single-hotel schema (migrations 1-11, no tenancy conversion)",
    // Prisma's ledger has no "partially applied" concept: the assertion is
    // "the effects of migrations 1-11 are present".
    appliedThrough: "20261002090100_add_half_board_meal_plan",
    require: [
      "table_User",
      "table_Guest",
      "table_ReservationRoom",
      "table_RecipeIngredient",
      "table_Wastage",
      "column_User_role",
      "column_Guest_isArchived",
      "column_InventoryItem_isActive",
      "column_Room_isActive",
      "column_Wastage_accountableUserId",
      "enum_MealPlan_HALF_BOARD",
    ],
    forbid: ["table_Hotel", "column_Room_isTwin"],
  },
  {
    id: "saas_through_081",
    label: "Tenancy conversion applied, SaaS follow-ups missing (migrations 1-13)",
    appliedThrough: "20261008123000_multi_tenant_saas_init",
    require: ["table_Hotel", "table_HotelMembership"],
    forbid: [
      "table_Subscription",
      "column_HotelMembership_department",
      "column_Payment_idempotencyKey",
      "column_ReservationRoom_hotelId",
    ],
  },
  {
    id: "saas_through_14",
    label: "Tenancy conversion + payment idempotency (migrations 1-14)",
    appliedThrough: "20261012063000_add_payment_idempotency_key",
    require: ["table_Hotel", "table_HotelMembership", "column_Payment_idempotencyKey"],
    forbid: [
      "column_Payment_requestFingerprint",
      "table_Subscription",
      "column_HotelMembership_department",
      "column_Order_idempotencyOperation",
      "column_ReservationRoom_hotelId",
    ],
  },
  {
    id: "saas_through_15",
    label: "Tenancy conversion + payment fingerprint (migrations 1-15)",
    appliedThrough: "20261014020000_add_payment_request_fingerprint",
    require: [
      "table_Hotel",
      "table_HotelMembership",
      "column_Payment_idempotencyKey",
      "column_Payment_requestFingerprint",
    ],
    forbid: [
      "table_Subscription",
      "column_HotelMembership_department",
      "column_Order_idempotencyOperation",
      "column_ReservationRoom_hotelId",
    ],
  },
  {
    id: "saas_through_16",
    label: "SaaS subscriptions applied, membership department missing (migrations 1-16)",
    appliedThrough: "20261019000000_add_saas_subscription",
    require: [
      "table_Hotel",
      "table_HotelMembership",
      "table_Subscription",
      "column_Payment_idempotencyKey",
      "column_Payment_requestFingerprint",
    ],
    forbid: [
      "column_HotelMembership_department",
      "column_Order_idempotencyOperation",
      "column_ReservationRoom_hotelId",
    ],
  },
  {
    id: "saas_through_17",
    label: "SaaS schema through membership department (migrations 1-17)",
    appliedThrough: "20261027100000_add_membership_department",
    require: [
      "table_Hotel",
      "table_HotelMembership",
      "table_Subscription",
      "column_HotelMembership_department",
      "column_Payment_idempotencyKey",
      "column_Payment_requestFingerprint",
    ],
    forbid: ["column_Order_idempotencyOperation", "column_ReservationRoom_hotelId"],
  },
  {
    id: "saas_through_18",
    label: "Charge-to-room idempotency applied, tenant join keys missing (migrations 1-18)",
    appliedThrough: "20261029120000_add_pos_charge_to_room_idempotency",
    require: [
      "table_Hotel",
      "column_HotelMembership_department",
      "column_Order_idempotencyOperation",
      "column_Order_idempotencyKey",
      "column_Order_requestFingerprint",
      "index_Order_charge_to_room_key",
    ],
    forbid: ["column_ReservationRoom_hotelId"],
  },
  {
    id: "saas_through_19",
    label: "Tenant composite join keys applied, pricing engine missing (migrations 1-19)",
    appliedThrough: "20261029130000_add_tenant_composite_join_fks",
    require: [
      "table_Hotel",
      "table_Subscription",
      "column_HotelMembership_department",
      "column_Order_idempotencyOperation",
      "column_Payment_requestFingerprint",
      "column_ReservationRoom_hotelId",
      "column_Recipe_hotelId",
      "column_RecipeIngredient_hotelId",
      "column_OrderItem_hotelId",
      "fk_ReservationRoom_reservation",
      "fk_ReservationRoom_room",
      "fk_Recipe_menuItem",
      "fk_RecipeIngredient_recipe",
      "fk_RecipeIngredient_inventoryItem",
      "fk_OrderItem_order",
      "fk_OrderItem_menuItem",
    ],
    forbid: [
      "table_HotelPricingSettings",
      "table_ReservationPriceSnapshot",
    ],
  },
  {
    id: "saas_current",
    label: "Current schema, all migrations applied (migrations 1-20)",
    appliedThrough: "20261031120000_add_pricing_engine",
    require: [
      "table_Hotel",
      "table_Subscription",
      "column_HotelMembership_department",
      "column_Order_idempotencyOperation",
      "column_Payment_requestFingerprint",
      "column_ReservationRoom_hotelId",
      "column_Recipe_hotelId",
      "column_RecipeIngredient_hotelId",
      "column_OrderItem_hotelId",
      "fk_ReservationRoom_reservation",
      "fk_ReservationRoom_room",
      "fk_Recipe_menuItem",
      "fk_RecipeIngredient_recipe",
      "fk_RecipeIngredient_inventoryItem",
      "fk_OrderItem_order",
      "fk_OrderItem_menuItem",
      "table_HotelPricingSettings",
      "table_OccupancyType",
      "table_MealPlanConfig",
      "table_ReservationPriceSnapshot",
      "column_ReservationPriceSnapshot_grandTotal",
    ],
    forbid: [],
  },
];

/** Pure checkpoint predicate, identical in meaning to `checkpointPredicateSql`. */
export function checkpointMatches(checkpoint, features) {
  const requiresMet = (checkpoint.require ?? []).every((name) => features[name] === true);
  const forbiddenClear = (checkpoint.forbid ?? []).every((name) => features[name] === false);
  return requiresMet && forbiddenClear;
}

/** SQL predicate for the same checkpoint, used as an in-transaction guard. */
export function checkpointPredicateSql(checkpoint) {
  const clauses = [
    ...(checkpoint.require ?? []).map((name) => `(${SCHEMA_FEATURES[name]})`),
    ...(checkpoint.forbid ?? []).map((name) => `NOT (${SCHEMA_FEATURES[name]})`),
  ];
  return clauses.length > 0 ? clauses.join("\n      AND ") : "true";
}

export function evaluateCheckpoints(features) {
  return CHECKPOINTS.filter((checkpoint) => checkpointMatches(checkpoint, features)).map((checkpoint) => checkpoint.id);
}

function checkpointIndex(checkpoint, migrations) {
  if (!checkpoint.appliedThrough) return { index: 0, problems: [] };
  const index = migrations.findIndex((migration) => migration.name === checkpoint.appliedThrough);
  if (index < 0) {
    return {
      index: 0,
      problems: [
        `Checkpoint '${checkpoint.id}' refers to migration '${checkpoint.appliedThrough}', which is not in the migration directory.`,
      ],
    };
  }
  return { index: index + 1, problems: [] };
}

/**
 * Decide what a detected target state implies.
 *
 * Returns the baseline (record as applied, do not run) and pending (still to be
 * deployed) migration names, plus a list of problems that must block any write.
 * Pure: the caller passes migration metadata, the feature map and ledger rows.
 *
 * @param {{
 *   migrations: Array<{ name: string, checksum: string }>,
 *   features: Record<string, boolean>,
 *   ledgerRows?: Array<{
 *     migration_name: string,
 *     checksum: string,
 *     finished_at: string | null,
 *     rolled_back_at: string | null,
 *     applied_steps_count: number,
 *   }>,
 * }} params
 */
export function buildAdoptionPlan({ migrations, features, ledgerRows = [] }) {
  const problems = [];
  const matching = evaluateCheckpoints(features);

  if (matching.length === 0) {
    problems.push(
      "The database schema does not match any approved checkpoint. Do not baseline it; investigate with `prisma migrate diff` before any deploy."
    );
  } else if (matching.length > 1) {
    problems.push(`The database schema matches multiple checkpoints (${matching.join(", ")}); refusing to guess.`);
  }

  const checkpoint = matching.length === 1 ? CHECKPOINTS.find((c) => c.id === matching[0]) : null;
  let appliedCount = 0;
  if (checkpoint) {
    const resolved = checkpointIndex(checkpoint, migrations);
    appliedCount = resolved.index;
    problems.push(...resolved.problems);
  }

  const known = new Map(migrations.map((migration) => [migration.name, migration]));
  const pending = migrations.slice(appliedCount).map((migration) => migration.name);
  const appliedByName = new Map();

  for (const row of ledgerRows) {
    if (appliedByName.has(row.migration_name)) {
      problems.push(`Migration ledger has duplicate rows for '${row.migration_name}'.`);
    }
    appliedByName.set(row.migration_name, row);

    const migration = known.get(row.migration_name);
    if (!migration) {
      problems.push(`Migration ledger records '${row.migration_name}', which is not in prisma/migrations.`);
      continue;
    }
    if (row.finished_at === null && row.rolled_back_at === null) {
      problems.push(`Migration '${row.migration_name}' is recorded as started but not finished; resolve it before baselining.`);
    }
    if (row.checksum !== migration.checksum) {
      problems.push(
        `Checksum mismatch for '${row.migration_name}': ledger=${row.checksum} reviewed=${migration.checksum}. ` +
          "The file changed after it was applied; do not re-baseline or replay it."
      );
    }
  }

  const appliedPositions = migrations
    .map((migration, position) => ({ migration, position }))
    .filter(({ migration }) => {
      const row = appliedByName.get(migration.name);
      return row && row.finished_at !== null && row.rolled_back_at === null;
    })
    .map(({ position }) => position);

  for (const position of appliedPositions) {
    if (position >= appliedCount) {
      problems.push(
        `Migration '${migrations[position].name}' is recorded as applied, but the schema does not contain its effects. ` +
          "The ledger and the schema disagree; stop until explained."
      );
    }
  }

  if (appliedPositions.length > 0) {
    const highest = Math.max(...appliedPositions);
    const missingEarlier = [];
    for (let position = 0; position <= highest; position += 1) {
      if (!appliedPositions.includes(position)) missingEarlier.push(migrations[position].name);
    }
    if (missingEarlier.length > 0) {
      problems.push(
        `Migration ledger has gaps: ${missingEarlier.join(", ")}. Inserting history around existing rows is not safe.`
      );
    }
  }

  const baseline = migrations
    .slice(0, appliedCount)
    .filter((migration) => !appliedByName.has(migration.name))
    .map((migration) => migration.name);

  return {
    checkpoint: checkpoint ? { id: checkpoint.id, label: checkpoint.label, appliedThrough: checkpoint.appliedThrough } : null,
    matchingCheckpoints: matching,
    baseline,
    pending,
    ledgerRows: ledgerRows.length,
    problems,
  };
}

/** Group checkpoint feature expectations for human-readable output. */
export function describeCheckpoints() {
  return CHECKPOINTS.map((checkpoint) => ({
    id: checkpoint.id,
    label: checkpoint.label,
    appliedThrough: checkpoint.appliedThrough,
  }));
}

/* -------------------------------------------------------------------------- */
/* Release manifest                                                            */
/* -------------------------------------------------------------------------- */

export function buildReleaseManifest(migrations, { prismaVersion } = {}) {
  return {
    schemaVersion: 1,
    purpose:
      "Reviewed migration release artifacts. `node scripts/migrate-adopt.mjs` refuses to baseline a migration whose file no longer matches this manifest.",
    prismaVersion: prismaVersion ?? null,
    migrations: migrations.map((migration) => ({ name: migration.name, sha256: migration.checksum })),
  };
}

export function readReleaseManifest(manifestPath = RELEASE_MANIFEST_PATH) {
  if (!fs.existsSync(manifestPath)) return null;
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

/**
 * Compare the migration directory against the committed manifest. Any
 * add/remove/edit is reported; a release requires both to agree exactly.
 */
export function verifyReleaseManifest(migrations, manifest) {
  const problems = [];
  if (!manifest) return { problems: ["prisma/migration-release-manifest.json is missing."], unchecked: [] };

  const listed = new Map(manifest.migrations.map((entry) => [entry.name, entry.sha256]));
  for (const migration of migrations) {
    if (!listed.has(migration.name)) {
      problems.push(`Migration '${migration.name}' is not listed in the release manifest.`);
    } else if (listed.get(migration.name) !== migration.checksum) {
      problems.push(
        `Migration '${migration.name}' does not match the reviewed checksum (manifest=${listed.get(migration.name)}, file=${migration.checksum}).`
      );
    }
  }
  for (const name of listed.keys()) {
    if (!migrations.some((migration) => migration.name === name)) {
      problems.push(`Release manifest lists '${name}', which no longer exists in prisma/migrations.`);
    }
  }
  return { problems, unchecked: [] };
}

/** Reads a checksum from the manifest for a migration name (used in reports). */
export function manifestChecksum(manifest, name) {
  return manifest?.migrations.find((entry) => entry.name === name)?.sha256 ?? null;
}

/* -------------------------------------------------------------------------- */
/* CLI: manifest generation and inspection                                     */
/* -------------------------------------------------------------------------- */

function runCli(argv) {
  const [command, ...rest] = argv;
  const migrations = readMigrations();

  if (command === "manifest") {
    // Record the pinned Prisma version so a future reader can tell which
    // release generated these checksums.
    let prismaVersion = null;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
      prismaVersion = pkg.devDependencies?.prisma ?? pkg.dependencies?.prisma ?? null;
    } catch {
      prismaVersion = null;
    }
    const manifest = buildReleaseManifest(migrations, { prismaVersion });
    if (rest.includes("--write")) {
      fs.writeFileSync(RELEASE_MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
      process.stdout.write(`Wrote ${path.relative(repoRoot, RELEASE_MANIFEST_PATH)} with ${migrations.length} entries.\n`);
      return 0;
    }
    if (rest.includes("--check")) {
      const { problems } = verifyReleaseManifest(migrations, readReleaseManifest());
      if (problems.length > 0) {
        process.stderr.write(`${problems.join("\n")}\n`);
        return 1;
      }
      process.stdout.write(`Release manifest matches ${migrations.length} migration files.\n`);
      return 0;
    }
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    return 0;
  }

  if (command === "checkpoints") {
    process.stdout.write(`${JSON.stringify(describeCheckpoints(), null, 2)}\n`);
    return 0;
  }

  if (command === "features") {
    process.stdout.write(`${buildFeatureQuery()}\n`);
    return 0;
  }

  process.stderr.write(
    [
      "Usage:",
      "  node scripts/migration-ledger.mjs manifest [--write|--check]",
      "  node scripts/migration-ledger.mjs checkpoints",
      "  node scripts/migration-ledger.mjs features",
      "",
    ].join("\n")
  );
  return 2;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runCli(process.argv.slice(2));
}
