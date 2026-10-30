import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  APPLICATION_SCHEMA,
  SUPABASE_MANAGED_SCHEMAS,
  buildFilteredToc,
  parseToc,
  relationsIn,
  summariseToc,
} from "../../scripts/archive-toc.mjs";

/**
 * The owner's backup is a Supabase dump. Restoring it wholesale into a stock
 * PostgreSQL server fails partway through — which leaves a half-restored database
 * that looks like a success to anything checking only the exit code. These tests
 * cover the decision layer that prevents that: what the archive contains, what a
 * plain server can satisfy, and which TOC entries to comment out.
 *
 * The TOC text below is modelled on a real `pg_restore --list` of a Supabase
 * project (header, platform schemas, an extension, a publication, and the
 * application's own tables). It is a fixture, not a recording of the owner's
 * archive.
 */

const TOC = `;
; Archive created at 2026-10-28 14:08:23 EAT
;     dbname: postgres
;     TOC Entries: 19
;     Dump Version: 1.15-0
;     Format: CUSTOM
;
; Selected TOC Entries:
;
7; 2615 16388 SCHEMA - auth supabase_admin
8; 2615 16389 SCHEMA - extensions supabase_admin
9; 2615 16390 SCHEMA - supabase_migrations supabase_admin
2; 3079 16391 EXTENSION - pgcrypto
10; 3079 16392 EXTENSION - "uuid-ossp"
2619; 0 0 COMMENT - EXTENSION pgcrypto
221; 1259 16428 TABLE auth users postgres
223; 1259 16443 TABLE public "Guest" postgres
222; 1259 16436 TABLE public "Hotel" postgres
224; 1259 16456 TABLE supabase_migrations schema_migrations postgres
2609; 0 16428 TABLE DATA auth users postgres
2611; 0 16443 TABLE DATA public "Guest" postgres
2610; 0 16436 TABLE DATA public "Hotel" postgres
2612; 0 16456 TABLE DATA supabase_migrations schema_migrations postgres
2455; 2606 16435 CONSTRAINT auth users users_pkey postgres
2459; 2606 16449 CONSTRAINT public "Guest" "Guest_pkey" postgres
2457; 2606 16442 CONSTRAINT public "Hotel" "Hotel_pkey" postgres
2462; 2606 16450 FK CONSTRAINT public "Guest" "Guest_hotelId_fkey" postgres
2608; 6104 16455 PUBLICATION - supabase_realtime postgres
`;

describe("parseToc", () => {
  it("separates the header comments from the entries", () => {
    const parsed = parseToc(TOC);
    expect(parsed.header.length).toBeGreaterThan(5);
    expect(parsed.header.every((line) => line.startsWith(";"))).toBe(true);
    expect(parsed.entries).toHaveLength(19);
  });

  it("parses the identifiers, types, schemas and names", () => {
    const parsed = parseToc(TOC);
    const hotel = parsed.entries.find((entry) => entry.name === "Hotel" && entry.type === "TABLE");
    expect(hotel).toMatchObject({ schema: "public", owner: "postgres" });

    const data = parsed.entries.find((entry) => entry.type === "TABLE DATA" && entry.name === "Guest");
    expect(data).toMatchObject({ schema: "public" });

    // A constraint entry names a table, then the constraint: the constraint lands
    // in `owner`.
    const fk = parsed.entries.find((entry) => entry.type === "FK CONSTRAINT");
    expect(fk).toMatchObject({ schema: "public", name: "Guest", owner: '"Guest_hotelId_fkey"' });
  });

  it("puts a schema's own name in `name`, not `schema`", () => {
    const auth = parseToc(TOC).entries.find((entry) => entry.type === "SCHEMA" && entry.name === "auth");
    expect(auth).toBeDefined();
    expect(auth?.schema).toBeNull();
  });

  it("keeps an unrecognised line rather than dropping it", () => {
    const parsed = parseToc("not a toc line\n");
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].type).toBe("UNPARSED");
    expect(parsed.entries[0].raw).toBe("not a toc line");
  });
});

