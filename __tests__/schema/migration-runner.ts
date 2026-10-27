import fs from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";

export const MIGRATIONS_DIR = "prisma/migrations";

export function migrationDirectories(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((dir) => fs.existsSync(path.join(MIGRATIONS_DIR, dir, "migration.sql")))
    .sort();
}

/**
 * Executes the repository's real migration SQL in timestamp order against the
 * supplied isolated PGlite database. This small ledger mirrors deploy's
 * once-only behavior: completed migrations are skipped on a later invocation.
 * SQL itself is not mocked. Each migration and its ledger row commit together.
 */
export async function applyPendingMigrations(
  db: PGlite,
  beforeMigration?: (directory: string, db: PGlite) => Promise<void>
): Promise<string[]> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "migration_name" TEXT PRIMARY KEY,
      "finished_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const appliedNow: string[] = [];
  for (const directory of migrationDirectories()) {
    const prior = await db.query<{ migration_name: string }>(
      `SELECT "migration_name" FROM "_prisma_migrations" WHERE "migration_name" = $1`,
      [directory]
    );
    if (prior.rows.length > 0) continue;

    await beforeMigration?.(directory, db);
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, directory, "migration.sql"), "utf8");
    await db.exec("BEGIN");
    try {
      await db.exec(sql);
      await db.query(
        `INSERT INTO "_prisma_migrations" ("migration_name") VALUES ($1)`,
        [directory]
      );
      await db.exec("COMMIT");
      appliedNow.push(directory);
    } catch (error) {
      try {
        await db.exec("ROLLBACK");
      } catch {
        // Preserve the original migration failure if the transaction already aborted.
      }
      throw new Error(`Migration ${directory} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return appliedNow;
}
