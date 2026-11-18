// @vitest-environment node
import { expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { applyPendingMigrations, PGLITE_MIGRATION_TIMEOUT_MS } from "./migration-runner";
vi.setConfig({ testTimeout: PGLITE_MIGRATION_TIMEOUT_MS });
it("copies existing logos while preserving their original column", async () => {
  const db = new PGlite();
  try {
    await applyPendingMigrations(db, async (name, connection) => {
      if (name === "20261111120000_hotel_branding_logo_url") {
        await connection.query('INSERT INTO "Hotel" (id, name, slug, status, "logo", "updatedAt") VALUES ($1, $2, $3, $4, $5, CURRENT_TIMESTAMP)', ["hotel-a", "Kim Resort", "kim", "ACTIVE", "https://example.test/logo.png"]);
      }
    });
    const result = await db.query('SELECT "logo", "logoUrl" FROM "Hotel" WHERE id = $1', ["hotel-a"]);
    expect(result.rows).toEqual([{ logo: "https://example.test/logo.png", logoUrl: "https://example.test/logo.png" }]);
  } finally { await db.close(); }
});
