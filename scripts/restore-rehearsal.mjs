#!/usr/bin/env node
/**
 * Restore rehearsal in one command: verify an archive's identity, restore it
 * into a disposable database this script creates, fingerprint the result, then
 * drop the database again.
 *
 * Why a script and not a checklist
 * --------------------------------
 * A restore is only evidence if the archive that was restored is the archive
 * whose digest was recorded, and if the restored database is thrown away
 * afterwards. Both are easy to get wrong by hand: `pg_restore` happily restores
 * the wrong file, and a half-finished rehearsal leaves a database behind on a
 * server nobody is watching. Here the digest is checked *before* the server is
 * contacted, the scratch database name is generated (and refused if it already
 * exists), and the database is dropped in every path except `--keep`.
 *
 * The archive's recorded identity is supplied with `--expect-sha256`. Without
 * it the script still restores, but reports `digestVerified: false` and exits 0
 * only if `--allow-unverified` is passed: an unverified restore proves that the
 * file is a valid dump, not that it is *the* backup. For a production backup the
 * expected digest is
 *   F81566E9CCBB511DD34D0FEA5076934CDFBB03CD8BCDE1B1611E8D0F77DB24A7
 * (hotel-management-saas-20261028-140823.dump, 384096 bytes). Pass it explicitly;
 * this script does not hard-code a digest for a file it has not seen.
 *
 * Server selection
 * ----------------
 * `--base-url` (or RESTORE_REHEARSAL_BASE_URL) is the server that hosts the
 * disposable database; it must not be the database this app runs on. Loopback is
 * the default (postgresql://postgres@127.0.0.1:5432). Any other host needs
 * `--allow-remote-target`, because a rehearsal creates and drops a database:
 * that belongs on a scratch server or a dedicated scratch project, never on a
 * shared one.
 *
 * Usage: node scripts/restore-rehearsal.mjs --dump <path> [options]
 *
 * Exit codes: 0 restored and (by default) dropped, 1 anything failed,
 * 2 usage error.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  APPLICATION_SCHEMA,
  SUPABASE_ONLY_TYPES,
  buildFilteredToc,
  parseToc,
  summariseToc,
} from "./archive-toc.mjs";
import { buildFeatureQuery, evaluateCheckpoints } from "./migration-ledger.mjs";
import { psqlVersion, queryJson, queryScalar, PsqlError, resolvePsql, runPsql } from "./psql.mjs";
import { sanitiseForPgTools } from "./pg-url.mjs";

const USAGE = `Usage: node scripts/restore-rehearsal.mjs --dump <path> [options]

Verifies an archive, restores it into a disposable database, fingerprints the
restored schema and data, then drops that database.

Options:
  --dump <path>              Archive to restore (pg_dump custom/tar, a directory
                             archive, or a plain .sql file). Required.
  --expect-sha256 <hex>      Recorded SHA-256 of the archive. Restore is refused
                             unless the file matches.
  --allow-unverified         Permit a restore without --expect-sha256 (the report
                             then states that the digest was not verified).
  --base-url <url>           Server that hosts the scratch database.
                             Default: RESTORE_REHEARSAL_BASE_URL, then
                             postgresql://postgres@127.0.0.1:5432
  --maintenance-db <name>    Database used to CREATE/DROP the scratch database
                             (default: postgres).
  --database <name>          Scratch database name. Default:
                             rehearsal_restore_<YYYYMMDD_HHMMSS>. Refused if it
                             already exists.
  --psql <path>              psql binary (default PSQL_BIN, then psql on PATH).
  --pg-restore <path>        pg_restore binary (default PG_RESTORE_BIN, then a
                             sibling of psql, then pg_restore on PATH).
  --expect-checkpoint <ids>  Comma-separated acceptable checkpoint ids for the
                             restored schema.
  --profile <auto|plain|supabase>
                             How much of the archive to restore. 'plain' (the
                             default when the archive carries Supabase schemas and
                             the target is a stock server) restores the application
                             schema and skips Supabase-managed schemas, event
                             triggers and extensions the target does not have.
                             'supabase' assumes a local Supabase stack.
                             'auto' decides from the archive and the server.
  --exclude-schema <names>   Extra schemas to skip (comma-separated), in addition
                             to the Supabase-managed ones.
  --toc                      Analyse the archive's table of contents and exit;
                             no database is created and nothing is restored.
  --keep                     Keep the restored database (its name is printed).
  --allow-remote-target      Permit a non-loopback --base-url.
  --json                     Print the report as JSON.
  --help, -h                 Show this text.
`;

// Session default for the post-restore inspection: the server, not this script,
// rejects writes while the restored database is being read.
const READ_ONLY_OPTION = "-c default_transaction_read_only=on";

/**
 * A scratch database that exists and has not been dropped yet.
 *
 * The normal path drops it and clears this, so reaching the top-level error
 * handler with it still set means main() threw somewhere unexpected (an fs
 * error, a psql failure outside the handled branches, a bug). Without this, such
 * a throw would leave a database behind on the server -- which is how
 * "disposable" quietly stops being true.
 */
