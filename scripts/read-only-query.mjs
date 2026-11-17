import { PsqlError, runPsql } from "./psql.mjs";

/** Execute a single internal SELECT in its own server-enforced read-only
 * transaction. The read-only flag is returned by the SAME statement and
 * connection as the result, so a pooler cannot substitute a different session.
 * Never use this helper for SQL supplied by a user. */
export function queryReadOnlyJson({ url, psqlBin, sql, runner = runPsql }) {
  const statement = sql.trim().replace(/;\s*$/, "");
  if (!/^(SELECT|WITH)\b/i.test(statement) || /;\s*\S/.test(statement)) {
    throw new PsqlError("Read-only query must be one internal SELECT statement.");
  }
  const input = `BEGIN READ ONLY;\nSELECT json_build_object('readOnly', current_setting('transaction_read_only'), 'value', payload::json)::text FROM (${statement}) AS result(payload);\nROLLBACK;\n`;
  const output = runner({ url, psqlBin, input });
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 3 || lines[0] !== "BEGIN" || lines[2] !== "ROLLBACK") {
    throw new PsqlError("Read-only transaction did not complete as expected; no result can be trusted.");
  }
  let result;
  try { result = JSON.parse(lines[1]); }
  catch { throw new PsqlError("Read-only transaction returned an invalid response."); }
  if (!result || typeof result !== "object" || result.readOnly !== "on" || !Object.hasOwn(result, "value")) {
    throw new PsqlError("The server did not confirm the query ran in a read-only transaction.");
  }
  return result.value;
}
