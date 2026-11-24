#!/usr/bin/env node
/** Offline preflight for an audit-migration rehearsal. Reads only an operator-
 * supplied JSON file, never connects to any database or changes one. The caller
 * must independently verify the disposable server and obtain ledger rows from it.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const AUDIT_MIGRATION = "20261115120000_append_only_audit_log";

export function checkAuditRehearsalLedger(manifest, rows) {
  if (!Array.isArray(manifest?.migrations) || !Array.isArray(rows)) throw new Error("Invalid manifest or ledger input.");
  const expected = new Map();
  for (const migration of manifest.migrations) {
    if (typeof migration.name !== "string" || !/^[0-9a-f]{64}$/.test(migration.sha256) || expected.has(migration.name)) throw new Error("Invalid or duplicated manifest entry.");
    expected.set(migration.name, migration.sha256);
  }
  if ([...expected.keys()].at(-1) !== AUDIT_MIGRATION) throw new Error("Audit migration must be the final manifest entry.");
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row.name !== "string" || typeof row.checksum !== "string" || typeof row.finished !== "boolean" || typeof row.rolledBack !== "boolean") throw new Error("Invalid ledger row.");
    if (row.finished && row.rolledBack) throw new Error("The restored ledger contains an inconsistent migration state.");
    if (!row.finished && !row.rolledBack) throw new Error("The restored ledger contains an unresolved migration.");
    if (!expected.has(row.name)) throw new Error("The restored ledger contains an unknown migration.");
    if (row.name === AUDIT_MIGRATION) throw new Error("Audit migration has already been attempted; restore a fresh archive.");
    // A known historical rolled-back attempt does not count as applied. Its
    // checksum may differ from a later successful retry of the same migration.
    if (row.rolledBack) continue;
    if (!expected.has(row.name) || expected.get(row.name) !== row.checksum || seen.has(row.name)) throw new Error("Applied migration ledger differs from the reviewed manifest.");
    seen.add(row.name);
  }
  expected.delete(AUDIT_MIGRATION);
  if (seen.size !== expected.size || [...expected.keys()].some((name) => !seen.has(name))) throw new Error("The restored copy does not have exactly the expected prior migrations.");
  return { priorMigrations: seen.size, pending: AUDIT_MIGRATION };
}

function main() {
  if (process.argv.length !== 4) throw new Error("Usage: node scripts/audit-rehearsal-ledger.mjs <manifest.json> <ledger.json>");
  const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const rows = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const result = checkAuditRehearsalLedger(manifest, rows);
  console.log(`Ledger preflight PASS: ${result.priorMigrations} prior migrations; only ${result.pending} pending.`);
  console.log("This offline check does not verify the database target, actual migration files, or deployment safety.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`Ledger preflight STOP: ${error.message}`); process.exitCode = 1; }
}
