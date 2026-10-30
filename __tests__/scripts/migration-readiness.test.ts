import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `scripts/migration-readiness.mjs` exists to stop three separate gaps from being
 * reported as one vague "blocked". It must therefore be precise about *which*
 * prerequisite is missing, and must never report ready when one is absent.
 *
 * None of these tests needs a database: the archive and engine checks are hashes,
 * and the credentials check inspects the environment. `--check-target` (the one
 * path that connects) is deliberately not exercised here — it is covered by the
 * target-check tests and by the recorded runs in docs/saas-migration-rehearsal.md.
 */

const repoRoot = path.resolve(__dirname, "../..");
const SCRIPT = path.join(repoRoot, "scripts/migration-readiness.mjs");

function run(args: string[], env: Record<string, string> = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "DIRECT_URL",
    "DATABASE_URL",
    "SAAS_ENVIRONMENT",
    "SAAS_DATABASE_IDENTIFIER",
    "PRISMA_SCHEMA_ENGINE_BINARY",
    "PRISMA_QUERY_ENGINE_LIBRARY",
    "BACKUP_ARCHIVE",
  ]) {
    delete base[key];
  }
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { ...base, ...env } });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const archive = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "readiness-"));
  const file = path.join(dir, "backup.dump");
  writeFileSync(file, Buffer.from("pretend custom-format archive\n"));
  return { file, digest: createHash("sha256").update(readFileSync(file)).digest("hex") };
})();

const fakeEngine = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "readiness-engine-"));
  const file = path.join(dir, "schema-engine");
  writeFileSync(file, Buffer.from("not the pinned engine\n"));
  return { file };
})();

describe("migration readiness — reporting, never inferring", () => {
  it("prints usage and exits 0 for --help", () => {
    const { status, stdout } = run(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Backup archive");
    expect(stdout).toContain("Target credentials");
    expect(stdout).toContain("Pinned engine");
  });

  it("names all three prerequisites when none is supplied", () => {
    const { status, stdout } = run([]);
    expect(status).toBe(1);
    expect(stdout).toMatch(/archive\s+: MISSING/);
    expect(stdout).toMatch(/credentials\s+: MISSING/);
    expect(stdout).toMatch(/engine\s+: MISSING/);
    expect(stdout).toContain("Not ready");
  });

  it("accepts an archive whose digest matches the expected value", () => {
    const { stdout, status } = run(["--dump", archive.file, "--expect-sha256", archive.digest]);
    expect(stdout).toMatch(/archive\s+: PRESENT/);
    // Only the archive is satisfied; readiness still requires the other two.
    expect(status).toBe(1);
    expect(stdout).toContain("Not ready");
  });

  it("refuses an archive that does not match the recorded digest", () => {
    const { stdout } = run(["--dump", archive.file]);
    expect(stdout).toMatch(/archive\s+: MISMATCH/);
    expect(stdout).toContain("not the recorded backup");
  });

  it("reports configured credentials without contacting the target by default", () => {
    const { stdout, status } = run([], {
      SAAS_ENVIRONMENT: "saas",
      SAAS_DATABASE_IDENTIFIER: "example",
      DIRECT_URL: "postgresql://postgres@127.0.0.1:5432/example",
    });
    expect(stdout).toMatch(/credentials\s+: CONFIGURED/);
    expect(stdout).toContain("not contacted");
    expect(status).toBe(1); // archive and engine are still missing
  });

  it("fails the engine prerequisite for a file that is not the pinned release", () => {
    const { stdout } = run([], { PRISMA_SCHEMA_ENGINE_BINARY: fakeEngine.file });
    expect(stdout).toMatch(/engine\s+: FAILED/);
    expect(stdout).toContain("does not match the pinned 5.17.0 artifact");
  });

  it("never claims approval", () => {
    const { stdout } = run(["--json"], { BACKUP_ARCHIVE: archive.file });
    expect(JSON.parse(stdout).approval.granted).toBe(false);
  });

  it("rejects unknown flags", () => {
    const { status, stderr } = run(["--force-ready"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown option");
  });

  it("reports ready=false in JSON when something is missing", () => {
    const { status, stdout } = run(["--json"], { BACKUP_ARCHIVE: archive.file });
    const report = JSON.parse(stdout);
    expect(status).toBe(1);
    expect(report.ready).toBe(false);
    expect(report.approval.granted).toBe(false);
    expect(report.prerequisites.map((entry: { id: string }) => entry.id)).toEqual(["archive", "credentials", "engine"]);
  });
});
