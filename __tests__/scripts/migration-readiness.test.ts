import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `scripts/migration-readiness.mjs` exists to stop three separate gaps from being
 * reported as one vague "blocked", and to keep a green test suite from being read
 * as production readiness.
 *
 * The vocabulary is therefore part of the contract: PASS means "demonstrated
 * here", BLOCKED means "external input missing", FAIL means "a check ran and did
 * not pass", and the owner's approval is always PENDING APPROVAL. These tests
 * assert those distinctions, not just exit codes.
 *
 * None of them needs a database: the archive and engine checks are hashes, and
 * the credentials check inspects the environment. `--check-target` (the one path
 * that connects) is covered by the target-check tests and by the recorded runs in
 * docs/saas-migration-rehearsal.md.
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

describe("migration readiness — four states, no inference", () => {
  it("prints usage and exits 0 for --help", () => {
    const { status, stdout } = run(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Backup archive");
    expect(stdout).toContain("Target credentials");
    expect(stdout).toContain("Pinned engine");
  });

  it("reports all three prerequisites as BLOCKED when none is supplied", () => {
    const { status, stdout } = run([]);
    expect(status).toBe(1);
    expect(stdout).toMatch(/archive\s+: BLOCKED/);
    expect(stdout).toMatch(/credentials\s+: BLOCKED/);
    expect(stdout).toMatch(/engine\s+: BLOCKED/);
    expect(stdout).toMatch(/Decision\s+: BLOCKED/);
  });

  it("always reports approval as PENDING APPROVAL, never granted", () => {
    const { stdout } = run([]);
    expect(stdout).toMatch(/approval\s+: PENDING APPROVAL/);
    expect(stdout).not.toMatch(/approval\s+: PASS/);
  });

  it("reports PASS for an archive whose digest matches the expected value", () => {
    const { stdout, status } = run(["--dump", archive.file, "--expect-sha256", archive.digest]);
    expect(stdout).toMatch(/archive\s+: PASS/);
    // Only the archive is demonstrated; readiness still requires the other two.
    expect(status).toBe(1);
    expect(stdout).toMatch(/Decision\s+: BLOCKED/);
  });

  it("reports FAIL, not BLOCKED, for an archive that does not match", () => {
    const { stdout } = run(["--dump", archive.file]);
    expect(stdout).toMatch(/archive\s+: FAIL/);
    expect(stdout).toContain("not the recorded backup");
    expect(stdout).toMatch(/Decision\s+: FAIL/);
  });

  it("does not treat configured credentials as demonstrated", () => {
    const { stdout, status } = run([], {
      SAAS_ENVIRONMENT: "saas",
      SAAS_DATABASE_IDENTIFIER: "example",
      DIRECT_URL: "postgresql://postgres@127.0.0.1:5432/example",
    });
    expect(stdout).toMatch(/credentials\s+: BLOCKED/);
    expect(stdout).toContain("has not been contacted");
    expect(status).toBe(1);
  });

  it("reports FAIL for an engine file that is not the pinned release", () => {
    const { stdout } = run([], { PRISMA_SCHEMA_ENGINE_BINARY: fakeEngine.file });
    expect(stdout).toMatch(/engine\s+: FAIL/);
    expect(stdout).toContain("does not match the pinned 5.17.0 artifact");
    expect(stdout).toMatch(/Decision\s+: FAIL/);
  });

  it("exposes the same distinctions in JSON", () => {
    const { stdout, status } = run(["--json", "--expect-sha256", archive.digest], { BACKUP_ARCHIVE: archive.file });
    const report = JSON.parse(stdout);
    expect(status).toBe(1);
    expect(report.readyForApproval).toBe(false);
    expect(report.decision.status).toBe("BLOCKED");
    expect(report.approval.status).toBe("PENDING APPROVAL");
    expect(report.prerequisites.map((entry: { id: string }) => entry.id)).toEqual([
      "archive",
      "credentials",
      "engine",
    ]);
    // The archive matches its recorded digest, so that row alone is PASS.
    expect(report.prerequisites[0].status).toBe("PASS");
  });

  it("rejects unknown flags", () => {
    const { status, stderr } = run(["--force-ready"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown option");
  });
});
