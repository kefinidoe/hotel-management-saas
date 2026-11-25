// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import fs from "node:fs";
import {
  PGLITE_MIGRATION_TIMEOUT_MS,
  applyPendingMigrations,
  migrationDirectories,
} from "./migration-runner";

// This suite applies the entire migration chain to an in-memory PGlite database:
// a WASM Postgres working through ~22 migration files. That is legitimately slow
// and markedly slower on Windows (roughly 5-7s against ~2s on Linux), which the
// default 5s per-test/per-hook budget does not cover. Raise the budget for this
// file only — where that work actually happens — so a real hang elsewhere still
// fails fast instead of hiding behind a global timeout.
vi.setConfig({ testTimeout: PGLITE_MIGRATION_TIMEOUT_MS, hookTimeout: PGLITE_MIGRATION_TIMEOUT_MS });


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
    // Prisma cannot express a partial expression index in schema.prisma. This
    // database-native safety constraint is verified separately below.
    expectedIndexes.add("AuditLog_manual_payment_reference_unique");
    expectedIndexes.add("Payment_hotelId_normalizedReference_key");
    for (const name of expectedIndexes) if (!dbIndexes.has(name)) problems.push(`missing index: ${name}`);
    for (const name of dbIndexes) if (!expectedIndexes.has(name)) problems.push(`extra index: ${name}`);
    expect(problems).toEqual([]);
  });

  it("keeps normalized payment references unique per hotel only when present", async () => {
    const result = await db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'Payment_hotelId_normalizedReference_key'`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].indexdef).toMatch(/CREATE UNIQUE INDEX/i);
    expect(result.rows[0].indexdef).toContain('"hotelId", "normalizedReference"');
    expect(result.rows[0].indexdef).toMatch(/WHERE.*"normalizedReference" IS NOT NULL/i);
  });

  it("keeps the manual payment reference index unique and scoped to subscription payment audit records", async () => {
    const result = await db.query<{ indexdef: string }>(`SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'AuditLog_manual_payment_reference_unique'`);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].indexdef).toMatch(/CREATE UNIQUE INDEX/i);
    expect(result.rows[0].indexdef).toMatch(/upper\(btrim/i);
    expect(result.rows[0].indexdef).toContain("PLATFORM_MANUAL_PAYMENT_ACTIVATED");
    expect(result.rows[0].indexdef).toContain("Subscription");
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
      "ReservationRoom_reservationId_hotelId_fkey",
      "ReservationRoom_roomId_hotelId_fkey",
      "Recipe_menuItemId_hotelId_fkey",
      "RecipeIngredient_recipeId_hotelId_fkey",
      "RecipeIngredient_inventoryItemId_hotelId_fkey",
      "OrderItem_orderId_hotelId_fkey",
      "OrderItem_menuItemId_hotelId_fkey",
    ]) expect(names.has(name), `missing tenant-scoped foreign key ${name}`).toBe(true);
  });
});

describe("tenant join-key migration", () => {
  it("aborts before changing the schema when an existing reservation-room link crosses hotels", async () => {
    const rehearsal = new PGlite();
    try {
      const seedAndCorruptBeforeDraft = async (directory: string, target: PGlite) => {
        if (directory === "20261008123000_multi_tenant_saas_init") {
          await target.exec(fs.readFileSync("__tests__/schema/fixtures/pre-saas-conversion.sql", "utf8"));
        }
        if (directory === "20261029130000_add_tenant_composite_join_fks") {
          await target.exec(`
            INSERT INTO "Hotel" (id, name, slug, "updatedAt") VALUES ('cross-hotel', 'Cross Hotel', 'cross-hotel', NOW());
            INSERT INTO "RoomType" (id, "hotelId", name, "baseRate", capacity, "updatedAt") VALUES ('cross-room-type', 'cross-hotel', 'Other', 100, 1, NOW());
            INSERT INTO "Room" (id, "hotelId", number, "roomTypeId", "updatedAt") VALUES ('cross-room', 'cross-hotel', '201', 'cross-room-type', NOW());
            UPDATE "ReservationRoom" SET "roomId" = 'cross-room' WHERE id = 'legacy-reservation-room';
          `);
        }
      };

      await expect(applyPendingMigrations(rehearsal, seedAndCorruptBeforeDraft))
        .rejects.toThrow(/Tenant-integrity precheck failed: ReservationRoom/);
      const draftColumn = await rehearsal.query(
        `SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ReservationRoom' AND column_name = 'hotelId'`,
      );
      expect(draftColumn.rows).toHaveLength(0);
    } finally {
      await rehearsal.close();
    }
  });

  it("backfills join-table tenant IDs from authoritative parents before enforcing composite FKs", async () => {
    const rehearsal = new PGlite();
    try {
      const seedBeforeDraft = async (directory: string, target: PGlite) => {
        if (directory !== "20261029130000_add_tenant_composite_join_fks") return;
        await target.exec(`
          INSERT INTO "Hotel" (id, name, slug, "updatedAt") VALUES ('join-test-hotel', 'Join Test', 'join-test', NOW());
          INSERT INTO "User" (id, name, email, "passwordHash", "updatedAt") VALUES ('join-test-user', 'Join Test', 'join-test@example.test', 'hash', NOW());
          INSERT INTO "RoomType" (id, "hotelId", name, "baseRate", capacity, "updatedAt") VALUES ('join-test-room-type', 'join-test-hotel', 'Standard', 100, 1, NOW());
          INSERT INTO "Room" (id, "hotelId", number, "roomTypeId", "updatedAt") VALUES ('join-test-room', 'join-test-hotel', '101', 'join-test-room-type', NOW());
          INSERT INTO "Guest" (id, "hotelId", "fullName", "updatedAt") VALUES ('join-test-guest', 'join-test-hotel', 'Test Guest', NOW());
          INSERT INTO "Reservation" (id, "hotelId", code, "guestId", "createdById", "checkInDate", "checkOutDate", "updatedAt")
            VALUES ('join-test-reservation', 'join-test-hotel', 'JOIN-001', 'join-test-guest', 'join-test-user', NOW(), NOW() + interval '1 day', NOW());
          INSERT INTO "ReservationRoom" (id, "reservationId", "roomId", rate) VALUES ('join-test-reservation-room', 'join-test-reservation', 'join-test-room', 100);
          INSERT INTO "MenuCategory" (id, "hotelId", name) VALUES ('join-test-category', 'join-test-hotel', 'Test');
          INSERT INTO "MenuItem" (id, "hotelId", "categoryId", name, price) VALUES ('join-test-menu-item', 'join-test-hotel', 'join-test-category', 'Test Item', 10);
          INSERT INTO "InventoryItem" (id, "hotelId", sku, name, category, unit, "updatedAt") VALUES ('join-test-inventory', 'join-test-hotel', 'JOIN-1', 'Test Stock', 'Test', 'pcs', NOW());
          INSERT INTO "Recipe" (id, "menuItemId", portions, "updatedAt") VALUES ('join-test-recipe', 'join-test-menu-item', 1, NOW());
          INSERT INTO "RecipeIngredient" (id, "recipeId", "inventoryItemId", quantity) VALUES ('join-test-ingredient', 'join-test-recipe', 'join-test-inventory', 1);
          INSERT INTO "Order" (id, "hotelId", total) VALUES ('join-test-order', 'join-test-hotel', 10);
          INSERT INTO "OrderItem" (id, "orderId", "menuItemId", name, "unitPrice", quantity, total)
            VALUES ('join-test-order-item', 'join-test-order', 'join-test-menu-item', 'Test Item', 10, 1, 10);
        `);
      };

      await applyPendingMigrations(rehearsal, seedBeforeDraft);
      const result = await rehearsal.query<{ reservationHotel: string; recipeHotel: string; ingredientHotel: string; orderItemHotel: string }>(`
        SELECT
          (SELECT "hotelId" FROM "ReservationRoom" WHERE id = 'join-test-reservation-room') AS "reservationHotel",
          (SELECT "hotelId" FROM "Recipe" WHERE id = 'join-test-recipe') AS "recipeHotel",
          (SELECT "hotelId" FROM "RecipeIngredient" WHERE id = 'join-test-ingredient') AS "ingredientHotel",
          (SELECT "hotelId" FROM "OrderItem" WHERE id = 'join-test-order-item') AS "orderItemHotel"
      `);
      expect(result.rows).toEqual([{
        reservationHotel: "join-test-hotel",
        recipeHotel: "join-test-hotel",
        ingredientHotel: "join-test-hotel",
        orderItemHotel: "join-test-hotel",
      }]);
    } finally {
      await rehearsal.close();
    }
  });
});

