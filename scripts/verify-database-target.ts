/**
 * Pre-flight verification script for Hotel Management SaaS database target.
 *
 * Verifies that the current environment and connection strings point strictly
 * to the approved SaaS database. Never reveals credentials or secrets, and never
 * opens a connection.
 *
 * Since round 28 this script loads `.env` through the same loader the Prisma CLI
 * and the maintenance scripts use (`scripts/env-file.mjs`). Before that it read
 * only the ambient shell environment, so an operator could verify one database
 * and then migrate another: `npm run prisma:deploy` loads `.env` itself.
 *
 * Usage:
 *   npx tsx scripts/verify-database-target.ts
 *   npm run db:verify
 */

import { assertDatabaseSafety, DatabaseSafetyError } from "../lib/db-safety-guard";
import { loadEnvFiles } from "../scripts/env-file.mjs";

function runVerification() {
  console.log("============================================================");
  console.log("  HOTEL MANAGEMENT SAAS - DATABASE SAFETY VERIFICATION");
  console.log("============================================================");

  // Same precedence as the Prisma CLI: an already-set variable wins, otherwise
  // prisma/.env then .env are applied.
  const loaded = loadEnvFiles();
  if (loaded.files.length === 0) {
    console.log(" - Environment file : none found (using the shell environment)");
  } else {
    console.log(` - Environment file : ${loaded.files.map((file) => file.split(/[\\/]/).pop()).join(", ")}`);
  }
  console.log(` - Variables loaded : ${loaded.keys.length}`);
  console.log("------------------------------------------------------------");

  try {
    // A remote target must supply both URLs: `migrate deploy` runs every DDL
    // statement over DIRECT_URL, so verifying DATABASE_URL alone proves nothing.
    const meta = assertDatabaseSafety(undefined, { requireDirectUrl: "remote" });
    console.log(" [SAFETY CHECK PASSED]");
    console.log(` - Environment Status : VERIFIED (saas)`);
    console.log(` - Approved Identifier: ${meta.identifierMatched}`);
    console.log(` - Target Host        : ${meta.host}`);
    console.log(` - Target Port        : ${meta.port}`);
    console.log(` - Target Database    : ${meta.database}`);
    console.log(` - Endpoint Class     : ${meta.kind}`);
    if (meta.projectRef) {
      console.log(` - Supabase Project   : ${meta.projectRef}`);
    }
    if (meta.directKind) {
      console.log(` - DIRECT_URL Class   : ${meta.directKind}`);
    }
    console.log("------------------------------------------------------------");
    console.log(" Configured target matches the declared identifier only.");
    console.log(" This check does NOT verify ownership, production status, or migration history.");
    console.log(" Independently verify the project and migration history before any DB operation.");
    console.log(" Run `npm run backup` before and after any migration.");
    console.log("============================================================");
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(" [CRITICAL DATABASE SAFETY CHECK FAILED]");
    console.error(` Error: ${message}`);
    if (!(error instanceof DatabaseSafetyError)) {
      console.error(" The failure was not a guard decision; treat it as a configuration error.");
    }
    console.error(" Execution halted immediately. Production database is protected.");
    console.error("============================================================");
    process.exit(1);
  }
}

runVerification();
