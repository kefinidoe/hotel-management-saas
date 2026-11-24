#!/usr/bin/env node
/** Read-only assessment of the actual DATABASE_URL role, never DIRECT_URL.
 * It intentionally does not create roles, grant privileges or change settings.
 * Run only against an explicitly approved target. No credentials are printed. */
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadEnvFiles } from "./env-file.mjs";
import { assertDatabaseTarget } from "./database-target-safety.mjs";
import { sanitiseForPgTools } from "./pg-url.mjs";

export const AUDIT_RUNTIME_QUERY = `
  SELECT current_setting('transaction_read_only') AS read_only,
    current_user AS runtime_role, session_user AS session_role,
    current_setting('session_replication_role') AS replication_role,
    c.oid IS NOT NULL AS audit_table_exists,
    COALESCE(has_table_privilege(current_user, c.oid, 'SELECT'), false) AS can_select,
    COALESCE(has_table_privilege(current_user, c.oid, 'INSERT'), false) AS can_insert,
    ARRAY(SELECT r.rolname FROM pg_roles r
      WHERE pg_has_role(current_user, r.oid, 'MEMBER') AND (
        r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls OR
        pg_has_role(r.oid, c.relowner, 'MEMBER') OR
        pg_has_role(r.oid, n.nspowner, 'MEMBER') OR
        EXISTS (SELECT 1 FROM pg_database d WHERE d.datname=current_database()
          AND pg_has_role(r.oid, d.datdba, 'MEMBER')) OR
        EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace=n.oid AND p.prosecdef
          AND has_function_privilege(r.oid, p.oid, 'EXECUTE')) OR
        EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace=n.oid
          AND p.proname='reject_audit_log_mutation' AND p.pronargs=0
          AND pg_has_role(r.oid, p.proowner, 'MEMBER')) OR
        has_schema_privilege(r.oid, n.oid, 'CREATE') OR
        has_table_privilege(r.oid, c.oid, 'UPDATE') OR
        has_any_column_privilege(r.oid, c.oid, 'UPDATE') OR
        has_table_privilege(r.oid, c.oid, 'DELETE') OR
        has_table_privilege(r.oid, c.oid, 'TRUNCATE')
      ) ORDER BY r.rolname) AS risky_roles
  FROM (SELECT 1) one
  LEFT JOIN pg_namespace n ON n.nspname='public'
  LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname='AuditLog' AND c.relkind IN ('r','p')
`;

export function evaluateAuditRuntime(row) {
  if (!row || row.read_only !== "on" || row.audit_table_exists !== true ||
      typeof row.can_select !== "boolean" || typeof row.can_insert !== "boolean" ||
      !Array.isArray(row.risky_roles) || typeof row.runtime_role !== "string" ||
      typeof row.session_role !== "string" || typeof row.replication_role !== "string") {
    return { ok: false, reason: "Could not establish a complete read-only audit role assessment." };
  }
  if (row.runtime_role !== row.session_role) return { ok: false, reason: "Runtime and session roles differ; investigate role switching." };
  if (row.replication_role !== "origin") return { ok: false, reason: "Session replication role is not origin; ordinary triggers may not fire." };
  if (!row.can_select || !row.can_insert) return { ok: false, reason: "Runtime role lacks audit SELECT or INSERT." };
  if (row.risky_roles.length) return { ok: false, reason: "Runtime role owns or can assume a role with dangerous audit/schema privileges.", riskyRoles: row.risky_roles };
  return { ok: true, reason: "No checked audit-table or schema privilege risks detected." };
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--connect") {
    console.error("Usage: node scripts/audit-runtime-role-check.mjs --connect (read-only; connects using DATABASE_URL)");
    process.exitCode = 2;
    return;
  }
  loadEnvFiles();
  assertDatabaseTarget({ environment: process.env.SAAS_ENVIRONMENT, identifier: process.env.SAAS_DATABASE_IDENTIFIER,
    databaseUrl: process.env.DATABASE_URL, directUrl: process.env.DIRECT_URL, requireDirectUrl: "remote" });
  const client = new pg.Client({ connectionString: sanitiseForPgTools(process.env.DATABASE_URL), connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    await client.query("BEGIN READ ONLY");
    const result = await client.query(AUDIT_RUNTIME_QUERY);
    const assessment = evaluateAuditRuntime(result.rows[0]);
    await client.query("ROLLBACK");
    console.log(`Audit runtime privilege check: ${assessment.ok ? "PASS" : "FAIL"}`);
    console.log(assessment.reason);
    if (assessment.riskyRoles?.length) console.log(`Risky roles: ${assessment.riskyRoles.join(", ")}`);
    console.log("This is a targeted privilege check, not proof of full application permissions, deployment readiness, retention compliance or protection from database administrators.");
    if (!assessment.ok) process.exitCode = 1;
  } finally { await client.end(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(() => { console.error("Audit role inspection failed. Check the approved target, database availability and privileges; no connection details are printed."); process.exitCode = 1; });
}
