/**
 * Reading and filtering a `pg_restore --list` table of contents.
 *
 * Why this exists
 * ---------------
 * The owner's backup is a Supabase database. A `pg_dump` of a Supabase project
 * is not a plain application dump: it carries the `auth`, `storage`, `realtime`,
 * `vault`, `graphql`, `extensions` and `supabase_migrations` schemas, Supabase's
 * event triggers, publications, foreign-data wrappers, and `CREATE EXTENSION`
 * statements for extensions only a Supabase stack provides. Restoring that into a
 * stock PostgreSQL server fails partway through, which is the worst outcome for a
 * rehearsal: a half-restored database proves nothing and looks like success to
 * anything that only checks the exit code.
 *
 * The safe approach is to decide *before* restoring what can be restored:
 * read the TOC, work out which schemas and extensions the target can actually
 * satisfy, comment out the rest with a `--use-list` file, and then verify that
 * every application table in the archive exists afterwards with its data.
 *
 * This module is deliberately pure: text in, decisions out. It is the part of
 * that reasoning that can be tested without a database.
 *
 * TOC line format (from pg_restore --list):
 *
 *   214; 1259 16385 TABLE public "Guest" postgres
 *  3310; 0 0 ACL - SCHEMA auth postgres
 *   206; 3079 16390 EXTENSION - "uuid-ossp"
 *
 * i.e. `<dumpId>; <catalogOid> <oid> <TYPE> [<schema>] <name> [<owner>]`.
 *
 * Three entries do not follow the positional reading, and all three matter here:
 *
 *  - `SCHEMA - auth supabase_admin` names the schema itself in `name`; the
 *    `schema` field is null. Filtering a schema out by matching `schema` alone
 *    therefore leaves the schema's own entry live, the schema gets created, and
 *    the restore fails on its first object instead of being skipped cleanly.
 *  - `CONSTRAINT`/`FK CONSTRAINT` entries name a table and then the constraint,
 *    so the constraint lands in `owner` (`name` is the table).
 *  - `COMMENT`/`ACL` entries that act on an extension or a schema put the object
 *    after the dash: `COMMENT - EXTENSION supabase_vault`, `ACL - SCHEMA auth`.
 *    Positionally that reads as `name: "EXTENSION", owner: "supabase_vault"`, so
 *    filtering on `type`/`name` never matches it. Left live, `pg_restore` runs
 *    `COMMENT ON EXTENSION supabase_vault ...` against a database where that
 *    extension was deliberately not created, and the whole restore aborts with
 *    `ERROR: extension "supabase_vault" does not exist` -- the failure seen in
 *    the first genuine rehearsal of the owner's backup. `objectType`/`objectName`
 *    expose the dependency so it can be excluded with its object.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** Schemas that belong to the Supabase platform rather than to this application. */
export const SUPABASE_MANAGED_SCHEMAS = [
  "auth",
  "storage",
  "realtime",
  "_realtime",
  "_analytics",
  "_supavisor",
  "vault",
  "graphql",
  "graphql_public",
  "extensions",
  "supabase_migrations",
  "supabase_functions",
  "pgbouncer",
  "net",
  "cron",
  "pgsodium",
  "pgtle",
];

/** The schema this application actually owns. */
export const APPLICATION_SCHEMA = "public";

/** TOC types that name their object in three words (`SEQUENCE OWNED BY public s`). */
const THREE_WORD_TYPES = new Set(["SEQUENCE OWNED BY"]);

/** TOC types that name their object in two words. */
const TWO_WORD_TYPES = new Set([
  "TABLE DATA",
  "TABLE ATTACH",
  "FK CONSTRAINT",
  "DEFAULT ACL",
  "EVENT TRIGGER",
  "MATERIALIZED VIEW",
  "USER MAPPING",
  "BLOB METADATA",
  "SEQUENCE SET",
]);

