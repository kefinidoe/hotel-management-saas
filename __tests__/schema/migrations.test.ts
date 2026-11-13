// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import { applyPendingMigrations, migrationDirectories } from "./migration-runner";

const SCHEMA_PATH = "prisma/schema.prisma";

type PrismaField = {
  name: string;
  type: string;
  isList: boolean;
  isOptional: boolean;
  isRelation: boolean;
  declaration: string;
};
type PrismaModel = { fields: PrismaField[]; declaration: string };

function parsePrisma(src: string): { models: Map<string, PrismaModel>; enums: Map<string, string[]> } {
  const models = new Map<string, PrismaModel>();
  for (const match of src.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const fields: PrismaField[] = [];
    for (const raw of match[2].split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("//") || line.startsWith("@@")) continue;
      const field = line.match(/^(\w+)\s+(\w+)(\[\])?(\?)?/);
      if (field) {
        fields.push({
          name: field[1],
          type: field[2],
          isList: Boolean(field[3]),
          isOptional: Boolean(field[4]),
          isRelation: false,
          declaration: line,
        });
      }
    }
    models.set(match[1], { fields, declaration: match[2] });
  }

  const modelNames = new Set(models.keys());
  for (const model of models.values()) {
    for (const field of model.fields) field.isRelation = modelNames.has(field.type);
  }

  const enums = new Map<string, string[]>();
  for (const match of src.matchAll(/^enum\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    enums.set(
      match[1],
      match[2]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("//") && !line.startsWith("@@"))
        .map((line) => line.split(/\s+/)[0])
    );
  }
  return { models, enums };
}

function expectedIndexNames(models: Map<string, PrismaModel>): Set<string> {
  const names = new Set<string>();
  for (const [modelName, model] of models) {
    for (const field of model.fields) {
      if (field.declaration.includes("@id")) names.add(`${modelName}_pkey`);
      if (field.declaration.includes("@unique")) names.add(`${modelName}_${field.name}_key`);
    }
    for (const match of model.declaration.matchAll(/@@(id|unique|index)\s*\(\[([^\]]+)\]\)/g)) {
      const fields = match[2].split(",").map((field) => field.trim().split(/\s+/)[0]);
      const suffix = match[1] === "id" ? "pkey" : match[1] === "unique" ? "key" : "idx";
      names.add(`${modelName}_${fields.join("_")}_${suffix}`);
    }
  }
  return names;
}

let db: PGlite;
let dbColumns: Map<string, Set<string>>;
let dbEnumTypes: Map<string, string[]>;
let dbIndexes: Set<string>;