describe("summariseToc", () => {
  const summary = summariseToc(parseToc(TOC));

  it("lists the schemas, including the ones the schema entries name", () => {
    expect(summary.schemas).toEqual(["auth", "extensions", "public", "supabase_migrations"]);
  });

  it("recognises a Supabase archive", () => {
    expect(summary.looksLikeSupabase).toBe(true);
    expect(summary.supabaseSchemas).toEqual(["auth", "extensions", "supabase_migrations"]);
    for (const schema of summary.supabaseSchemas) {
      expect(SUPABASE_MANAGED_SCHEMAS).toContain(schema);
    }
  });

  it("lists the extensions and the application tables", () => {
    expect(summary.extensions).toEqual(["pgcrypto", "uuid-ossp"]);
    expect(summary.applicationTables).toEqual(["Guest", "Hotel"]);
    expect(summary.supabaseOnlyObjectTypes).toEqual(["PUBLICATION"]);
  });

  it("compares the extensions against what the target can install", () => {
    const withAvailability = summariseToc(parseToc(TOC), { availableExtensions: ["pgcrypto", "plpgsql"] });
    expect(withAvailability.unavailableExtensions).toEqual(["uuid-ossp"]);
  });

  it("does not claim Supabase for an ordinary dump", () => {
    const plain = summariseToc(parseToc('223; 1259 16443 TABLE public "Guest" postgres\n'));
    expect(plain.looksLikeSupabase).toBe(false);
    expect(plain.supabaseSchemas).toEqual([]);
    expect(plain.applicationTables).toEqual(["Guest"]);
  });
});

describe("relationsIn", () => {
  it("returns only relations in the requested schema", () => {
    expect(relationsIn(parseToc(TOC), APPLICATION_SCHEMA).sort()).toEqual(["Guest", "Hotel"]);
    expect(relationsIn(parseToc(TOC), "auth")).toEqual(["users"]);
    expect(relationsIn(parseToc(TOC), "nope")).toEqual([]);
  });
});

describe("buildFilteredToc", () => {
  const excludeSchemas = ["auth", "supabase_migrations"];
  const filtered = buildFilteredToc(parseToc(TOC), {
    excludeSchemas,
    excludeExtensions: ["uuid-ossp"],
    excludeTypes: ["PUBLICATION"],
  });

  it("comments out the schema entry itself, not just its objects", () => {
    // This is the regression that let `auth` survive a filtered restore: the
    // schema's own TOC entry still ran, so the schema existed and its objects
    // were the only thing missing.
    const lines = filtered.text.split("\n");
    expect(lines).toContain("; 7; 2615 16388 SCHEMA - auth supabase_admin");
    expect(lines).toContain("; 221; 1259 16428 TABLE auth users postgres");
    expect(lines).toContain("; 2609; 0 16428 TABLE DATA auth users postgres");
  });

  it("keeps the application schema and its objects", () => {
    const lines = filtered.text.split("\n");
    expect(lines).toContain('223; 1259 16443 TABLE public "Guest" postgres');
    expect(lines).toContain('2611; 0 16443 TABLE DATA public "Guest" postgres');
    expect(lines).toContain('2462; 2606 16450 FK CONSTRAINT public "Guest" "Guest_hotelId_fkey" postgres');
  });

  it("keeps an available extension and drops an unavailable one", () => {
    const lines = filtered.text.split("\n");
    expect(lines).toContain("2; 3079 16391 EXTENSION - pgcrypto");
    expect(lines).toContain('; 10; 3079 16392 EXTENSION - "uuid-ossp"');
  });

  it("drops the Supabase-only object types", () => {
    expect(filtered.text).toContain("; 2608; 6104 16455 PUBLICATION - supabase_realtime postgres");
  });

  it("preserves the header and counts what it kept", () => {
    expect(filtered.text).toContain("; Selected TOC Entries:");
    expect(filtered.kept + filtered.excluded.length).toBe(19);
    expect(filtered.excluded.map((entry) => entry.reason).sort()).toEqual([
      "extension",
      "schema",
      "schema",
      "schema",
      "schema",
      "schema",
      "schema",
      "schema",
      "type",
    ]);
  });

  it("restores everything when nothing is excluded", () => {
    const parsed = parseToc(TOC);
    const unfiltered = buildFilteredToc(parsed);
    expect(unfiltered.excluded).toEqual([]);
    expect(unfiltered.kept).toBe(19);
    // Only the archive's own header comments remain: no entry line is commented.
    const lines = unfiltered.text.split("\n");
    expect(lines.filter((line) => line.startsWith(";"))).toEqual(parsed.header);
  });
});

/**
 * Records from the first genuine rehearsal of the owner's backup, which aborted
 * with:
 *
 *   pg_restore: error: could not execute query: ERROR:
 *     extension "supabase_vault" does not exist
 *   Command was: COMMENT ON EXTENSION supabase_vault IS 'Supabase Vault extension';
 *
 * The extension entry was commented out by the `plain` profile, but the comment
 * entry that depends on it was not: positionally, `COMMENT - EXTENSION
 * supabase_vault` reads as `{ type: "COMMENT", name: "EXTENSION", owner:
 * "supabase_vault" }`, so nothing in the filter matched it. The TOC below is the
 * shape `pg_dump -Fc` actually emits for that case, reproduced on PostgreSQL 17.11
 * with a stand-in `supabase_vault` extension.
 */