/**
 * TOC types that name a *dependent* object after the `-` placeholder, e.g.
 * `COMMENT - EXTENSION pgcrypto` or `ACL - SCHEMA auth`. Excluding the object
 * (the extension or schema) without excluding these leaves executable SQL behind
 * that references an object the restore never created.
 */
const DEPENDENT_OBJECT_TYPES = new Set(["COMMENT", "ACL", "DEFAULT ACL", "SECURITY LABEL"]);

/**
 * Object types Supabase adds that have no meaning (and no dependencies) on a
 * plain PostgreSQL server. Event triggers and publications in particular point at
 * Supabase's own functions, so restoring them would only produce errors.
 */
export const SUPABASE_ONLY_TYPES = [
  "EVENT TRIGGER",
  "FOREIGN DATA WRAPPER",
  "SERVER",
  "USER MAPPING",
  "PUBLICATION",
  "SUBSCRIPTION",
];

function unquote(value) {
  if (value && value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/""/g, '"');
  }
  return value ?? null;
}

/**
 * Split `pg_restore --list` output into header lines and entries.
 *
 * Lines beginning with `;` are the file's own comments and are preserved as
 * `header`. Everything else is parsed; a line that does not match the shape is
 * kept as `{ type: "UNPARSED", raw }` rather than dropped, so a filtering pass
 * can leave it alone and a report can say so.
 */
export function parseToc(text) {
  const header = [];
  const entries = [];

  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line) continue;
    if (line.startsWith(";")) {
      header.push(line);
      continue;
    }

    const match = line.match(/^(\d+);\s+(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!match) {
      entries.push({
        id: null,
        catalogOid: null,
        oid: null,
        type: "UNPARSED",
        schema: null,
        name: null,
        owner: null,
        objectType: null,
        objectName: null,
        raw: line,
      });
      continue;
    }

    const [, id, catalogOid, oid, firstWord, rest = ""] = match;
    let type = firstWord;
    let remainder = rest.trim();

    // `SEQUENCE OWNED BY public Guest_id_seq postgres` reads as a three-word type;
    // without this the parser called `OWNED` a schema and the analysis reported it
    // as one.
    const words = remainder ? remainder.split(/\s+/) : [];
    const threeWord = words.length >= 2 ? `${firstWord} ${words[0]} ${words[1]}` : "";
    const twoWord = words.length >= 1 ? `${firstWord} ${words[0]}` : "";
    if (THREE_WORD_TYPES.has(threeWord)) {
      type = threeWord;
      remainder = words.slice(2).join(" ").trim();
    } else if (TWO_WORD_TYPES.has(twoWord)) {
      type = twoWord;
      remainder = words.slice(1).join(" ").trim();
    }

    const parts = remainder ? remainder.split(/\s+/) : [];
    let schema = null;
    let name = null;
    let owner = null;
    let objectType = null;
    let objectName = null;

    if (type === "SCHEMA") {
      // SCHEMA - public postgres
      name = unquote(parts[1] ?? parts[0]);
      owner = parts[2] ?? null;
    } else if (parts.length >= 1) {
      schema = parts[0] === "-" ? null : unquote(parts[0]);
      name = unquote(parts[1] ?? null);
      owner = parts[2] ?? null;
    }

    // `COMMENT - EXTENSION supabase_vault`, `ACL - SCHEMA auth`: the object this
    // entry acts on is named after the dash, not in `schema`/`name`. Captured
    // separately so the filter can drop it together with that object.
    if (DEPENDENT_OBJECT_TYPES.has(type) && parts[0] === "-" && parts.length >= 3) {
      objectType = parts[1];
      objectName = unquote(parts[2]);
    }

    entries.push({
      id: Number(id),
      catalogOid: Number(catalogOid),
      oid: Number(oid),
      type,
      schema,
      name,
      owner,
      objectType,
      objectName,
      raw: line,
    });
  }

  return { header, entries };
}

/** Tables, views and materialized views that live in a schema. */
export function relationsIn(parsed, schema) {
  return parsed.entries
    .filter((entry) => entry.schema === schema && ["TABLE", "VIEW", "MATERIALIZED VIEW"].includes(entry.type))
    .map((entry) => entry.name)
    .filter(Boolean);
}

