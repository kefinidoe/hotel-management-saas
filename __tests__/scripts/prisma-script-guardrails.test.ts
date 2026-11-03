import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CI regression tests for the database-command protections.
 *
 * These are static assertions on purpose: they must fail the build the moment
 * somebody unwraps a Prisma script, deletes a denial rule, or reintroduces a
 * second `.env` parser — without needing a database or the Prisma CLI.
 */

const root = resolve(__dirname, "../..");
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
const prismaSafe = read("scripts/prisma-safe.mjs");
const targetSafety = read("scripts/database-target-safety.mjs");
const guard = read("lib/db-safety-guard.ts");
const dbIntegrity = read("scripts/db-integrity.mjs");
const verifyTarget = read("scripts/verify-database-target.ts");
const backup = read("scripts/backup-db.mjs");
const restore = read("scripts/restore-db.mjs");
const envExample = read(".env.example");

describe("package.json — the Prisma scripts cannot reach the CLI unguarded", () => {
  it("routes migrate dev through the wrapper", () => {
    expect(pkg.scripts["prisma:migrate"]).toBe("node scripts/prisma-safe.mjs migrate dev");
  });

  it("routes migrate deploy through the wrapper", () => {
    expect(pkg.scripts["prisma:deploy"]).toBe("node scripts/prisma-safe.mjs migrate deploy");
  });

  it("routes studio through the wrapper", () => {
    expect(pkg.scripts["prisma:studio"]).toBe("node scripts/prisma-safe.mjs studio");
  });

  it("exposes a verify-only guard entry point", () => {
    expect(pkg.scripts["prisma:guard"]).toBe("node scripts/prisma-safe.mjs guard");
  });

  it("leaves the connection-free commands alone", () => {
    // generate/validate open no connection; wrapping them would break offline builds
    // (and `postinstall`) for no security benefit.
    expect(pkg.scripts["prisma:generate"]).toBe("prisma generate");
    expect(pkg.scripts.postinstall).toBe("prisma generate");
    expect(pkg.scripts.build).not.toContain("prisma-safe");
  });

  it("has no script that runs a bare destructive Prisma verb", () => {
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(command, `${name} must not run migrate reset`).not.toMatch(/prisma\s+migrate\s+reset/);
      expect(command, `${name} must not run db push`).not.toMatch(/prisma\s+db\s+push/);
    }
  });
});

describe("prisma-safe.mjs — the denial rules are present", () => {
  it("denies migrate dev on a remote target with the shadow-database reason", () => {
    expect(prismaSafe).toContain("not permitted against a remote database");
    expect(prismaSafe).toContain("shadow database");
  });

  it("denies migrate reset on a remote target unconditionally", () => {
    expect(prismaSafe).toContain("forbidden against any remote database");
    expect(prismaSafe).toContain("SAAS_ALLOW_LOCAL_RESET");
  });

  it("denies db push as a production workflow", () => {
    expect(prismaSafe).toContain("not the approved schema workflow");
  });

  it("denies the destructive flags outright", () => {
    expect(prismaSafe).toContain("--force-reset");
    expect(prismaSafe).toContain("--accept-data-loss");
    expect(prismaSafe).toContain("DESTRUCTIVE_FLAGS");
  });

  it("requires the shared identity guard instead of reimplementing one", () => {
    expect(prismaSafe).toContain("assertDatabaseTarget");
    expect(prismaSafe).toContain("requireDirectUrl");
  });

  it("loads .env through the shared loader, so it judges what Prisma will use", () => {
    expect(prismaSafe).toContain('from "./env-file.mjs"');
    expect(prismaSafe).toContain("loadEnvFiles");
  });

  it("refuses a schema file other than prisma/schema.prisma", () => {
    expect(prismaSafe).toContain("findSchemaOverride");
    expect(prismaSafe).toContain("only prisma/schema.prisma is approved");
  });

  it("documents that a hand-typed npx prisma call is not intercepted", () => {
    expect(prismaSafe).toContain("cannot intercept `npx prisma");
  });
});

