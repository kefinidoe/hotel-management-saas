import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `scripts/check-prisma-client.mjs` is the build-time half of the fix for
 * `Cannot read properties of undefined (reading 'findUnique')`: it fails a build
 * whose generated client does not match prisma/schema.prisma.
 *
 * A guard that cannot fail is worse than none, so these tests drive the script
 * against deliberately broken fixtures as well as the real repository.
 */

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "check-prisma-client.mjs");
const GENERATED_DIR = join(ROOT, "node_modules", ".prisma", "client");

function run(args: string[] = [], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("check-prisma-client.mjs", () => {
  it("passes for the installed client", () => {
    const result = run(["--quiet"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("fails when the client was generated from a different schema", () => {
    expect(existsSync(join(GENERATED_DIR, "schema.prisma"))).toBe(true);

    const generated = mkdtempSync(join(tmpdir(), "prisma-client-generated-"));
    copyFileSync(join(GENERATED_DIR, "schema.prisma"), join(generated, "schema.prisma"));
    // The types live next to the schema copy in a real client; the delegate check
    // reads them when Prisma.dmmf is unavailable.
    if (existsSync(join(GENERATED_DIR, "index.d.ts"))) {
      copyFileSync(join(GENERATED_DIR, "index.d.ts"), join(generated, "index.d.ts"));
    }

    const schemaDir = mkdtempSync(join(tmpdir(), "prisma-schema-"));
    const schemaPath = join(schemaDir, "schema.prisma");
    // Simulate "the repository schema gained a model the client never saw".
    writeFileSync(
      schemaPath,
      `${readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8")}\nmodel BrandNewModel {\n  id String @id\n}\n`
    );

    const result = run([], {
      PRISMA_CLIENT_CHECK_SCHEMA: schemaPath,
      PRISMA_CLIENT_CHECK_GENERATED_DIR: generated,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("built from a different schema");
    expect(result.stderr).toContain("npx prisma generate");
  });

  it("fails when the generated client is missing entirely", () => {
    const missing = join(mkdtempSync(join(tmpdir(), "prisma-client-empty-")), "not-generated");

    const result = run([], { PRISMA_CLIENT_CHECK_GENERATED_DIR: missing });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("generated Prisma Client is missing");
  });

  it("fails when the client directory exists but holds no client", () => {
    const empty = mkdtempSync(join(tmpdir(), "prisma-client-hollow-"));

    const result = run([], { PRISMA_CLIENT_CHECK_GENERATED_DIR: empty });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no type declarations");
  });

  it("still verifies a deployment image that ships no schema file", () => {
    const result = run(["--allow-missing-schema"], {
      PRISMA_CLIENT_CHECK_SCHEMA: join(tmpdir(), "definitely-not-here", "schema.prisma"),
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("skipping the schema comparison");
  });
});