/**
 * Describe what an archive contains, and what a plain PostgreSQL target can do
 * with it.
 *
 * `availableExtensions` is optional; when given, extensions missing from the
 * target are listed as `unavailableExtensions`.
 */
export function summariseToc(parsed, { availableExtensions = null } = {}) {
  const byType = {};
  const bySchema = {};
  const schemas = new Set();
  const extensions = new Set();

  for (const entry of parsed.entries) {
    byType[entry.type] = (byType[entry.type] ?? 0) + 1;
    if (entry.schema) {
      schemas.add(entry.schema);
      bySchema[entry.schema] = (bySchema[entry.schema] ?? 0) + 1;
    }
    if (entry.type === "EXTENSION" && entry.name) extensions.add(entry.name);
    // SCHEMA entries carry their name in `name`, not `schema`.
    if (entry.type === "SCHEMA" && entry.name) {
      schemas.add(entry.name);
      bySchema[entry.name] = (bySchema[entry.name] ?? 0) + 1;
    }
  }

  const supabaseSchemas = [...schemas].filter((name) => SUPABASE_MANAGED_SCHEMAS.includes(name)).sort();
  const available = availableExtensions ? new Set(availableExtensions) : null;
  const extensionList = [...extensions].sort();

  return {
    entries: parsed.entries.length,
    byType,
    schemas: [...schemas].sort(),
    bySchema,
    supabaseSchemas,
    looksLikeSupabase: supabaseSchemas.length > 0,
    extensions: extensionList,
    unavailableExtensions: available ? extensionList.filter((name) => !available.has(name)) : null,
    applicationTables: relationsIn(parsed, APPLICATION_SCHEMA).sort(),
    supabaseOnlyObjectTypes: Object.keys(byType).filter((type) => SUPABASE_ONLY_TYPES.includes(type)).sort(),
  };
}

/**
 * Produce a `pg_restore --use-list` file that restores everything except the
 * entries the caller excluded.
 *
 * Excluded entry lines are commented out with `;`, which is exactly what
 * `pg_restore` treats as "do not restore this entry". Header lines are preserved
 * verbatim, and the original order is kept so dependencies between kept entries
 * stay intact.
 */
export function buildFilteredToc(parsed, { excludeSchemas = [], excludeExtensions = [], excludeTypes = [] } = {}) {
  const schemaSet = new Set(excludeSchemas);
  const extensionSet = new Set(excludeExtensions);
  const typeSet = new Set(excludeTypes);
  const excluded = [];

  const lines = [...parsed.header];
  for (const entry of parsed.entries) {
    // A SCHEMA entry names its schema in `name` (`SCHEMA - auth supabase_admin`);
    // every other entry names it in `schema`. Miss this and the schema is
    // excluded but created anyway by its own TOC entry -- which is exactly how
    // `auth` survived the first filtered restore.
    const owningSchema = entry.type === "SCHEMA" ? entry.name : entry.schema;
    const excludedBySchema = owningSchema !== null && schemaSet.has(owningSchema);
    const excludedByType = typeSet.has(entry.type);
    const excludedByExtension = entry.type === "EXTENSION" && extensionSet.has(entry.name);
    // A comment or ACL on an excluded object is executable SQL against something
    // this restore deliberately does not create: `COMMENT ON EXTENSION
    // supabase_vault`, `COMMENT ON SCHEMA auth`, `GRANT ... ON SCHEMA auth`. The
    // object's own entry being commented out is not enough -- that is exactly the
    // failure the first genuine rehearsal hit.
    const excludedByDependency =
      entry.objectType === "EXTENSION"
        ? extensionSet.has(entry.objectName)
        : entry.objectType === "SCHEMA"
          ? schemaSet.has(entry.objectName)
          : false;
    const reason = excludedBySchema
      ? "schema"
      : excludedByType
        ? "type"
        : excludedByExtension
          ? "extension"
          : excludedByDependency
            ? entry.type === "COMMENT"
              ? `${entry.objectType.toLowerCase()} comment`
              : `${entry.objectType.toLowerCase()} ${entry.type.toLowerCase()}`
            : null;
    if (reason) {
      excluded.push({ type: entry.type, schema: entry.schema, name: entry.name, objectType: entry.objectType, objectName: entry.objectName, reason });
      lines.push(`; ${entry.raw}`);
    } else {
      lines.push(entry.raw);
    }
  }

  return { text: `${lines.join("\n")}\n`, excluded, kept: parsed.entries.length - excluded.length };
}