beforeAll(async () => {
  db = new PGlite();
  // Migration failures throw immediately; later migrations are never run on a
  // partially initialized database, which used to hide the first root cause.
  await applyPendingMigrations(db);

  const columns = await db.query<{ table_name: string; column_name: string }>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name <> '_prisma_migrations'
    ORDER BY table_name, ordinal_position
  `);
  dbColumns = new Map();
  for (const row of columns.rows) {
    if (!dbColumns.has(row.table_name)) dbColumns.set(row.table_name, new Set());
    dbColumns.get(row.table_name)!.add(row.column_name);
  }

  const enums = await db.query<{ typname: string; enumlabel: string }>(`
    SELECT t.typname, e.enumlabel
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
    ORDER BY t.typname, e.enumsortorder
  `);
  dbEnumTypes = new Map();
  for (const row of enums.rows) {
    if (!dbEnumTypes.has(row.typname)) dbEnumTypes.set(row.typname, []);
    dbEnumTypes.get(row.typname)!.push(row.enumlabel);
  }

  const indexes = await db.query<{ indexname: string }>(`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `);
  dbIndexes = new Set(indexes.rows.map((row) => row.indexname));
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe("Prisma migration history", () => {
  it("applies the complete chronological migration chain to an empty isolated database", async () => {
    const ledger = await db.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM "_prisma_migrations"`);
    expect(Number(ledger.rows[0].count)).toBe(migrationDirectories().length);
    expect(dbColumns.has("Hotel")).toBe(true);
    expect(dbColumns.has("HotelMembership")).toBe(true);
  });

  it("skips completed migrations on a repeat deploy-style run", async () => {
    const before = await db.query<{ migration_name: string }>(
      `SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name`
    );
    const appliedAgain = await applyPendingMigrations(db);
    const after = await db.query<{ migration_name: string }>(
      `SELECT migration_name FROM "_prisma_migrations" ORDER BY migration_name`
    );
    expect(appliedAgain).toEqual([]);
    expect(after.rows).toEqual(before.rows);
  });

  it("matches Prisma model columns, enums, and indexes exactly", () => {
    const { models, enums } = parsePrisma(fs.readFileSync(SCHEMA_PATH, "utf8"));
    const problems: string[] = [];

    for (const name of models.keys()) if (!dbColumns.has(name)) problems.push(`missing table: ${name}`);
    for (const name of dbColumns.keys()) if (!models.has(name)) problems.push(`extra table: ${name}`);
    for (const [modelName, model] of models) {
      const actualColumns = dbColumns.get(modelName);
      if (!actualColumns) continue;
      for (const field of model.fields) {
        if (field.isRelation) continue;
        if (!actualColumns.has(field.name)) problems.push(`missing column: ${modelName}.${field.name}`);
      }
      for (const column of actualColumns) {
        if (!model.fields.some((field) => !field.isRelation && field.name === column)) {
          problems.push(`extra column: ${modelName}.${column}`);
        }
      }
    }

    for (const [name, values] of enums) {
      const actual = dbEnumTypes.get(name);
      if (!actual) problems.push(`missing enum: ${name}`);
      else if (JSON.stringify(actual) !== JSON.stringify(values)) {
        problems.push(`${name}: schema=[${values.join(",")}], database=[${actual.join(",")}]`);
      }
    }
    for (const name of dbEnumTypes.keys()) if (!enums.has(name)) problems.push(`extra enum: ${name}`);

    const expectedIndexes = expectedIndexNames(models);
    for (const name of expectedIndexes) if (!dbIndexes.has(name)) problems.push(`missing index: ${name}`);
    for (const name of dbIndexes) if (!expectedIndexes.has(name)) problems.push(`extra index: ${name}`);
    expect(problems).toEqual([]);
  });

  it("keeps every required tenant ID non-null and has composite tenant ownership constraints", async () => {
    const { models } = parsePrisma(fs.readFileSync(SCHEMA_PATH, "utf8"));
    const tenantTables = [...models.entries()]
      .filter(([, model]) => model.fields.some((field) => field.name === "hotelId" && !field.isOptional))
      .map(([name]) => name);
    for (const table of tenantTables) {
      const result = await db.query<{ is_nullable: string }>(`
        SELECT is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'hotelId'
      `, [table]);
      expect(result.rows[0]?.is_nullable, `${table}.hotelId must be NOT NULL`).toBe("NO");
    }

    const constraints = await db.query<{ constraint_name: string }>(`
      SELECT constraint_name FROM information_schema.table_constraints
      WHERE constraint_schema = 'public' AND constraint_type = 'FOREIGN KEY'
    `);
    const names = new Set(constraints.rows.map((row) => row.constraint_name));
    for (const [modelName, model] of models) {
      for (const relation of model.declaration.matchAll(/^\s*\w+\s+Hotel\??\s+@relation\(fields: \[([^\]]+)\]/gm)) {
        const fields = relation[1].split(",").map((field) => field.trim());
        expect(names.has(`${modelName}_${fields.join("_")}_fkey`), `${modelName} must reference Hotel`).toBe(true);
      }
    }
    for (const name of [
      "Room_roomTypeId_hotelId_fkey",
      "Reservation_guestId_hotelId_fkey",
      "Folio_guestId_hotelId_fkey",
      "Payment_paymentMethodId_hotelId_fkey",
      "MenuItem_categoryId_hotelId_fkey",
      "StockMovement_inventoryItemId_hotelId_fkey",
    ]) expect(names.has(name), `missing tenant-scoped foreign key ${name}`).toBe(true);
  });
});

