import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `scripts/prisma-safe.mjs` is the only way the npm scripts reach the Prisma CLI.
 * Every case here runs the wrapper with `--print-target`, which resolves and
 * prints the decision and then exits — the real CLI is never spawned and no
 * database is ever contacted from this test file.
 */

const SCRIPT = resolve(__dirname, "../../scripts/prisma-safe.mjs");

const REF = "jhablmqphfcjwealyxxr";
const OTHER_REF = "otherprojectref12345";

const POOLED = `postgresql://postgres.${REF}:sup3r-s3cret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true`;
const DIRECT = `postgresql://postgres:sup3r-s3cret@db.${REF}.supabase.co:5432/postgres`;
const POOLED_OTHER = `postgresql://postgres.${OTHER_REF}:sup3r-s3cret@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`;
const LOCAL = "postgresql://postgres:pw@127.0.0.1:5432/hotel_saas_dev";

interface Env {
  SAAS_ENVIRONMENT?: string;
  SAAS_DATABASE_IDENTIFIER?: string;
  DATABASE_URL?: string;
  DIRECT_URL?: string;
  SAAS_ALLOW_LOCAL_RESET?: string;
  PGHOSTADDR?: string;
  PGSERVICE?: string;
}

function run(args: string[], env: Env) {
  // A deliberately tiny environment: nothing from the developer's shell leaks in,
  // so a passing case cannot be an accident of an ambient DATABASE_URL.
  // NODE_ENV is part of ProcessEnv in this project's typings, so it is set here
  // rather than inherited.
  const childEnv: NodeJS.ProcessEnv = { NODE_ENV: "test" };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) childEnv[key] = value;
  }
  if (process.env.PATH) childEnv.PATH = process.env.PATH;
  if (process.env.SystemRoot) childEnv.SystemRoot = process.env.SystemRoot;

  const result = spawnSync(process.execPath, [SCRIPT, "--print-target", ...args], {
    encoding: "utf8",
    env: childEnv,
    timeout: 20_000,
  });

  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

const remoteEnv: Env = {
  SAAS_ENVIRONMENT: "saas",
  SAAS_DATABASE_IDENTIFIER: REF,
  DATABASE_URL: POOLED,
  DIRECT_URL: DIRECT,
};

const loopbackEnv: Env = {
  SAAS_ENVIRONMENT: "saas",
  SAAS_DATABASE_IDENTIFIER: "hotel_saas_dev",
  DATABASE_URL: LOCAL,
  DIRECT_URL: LOCAL,
};

describe("prisma-safe — identity is required before any database command", () => {
  it("allows migrate deploy for the approved project", () => {
    const { status, stdout } = run(["migrate", "deploy"], remoteEnv);
    expect(status).toBe(0);
    expect(stdout).toContain("ALLOW migrate deploy");
    expect(stdout).toContain(`(project ${REF})`);
  });

  it("refuses migrate deploy when the identity is missing", () => {
    const { status, stderr } = run(["migrate", "deploy"], { ...remoteEnv, SAAS_DATABASE_IDENTIFIER: undefined });
    expect(status).toBe(1);
    expect(stderr).toContain("SAAS_DATABASE_IDENTIFIER");
  });

  it("refuses migrate deploy when SAAS_ENVIRONMENT is not 'saas'", () => {
    const { status, stderr } = run(["migrate", "deploy"], { ...remoteEnv, SAAS_ENVIRONMENT: "production" });
    expect(status).toBe(1);
    expect(stderr).toContain("SAAS_ENVIRONMENT");
  });

  it("refuses migrate deploy against a different project", () => {
    const { status, stderr } = run(["migrate", "deploy"], {
      ...remoteEnv,
      DATABASE_URL: POOLED_OTHER,
      DIRECT_URL: `postgresql://postgres:pw@db.${OTHER_REF}.supabase.co:5432/postgres`,
    });
    expect(status).toBe(1);
    expect(stderr).toContain("does not match the approved SAAS_DATABASE_IDENTIFIER");
  });

  it("refuses migrate deploy when DIRECT_URL is missing", () => {
    const { status, stderr } = run(["migrate", "deploy"], { ...remoteEnv, DIRECT_URL: undefined });
    expect(status).toBe(1);
    expect(stderr).toContain("DIRECT_URL is missing or empty");
  });

  it("refuses migrate deploy when only DATABASE_URL is set", () => {
    const { status, stderr } = run(["migrate", "deploy"], {
      SAAS_ENVIRONMENT: "saas",
      SAAS_DATABASE_IDENTIFIER: REF,
      DATABASE_URL: POOLED,
    });
    expect(status).toBe(1);
    expect(stderr).toContain("DIRECT_URL");
  });

  it("refuses studio when the target cannot be identified", () => {
    const { status, stderr } = run(["studio"], { DATABASE_URL: POOLED });
    expect(status).toBe(1);
    expect(stderr).toContain("SAAS_ENVIRONMENT");
  });

  it("allows studio for the approved project", () => {
    const { status, stdout } = run(["studio"], remoteEnv);
    expect(status).toBe(0);
    expect(stdout).toContain("ALLOW studio");
  });
});