let scratchToClean = null;

/** Temporary files/directories created for a --use-list restore; removed on exit. */
const tempPathsToClean = [];

function cleanTempPaths() {
  for (const target of tempPathsToClean.splice(0)) {
    try {
      rmSync(target, { recursive: true, force: true });
    } catch {
      // Leaving a temp lint file behind is not worth failing the run over.
    }
  }
}

// Tables fingerprinting tries to count. Absent tables are skipped, so this list
// can cover both the pre-tenancy and the current schema.
const KEY_TABLES = [
  "User",
  "Hotel",
  "HotelMembership",
  "Guest",
  "Room",
  "ReservationRoom",
  "Order",
  "Payment",
  "Wastage",
  "Subscription",
  "AuditLog",
];

function parseArgs(argv) {
  const options = {
    dump: undefined,
    expectSha256: undefined,
    allowUnverified: false,
    baseUrl: undefined,
    maintenanceDb: "postgres",
    database: undefined,
    psql: undefined,
    pgRestore: undefined,
    expectCheckpoint: undefined,
    profile: "auto",
    excludeSchemas: [],
    toc: false,
    keep: false,
    allowRemote: false,
    json: false,
    help: false,
  };

  const takeValue = (flag, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value.`);
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--dump":
        options.dump = takeValue(arg, i++);
        break;
      case "--expect-sha256": {
        const value = takeValue(arg, i++);
        if (!/^[0-9a-f]{64}$/i.test(value)) throw new Error("--expect-sha256 must be a 64-character hex digest.");
        options.expectSha256 = value.toLowerCase();
        break;
      }
      case "--allow-unverified":
        options.allowUnverified = true;
        break;
      case "--base-url":
        options.baseUrl = takeValue(arg, i++);
        break;
      case "--maintenance-db":
        options.maintenanceDb = takeValue(arg, i++);
        break;
      case "--database":
        options.database = takeValue(arg, i++);
        break;
      case "--psql":
        options.psql = takeValue(arg, i++);
        break;
      case "--pg-restore":
        options.pgRestore = takeValue(arg, i++);
        break;
      case "--expect-checkpoint":
        options.expectCheckpoint = takeValue(arg, i++)
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        break;
      case "--profile": {
        const value = takeValue(arg, i++);
        if (!["auto", "plain", "supabase"].includes(value)) throw new Error("--profile accepts auto, plain or supabase.");
        options.profile = value;
        break;
      }
      case "--exclude-schema": {
        const schemas = takeValue(arg, i++)
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        // Excluding `public` would drop every table this application owns, leaving
        // a rehearsal that restores nothing and proves nothing.
        if (schemas.includes(APPLICATION_SCHEMA)) {
          throw new Error(`--exclude-schema cannot drop '${APPLICATION_SCHEMA}': that is the schema the application owns.`);
        }
        options.excludeSchemas = schemas;
        break;
      }
      case "--toc":
        options.toc = true;
        break;
      case "--keep":
        options.keep = true;
        break;
      case "--allow-remote-target":
        options.allowRemote = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option '${arg}'.`);
    }
  }
  return options;
}

function sha256File(file) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/**
 * Digest of a directory-format archive. Sorted relative paths plus each file's
 * own digest, so the result changes if any member changes and does not depend on
 * filesystem ordering.
 */
async function sha256Directory(root) {
  const hash = createHash("sha256");
  const walk = async (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        hash.update(`dir ${relative}\n`);
        await walk(full);
      } else {
        const digest = await sha256File(full);
        hash.update(`file ${relative} ${statSync(full).size} ${digest}\n`);
      }
    }
  };
  await walk(root);
  return hash.digest("hex");
}

function detectFormat(dumpPath) {
  if (statSync(dumpPath).isDirectory()) return "directory";
  const fd = openSync(dumpPath, "r");
  try {
    const header = Buffer.alloc(5);
    readSync(fd, header, 0, 5, 0);
    return header.toString("latin1") === "PGDMP" ? "custom" : "plain";
  } finally {
    closeSync(fd);
  }
}

