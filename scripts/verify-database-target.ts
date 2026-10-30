/**
 * Pre-flight verification script for Hotel Management SaaS database target.
 *
 * Verifies that the current environment and connection strings point strictly
 * to the approved SaaS database. Never reveals credentials or secrets.
 *
 * Usage:
 *   npx tsx scripts/verify-database-target.ts
 */

import { assertDatabaseSafety } from "../lib/db-safety-guard";

function runVerification() {
  console.log("============================================================");
  console.log("  HOTEL MANAGEMENT SAAS - DATABASE SAFETY VERIFICATION");
  console.log("============================================================");

  try {
    const meta = assertDatabaseSafety();
    console.log(" [SAFETY CHECK PASSED]");
    console.log(` - Environment Status : VERIFIED (saas)`);
    console.log(` - Approved Identifier: ${meta.identifierMatched}`);
    console.log(` - Target Host        : ${meta.host}`);
    console.log(` - Target Port        : ${meta.port}`);
    console.log(` - Target Database    : ${meta.database}`);
    if (meta.userPrefix) {
      console.log(` - Project Reference  : ${meta.userPrefix}`);
    }
    console.log("------------------------------------------------------------");
    console.log(" Configured target matches the declared identifier only.");
    console.log(" This check does NOT verify ownership, production status, or migration history.");
    console.log(" Independently verify the project and migration history before any DB operation.");
    console.log("============================================================");
    process.exit(0);
  } catch (error) {
    console.error(" [CRITICAL DATABASE SAFETY CHECK FAILED]");
    console.error(` Error: ${(error as Error).message}`);
    console.error(" Execution halted immediately. Production database is protected.");
    console.error("============================================================");
    process.exit(1);
  }
}

runVerification();