describe("prisma-safe — remote migrate dev is refused (shadow database)", () => {
  it("refuses migrate dev against a remote Supabase project", () => {
    const { status, stderr } = run(["migrate", "dev"], remoteEnv);
    expect(status).toBe(1);
    expect(stderr).toContain("not permitted against a remote database");
    expect(stderr).toContain("shadow database");
  });

  it("refuses migrate dev --name even when the name looks harmless", () => {
    const { status, stderr } = run(["migrate", "dev", "--name", "add_index"], remoteEnv);
    expect(status).toBe(1);
    expect(stderr).toContain("not permitted against a remote database");
  });

  it("allows migrate dev against a loopback database", () => {
    const { status, stdout } = run(["migrate", "dev"], loopbackEnv);
    expect(status).toBe(0);
    expect(stdout).toContain("ALLOW migrate dev");
    expect(stdout).toContain("loopback");
  });
});

describe("prisma-safe — destructive commands", () => {
  it("refuses migrate reset against a remote database", () => {
    const { status, stderr } = run(["migrate", "reset"], remoteEnv);
    expect(status).toBe(1);
    expect(stderr).toContain("forbidden against any remote database");
  });

  it("refuses migrate reset --force against a remote database", () => {
    const { status, stderr } = run(["migrate", "reset", "--force"], remoteEnv);
    expect(status).toBe(1);
    expect(stderr).toContain("forbidden against any remote database");
  });

  it("refuses migrate reset locally unless SAAS_ALLOW_LOCAL_RESET=true", () => {
    const withoutFlag = run(["migrate", "reset"], loopbackEnv);
    expect(withoutFlag.status).toBe(1);
    expect(withoutFlag.stderr).toContain("SAAS_ALLOW_LOCAL_RESET");

    const withFlag = run(["migrate", "reset"], { ...loopbackEnv, SAAS_ALLOW_LOCAL_RESET: "true" });
    expect(withFlag.status).toBe(0);
    expect(withFlag.stdout).toContain("ALLOW migrate reset");
  });

  it("refuses db push --force-reset even on a loopback database", () => {
    const { status, stderr } = run(["db", "push", "--force-reset"], loopbackEnv);
    expect(status).toBe(1);
    expect(stderr).toContain("--force-reset");
    expect(stderr).toContain("destructive");
  });

  it("refuses db push --accept-data-loss", () => {
    const { status, stderr } = run(["db", "push", "--accept-data-loss"], remoteEnv);
    expect(status).toBe(1);
    expect(stderr).toContain("--accept-data-loss");
  });

  it("refuses db push against a remote database", () => {
    const { status, stderr } = run(["db", "push"], remoteEnv);
    expect(status).toBe(1);
    expect(stderr).toContain("not the approved schema workflow");
  });

  it("allows db push on a loopback database", () => {
    const { status } = run(["db", "push"], loopbackEnv);
    expect(status).toBe(0);
  });

  it("refuses db execute against a remote database", () => {
    const { status, stderr } = run(["db", "execute"], remoteEnv);
    expect(status).toBe(1);
    expect(stderr).toContain("arbitrary SQL");
  });

  it("refuses prisma format", () => {
    const { status, stderr } = run(["format"], remoteEnv);
    expect(status).toBe(1);
    expect(stderr).toContain("rewrites prisma/schema.prisma");
  });
});