// ── CLI ───────────────────────────────────────────────────────────────────────
//
// This module is a library first: the parser and filter are imported by
// `restore-rehearsal.mjs` and by the tests. The CLI below is for operators who
// want to look at an archive without rehearsing it -- no database, no scratch
// database, no writes. It is guarded so importing the module never runs it.

const USAGE = `Usage: node scripts/archive-toc.mjs --dump <path> [options]

Reads a pg_dump archive's table of contents with \`pg_restore --list\` and reports
what it contains and what a plain PostgreSQL server can restore from it. No
database is created or contacted; the archive is only read.

Options:
  --dump <path>                 Archive to analyse (custom, tar or directory).
                                Required.
  --toc                         Explicitly select analysis (the default action).
  --expect-sha256 <hex>         Compare the archive's SHA-256 with this value and
                                fail if they differ.
  --pg-restore <path>           pg_restore binary (default PG_RESTORE_BIN, then
                                pg_restore on PATH).
  --available-extension <list>  Comma-separated extensions the target can install,
                                without querying a database. Without it the report
                                cannot say which extensions are unavailable.
  --json                        Print the report as JSON.
  --help, -h                    Show this text.
`;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = {
    dump: null,
    expectSha256: null,
    pgRestore: process.env.PG_RESTORE_BIN || null,
    availableExtensions: null,
    json: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const takeValue = (name) => {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) throw new UsageError(`${name} requires a value.`);
      i++;
      return value;
    };

    switch (arg) {
      case "--dump":
        options.dump = takeValue("--dump");
        break;
      case "--toc":
        break;
      case "--expect-sha256": {
        const value = takeValue("--expect-sha256");
        if (!/^[0-9a-f]{64}$/i.test(value)) throw new UsageError("--expect-sha256 must be a 64-character hex digest.");
        options.expectSha256 = value.toLowerCase();
        break;
      }
      case "--pg-restore":
        options.pgRestore = takeValue("--pg-restore");
        break;
      case "--available-extension": {
        const value = takeValue("--available-extension");
        options.availableExtensions = value
          .split(",")
          .map((entry) => entry.trim())
          .filter(Boolean);
        break;
      }
      case "--json":
        options.json = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new UsageError(`Unknown option '${arg}'.`);
    }
  }

  return options;
}

