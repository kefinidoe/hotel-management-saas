import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * CLI-level tests for the two evidence tools added to close the migration
 * evidence gaps:
 *
 *   scripts/target-check.mjs         read-only checkpoint + fingerprint check
 *   scripts/restore-rehearsal.mjs    digest-verified restore into a scratch DB
 *
 * Both are scripts, not libraries, and their most important behaviour is
 * refusal: a check that can write, or a rehearsal that restores an archive whose
 * digest was never compared, is worse than no check at all. Every case below
 * exercises a path that must stop *before* a database is touched, so the suite
 * needs neither PostgreSQL nor the psql binary — which is also why it runs in CI.
 */

const repoRoot = path.resolve(__dirname, "../..");

/** Environment without any target the tooling could mistake for a real one. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  delete env.DIRECT_URL;
  delete env.DATABASE_URL;
  delete env.SAAS_ENVIRONMENT;
  delete env.SAAS_DATABASE_IDENTIFIER;
  delete env.PSQL_BIN;
  delete env.PGOPTIONS;
  delete env.RESTORE_REHEARSAL_BASE_URL;
  return { ...env, ...extra };
}

function run(script: string, args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", script), ...args], {
    encoding: "utf8",
    env: cleanEnv(extra),
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const scratchDump = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "restore-rehearsal-test-"));
  const file = path.join(dir, "synthetic.dump");
  // Starts with the pg_dump custom-format magic so the format probe is exercised.
  writeFileSync(file, Buffer.concat([Buffer.from("PGDMP", "latin1"), Buffer.from("test archive body")]));
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  return { file, digest };
})();

describe("scripts/target-check.mjs — refusals before any connection", () => {
  it("prints usage and exits 0 for --help", () => {
    const { status, stdout } = run("target-check.mjs", ["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("without writing anything");
    expect(stdout).toContain("server-verified read-only transaction");
  });

  it("rejects write-shaped flags outright", () => {
    for (const flag of ["--execute", "--apply", "--baseline"]) {
      const { status, stderr } = run("target-check.mjs", [flag]);
      expect(status, `${flag} must not be accepted`).toBe(2);
      expect(stderr).toContain("Unknown option");
    }
  });

  it("refuses to guess a target when no connection string is configured", () => {
    const { status, stderr } = run("target-check.mjs", []);
    expect(status).toBe(1);
    expect(stderr).toContain("No target database configured");
  });

  it("requires the SaaS target binding before reading anything", () => {
    const { status, stderr } = run("target-check.mjs", ["--url", "postgresql://postgres@127.0.0.1:5432/hms"]);
    expect(status).toBe(1);
    expect(stderr).toContain("DATABASE TARGET SAFETY CHECK FAILED");
    expect(stderr).toContain("SAAS_ENVIRONMENT");
  });

  it("only accepts SAAS_ENVIRONMENT=rehearsal for a loopback database", () => {
    const { status, stderr } = run(
      "target-check.mjs",
      ["--url", "postgresql://postgres@db.abcdefgh.supabase.co:5432/postgres"],
      { SAAS_ENVIRONMENT: "rehearsal" }
    );
    expect(status).toBe(1);
    expect(stderr).toContain("only accepted for a loopback database");
  });

  it("refuses the transaction pooler port, where session state is not reliable", () => {
    const { status, stderr } = run("target-check.mjs", ["--url", "postgresql://postgres@127.0.0.1:6543/hms"], {
      SAAS_ENVIRONMENT: "rehearsal",
    });
    expect(status).toBe(1);
    expect(stderr).toContain("6543");
    expect(stderr).toContain("session/direct connection");
  });
});

// The preflight parses the archive with pg_restore before any database is
// created. Proving that needs the real client, so these two skip where the
// PostgreSQL client tools are not installed (as in CI).
const pgToolsAvailable = (() => {
  const psql = spawnSync("psql", ["--version"], { encoding: "utf8" });
  const pgRestore = spawnSync("pg_restore", ["--version"], { encoding: "utf8" });
  return psql.status === 0 && pgRestore.status === 0;
})();

describe("scripts/restore-rehearsal.mjs — refusals before the server is contacted", () => {
  it("prints usage and exits 0 for --help", () => {
    const { status, stdout } = run("restore-rehearsal.mjs", ["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("--expect-sha256");
    expect(stdout).toContain("--keep");
  });

  it("requires --dump", () => {
    const { status, stderr } = run("restore-rehearsal.mjs", []);
    expect(status).toBe(2);
    expect(stderr).toContain("--dump is required");
  });

  it("refuses a missing archive instead of creating one", () => {
    const { status, stderr } = run("restore-rehearsal.mjs", ["--dump", "/nonexistent/hotel.dump"]);
    expect(status).toBe(1);
    expect(stderr).toContain("No such archive");
    expect(stderr).toContain("never creates one");
  });

  it("refuses to restore without the recorded digest", () => {
    const { status, stderr } = run("restore-rehearsal.mjs", ["--dump", scratchDump.file]);
    expect(status).toBe(1);
    expect(stderr).toContain("recorded digest");
  });

  it("refuses an archive whose digest does not match, before connecting", () => {
    const { status, stderr } = run("restore-rehearsal.mjs", [
      "--dump",
      scratchDump.file,
      "--expect-sha256",
      "0".repeat(64),
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("does not match the recorded value");
    expect(stderr).toContain(scratchDump.digest);
  });

  it.skipIf(!pgToolsAvailable)("rejects a corrupt archive before creating any database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "restore-rehearsal-corrupt-"));
    const file = path.join(dir, "truncated.dump");
    // Custom-format magic, then nothing: pg_restore's --list cannot parse it.
    writeFileSync(file, Buffer.concat([Buffer.from("PGDMP", "latin1"), Buffer.from("truncated body")]));
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");

    const { status, stderr } = run("restore-rehearsal.mjs", [
      "--dump",
      file,
      "--expect-sha256",
      digest,
      "--base-url",
      "postgresql://postgres@127.0.0.1:5432",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("could not be read by pg_restore");
    expect(stderr).toContain("no database was created");
  });

  it("documents the archive-analysis and filtering flags", () => {
    const { status, stdout } = run("restore-rehearsal.mjs", ["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("--profile");
    expect(stdout).toContain("--toc");
    expect(stdout).toContain("--exclude-schema");
  });

  it("rejects an unknown restore profile before reading the archive", () => {
    const { status, stderr } = run("restore-rehearsal.mjs", [
      "--dump",
      scratchDump.file,
      "--expect-sha256",
      scratchDump.digest,
      "--profile",
      "nonsense",
    ]);
    expect(status).toBe(2);
    expect(stderr).toContain("--profile accepts auto, plain or supabase");
  });

  it("refuses to exclude the application's own schema", () => {
    const { status, stderr } = run("restore-rehearsal.mjs", [
      "--dump",
      scratchDump.file,
      "--expect-sha256",
      scratchDump.digest,
      "--exclude-schema",
      "auth,public",
    ]);
    expect(status).toBe(2);
    expect(stderr).toContain("--exclude-schema cannot drop 'public'");
  });

  it.skipIf(!pgToolsAvailable)("refuses to analyse a plain SQL archive", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "restore-rehearsal-plain-"));
    const file = path.join(dir, "plain.sql");
    writeFileSync(file, "CREATE TABLE t (id int);\n");
    const digest = createHash("sha256").update(readFileSync(file)).digest("hex");

    const { status, stderr } = run("restore-rehearsal.mjs", [
      "--dump",
      file,
      "--expect-sha256",
      digest,
      "--toc",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("plain SQL archive has no table of contents");
  });

  it("rejects a malformed --expect-sha256", () => {
    const { status, stderr } = run("restore-rehearsal.mjs", ["--dump", scratchDump.file, "--expect-sha256", "abc"]);
    expect(status).toBe(2);
    expect(stderr).toContain("64-character hex digest");
  });

  it("refuses a non-loopback server unless it is explicitly disposable", () => {
    const { status, stderr } = run("restore-rehearsal.mjs", [
      "--dump",
      scratchDump.file,
      "--expect-sha256",
      scratchDump.digest,
      "--base-url",
      "postgresql://postgres@db.abcdefgh.supabase.co:5432",
    ]);
    expect(status).toBe(1);
    expect(stderr).toContain("Refusing to create and drop databases");
    expect(stderr).toContain("--allow-remote-target");
  });

  it("refuses the maintenance and reserved database names", () => {
    for (const name of ["postgres", "template0", "template1"]) {
      const { status, stderr } = run("restore-rehearsal.mjs", [
        "--dump",
        scratchDump.file,
        "--expect-sha256",
        scratchDump.digest,
        "--database",
        name,
      ]);
      expect(status, `${name} must not be usable as the scratch database`).toBe(1);
      expect(stderr).toContain("Refusing to use");
    }
  });

  it("refuses a scratch database name equal to the configured application database", () => {
    const { status, stderr } = run(
      "restore-rehearsal.mjs",
      ["--dump", scratchDump.file, "--expect-sha256", scratchDump.digest, "--database", "hms_live"],
      { DATABASE_URL: "postgresql://postgres@127.0.0.1:5432/hms_live" }
    );
    expect(status).toBe(1);
    expect(stderr).toContain("configured to use");
  });
});

// ---------------------------------------------------------------------------
// End-to-end regression for the dependency-aware filter.
//
// The genuine rehearsal failed on `COMMENT ON EXTENSION supabase_vault` because
// the extension was filtered out and its comment was not. The same dependency
// exists for schemas, and that variant can be built without any Supabase
// extension: a schema plus `COMMENT ON SCHEMA` produces the identical
// `COMMENT - SCHEMA auth` entry shape in the archive.
//
// This test needs a disposable PostgreSQL server, so it runs only when
// REHEARSAL_TEST_BASE_URL points at one (never in CI):
//   REHEARSAL_TEST_BASE_URL=postgresql://postgres@127.0.0.1:55432 npm run test:run
// ---------------------------------------------------------------------------
const rehearsalBaseUrl = process.env.REHEARSAL_TEST_BASE_URL;

describe("scripts/restore-rehearsal.mjs — dependent comments survive filtering", () => {
  it.skipIf(!pgToolsAvailable || !rehearsalBaseUrl)(
    "restores an archive whose schema comment refers to an excluded schema",
    () => {
      const base = (rehearsalBaseUrl as string).replace(/\/+$/, "");
      const source = `toc_dep_source_${Date.now()}`;
      const dir = mkdtempSync(path.join(tmpdir(), "restore-rehearsal-dep-"));
      const dump = path.join(dir, "dependent-comment.dump");

      const psql = (args: string[]) => spawnSync("psql", args, { encoding: "utf8", env: cleanEnv() });
      try {
        const created = spawnSync("psql", ["-d", base, "-q", "-c", `CREATE DATABASE ${source}`], { encoding: "utf8" });
        expect(created.status, created.stderr).toBe(0);
        const build = psql([
          "-d",
          `${base}/${source}`,
          "-v",
          "ON_ERROR_STOP=1",
          "-q",
          "-c",
          "CREATE SCHEMA auth",
          "-c",
          "CREATE TABLE auth.users (id int primary key)",
          "-c",
          'CREATE TABLE public."_prisma_migrations" (id text primary key, finished_at timestamptz, rolled_back_at timestamptz)',
          "-c",
          `INSERT INTO public."_prisma_migrations" VALUES ('fictional', now(), null)`,
          "-c",
          'CREATE TABLE public."Hotel" (id int primary key)',
          "-c",
          'CREATE TABLE public."Guest" (id int primary key, "hotelId" int references public."Hotel"(id))',
          "-c",
          'INSERT INTO public."Hotel" VALUES (1)',
          "-c",
          'INSERT INTO public."Guest" VALUES (1, 1)',
          "-c",
          "COMMENT ON SCHEMA auth IS 'excluded schema comment'",
          "-c",
          'COMMENT ON TABLE public."Hotel" IS \'kept table comment\'',
        ]);
        expect(build.status, build.stderr).toBe(0);

        const dumped = spawnSync("pg_dump", ["-Fc", "-d", `${base}/${source}`, "-f", dump], {
          encoding: "utf8",
        });
        expect(dumped.status, dumped.stderr).toBe(0);

        const digest = createHash("sha256").update(readFileSync(dump)).digest("hex");
        const { status, stdout } = run("restore-rehearsal.mjs", [
          "--dump",
          dump,
          "--expect-sha256",
          digest,
          "--base-url",
          base,
          "--profile",
          "plain",
          "--json",
        ]);

        const report = JSON.parse(stdout);
        // The fixture schema matches no approved checkpoint, so the exit code is 1
        // by design; what matters is that the restore itself completed cleanly.
        expect(status).toBe(1);
        expect(report.restore.ok).toBe(true);
        expect(report.restore.problems).toEqual([]);
        expect(report.restore.filter.byReason).toMatchObject({ "schema comment": 1 });
        expect(report.inspection.tables).toEqual(["Guest", "Hotel", "_prisma_migrations"]);
        expect(report.inspection.rowCounts).toEqual({ Hotel: 1, Guest: 1, _prisma_migrations: 1 });
        expect(report.inspection.missingTables).toEqual([]);
        expect(report.inspection.extraTables).toEqual([]);
        expect(report.checks.find((check: { name: string }) => check.name === "every application table in the archive was restored").ok).toBe(true);
        const restoreCheck = report.checks.find((check: { name: string }) => check.name.startsWith("restore finished"));
        expect(restoreCheck.ok).toBe(true);
      } finally {
        psql(["-d", base, "-c", `DROP DATABASE IF EXISTS ${source}`]);
      }
    },
    60_000
  );
});

// ---------------------------------------------------------------------------
// End-to-end regression for the second genuine failure: `ERROR: schema
// "realtime" does not exist`. Reproduces both halves of it — a row-security
// entry whose multi-word type used to be misparsed, and a `public`-schema
// function whose signature names an excluded type.
// Runs only with REHEARSAL_TEST_BASE_URL pointing at a disposable server.
// ---------------------------------------------------------------------------
describe("scripts/restore-rehearsal.mjs — realtime-schema dependencies", () => {
  it.skipIf(!pgToolsAvailable || !rehearsalBaseUrl)(
    "restores when a retained function references an excluded schema",
    () => {
      const base = (rehearsalBaseUrl as string).replace(/\/+$/, "");
      const source = `realtime_source_${Date.now()}`;
      const dir = mkdtempSync(path.join(tmpdir(), "restore-rehearsal-realtime-"));
      const dump = path.join(dir, "realtime.dump");
      const psql = (args: string[]) => spawnSync("psql", args, { encoding: "utf8" });
      try {
        expect(psql(["-d", base, "-q", "-c", `CREATE DATABASE ${source}`]).status).toBe(0);
        const build = psql([
          "-d",
          `${base}/${source}`,
          "-q",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          'CREATE TABLE public."Hotel" (id int primary key)',
          "-c",
          'CREATE TABLE public."Guest" (id int primary key, "hotelId" int references public."Hotel"(id))',
          "-c",
          'INSERT INTO public."Hotel" VALUES (1)',
          "-c",
          'INSERT INTO public."Guest" VALUES (1, 1)',
          // Supabase-shaped realtime schema.
          "-c",
          "CREATE SCHEMA realtime",
          "-c",
          "CREATE TYPE realtime.wal_rls AS (wal jsonb)",
          "-c",
          "CREATE TABLE realtime.messages (id bigserial primary key, topic text)",
          "-c",
          "INSERT INTO realtime.messages (topic) VALUES ('room:1')",
          "-c",
          "CREATE FUNCTION realtime.notify_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$",
          "-c",
          "CREATE TRIGGER messages_notify AFTER INSERT ON realtime.messages FOR EACH ROW EXECUTE FUNCTION realtime.notify_event()",
          "-c",
          "ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY",
          "-c",
          "CREATE POLICY messages_select ON realtime.messages FOR SELECT USING (true)",
          // The entry that broke the genuine restore: a public function whose
          // argument type lives in the excluded schema.
          "-c",
          "CREATE FUNCTION public.audit_realtime(wal realtime.wal_rls) RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$",
        ]);
        expect(build.status, build.stderr).toBe(0);

        const dumped = spawnSync("pg_dump", ["-Fc", "-d", `${base}/${source}`, "-f", dump], { encoding: "utf8" });
        expect(dumped.status, dumped.stderr).toBe(0);

        const digest = createHash("sha256").update(readFileSync(dump)).digest("hex");
        const { status, stdout } = run("restore-rehearsal.mjs", [
          "--dump",
          dump,
          "--expect-sha256",
          digest,
          "--base-url",
          base,
          "--profile",
          "plain",
          "--json",
        ]);

        const report = JSON.parse(stdout);
        expect(status).toBe(1); // no approved checkpoint in this fixture, by design
        expect(report.restore.ok).toBe(true);
        expect(report.restore.problems).toEqual([]);
        expect(report.restore.filter.excludeSchemas).toContain("realtime");
        expect(report.restore.filter.byReason).toMatchObject({ "schema reference": 1 });
        expect(report.inspection.tables).toEqual(["Guest", "Hotel"]);
        expect(report.inspection.rowCounts).toEqual({ Hotel: 1, Guest: 1 });
      } finally {
        psql(["-d", base, "-q", "-c", `DROP DATABASE IF EXISTS ${source}`]);
      }
    },
    60_000
  );
});

// ---------------------------------------------------------------------------
// When a dependency cannot be seen in the table of contents, the restore must
// still fail *informatively*: the report has to carry pg_restore's `Command was:`
// statement, not just the error text. A view body is the clearest such case — a
// TOC line carries only the view's name, never its definition.
// ---------------------------------------------------------------------------
describe("scripts/restore-rehearsal.mjs — failing statement in the report", () => {
  it.skipIf(!pgToolsAvailable || !rehearsalBaseUrl)(
    "names the SQL statement that broke the restore",
    () => {
      const base = (rehearsalBaseUrl as string).replace(/\/+$/, "");
      const source = `view_source_${Date.now()}`;
      const dir = mkdtempSync(path.join(tmpdir(), "restore-rehearsal-view-"));
      const dump = path.join(dir, "view.dump");
      const psql = (args: string[]) => spawnSync("psql", args, { encoding: "utf8" });
      try {
        expect(psql(["-d", base, "-q", "-c", `CREATE DATABASE ${source}`]).status).toBe(0);
        const build = psql([
          "-d",
          `${base}/${source}`,
          "-q",
          "-v",
          "ON_ERROR_STOP=1",
          "-c",
          'CREATE TABLE public."Hotel" (id int primary key)',
          "-c",
          "CREATE SCHEMA realtime",
          "-c",
          "CREATE TABLE realtime.messages (id int primary key, topic text)",
          // A view body is invisible in `pg_restore --list`, so the filter cannot
          // know this entry depends on the excluded schema.
          "-c",
          'CREATE VIEW public."RecentMessages" AS SELECT id, topic FROM realtime.messages',
        ]);
        expect(build.status, build.stderr).toBe(0);

        const dumped = spawnSync("pg_dump", ["-Fc", "-d", `${base}/${source}`, "-f", dump], { encoding: "utf8" });
        expect(dumped.status, dumped.stderr).toBe(0);
        const digest = createHash("sha256").update(readFileSync(dump)).digest("hex");

        const { stdout } = run("restore-rehearsal.mjs", [
          "--dump",
          dump,
          "--expect-sha256",
          digest,
          "--base-url",
          base,
          "--profile",
          "plain",
          "--json",
        ]);

        const report = JSON.parse(stdout);
        expect(report.restore.ok).toBe(false);
        expect(report.restore.problems).toHaveLength(1);
        // The error alone would not say which object failed.
        expect(report.restore.problems[0]).toContain("does not exist");
        expect(report.restore.problems[0]).toContain("Command was:");
        expect(report.restore.problems[0]).toContain("RecentMessages");
        expect(report.restore.problems[0]).not.toContain("LINE 4:");
      } finally {
        psql(["-d", base, "-q", "-c", `DROP DATABASE IF EXISTS ${source}`]);
      }
    },
    60_000
  );
});
