// @vitest-environment node
import { expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPendingMigrations, PGLITE_MIGRATION_TIMEOUT_MS } from "./migration-runner";
vi.setConfig({ testTimeout: PGLITE_MIGRATION_TIMEOUT_MS });

it("defaults existing and newly created hotels to legacy pricing", async () => {
  const db = new PGlite();
  try {
    await applyPendingMigrations(db, async (name, connection) => {
      if (name === "20261109120000_modular_pricing_opt_in") {
        await connection.query('INSERT INTO "Hotel" (id, name, slug, status, "updatedAt") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)', ["old-hotel", "Old", "old-hotel", "ACTIVE"]);
      }
    });
    await db.query('INSERT INTO "Hotel" (id, name, slug, status, "updatedAt") VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)', ["new-hotel", "New", "new-hotel", "ACTIVE"]);
    const result = await db.query<{ id: string; useModularPricing: boolean }>('SELECT id, "useModularPricing" FROM "Hotel" WHERE id IN ($1, $2) ORDER BY id', ["old-hotel", "new-hotel"]);
    expect(result.rows).toEqual([{ id: "new-hotel", useModularPricing: false }, { id: "old-hotel", useModularPricing: false }]);
  } finally { await db.close(); }
});
