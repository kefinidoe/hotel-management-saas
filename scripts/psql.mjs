/**
 * Thin, explicit wrapper around the `psql` client used by the migration
 * rehearsal and adoption tooling.
 *
 * The repository intentionally has no `pg` dependency: the migration tools must
 * use the same PostgreSQL client the operator would use by hand, so that a
 * rehearsal exercises the real wire protocol and the server's own SQL parser.
 * `psql` therefore has to be on PATH, or supplied with --psql / PSQL_BIN.
 *
 * Every call uses -X (ignore ~/.psqlrc), --no-password and ON_ERROR_STOP=1 so a
 * script can never continue past a failed statement or hang on a password
 * prompt.
 */
import { execFileSync } from "node:child_process";

export class PsqlError extends Error {
  constructor(message, { stderr, status } = {}) {
    super(message);
    this.name = "PsqlError";
    this.stderr = stderr;
    this.status = status;
  }
}

export function resolvePsql(psqlPath) {
  return psqlPath || process.env.PSQL_BIN || "psql";
}

export function psqlVersion(psqlBin) {
  try {
    return execFileSync(psqlBin, ["--version"], { encoding: "utf8" }).trim();
  } catch (error) {
    throw new PsqlError(
      `Could not run '${psqlBin}'. Install the PostgreSQL client (matching the target major version) ` +
        "or pass --psql/PSQL_BIN. Rehearsals must never fall back to another client.",
      { stderr: error.stderr?.toString(), status: error.status }
    );
  }
}

/**
 * Run SQL through psql and return stdout.
 *
 * @param {object} options
 * @param {string} options.url          connection string (never logged)
 * @param {string} [options.sql]        SQL passed with -c
 * @param {string} [options.input]      SQL passed on stdin (for multi-statement scripts)
 * @param {string} [options.file]       path applied with -f
 * @param {string} [options.psqlBin]
 * @param {boolean} [options.singleTransaction] wrap a -f/-input script in one transaction
 * @param {boolean} [options.quiet] suppress NOTICE output (used for re-run/idempotency runs)
 */
export function runPsql({ url, sql, input, file, psqlBin = resolvePsql(), singleTransaction = false, quiet = false }) {
  const args = [url, "-X", "--no-password", "-v", "ON_ERROR_STOP=1"];
  if (singleTransaction) args.push("-1");
  if (sql !== undefined) args.push("-c", sql);
  if (file !== undefined) args.push("-f", file);
  args.push("-t", "-A");

  const env = { ...process.env, PGCONNECT_TIMEOUT: process.env.PGCONNECT_TIMEOUT ?? "10" };
  if (quiet) {
    env.PGOPTIONS = `${process.env.PGOPTIONS ?? ""} -c client_min_messages=warning`.trim();
  }
  try {
    return execFileSync(psqlBin, args, {
      encoding: "utf8",
      input: input ?? undefined,
      env,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const stderr = (error.stderr ?? "").toString().trim();
    throw new PsqlError(stderr || `psql exited with status ${error.status}`, { stderr, status: error.status });
  }
}

/** Read one JSON document produced by `json_build_object(...)`/`row_to_json(...)`. */
export function queryJson(options) {
  const output = runPsql(options).trim();
  const lastLine = output.split("\n").filter(Boolean).pop();
  if (!lastLine) throw new PsqlError("psql returned no rows for a JSON query.");
  return JSON.parse(lastLine);
}

/** Convenience: scalar text value. */
export function queryScalar(options) {
  return runPsql(options).trim();
}