const SUPABASE_TOC = `;
; Archive created at 2026-10-30 14:03:43 UTC
;     dbname: postgres
;     TOC Entries: 26
;     Dump Version: 1.16-0
;     Format: CUSTOM
;
; Selected TOC Entries:
;
8; 2615 16418 SCHEMA - auth postgres
2625; 0 0 COMMENT - SCHEMA auth postgres
3310; 0 0 ACL - SCHEMA auth postgres
2; 3079 16450 EXTENSION - supabase_vault
2626; 0 0 COMMENT - EXTENSION supabase_vault
3; 3079 16461 EXTENSION - pgcrypto
2627; 0 0 COMMENT - EXTENSION pgcrypto
4; 3079 16462 EXTENSION - "uuid-ossp"
2628; 0 0 COMMENT - EXTENSION "uuid-ossp"
221; 1259 16419 TABLE auth users postgres
223; 1259 16428 TABLE public "Hotel" postgres
2629; 0 0 COMMENT public TABLE "Hotel" postgres
224; 1259 16436 TABLE public "Guest" postgres
2614; 0 16419 TABLE DATA auth users postgres
2616; 0 16428 TABLE DATA public "Hotel" postgres
2618; 0 16437 TABLE DATA public "Guest" postgres
2462; 2606 16435 CONSTRAINT public "Hotel" "Hotel_pkey" postgres
2613; 6104 16498 PUBLICATION - supabase_realtime postgres
`;

const supabaseFiltered = buildFilteredToc(parseToc(SUPABASE_TOC), {
  excludeSchemas: ["auth"],
  excludeExtensions: ["supabase_vault", "uuid-ossp"],
  excludeTypes: ["PUBLICATION"],
});

const liveLines = (text: string) => text.split("\n").filter((line) => line.trim() && !line.startsWith(";"));