function resolvePgRestore(explicit, psqlBin) {
  if (explicit) return explicit;
  if (process.env.PG_RESTORE_BIN) return process.env.PG_RESTORE_BIN;
  // A --psql pointing into a PostgreSQL bin/ directory implies a matching
  // pg_restore; prefer it over whatever happens to be on PATH, because a client
  // older than the archive's format version cannot read it.
  if (psqlBin.includes(path.sep)) {
    const candidate = path.join(path.dirname(psqlBin), process.platform === "win32" ? "pg_restore.exe" : "pg_restore");
    if (existsSync(candidate)) return candidate;
  }
  return "pg_restore";
}

function pgRestoreVersion(bin) {
  const result = spawnSync(bin, ["--version"], { encoding: "utf8" });
  if (result.error) throw new Error(`Could not run '${bin}': ${result.error.message}`);
  return (result.stdout || "").trim();
}

function runPgRestore(bin, args) {
  const result = spawnSync(bin, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw new Error(`Could not run ${bin}: ${result.error.message}`);
  return { status: result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

function withDatabase(baseUrl, database) {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return sanitiseForPgTools(url.toString());
}

function isLoopback(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Post-restore, read-only inspection: ledger, checkpoint, tables, key row counts. */
function inspectRestored(url, psqlBin) {
  process.env.PGOPTIONS = `${process.env.PGOPTIONS ?? ""} ${READ_ONLY_OPTION}`.trim();

  const identity = queryJson({
    url,
    psqlBin,
    sql: `SELECT json_build_object(
        'database', current_database(),
        'serverVersion', current_setting('server_version'),
        'readOnly', current_setting('transaction_read_only'),
        'ledgerExists', to_regclass('public."_prisma_migrations"') IS NOT NULL,
        'publicTables', (
          SELECT count(*) FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ),
        'tables', (
          SELECT coalesce(json_agg(table_name ORDER BY table_name), '[]')
          FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        )
      )::text;`,
  });

  const ledgerRows = identity.ledgerExists
    ? Number(
        queryScalar({ url, psqlBin, sql: 'SELECT count(*) FROM "_prisma_migrations";' }) || "0"
      )
    : 0;
  const failedRows = identity.ledgerExists
    ? Number(
        queryScalar({
          url,
          psqlBin,
          sql: 'SELECT count(*) FROM "_prisma_migrations" WHERE "finished_at" IS NULL AND "rolled_back_at" IS NULL;',
        }) || "0"
      )
    : 0;

  const features = queryJson({ url, psqlBin, sql: buildFeatureQuery() });
  const checkpoints = evaluateCheckpoints(features);

  const present = new Set(identity.tables ?? []);
  // Every public table, not a hard-coded shortlist: a backup rehearsal has to
  // account for all of the owner's tables, including ones this repository does
  // not know about. `KEY_TABLES` only decides the order in the human summary.
  const wanted = [...present].sort((a, b) => {
    const rank = (name) => (KEY_TABLES.includes(name) ? KEY_TABLES.indexOf(name) : KEY_TABLES.length);
    return rank(a) - rank(b) || a.localeCompare(b);
  });
  const rowCounts = {};
  if (wanted.length > 0) {
    // Column names deliberately differ from the subquery alias (`t`): naming a
    // column `rows` inside `... FROM (...) rows` makes `row_to_json(rows)` resolve
    // to the bigint column instead of the row, which is exactly how this failed
    // the first time it ran.
    const union = wanted
      .map(
        (name) =>
          `SELECT '${name.replace(/'/g, "''")}'::text AS table_name, count(*)::bigint AS row_count FROM ${quoteIdent(name)}`
      )
      .join(" UNION ALL ");
    const rows = queryJson({
      url,
      psqlBin,
      sql: `SELECT coalesce(json_agg(row_to_json(t))::text, '[]') FROM (${union}) t;`,
    });
    for (const row of rows) rowCounts[row.table_name] = Number(row.row_count);
  }

  return {
    database: identity.database,
    serverVersion: identity.serverVersion,
    readOnly: identity.readOnly,
    ledgerExists: identity.ledgerExists,
    ledgerRows,
    failedLedgerRows: failedRows,
    publicTables: identity.publicTables,
    tables: identity.tables,
    checkpoints,
    rowCounts,
  };
}

/** Extensions this server can install, regardless of whether they are installed. */
function availableExtensions(url, psqlBin) {
  const raw = queryScalar({
    url,
    psqlBin,
    sql: "SELECT coalesce(json_agg(name)::text, '[]') FROM pg_available_extensions;",
  });
  return JSON.parse(raw || "[]");
}

/** Does this server have Supabase's role? i.e. is it a local Supabase stack? */
function targetHasRole(url, psqlBin, role) {
  const count = queryScalar({
    url,
    psqlBin,
    sql: `SELECT count(*) FROM pg_roles WHERE rolname = '${String(role).replace(/'/g, "''")}';`,
  });
  return Number(count) > 0;
}

/**
 * Write a `pg_restore --use-list` file outside the repository and return its path.
 * It is deleted with the scratch database; it contains object names, not data.
 */
function writeUseList(text) {
  const dir = mkdtempSync(path.join(tmpdir(), "restore-uselist-"));
  const file = path.join(dir, "toc.list");
  writeFileSync(file, text);
  tempPathsToClean.push(dir);
  return file;
}

/**
 * Drop the scratch database and clear the read-only session default first.
 *
 * `DROP DATABASE` is refused inside a read-only transaction, and the inspection
 * phase sets that default for the whole process, so the option has to come off
 * before the maintenance connection is used -- whether or not inspection got far
 * enough to matter.
 */
function dropScratchDatabase({ maintenanceUrl, psqlBin, database }) {
  process.env.PGOPTIONS = (process.env.PGOPTIONS ?? "").replace(READ_ONLY_OPTION, "").trim();
  if (!process.env.PGOPTIONS) delete process.env.PGOPTIONS;
  runPsql({ url: maintenanceUrl, psqlBin, sql: `DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE);` });
}

function printHumanReport(report) {
  const lines = [];
  lines.push("");
  lines.push("Backup restore rehearsal");
  lines.push("------------------------");
  lines.push(`Archive              : ${report.archive.path}`);
  lines.push(
    `Archive size         : ${report.archive.size === null ? "directory archive" : formatBytes(report.archive.size)} (${report.archive.format} format)`
  );
  lines.push(`Archive SHA-256      : ${report.archive.sha256}`);
  lines.push(
    `Table of contents    : ${
      report.archive.tocEntries === null ? "plain SQL (no table of contents)" : `${report.archive.tocEntries} entries, parsed by pg_restore`
    }`
  );
  lines.push(
    `Digest verified      : ${
      report.archive.digestVerified
        ? "yes, matches --expect-sha256"
        : report.archive.expectedSha256
          ? "NO: the archive does not match the recorded digest"
          : "no (no --expect-sha256 supplied)"
    }`
  );
  if (report.archive.expectedSha256) lines.push(`Expected SHA-256     : ${report.archive.expectedSha256}`);
  lines.push(`Base server          : ${report.server.host} (maintenance db: ${report.server.maintenanceDatabase})`);
  lines.push(`psql / pg_restore    : ${report.server.psqlVersion} / ${report.server.pgRestoreVersion}`);
  lines.push(`Scratch database     : ${report.scratch.database}${report.scratch.created ? "" : " (not created)"}`);
  if (report.restore.filter) {
    const filter = report.restore.filter;
    lines.push(
      `Restore profile      : ${filter.profile} — kept ${filter.kept} of ${
        report.archive.tocEntries ?? filter.kept + filter.excluded
      } TOC entries, skipped ${filter.excluded}` +
        (filter.excluded > 0 ? ` (${Object.entries(filter.byReason).map(([reason, count]) => `${reason}: ${count}`).join(", ")})` : "")
    );
    if (filter.excludeSchemas?.length) lines.push(`Skipped schemas      : ${filter.excludeSchemas.join(", ")}`);
    if (filter.excludeExtensions?.length) lines.push(`Skipped extensions   : ${filter.excludeExtensions.join(", ")}`);
  }
  lines.push("");
  lines.push(`Restore              : ${report.restore.ok ? "finished with no errors" : "FAILED"}`);
  if (report.restore.problems.length > 0) {
    for (const line of report.restore.problems.slice(0, 10)) lines.push(`  ! ${line}`);
  }

  if (report.inspection) {
    const inspection = report.inspection;
    lines.push("");
    lines.push("Restored database (read-only inspection)");
    lines.push(`  Server version     : ${inspection.serverVersion}`);
    lines.push(`  Public tables      : ${inspection.publicTables}`);
    lines.push(
      `  Ledger             : ${inspection.ledgerExists ? `present, ${inspection.ledgerRows} row(s), ${inspection.failedLedgerRows} unfinished` : "absent (pre-ledger backup)"}`
    );
    lines.push(`  Detected checkpoint: ${inspection.checkpoints.length ? inspection.checkpoints.join(", ") : "none matched"}`);
    if (inspection.missingTables) {
      lines.push(
        `  Table coverage     : ${inspection.missingTables.length === 0 ? "every archive table restored" : `MISSING ${inspection.missingTables.join(", ")}`}`
      );
      if (inspection.extraTables.length > 0) lines.push(`  Extra tables       : ${inspection.extraTables.join(", ")}`);
    }
    const counts = Object.entries(inspection.rowCounts);
    if (counts.length > 0) {
      lines.push(`  Row counts (${counts.length} tables):`);
      for (const [name, rows] of counts) lines.push(`    ${name.padEnd(28)} ${rows}`);
    }
  }

  lines.push("");
  if (report.checks.length > 0) {
    lines.push("Checks");
    for (const check of report.checks) lines.push(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? `: ${check.detail}` : ""}`);
    lines.push("");
  }
  lines.push(`Cleanup              : ${report.cleanup.details}`);
  lines.push("");
  lines.push(report.ok ? "Result: PASS." : "Result: FAIL. See the failed checks above.");
  return lines.join("\n");
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!options.dump) {
    process.stderr.write(`--dump is required: point it at the archive to rehearse.\n\n${USAGE}`);
    return 2;
  }
  if (!existsSync(options.dump)) {
    process.stderr.write(
      `No such archive: ${options.dump}\n` +
        "This rehearsal restores a real archive only; it never creates one to stand in for a missing backup.\n"
    );
    return 1;
  }
  if (!options.expectSha256 && !options.allowUnverified) {
    process.stderr.write(
      "Refusing to rehearse without the archive's recorded digest.\n" +
        "Pass --expect-sha256 <hex> so the rehearsal proves that this exact file is the recorded backup.\n" +
        "Use --allow-unverified only to test the harness against an archive whose digest is not yet on record.\n"
    );
    return 1;
  }

  const dumpPath = path.resolve(options.dump);
  const stats = statSync(dumpPath);
  if (!stats.isDirectory() && stats.size === 0) {
    process.stderr.write(`The archive is empty: ${dumpPath}\n`);
    return 1;
  }

  const format = detectFormat(dumpPath);
  const sha256 = stats.isDirectory() ? await sha256Directory(dumpPath) : await sha256File(dumpPath);
  const digestVerified = options.expectSha256 ? sha256 === options.expectSha256 : false;

  if (options.expectSha256 && !digestVerified) {
    process.stderr.write(
      `Archive digest does not match the recorded value; nothing was restored.\n` +
        `  archive : ${dumpPath}\n  sha256  : ${sha256}\n  expected: ${options.expectSha256}\n` +
        "Stop here: restoring a different archive would produce evidence for the wrong file.\n"
    );
    return 1;
  }

  const baseUrlRaw = options.baseUrl || process.env.RESTORE_REHEARSAL_BASE_URL || "postgresql://postgres@127.0.0.1:5432";
  let baseUrl;
  try {
    baseUrl = new URL(baseUrlRaw);
  } catch {
    process.stderr.write("--base-url is not a valid PostgreSQL URL (it is never echoed, since it may hold a password).\n");
    return 1;
  }
  if (baseUrl.protocol !== "postgres:" && baseUrl.protocol !== "postgresql:") {
    process.stderr.write("--base-url must use the postgres or postgresql protocol.\n");
    return 1;
  }
  if (!isLoopback(baseUrl.hostname) && !options.allowRemote) {
    process.stderr.write(
      `Refusing to create and drop databases on '${baseUrl.hostname}': this rehearsal owns a scratch database, ` +
        "so it belongs on a scratch server or a disposable project.\n" +
        "If that host really is disposable, re-run with --allow-remote-target.\n"
    );
    return 1;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(options.maintenanceDb)) {
    process.stderr.write("--maintenance-db must be a plain PostgreSQL identifier.\n");
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "").replace("T", "_");
  const database = options.database || `rehearsal_restore_${stamp}`;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(database)) {
    process.stderr.write("--database must be a lower-case PostgreSQL identifier, at most 63 characters.\n");
    return 1;
  }
  if (database === options.maintenanceDb || ["postgres", "template0", "template1"].includes(database)) {
    process.stderr.write(`Refusing to use '${database}' as the scratch database.\n`);
    return 1;
  }

  // Never restore into the database name this app is configured for, even on the
  // same host: the name collision is the mistake worth catching.
  const live = process.env.DIRECT_URL || process.env.DATABASE_URL;
  if (live) {
    try {
      const liveUrl = new URL(live);
      if (liveUrl.hostname === baseUrl.hostname && liveUrl.pathname.replace(/^\//, "") === database) {
        process.stderr.write(
          `Refusing to use '${database}': that is the database this app is configured to use.\n`
        );
        return 1;
      }
    } catch {
      // An unparseable live URL cannot collide with a name we generate.
    }
  }

  const psqlBin = resolvePsql(options.psql);
  let psqlClientVersion;
  let pgRestoreBin;
  let pgRestoreClientVersion;
  try {
    psqlClientVersion = psqlVersion(psqlBin);
    pgRestoreBin = resolvePgRestore(options.pgRestore, psqlBin);
    pgRestoreClientVersion = pgRestoreVersion(pgRestoreBin);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  // Read the archive's table of contents before touching the server. A truncated
  // or corrupt dump must fail here, with no database created and nothing to
  // clean up -- the previous behaviour created the scratch database first and
  // only discovered the corruption inside pg_restore.
  let tocEntries = null;
  let parsedToc = null;
  let tocSummary = null;
  let listingText = null;
  if (format !== "plain") {
    const listing = spawnSync(pgRestoreBin, ["--list", dumpPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (listing.error) {
      process.stderr.write(`Could not run ${pgRestoreBin}: ${listing.error.message}\n`);
      return 1;
    }
    if (listing.status !== 0) {
      process.stderr.write(
        `The archive could not be read by pg_restore; nothing was restored and no database was created.\n` +
          `${(listing.stderr ?? "").trim().slice(0, 500)}\n`
      );
      return 1;
    }
    listingText = listing.stdout ?? "";
    parsedToc = parseToc(listingText);
    tocSummary = summariseToc(parsedToc);
    tocEntries = tocSummary.entries;
  }

  if (options.toc) {
    // Analysis only: no database is created, nothing is restored. This is the
    // step that tells an operator whether the archive is a Supabase dump and what
    // a plain PostgreSQL server will and will not be able to take from it.
    if (format === "plain" || !tocSummary) {
      process.stderr.write(
        "A plain SQL archive has no table of contents, so there is nothing to analyse.\n" +
          "This mode reads the archive the way the restore does: with pg_restore --list.\n" +
          "Use the custom or directory format (pg_dump -Fc / -Fd) for an analysable archive.\n"
      );
      return 1;
    }
    const summary = {
      mode: "archive-analysis",
      archive: {
        path: dumpPath,
        size: stats.isDirectory() ? null : stats.size,
        format,
        sha256,
        expectedSha256: options.expectSha256 ?? null,
        digestVerified,
        entries: tocEntries,
      },
      analysis: tocSummary,
    };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      const lines = [];
      lines.push("");
      lines.push("Archive analysis (no database is created)");
      lines.push("----------------------------------------");
      lines.push(`Archive            : ${dumpPath}`);
      lines.push(`Size / SHA-256     : ${stats.isDirectory() ? "directory archive" : formatBytes(stats.size)} / ${sha256}`);
      lines.push(`Digest verified    : ${digestVerified ? "yes" : options.expectSha256 ? "NO" : "no (no --expect-sha256)"}`);
      lines.push(`TOC entries        : ${tocSummary.entries}`);
      lines.push(`Schemas            : ${tocSummary.schemas.join(", ") || "none"}`);
      lines.push(`Application tables : ${tocSummary.applicationTables.length} in ${APPLICATION_SCHEMA}`);
      lines.push(`Extensions         : ${tocSummary.extensions.join(", ") || "none"}`);
      lines.push(`Supabase schemas   : ${tocSummary.supabaseSchemas.join(", ") || "none"}`);
      lines.push(`Looks like Supabase: ${tocSummary.looksLikeSupabase ? "yes" : "no"}`);
      lines.push(
        `Recommended profile: ${tocSummary.looksLikeSupabase ? "plain (application schema only) unless the target is a local Supabase stack" : "plain"}`
      );
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return digestVerified || !options.expectSha256 ? 0 : 1;
  }

  const maintenanceUrl = withDatabase(baseUrl.toString(), options.maintenanceDb);
  const scratchUrl = withDatabase(baseUrl.toString(), database);

  const report = {
    mode: "restore-rehearsal",
    archive: {
      path: dumpPath,
      size: stats.isDirectory() ? null : stats.size,
      format,
      sha256,
      expectedSha256: options.expectSha256 ?? null,
      digestVerified,
      tocEntries,
      analysis: tocSummary,
    },
    server: {
      host: baseUrl.hostname,
      maintenanceDatabase: options.maintenanceDb,
      psqlVersion: psqlClientVersion,
      pgRestoreVersion: pgRestoreClientVersion,
    },
    scratch: { database, created: false, kept: options.keep },
    restore: { ok: false, problems: [] },
    inspection: null,
    cleanup: { dropped: false, ok: true, details: "not attempted (no scratch database was created)" },
    checks: [],
    ok: false,
  };

  // Refuse before creating anything if the name is taken: a rehearsal must never
  // restore over a database it did not create.
  try {
    const exists = queryScalar({
      url: maintenanceUrl,
      psqlBin,
      sql: `SELECT count(*) FROM pg_database WHERE datname = '${database}';`,
    }).trim();
    if (exists !== "0") {
      process.stderr.write(
        `Database '${database}' already exists; refusing to restore into it.\n` +
          "Choose another --database name, or drop it yourself first.\n"
      );
      return 1;
    }
    runPsql({ url: maintenanceUrl, psqlBin, sql: `CREATE DATABASE ${quoteIdent(database)};` });
    report.scratch.created = true;
    scratchToClean = { maintenanceUrl, psqlBin, database };
  } catch (error) {
    if (error instanceof PsqlError) {
      process.stderr.write(`Could not create the scratch database (${database}): ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  // Decide how much of the archive this target can actually take. A Supabase
  // archive restored wholesale into a stock server fails partway through, which
  // leaves a half-restored database that proves nothing. `plain` keeps the
  // application schema and drops the platform schemas the server cannot satisfy.
  let restoreProfile = options.profile;
  let restoreFilter = null;
  let useListPath = null;
  if (format !== "plain" && parsedToc) {
    let available = [];
    try {
      available = availableExtensions(scratchUrl, psqlBin);
    } catch (error) {
      if (!(error instanceof PsqlError)) throw error;
      available = [];
    }
    tocSummary = summariseToc(parsedToc, { availableExtensions: available });
    report.archive.analysis = tocSummary;

    if (restoreProfile === "auto") {
      const isSupabaseStack = tocSummary.looksLikeSupabase && targetHasRole(scratchUrl, psqlBin, "supabase_admin");
      restoreProfile = isSupabaseStack ? "supabase" : "plain";
    }

    if (restoreProfile === "plain") {
      // `extensions` is kept even on a plain server: Supabase installs its
      // extensions there, and `CREATE EXTENSION ... SCHEMA extensions` fails if
      // the schema is missing. The extensions themselves are kept only when this
      // server can actually install them.
      const excludeSchemas = [
        ...new Set([
          ...tocSummary.supabaseSchemas.filter((name) => name !== "extensions"),
          ...options.excludeSchemas,
        ]),
      ];
      const excludeExtensions = tocSummary.extensions.filter((name) => !available.includes(name));
      const excludeTypes = SUPABASE_ONLY_TYPES.filter((type) => (tocSummary.byType[type] ?? 0) > 0);
      const filtered = buildFilteredToc(parsedToc, { excludeSchemas, excludeExtensions, excludeTypes });
      useListPath = writeUseList(filtered.text);
      const byReason = {};
      for (const entry of filtered.excluded) byReason[entry.reason] = (byReason[entry.reason] ?? 0) + 1;
      restoreFilter = {
        profile: restoreProfile,
        excluded: filtered.excluded.length,
        kept: filtered.kept,
        byReason,
        excludeSchemas,
        excludeExtensions,
        excludeTypes,
      };
    } else {
      restoreFilter = { profile: restoreProfile, excluded: 0, kept: tocSummary.entries, byReason: {} };
    }
  }

  let inspection = null;
  try {
    if (format === "plain") {
      runPsql({ url: scratchUrl, psqlBin, file: dumpPath });
      report.restore = { ok: true, problems: [], filter: null };
    } else {
      // --clean --if-exists: a freshly created database still owns a `public`
      // schema, and the archive's `CREATE SCHEMA public` would otherwise fail.
      // Dropping first makes the result exactly the archive; on an empty scratch
      // database the resulting "does not exist, skipping" notices are expected.
      const args = [
        "--dbname",
        scratchUrl,
        "--clean",
        "--if-exists",
        "--no-owner",
        "--no-privileges",
        "--single-transaction",
        "--exit-on-error",
        ...(useListPath ? ["--use-list", useListPath] : []),
        dumpPath,
      ];
      const result = runPgRestore(pgRestoreBin, args);
      const problems = result.stderr
        .split(/\r?\n/)
        .filter((line) => /error:/i.test(line) && !/does not exist, skipping/i.test(line));
      report.restore = {
        ok: result.status === 0 && problems.length === 0,
        problems,
        status: result.status,
        filter: restoreFilter,
      };
    }
  } catch (error) {
    if (error instanceof PsqlError) {
      report.restore = { ok: false, problems: [error.message] };
    } else {
      throw error;
    }
  }

  if (report.restore.ok) {
    try {
      inspection = inspectRestored(scratchUrl, psqlBin);
      report.inspection = inspection;
    } catch (error) {
      if (error instanceof PsqlError) {
        report.restore.ok = false;
        report.restore.problems.push(`Could not inspect the restored database: ${error.message}`);
      } else {
        throw error;
      }
    }
  }

  report.checks.push({
    name: "restore finished with no errors",
    ok: report.restore.ok,
    detail: report.restore.ok
      ? `${inspection ? `${inspection.publicTables} table(s) in public` : "restored, not inspected"}`
      : report.restore.problems[0] ?? `pg_restore exited with status ${report.restore.status ?? "unknown"}`,
  });

  if (inspection) {
    const archiveTables = tocSummary?.applicationTables ?? null;
    const restoredTables = (inspection.tables ?? []).filter((name) => !name.startsWith("_prisma"));
    if (archiveTables) {
      inspection.missingTables = archiveTables.filter((name) => !restoredTables.includes(name));
      inspection.extraTables = restoredTables.filter((name) => !archiveTables.includes(name));
      report.checks.push({
        name: "every application table in the archive was restored",
        ok: inspection.missingTables.length === 0,
        detail: inspection.missingTables.length
          ? `missing: ${inspection.missingTables.join(", ")}`
          : `${archiveTables.length} of ${archiveTables.length} table(s)`,
      });
    }
    report.checks.push({
      name: "restored schema matches a known checkpoint",
      ok: inspection.checkpoints.length > 0,
      detail: inspection.checkpoints.join(", ") || "no match",
    });
    if (options.expectCheckpoint) {
      report.checks.push({
        name: "restored schema matches an expected checkpoint",
        ok: inspection.checkpoints.some((id) => options.expectCheckpoint.includes(id)),
        detail: `expected ${options.expectCheckpoint.join("|")}, detected ${inspection.checkpoints.join("|") || "none"}`,
      });
    }
    report.checks.push({
      name: "inspection ran read-only",
      ok: inspection.readOnly === "on",
      detail: `transaction_read_only=${inspection.readOnly}`,
    });
  } else if (report.restore.ok) {
    report.checks.push({
      name: "restored database could be inspected",
      ok: false,
      detail: report.restore.problems.at(-1) ?? "inspection did not run",
    });
  }

  // Drop the scratch database unless asked to keep it. A rehearsal that leaves
  // databases behind is how "disposable" stops being true.
  if (report.scratch.created) {
    if (options.keep) {
      report.cleanup = { dropped: false, ok: true, kept: true, details: `kept at request (--keep): ${database}` };
      scratchToClean = null;
    } else {
      try {
        dropScratchDatabase({ maintenanceUrl, psqlBin, database });
        report.cleanup = { dropped: true, ok: true, details: `scratch database ${database} dropped` };
        scratchToClean = null;
      } catch (error) {
        const message = error instanceof PsqlError ? error.message : String(error?.message ?? error);
        report.cleanup = { dropped: false, ok: false, details: `could not drop ${database}: ${message}` };
        report.checks.push({ name: "scratch database removed", ok: false, detail: message });
      }
    }
  }

  cleanTempPaths();

  const checksOk = report.checks.every((check) => check.ok);
  report.ok = report.restore.ok && checksOk && report.cleanup.ok === true;

  process.stdout.write(`${options.json ? JSON.stringify(report, null, 2) : printHumanReport(report)}\n`);
  return report.ok ? 0 : 1;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    process.stderr.write(`${error?.message ?? error}\n`);
    cleanTempPaths();
    if (scratchToClean) {
      try {
        dropScratchDatabase(scratchToClean);
        process.stderr.write(`Dropped scratch database ${scratchToClean.database} after the failure.\n`);
      } catch (cleanupError) {
        const message = cleanupError instanceof PsqlError ? cleanupError.message : String(cleanupError?.message ?? cleanupError);
        process.stderr.write(`Could not drop scratch database ${scratchToClean.database}: ${message}\n`);
      }
    }
    process.exitCode = 1;
  });
