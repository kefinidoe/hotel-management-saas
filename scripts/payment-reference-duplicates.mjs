#!/usr/bin/env node
// Read-only, potentially sensitive financial identifiers: run only on an
// explicitly authorised database and protect the report as financial data.
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadEnvFiles } from "./env-file.mjs";
import { assertDatabaseTarget } from "./database-target-safety.mjs";
import { sanitiseForPgTools } from "./pg-url.mjs";

export const DUPLICATE_REFERENCE_SQL = `SELECT "hotelId", NULLIF(translate(translate(reference, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13), ''), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '') AS reference,
  array_agg(id ORDER BY id) AS "paymentIds"
  FROM "Payment" WHERE NULLIF(translate(translate(reference, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13), ''), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '') IS NOT NULL
  GROUP BY "hotelId", NULLIF(translate(translate(reference, ' ' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13), ''), 'abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'), '') HAVING count(*) > 1
  ORDER BY "hotelId", reference`;

async function main() {
  if (process.argv.length !== 2) throw new Error("Usage: node scripts/payment-reference-duplicates.mjs");
  loadEnvFiles();
  assertDatabaseTarget({ environment: process.env.SAAS_ENVIRONMENT, identifier: process.env.SAAS_DATABASE_IDENTIFIER,
    databaseUrl: process.env.DATABASE_URL, directUrl: process.env.DIRECT_URL, requireDirectUrl: "remote" });
  const client = new pg.Client({ connectionString: sanitiseForPgTools(process.env.DATABASE_URL), connectionTimeoutMillis: 10000 });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const check = await client.query("SELECT current_setting('transaction_read_only') AS mode");
    if (check.rows[0]?.mode !== "on") throw new Error("Read-only transaction not confirmed");
    const result = await client.query(DUPLICATE_REFERENCE_SQL);
    await client.query("ROLLBACK");
    console.log(JSON.stringify({ duplicateGroups: result.rows }, null, 2));
  } finally { await client.end(); }
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => { console.error("Duplicate-reference report failed. Check target identity and read access; connection details are not printed."); process.exitCode = 1; });
}