describe("dependency-aware filtering (the genuine-rehearsal failure)", () => {
  it("parses a comment on an extension as a dependent object", () => {
    const entry = parseToc(SUPABASE_TOC).entries.find((candidate) => candidate.raw.includes("COMMENT - EXTENSION supabase_vault"));
    expect(entry).toMatchObject({ type: "COMMENT", objectType: "EXTENSION", objectName: "supabase_vault" });
    // Still readable positionally, which is why type/name matching missed it.
    expect(entry).toMatchObject({ schema: null, name: "EXTENSION", owner: "supabase_vault" });
  });

  it("parses a comment and an ACL on a schema as dependent objects", () => {
    const comment = parseToc(SUPABASE_TOC).entries.find((entry) => entry.raw.includes("COMMENT - SCHEMA auth"));
    const acl = parseToc(SUPABASE_TOC).entries.find((entry) => entry.raw.includes("ACL - SCHEMA auth"));
    expect(comment).toMatchObject({ objectType: "SCHEMA", objectName: "auth" });
    expect(acl).toMatchObject({ objectType: "SCHEMA", objectName: "auth" });
  });

  it("excludes an unavailable extension and its comment together", () => {
    const lines = supabaseFiltered.text.split("\n");
    expect(lines).toContain("; 2; 3079 16450 EXTENSION - supabase_vault");
    expect(lines).toContain("; 2626; 0 0 COMMENT - EXTENSION supabase_vault");
    // The exact property that failed: nothing executable may reference it.
    expect(liveLines(supabaseFiltered.text).filter((line) => line.includes("supabase_vault"))).toEqual([]);
  });

  it("keeps a retained extension's creation and comment entries", () => {
    const lines = supabaseFiltered.text.split("\n");
    expect(lines).toContain("3; 3079 16461 EXTENSION - pgcrypto");
    expect(lines).toContain("2627; 0 0 COMMENT - EXTENSION pgcrypto");
  });

  it("keeps comments on application objects", () => {
    expect(liveLines(supabaseFiltered.text)).toContain('2629; 0 0 COMMENT public TABLE "Hotel" postgres');
  });

  it("excludes a comment and an ACL belonging to an excluded schema", () => {
    const lines = supabaseFiltered.text.split("\n");
    expect(lines).toContain("; 2625; 0 0 COMMENT - SCHEMA auth postgres");
    expect(lines).toContain("; 3310; 0 0 ACL - SCHEMA auth postgres");
    expect(liveLines(supabaseFiltered.text).filter((line) => line.includes("SCHEMA auth"))).toEqual([]);
  });

  it("handles quoted extension names", () => {
    const lines = supabaseFiltered.text.split("\n");
    expect(lines).toContain('; 4; 3079 16462 EXTENSION - "uuid-ossp"');
    expect(lines).toContain('; 2628; 0 0 COMMENT - EXTENSION "uuid-ossp"');
  });

  it("leaves every other extension entry untouched", () => {
    expect(liveLines(supabaseFiltered.text).filter((line) => line.includes("EXTENSION")).sort()).toEqual([
      "2627; 0 0 COMMENT - EXTENSION pgcrypto",
      "3; 3079 16461 EXTENSION - pgcrypto",
    ]);
  });

  it("labels the dependency in the report instead of hiding it", () => {
    const reasons = supabaseFiltered.excluded.map((entry) => `${entry.reason}:${entry.objectName ?? entry.name}`).sort();
    expect(reasons).toEqual([
      "extension comment:supabase_vault",
      "extension comment:uuid-ossp",
      "extension:supabase_vault",
      "extension:uuid-ossp",
      "schema acl:auth",
      "schema comment:auth",
      "schema:auth",
      "schema:users",
      "schema:users",
      "type:supabase_realtime",
    ]);
  });

  it("writes a use-list whose every live line is restorable", () => {
    // The generated file is what pg_restore receives, so assert its literal
    // content: header preserved, excluded entries commented, order unchanged.
    const expected = [
      ";",
      "; Archive created at 2026-10-30 14:03:43 UTC",
      ";     dbname: postgres",
      ";     TOC Entries: 26",
      ";     Dump Version: 1.16-0",
      ";     Format: CUSTOM",
      ";",
      "; Selected TOC Entries:",
      ";",
      "; 8; 2615 16418 SCHEMA - auth postgres",
      "; 2625; 0 0 COMMENT - SCHEMA auth postgres",
      "; 3310; 0 0 ACL - SCHEMA auth postgres",
      "; 2; 3079 16450 EXTENSION - supabase_vault",
      "; 2626; 0 0 COMMENT - EXTENSION supabase_vault",
      "3; 3079 16461 EXTENSION - pgcrypto",
      "2627; 0 0 COMMENT - EXTENSION pgcrypto",
      '; 4; 3079 16462 EXTENSION - "uuid-ossp"',
      '; 2628; 0 0 COMMENT - EXTENSION "uuid-ossp"',
      "; 221; 1259 16419 TABLE auth users postgres",
      '223; 1259 16428 TABLE public "Hotel" postgres',
      '2629; 0 0 COMMENT public TABLE "Hotel" postgres',
      '224; 1259 16436 TABLE public "Guest" postgres',
      "; 2614; 0 16419 TABLE DATA auth users postgres",
      '2616; 0 16428 TABLE DATA public "Hotel" postgres',
      '2618; 0 16437 TABLE DATA public "Guest" postgres',
      '2462; 2606 16435 CONSTRAINT public "Hotel" "Hotel_pkey" postgres',
      "; 2613; 6104 16498 PUBLICATION - supabase_realtime postgres",
      "",
    ].join("\n");
    expect(supabaseFiltered.text).toBe(expected);
  });

  it("does not change any entry when no extension or schema is excluded", () => {
    const unfiltered = buildFilteredToc(parseToc(SUPABASE_TOC));
    expect(unfiltered.excluded).toEqual([]);
    expect(unfiltered.text.split("\n").filter((line) => line.startsWith(";"))).toEqual(parseToc(SUPABASE_TOC).header);
  });
});


// ---------------------------------------------------------------------------
// CLI. The parser and filter are libraries; this is the operator-facing entry
// point, and its two failure modes both look like success if unhandled: no
// output at all (the module is imported, nothing runs) or a silent exit 0.
// ---------------------------------------------------------------------------
const repoRoot = path.resolve(__dirname, "../..");
const cli = (args: string[]) =>
  spawnSync(process.execPath, [path.join(repoRoot, "scripts", "archive-toc.mjs"), ...args], { encoding: "utf8" });

const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

const pgRestoreAvailable = spawnSync("pg_restore", ["--version"], { encoding: "utf8" }).status === 0;
const rehearsalBaseUrl = process.env.REHEARSAL_TEST_BASE_URL;

