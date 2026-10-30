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
    expect(stdout).toContain("default_transaction_read_only");
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
