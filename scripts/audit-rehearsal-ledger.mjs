#!/usr/bin/env node
/** Offline preflight for an audit-migration rehearsal. Reads only an operator-
 * supplied JSON file, never connects to any database or changes one. The caller
 * must independently verify the disposable server and obtain ledger rows from it.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export const AUDIT_MIGRATION = "20261115120000_append_only_audit_log";
const KNOWN_CRLF = {
  name: "20261008123000_multi_tenant_saas_init",
  lf: "1699ad5263e6870210b92292bfde03aa10fb173f3ca4d39a59036a00f602663a",
  crlf: "6badbe313401501aeab622f7082f4182a0313c5149a02757a7afd166f533eccc",
};

export function checkAuditRehearsalLedger(manifest, rows, { allowKnownCrlf = false } = {}) {
  if (!Array.isArray(manifest?.migrations) || !Array.isArray(rows)) throw new Error("Invalid manifest or ledger input.");
  const expected = new Map();
  for (const migration of manifest.migrations) {
    if (typeof migration.name !== "string" || !/^[0-9a-f]{64}$/.test(migration.sha256) || expected.has(migration.name)) throw new Error("Invalid or duplicated manifest entry.");
    expected.set(migration.name, migration.sha256);
  }
  if ([...expected.keys()].at(-1) !== AUDIT_MIGRATION) throw new Error("Audit migration must be the final manifest entry.");
  const seen = new Set();
  const exceptions = [];
  for (const row of rows) {
    if (!row || typeof row.name !== "string" || typeof row.checksum !== "string" || typeof row.finished !== "boolean" || typeof row.rolledBack !== "boolean") throw new Error("Invalid ledger row.");
    if (row.finished && row.rolledBack) throw new Error("The restored ledger contains an inconsistent migration state.");
    if (!row.finished && !row.rolledBack) throw new Error("The restored ledger contains an unresolved migration.");
    if (!expected.has(row.name)) throw new Error("The restored ledger contains an unknown migration.");
    if (row.name === AUDIT_MIGRATION) throw new Error("Audit migration has already been attempted; restore a fresh archive.");
    // A known historical rolled-back attempt does not count as applied. Its
    // checksum may differ from a later successful retry of the same migration.
    if (row.rolledBack) continue;
    if (seen.has(row.name)) throw new Error(`Duplicate applied migration: ${row.name}`);
    if (expected.get(row.name) !== row.checksum) {
      const known = allowKnownCrlf && row.name === KNOWN_CRLF.name &&
        expected.get(row.name) === KNOWN_CRLF.lf && row.checksum === KNOWN_CRLF.crlf;
      if (!known) throw new Error(`Applied migration checksum differs from the reviewed manifest: ${row.name}`);
      exceptions.push(row.name);
    }
    seen.add(row.name);
  }
  expected.delete(AUDIT_MIGRATION);
  if (seen.size !== expected.size || [...expected.keys()].some((name) => !seen.has(name))) throw new Error("The restored copy does not have exactly the expected prior migrations.");
  return { priorMigrations: seen.size, pending: AUDIT_MIGRATION, exceptions };
}

function main() {
  if (process.argv.length !== 4 && !(process.argv.length === 5 && process.argv[4] === "--allow-known-crlf")) throw new Error("Usage: node scripts/audit-rehearsal-ledger.mjs <manifest.json> <ledger.json> [--allow-known-crlf]");
  const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const rows = JSON.parse(readFileSync(process.argv[3], "utf8"));
  const result = checkAuditRehearsalLedger(manifest, rows, { allowKnownCrlf: process.argv[4] === "--allow-known-crlf" });
  for (const name of result.exceptions) console.log(`EXPLICIT REHEARSAL EXCEPTION: ${name} ledger checksum matches the known CRLF form of the reviewed LF migration; the ledger is unchanged.`);
  console.log(`Ledger preflight PASS: ${result.priorMigrations} prior migrations; only ${result.pending} pending.`);
  console.log("This offline check does not verify the database target, actual migration files, or deployment safety.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { main(); } catch (error) { console.error(`Ledger preflight STOP: ${error.message}`); process.exitCode = 1; }
}