describe("scripts/archive-toc.mjs — CLI", () => {
  it("prints usage and exits 0 for --help", () => {
    const { status, stdout } = cli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Usage: node scripts/archive-toc.mjs --dump <path>");
    expect(stdout).toContain("--toc");
    expect(stdout).toContain("--expect-sha256");
    expect(stdout).toContain("--json");
  });

  it("explains the missing --dump instead of doing nothing", () => {
    const { status, stdout, stderr } = cli([]);
    expect(status).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("--dump is required");
    expect(stderr).toContain("Usage:");
  });

  it("rejects an unknown option", () => {
    const { status, stderr } = cli(["--nope"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown option '--nope'");
  });

  it("rejects a flag used as a value", () => {
    const { status, stderr } = cli(["--dump", "--json"]);
    expect(status).toBe(2);
    expect(stderr).toContain("--dump requires a value");
  });

  it("rejects a malformed digest", () => {
    const { status, stderr } = cli(["--dump", "whatever.dump", "--expect-sha256", "abc"]);
    expect(status).toBe(2);
    expect(stderr).toContain("64-character hex digest");
  });

  it("reports a missing archive and never creates one", () => {
    const { status, stderr } = cli(["--dump", path.join(tmpdir(), "definitely-not-here.dump")]);
    expect(status).toBe(1);
    expect(stderr).toContain("No such archive");
    expect(stderr).toContain("never creates one");
  });

  it("refuses a file that is not a custom-format archive", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "archive-toc-cli-"));
    const file = path.join(dir, "plain.sql");
    writeFileSync(file, "CREATE TABLE t (id int);\n");
    const { status, stderr } = cli(["--dump", file]);
    expect(status).toBe(1);
    expect(stderr).toContain("Not a PostgreSQL custom-format archive");
  });

  it("stops on a digest mismatch before parsing anything", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "archive-toc-digest-"));
    const file = path.join(dir, "looks-custom.dump");
    writeFileSync(file, Buffer.concat([Buffer.from("PGDMP", "latin1"), Buffer.from("body")]));
    const { status, stderr } = cli(["--dump", file, "--expect-sha256", "0".repeat(64)]);
    expect(status).toBe(1);
    expect(stderr).toContain("does not match the recorded value");
    // The real digest is reported so the operator can correct the record.
    expect(stderr).toContain(digest(file));
  });

  it.skipIf(!pgRestoreAvailable || !rehearsalBaseUrl)(
    "analyses a real archive and prints the report",
    () => {
      const base = (rehearsalBaseUrl as string).replace(/\/+$/, "");
      const source = `toc_cli_source_${Date.now()}`;
      const dir = mkdtempSync(path.join(tmpdir(), "archive-toc-cli-real-"));
      const dump = path.join(dir, "cli.dump");
      const psql = (args: string[]) => spawnSync("psql", args, { encoding: "utf8" });
      try {
        const created = psql(["-d", base, "-q", "-c", `CREATE DATABASE ${source}`]);
        expect(created.status, created.stderr).toBe(0);
        const built = psql([
          "-d",
          `${base}/${source}`,
          "-q",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          "CREATE SCHEMA auth",
          "-c",
          "CREATE TABLE auth.users (id int primary key)",
          "-c",
          'CREATE TABLE public."Hotel" (id int primary key)',
          "-c",
          'CREATE TABLE public."Guest" (id int primary key, "hotelId" int references public."Hotel"(id))',
          "-c",
          'COMMENT ON TABLE public."Hotel" IS \'kept\'',
        ]);
        expect(built.status, built.stderr).toBe(0);
        const dumped = spawnSync("pg_dump", ["-Fc", "-d", `${base}/${source}`, "-f", dump], { encoding: "utf8" });
        expect(dumped.status, dumped.stderr).toBe(0);

        const { status, stdout } = cli(["--dump", dump, "--expect-sha256", digest(dump).toUpperCase()]);
        expect(status).toBe(0);
        expect(stdout).toContain("Archive analysis (no database is created)");
        expect(stdout).toContain("Digest verified    : yes");
        expect(stdout).toContain("Schemas            : auth, public");
        expect(stdout).toContain("Supabase schemas   : auth");
        expect(stdout).toContain("Looks like Supabase: yes");
        expect(stdout).toContain("Application tables : 2 in public (Guest, Hotel)");
        // `OWNED` is not a schema: `SEQUENCE OWNED BY` must not be parsed as one.
        expect(stdout).not.toContain("OWNED");

        const json = cli(["--dump", dump, "--json"]);
        expect(json.status).toBe(0);
        const report = JSON.parse(json.stdout);
        expect(report.analysis.entries).toBeGreaterThan(10);
        expect(report.analysis.applicationTables).toEqual(["Guest", "Hotel"]);
        expect(report.archive.sha256).toBe(digest(dump));
      } finally {
        psql(["-d", base, "-q", "-c", `DROP DATABASE IF EXISTS ${source}`]);
      }
    },
    60_000
  );
});
