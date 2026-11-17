import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  PINNED_ARTIFACTS,
  PINNED_ENGINE_COMMIT,
  PINNED_PLATFORM,
  PINNED_PRISMA_VERSION,
  parseEngineCommit,
  sha256File,
  verifyPinnedArtifact,
} from "../../scripts/prisma-engine-pins.mjs";

/**
 * The pinned-engine check exists because "we downloaded the right binaries" is
 * normally asserted in prose and cannot be re-checked later. These tests cover
 * the parts that decide that question — the commit parser and the digest
 * comparison — plus the CLI's refusal behaviour, none of which needs the real
 * 40 MB engine.
 *
 * The positive CLI path (a genuine artifact passing both checks) can only be
 * exercised with the official binary; it is deliberately not faked here, because
 * a faked pass would be exactly the kind of evidence this whole exercise is
 * trying to avoid.
 */

const repoRoot = path.resolve(__dirname, "../..");

function runPin(args: string[], env: Record<string, string> = {}) {
  const clean: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete clean.PRISMA_SCHEMA_ENGINE_BINARY;
  delete clean.PRISMA_QUERY_ENGINE_LIBRARY;
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts/prisma-engine-pin.mjs"), ...args], {
    encoding: "utf8",
    env: { ...clean, ...env },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const fixture = (() => {
  const dir = mkdtempSync(path.join(tmpdir(), "prisma-engine-pin-"));
  const file = path.join(dir, "schema-engine");
  writeFileSync(file, Buffer.from("not really an engine\n"));
  return { file, digest: createHash("sha256").update(readFileSync(file)).digest("hex") };
})();

describe("pinned Prisma artifact table", () => {
  it("pins the release this application depends on", () => {
    expect(PINNED_PRISMA_VERSION).toBe("5.17.0");
    expect(PINNED_ENGINE_COMMIT).toBe("393aa359c9ad4a4bb28630fb5613f9c281cde053");
    expect(PINNED_PLATFORM).toBe("debian-openssl-3.0.x");
  });

  it("records a full SHA-256 for both artifacts and their archives", () => {
    for (const artifact of Object.values(PINNED_ARTIFACTS)) {
      expect(artifact.sha256, `${artifact.artifact} digest`).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.archiveSha256, `${artifact.archive} digest`).toMatch(/^[0-9a-f]{64}$/);
      expect(artifact.envVar).toMatch(/^PRISMA_/);
    }
  });
});

describe("parseEngineCommit", () => {
  it("reads the commit out of schema-engine --version", () => {
    expect(parseEngineCommit(`schema-engine-cli ${PINNED_ENGINE_COMMIT}`)).toBe(PINNED_ENGINE_COMMIT);
    expect(parseEngineCommit(`version: ${PINNED_ENGINE_COMMIT}\ncommit: ${PINNED_ENGINE_COMMIT}`)).toBe(
      PINNED_ENGINE_COMMIT
    );
  });

  it("returns null when no commit is reported", () => {
    expect(parseEngineCommit("schema-engine 5.17.0")).toBeNull();
    expect(parseEngineCommit("")).toBeNull();
    // A short hash cannot identify a build.
    expect(parseEngineCommit("schema-engine 393aa359")).toBeNull();
  });
});

describe("verifyPinnedArtifact", () => {
  it("accepts a file whose bytes match the expected digest", () => {
    const result = verifyPinnedArtifact({
      path: fixture.file,
      artifact: { artifact: "schema-engine", sha256: fixture.digest, envVar: "PRISMA_SCHEMA_ENGINE_BINARY" },
    });
    expect(result.ok).toBe(true);
    expect(result.digest).toBe(fixture.digest);
    expect(result.problems).toEqual([]);
  });

  it("rejects a file whose bytes do not match, naming both digests", () => {
    const expected = PINNED_ARTIFACTS.schemaEngine;
    const result = verifyPinnedArtifact({ path: fixture.file, artifact: expected });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain(result.digest as string);
    expect(result.problems[0]).toContain(expected.sha256);
    expect(result.problems[0]).toContain("Do not run this engine");
  });

  it("reports a missing file instead of throwing", () => {
    const result = verifyPinnedArtifact({ path: path.join(tmpdir(), "does-not-exist-engine"), artifact: PINNED_ARTIFACTS.schemaEngine });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("No such file");
  });

  it("reports an unsupplied artifact with the variable that would supply it", () => {
    const result = verifyPinnedArtifact({ path: null, artifact: PINNED_ARTIFACTS.queryEngineLibrary });
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toContain("PRISMA_QUERY_ENGINE_LIBRARY");
  });

  it("hashes bytes the same way the digest table does", () => {
    expect(sha256File(fixture.file)).toBe(fixture.digest);
  });
});

describe("scripts/prisma-engine-pin.mjs", () => {
  it("prints usage and exits 0 for --help", () => {
    const { status, stdout } = runPin(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain(PINNED_ENGINE_COMMIT);
    expect(stdout).toContain("--schema-engine");
  });

  it("exits 2 when nothing was supplied, and says what is needed", () => {
    const { status, stderr } = runPin([]);
    expect(status).toBe(2);
    expect(stderr).toContain("Nothing to verify");
    expect(stderr).toContain("PRISMA_SCHEMA_ENGINE_BINARY");
  });

  it("reads the artifacts from the environment the CLI uses", () => {
    const { status, stderr } = runPin([], { PRISMA_SCHEMA_ENGINE_BINARY: fixture.file });
    expect(status).toBe(1);
    expect(stderr).toBe("");
  });

  it("rejects a binary that is not the pinned release", () => {
    const { status, stdout } = runPin(["--schema-engine", fixture.file]);
    expect(status).toBe(1);
    expect(stdout).toContain("MISMATCH");
    expect(stdout).toContain(PINNED_ARTIFACTS.schemaEngine.sha256);
    expect(stdout).toContain("not run (digest did not match)");
  });

  it("rejects a missing binary", () => {
    const { status, stdout } = runPin(["--schema-engine", path.join(tmpdir(), "nope-engine")]);
    expect(status).toBe(1);
    expect(stdout).toContain("No such file");
  });

  it("rejects unknown flags, so no undocumented bypass can be added silently", () => {
    const { status, stderr } = runPin(["--skip-digest"]);
    expect(status).toBe(2);
    expect(stderr).toContain("Unknown option");
  });

  it("will not run the CLI without a schema engine to point it at", () => {
    const { status, stderr } = runPin(["--prisma", path.join(repoRoot, "package.json")]);
    expect(status).toBe(2);
    expect(stderr).toContain("Nothing to verify");
  });
});
