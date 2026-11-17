#!/usr/bin/env node
/**
 * Fail when a migration file is checked out with CRLF line endings.
 *
 * Git stores migration SQL as LF (`.gitattributes` pins `*.sql text eol=lf`), and
 * Prisma checksums the raw bytes it deploys. A checkout that reintroduces CRLF —
 * an old clone, an editor that "fixes" line endings, a tool that rewrites files —
 * would make `prisma migrate deploy` compute digests that differ from the reviewed
 * release manifest and from the rows already in `_prisma_migrations`.
 *
 * `scripts/migration-ledger.mjs` tolerates it for *verification* (it compares the
 * LF bytes Git would deploy) and `scripts/migrate-adopt.mjs` refuses it outright.
 * This command is the plain, CI-friendly assertion: exit 0 means every migration
 * file is byte-identical to what was reviewed.
 *
 * Usage:  node scripts/verify-migration-eol.mjs
 * Exit:   0 = all migrations are LF, 1 = at least one has CRLF (message says how to fix)
 */
import { assertLfMigrationFiles, readMigrations } from "./migration-ledger.mjs";

const migrations = readMigrations();

try {
  assertLfMigrationFiles(migrations);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

if (process.exitCode !== 1) {
  process.stdout.write(`All ${migrations.length} migration files use LF line endings.\n`);
}