describe("prisma-safe — the schema file cannot be swapped", () => {
  it("refuses --schema pointing at another file", () => {
    const { status, stderr } = run(["migrate", "deploy", "--schema", "other/schema.prisma"], remoteEnv);
    expect(status).toBe(1);
    expect(stderr).toContain("only prisma/schema.prisma is approved");
  });

  it("refuses --schema=<path> pointing at another file", () => {
    const { status, stderr } = run(["migrate", "deploy", "--schema=/tmp/other.prisma"], remoteEnv);
    expect(status).toBe(1);
    expect(stderr).toContain("only prisma/schema.prisma is approved");
  });

  it("still allows the approved schema file explicitly", () => {
    const { status } = run(["migrate", "deploy", "--schema", "prisma/schema.prisma"], remoteEnv);
    expect(status).toBe(0);
  });
});

describe("prisma-safe — unknown commands fail closed", () => {
  it("refuses an unrecognised migrate subcommand", () => {
    const { status, stderr } = run(["migrate", "bork"], remoteEnv);
    expect(status).toBe(1);
    expect(stderr).toContain("Unrecognised migrate subcommand");
  });

  it("refuses an unrecognised db subcommand", () => {
    const { status, stderr } = run(["db", "bork"], remoteEnv);
    expect(status).toBe(1);
    expect(stderr).toContain("Unrecognised db subcommand");
  });

  it("refuses an entirely unknown command rather than forwarding it", () => {
    const { status, stderr } = run(["teleport"], remoteEnv);
    expect(status).toBe(1);
    expect(stderr).toContain("Unrecognised Prisma command");
  });

  it("prints usage and exits non-zero when no command is given", () => {
    const result = spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toContain("Usage: node scripts/prisma-safe.mjs");
  });
});

describe("prisma-safe — commands that open no connection", () => {
  it("allows generate without any database identity", () => {
    const { status } = run(["generate"], {});
    expect(status).toBe(0);
  });

  it("allows validate without any database identity", () => {
    const { status } = run(["validate"], {});
    expect(status).toBe(0);
  });
});

describe("prisma-safe — datasource bypass regression", () => {
  it.each([
    ["--from-url", POOLED_OTHER],
    [`--to-url=${POOLED_OTHER}`],
    ["--from-schema-datamodel", "other.prisma"],
    ["--to-schema-datamodel", "other.prisma"],
    ["--from-schema-datasource", "other.prisma"],
    ["--to-schema-datasource", "other.prisma"],
    ["--shadow-database-url", POOLED_OTHER],
    ["--from-migrations", "prisma/migrations"],
  ])("refuses migrate diff with source arguments %s", (...args) => {
    const result = run(["migrate", "diff", ...args], remoteEnv);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("sup3r-s3cret");
  });

  it.each([
    ["db", "execute", "--url", POOLED_OTHER],
    ["db", "pull", `--url=${POOLED_OTHER}`],
    ["migrate", "deploy", "--shadow-database-url", POOLED_OTHER],
    ["migrate", "deploy", "--schema", "prisma/schema.prisma", "--schema", "other.prisma"],
    ["migrate", "deploy", "--schema=prisma/schema.prisma", "--schema=other.prisma"],
    ["migrate", "deploy", "--unknown-future-option", POOLED_OTHER],
    ["studio", "--url", POOLED_OTHER],
    ["migrate", "toString"],
    ["db", "constructor"],
    ["migrate", "deploy", "__proto__", POOLED_OTHER],
    ["validate", "--schema", "other.prisma"],
    ["generate", "--schema", "other.prisma"],
  ])("refuses datasource override for %s", (...args) => {
    const result = run(args, loopbackEnv);
    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("sup3r-s3cret");
  });

  it("rejects a self-consistent but unapproved remote project", () => {
    const result = run(["migrate", "deploy"], {
      ...remoteEnv, SAAS_DATABASE_IDENTIFIER: OTHER_REF, DATABASE_URL: POOLED_OTHER,
      DIRECT_URL: `postgresql://postgres:pw@db.${OTHER_REF}.supabase.co:5432/postgres`,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("restricted to the approved SaaS Supabase project");
  });
});


describe("prisma-safe — ambient connection defaults", () => {
  it.each(["PGHOSTADDR", "PGSERVICE"] as const)("rejects %s before launching Prisma", (key) => {
    const result = run(["migrate", "deploy"], { ...remoteEnv, [key]: "untrusted" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("environment defaults must be unset");
  });
});