function isCustomArchive(dumpPath) {
  let fd;
  try {
    fd = openSync(dumpPath, "r");
    const head = Buffer.alloc(5);
    return readSync(fd, head, 0, 5, 0) === 5 && head.toString("latin1") === "PGDMP";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function sha256File(file) {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(1024 * 1024);
  const fd = openSync(file, "r");
  try {
    let read;
    while ((read = readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, read));
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * Run `pg_restore --list` and return the raw text, the digest and the size.
 * Throws an Error whose message is meant for an operator, never a stack trace.
 */
export function readArchiveToc(dumpPath, { pgRestore = "pg_restore" } = {}) {
  const listing = spawnSync(pgRestore, ["--list", dumpPath], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (listing.error) {
    throw new Error(
      `Could not run '${pgRestore}': ${listing.error.code === "ENOENT" ? "not found" : listing.error.message}\n` +
        "Install the PostgreSQL client tools (matching the target major version) or pass --pg-restore.\n"
    );
  }
  if (listing.status !== 0) {
    throw new Error(
      `The archive could not be read by pg_restore; nothing was analysed.\n${(listing.stderr ?? "").trim().slice(0, 800)}\n`
    );
  }
  return listing.stdout ?? "";
}

const formatBytes = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);

/** Human-readable analysis, the same facts the CLI prints. */
export function formatAnalysis(report) {
  const { archive, analysis } = report;
  const lines = [];
  lines.push("");
  lines.push("Archive analysis (no database is created)");
  lines.push("----------------------------------------");
  lines.push(`Archive            : ${archive.path}`);
  lines.push(`Size / SHA-256     : ${formatBytes(archive.size)} / ${archive.sha256}`);
  lines.push(
    `Digest verified    : ${
      archive.expectedSha256 ? "yes, matches --expect-sha256" : "no (no --expect-sha256 supplied)"
    }`
  );
  lines.push(`TOC entries        : ${analysis.entries}`);
  lines.push(`Schemas            : ${analysis.schemas.join(", ") || "none"}`);
  lines.push(`Supabase schemas   : ${analysis.supabaseSchemas.join(", ") || "none"}`);
  lines.push(`Looks like Supabase: ${analysis.looksLikeSupabase ? "yes" : "no"}`);
  lines.push(`Extensions         : ${analysis.extensions.join(", ") || "none"}`);
  if (analysis.unavailableExtensions) {
    lines.push(`Unavailable there  : ${analysis.unavailableExtensions.join(", ") || "none"}`);
  }
  lines.push(
    `Application tables : ${analysis.applicationTables.length} in ${APPLICATION_SCHEMA}` +
      (analysis.applicationTables.length ? ` (${analysis.applicationTables.join(", ")})` : "")
  );
  if (analysis.supabaseOnlyObjectTypes.length) {
    lines.push(`Supabase-only types: ${analysis.supabaseOnlyObjectTypes.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!options.dump) {
    process.stderr.write(`--dump is required: point it at the archive to analyse.\n\n${USAGE}`);
    return 2;
  }

  const dumpPath = path.resolve(options.dump);
  let stats;
  try {
    stats = statSync(dumpPath);
  } catch {
    process.stderr.write(
      `No such archive: ${dumpPath}\nThis tool reads an existing archive only; it never creates one.\n`
    );
    return 1;
  }
  if (stats.isDirectory()) {
    process.stderr.write(
      `This analyser reads a single archive file, not a directory archive: ${dumpPath}\n` +
        "Use `npm run migration:restore-rehearsal -- --dump <dir> --toc` for directory archives.\n"
    );
    return 1;
  }
  if (!isCustomArchive(dumpPath)) {
    process.stderr.write(
      `Not a PostgreSQL custom-format archive: ${dumpPath}\n` +
        "The first bytes must be 'PGDMP'. A plain .sql file has no table of contents to analyse.\n"
    );
    return 1;
  }

  const sha256 = sha256File(dumpPath);
  if (options.expectSha256 && sha256 !== options.expectSha256) {
    process.stderr.write(
      `Archive digest does not match the recorded value; nothing was analysed.\n` +
        `  archive : ${dumpPath}\n  sha256  : ${sha256}\n  expected: ${options.expectSha256}\n`
    );
    return 1;
  }

  let listing;
  try {
    listing = readArchiveToc(dumpPath, { pgRestore: options.pgRestore ?? "pg_restore" });
  } catch (error) {
    process.stderr.write(`${error.message}`);
    return 1;
  }

  const analysis = summariseToc(parseToc(listing), { availableExtensions: options.availableExtensions });
  const report = {
    mode: "archive-analysis",
    archive: {
      path: dumpPath,
      size: stats.size,
      sha256,
      expectedSha256: options.expectSha256,
      digestVerified: Boolean(options.expectSha256),
    },
    analysis,
  };

  process.stdout.write(options.json ? `${JSON.stringify(report, null, 2)}\n` : formatAnalysis(report));
  return 0;
}

// `import` must stay free of side effects; only a direct run does anything.
const invokedDirectly =
  process.argv[1] !== undefined && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