describe("legacy data conversion", () => {
  it("preserves representative pre-SaaS records and assigns them to the legacy hotel", async () => {
    const legacyDb = new PGlite();
    try {
      const seedLegacyRows = async (directory: string, target: PGlite) => {
        if (directory !== "20261008123000_multi_tenant_saas_init") return;
        await target.exec(`
          INSERT INTO "User" ("id", "name", "email", "passwordHash", "role", "updatedAt")
          VALUES ('legacy-admin', 'Legacy Admin', 'legacy@example.test', 'hash', 'ADMIN', CURRENT_TIMESTAMP);
          INSERT INTO "RoomType" ("id", "name", "baseRate", "capacity", "mealPlan", "updatedAt")
          VALUES ('legacy-room-type', 'Legacy Half Board', 120.00, 2, 'HALF_BOARD', CURRENT_TIMESTAMP);
          INSERT INTO "Room" ("id", "number", "roomTypeId", "status", "updatedAt")
          VALUES ('legacy-room', '101', 'legacy-room-type', 'AVAILABLE', CURRENT_TIMESTAMP);
          INSERT INTO "Guest" ("id", "fullName", "updatedAt")
          VALUES ('legacy-guest', 'Legacy Guest', CURRENT_TIMESTAMP);
          INSERT INTO "Reservation" ("id", "code", "guestId", "checkInDate", "checkOutDate", "createdById", "updatedAt")
          VALUES ('legacy-reservation', 'LEGACY-001', 'legacy-guest', '2026-10-27', '2026-10-29', 'legacy-admin', CURRENT_TIMESTAMP);
          INSERT INTO "MenuCategory" ("id", "name") VALUES
            ('legacy-dessert-a', 'Desserts'), ('legacy-dessert-b', 'Desserts');
          INSERT INTO "MenuItem" ("id", "categoryId", "name", "price")
          VALUES ('legacy-dessert-item', 'legacy-dessert-b', 'Cake', 8.00);
          INSERT INTO "Notification" ("id", "title", "body")
          VALUES ('legacy-notification', 'Legacy title', 'Legacy notification body');
          INSERT INTO "AuditLog" ("id", "userId", "action", "entityType", "entityId", "before", "after", "reason")
          VALUES ('legacy-audit', 'legacy-admin', 'UPDATED', 'Reservation', 'legacy-reservation', '{"status":"PENDING"}', '{"status":"CONFIRMED"}', 'migration fixture');
        `);
      };
      await applyPendingMigrations(legacyDb, seedLegacyRows);

      const membership = await legacyDb.query<{ role: string; hotelId: string }>(`
        SELECT role, "hotelId" FROM "HotelMembership" WHERE "userId" = 'legacy-admin'
      `);
      expect(membership.rows).toEqual([{ role: "HOTEL_OWNER", hotelId: "legacy-hotel" }]);

      const room = await legacyDb.query<{ hotelId: string; mealPlan: string }>(`
        SELECT r."hotelId", rt."mealPlan" FROM "Room" r
        JOIN "RoomType" rt ON rt.id = r."roomTypeId" WHERE r.id = 'legacy-room'
      `);
      expect(room.rows).toEqual([{ hotelId: "legacy-hotel", mealPlan: "HALF_BOARD" }]);

      const categoryMerge = await legacyDb.query<{ categoryId: string; categoryCount: number }>(`
        SELECT item."categoryId", COUNT(category.id)::int AS "categoryCount"
        FROM "MenuItem" item
        JOIN "MenuCategory" category ON category.id = item."categoryId"
        WHERE item.id = 'legacy-dessert-item'
        GROUP BY item."categoryId"
      `);
      expect(categoryMerge.rows).toEqual([{ categoryId: "legacy-dessert-a", categoryCount: 1 }]);

      const notification = await legacyDb.query<{ hotelId: string; message: string; type: string }>(`
        SELECT "hotelId", message, type FROM "Notification" WHERE id = 'legacy-notification'
      `);
      expect(notification.rows).toEqual([{
        hotelId: "legacy-hotel", message: "Legacy notification body", type: "SYSTEM",
      }]);

      const audit = await legacyDb.query<{ hotelId: string; entity: string; metadata: { before: unknown; after: unknown; reason: string } }>(`
        SELECT "hotelId", entity, metadata FROM "AuditLog" WHERE id = 'legacy-audit'
      `);
      expect(audit.rows[0]).toMatchObject({
        hotelId: "legacy-hotel",
        entity: "Reservation",
        metadata: {
          before: { status: "PENDING" },
          after: { status: "CONFIRMED" },
          reason: "migration fixture",
        },
      });
    } finally {
      await legacyDb.close();
    }
  });
});