describe("database identity — the weak rules stay removed", () => {
  it("has no database-name match for a remote target", () => {
    expect(targetSafety).not.toContain("target.database === identifier");
    expect(guard).not.toContain("matchesDbName");
  });

  it("has no bare hostname equality or prefix match against the identifier", () => {
    expect(targetSafety).not.toContain("target.host === identifier");
    expect(targetSafety).not.toContain("startsWith(`${identifier}.`)");
    expect(guard).not.toContain("hostname.startsWith(`${approvedIdentifier}.`)");
  });

  it("rejects the reserved identifier 'postgres' in both implementations", () => {
    expect(targetSafety).toContain("RESERVED_IDENTIFIERS");
    expect(targetSafety).toContain('"postgres"');
    expect(guard).toContain("RESERVED_IDENTIFIERS");
  });

  it("pins the Supabase project-reference shape", () => {
    expect(targetSafety).toContain("SUPABASE_PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/");
    expect(guard).toContain("SUPABASE_PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/");
  });
});

describe("environment loading — one parser, used everywhere it matters", () => {
  it("db:verify loads the same environment the Prisma CLI loads", () => {
    expect(verifyTarget).toContain('from "../scripts/env-file.mjs"');
    expect(verifyTarget).toContain("loadEnvFiles");
    expect(verifyTarget).toContain('requireDirectUrl: "remote"');
  });

  it("backup and restore use the shared loader and keep no private parser", () => {
    for (const script of [backup, restore]) {
      expect(script).toContain('from "./env-file.mjs"');
      expect(script).toContain("loadEnvFiles");
      expect(script).not.toContain("function readEnv()");
    }
  });

  it("db-integrity loads .env the same way", () => {
    expect(dbIntegrity).toContain('from "./env-file.mjs"');
    expect(dbIntegrity).toContain("loadEnvFiles");
  });
});

describe("db-integrity — identity is checked before psql is reached", () => {
  it("calls the shared target guard", () => {
    expect(dbIntegrity).toContain("assertDatabaseTarget({");
  });

  it("checks identity after the remote refusal and before any psql call", () => {
    const remoteRefusal = dbIntegrity.indexOf("Refusing to inspect");
    const identity = dbIntegrity.indexOf("assertDatabaseTarget({");
    const psqlUse = dbIntegrity.indexOf("const psqlArgs = {");

    expect(remoteRefusal).toBeGreaterThan(-1);
    expect(identity).toBeGreaterThan(remoteRefusal);
    expect(psqlUse).toBeGreaterThan(identity);
  });

  it("keeps the session read-only", () => {
    expect(dbIntegrity).toContain("default_transaction_read_only");
    expect(dbIntegrity).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP)\b\s+(INTO|FROM|[A-Z])/);
  });
});

describe("restore and migration safeguards are still wired", () => {
  it("restore still requires an exact --confirm-target and refuses the live database", () => {
    expect(restore).toContain('arg("confirm-target") !== requiredConfirmation');
    expect(restore).toContain("sameDatabase");
    expect(restore).toContain("--force");
  });

  it("backup still binds both configured URLs before exporting", () => {
    expect(backup).toContain("assertDatabaseTarget({");
    expect(backup).toContain("directUrl: env.DIRECT_URL");
  });
});

describe(".env.example documents the only accepted identity", () => {
  it("uses the project reference, not a database name", () => {
    expect(envExample).toContain('SAAS_DATABASE_IDENTIFIER="jhablmqphfcjwealyxxr"');
    expect(envExample).not.toMatch(/SAAS_DATABASE_IDENTIFIER="postgres"/);
    expect(envExample).toContain('NEVER set this to "postgres"');
  });

  it("shows DIRECT_URL as a direct endpoint carrying the same reference", () => {
    expect(envExample).toContain("db.jhablmqphfcjwealyxxr.supabase.co:5432");
  });
});
