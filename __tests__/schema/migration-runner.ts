import fs from "node:fs";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";

export const MIGRATIONS_DIR = "prisma/migrations";

/**
 * Timeout for tests and hooks that apply the full migration chain to PGlite.
 *
 * This is a WASM Postgres running ~22 migration files; it is legitimately slow,
 * and markedly slower on Windows (typically 5-7s versus ~2s on Linux), which the
 * default 5s per-test budget does not cover. The budget is raised only where this
 * work happens, so a genuine hang anywhere else still fails fast.
 */
export const PGLITE_MIGRATION_TIMEOUT_MS = 120_000;

export function migrationDirectories(): string[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((dir) => fs.existsSync(path.join(MIGRATIONS_DIR, dir, "migration.sql")))
    .sort();
}

/**
 * Executes repository migration SQL in timestamp order against an in-memory
 * PGlite database. This test-only, name-only ledger checks only skip-on-repeat
 * behavior; it does not model Prisma's checksum, failure, rollback, or recovery
 * semantics. SQL itself is not mocked. Each file and this test ledger row are
 * wrapped in a PGlite transaction; this is not evidence of Prisma deploy atomicity.
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