describe("legacy data conversion", () => {
  it("preserves representative pre-SaaS records and assigns them to the legacy hotel", async () => {
    const legacyDb = new PGlite();
    try {
      const seedLegacyRows = async (directory: string, target: PGlite) => {
        if (directory !== "20261008123000_multi_tenant_saas_init") return;
        await target.exec(fs.readFileSync("__tests__/schema/fixtures/pre-saas-conversion.sql", "utf8"));
      };
      await applyPendingMigrations(legacyDb, seedLegacyRows);

      const membership = await legacyDb.query<{ role: string; hotelId: string; department: string }>(`
        SELECT role, "hotelId", department FROM "HotelMembership" WHERE "userId" = 'legacy-admin'
      `);
      expect(membership.rows).toEqual([{
        role: "HOTEL_OWNER",
        hotelId: "legacy-hotel",
        department: "Legacy Operations",
      }]);

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

      const joinOwnership = await legacyDb.query<{
        reservationRoomHotelId: string;
        recipeHotelId: string;
        recipeIngredientHotelId: string;
        orderItemHotelId: string;
      }>(`
        SELECT
          (SELECT "hotelId" FROM "ReservationRoom" WHERE id = 'legacy-reservation-room') AS "reservationRoomHotelId",
          (SELECT "hotelId" FROM "Recipe" WHERE id = 'legacy-recipe') AS "recipeHotelId",
          (SELECT "hotelId" FROM "RecipeIngredient" WHERE id = 'legacy-recipe-ingredient') AS "recipeIngredientHotelId",
          (SELECT "hotelId" FROM "OrderItem" WHERE id = 'legacy-order-item') AS "orderItemHotelId"
      `);
      expect(joinOwnership.rows).toEqual([{
        reservationRoomHotelId: "legacy-hotel",
        recipeHotelId: "legacy-hotel",
        recipeIngredientHotelId: "legacy-hotel",
        orderItemHotelId: "legacy-hotel",
      }]);

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

describe("charge-to-room idempotency migration", () => {
  const hotel = "pos-idempotency-hotel";

  beforeAll(async () => {
    await db.query(
      `INSERT INTO "Hotel" (id, name, slug, "updatedAt") VALUES ($1, 'POS Idempotency', 'pos-idempotency', NOW())`,
      [hotel]
    );
  });

  it("allows many orders without an idempotency key", async () => {
    for (const id of ["pos-plain-1", "pos-plain-2"]) {
      await db.query(`INSERT INTO "Order" (id, "hotelId", total) VALUES ($1, $2, 10)`, [id, hotel]);
    }
    const rows = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "Order" WHERE "hotelId" = $1 AND "idempotencyKey" IS NULL`,
      [hotel]
    );
    expect(rows.rows[0].count).toBe(2);
  });

  it("rejects a replayed key for the same hotel and operation", async () => {
    await db.query(
      `INSERT INTO "Order" (id, "hotelId", total, "idempotencyOperation", "idempotencyKey", "requestFingerprint")
       VALUES ('pos-key-1', $1, 10, 'CHARGE_TO_ROOM', 'key-1', 'fingerprint-1')`,
      [hotel]
    );
    await expect(
      db.query(
        `INSERT INTO "Order" (id, "hotelId", total, "idempotencyOperation", "idempotencyKey", "requestFingerprint")
         VALUES ('pos-key-2', $1, 10, 'CHARGE_TO_ROOM', 'key-1', 'fingerprint-2')`,
        [hotel]
      )
    ).rejects.toThrow(/Order_hotelId_idempotencyOperation_idempotencyKey_key/);
  });

  it("scopes a client key to its operation, so another operation may reuse it", async () => {
    await db.query(
      `INSERT INTO "Order" (id, "hotelId", total, "idempotencyOperation", "idempotencyKey", "requestFingerprint")
       VALUES ('pos-key-3', $1, 10, 'OTHER_OPERATION', 'key-1', 'fingerprint-1')`,
      [hotel]
    );
    const rows = await db.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "Order" WHERE "hotelId" = $1 AND "idempotencyKey" = 'key-1'`,
      [hotel]
    );
    expect(rows.rows[0].count).toBe(2);
  });

  it("rejects a partially populated idempotency tuple", async () => {
    await expect(
      db.query(
        `INSERT INTO "Order" (id, "hotelId", total, "idempotencyOperation", "idempotencyKey")
         VALUES ('pos-key-partial', $1, 10, 'CHARGE_TO_ROOM', 'key-partial')`,
        [hotel]
      )
    ).rejects.toThrow(/Order_idempotency_triple_check/);
  });

  it("rejects an empty idempotency value", async () => {
    await expect(
      db.query(
        `INSERT INTO "Order" (id, "hotelId", total, "idempotencyOperation", "idempotencyKey", "requestFingerprint")
         VALUES ('pos-key-empty', $1, 10, 'CHARGE_TO_ROOM', '   ', 'fingerprint')`,
        [hotel]
      )
    ).rejects.toThrow(/Order_idempotency_triple_check/);
  });
});
