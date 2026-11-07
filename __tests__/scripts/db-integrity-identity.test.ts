import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * `db:integrity` reads a restored database through `psql`. `--allow-remote-target`
 * used to be the only gate on a remote host, which meant one flag was enough to
 * point a read at any server. These cases prove the flag now authorises the
 * *network*, while the project reference authorises the *database*.
 *
 * Every case runs with `--print-target`, which exits before `psql` is resolved or
 * a connection is attempted.
 */

const SCRIPT = resolve(__dirname, "../../scripts/db-integrity.mjs");

const REF = "jhablmqphfcjwealyxxr";
const OTHER_REF = "otherprojectref12345";

const POOLED = `postgresql://postgres.${REF}:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres`;
const DIRECT = `postgresql://postgres:pw@db.${REF}.supabase.co:5432/postgres`;
const DIRECT_OTHER = `postgresql://postgres:pw@db.${OTHER_REF}.supabase.co:5432/postgres`;
const LOCAL = "postgresql://postgres:pw@127.0.0.1:5432/hms_restored";

interface Env {
  SAAS_ENVIRONMENT?: string;
  SAAS_DATABASE_IDENTIFIER?: string;
  DIRECT_URL?: string;
  DATABASE_URL?: string;
}

function run(args: string[], env: Env = {}) {
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

  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("db-integrity — loopback targets keep working unchanged", () => {
  it("allows a loopback target from DIRECT_URL", () => {
    const { status, stdout } = run([], { DIRECT_URL: LOCAL });
    expect(status).toBe(0);
    expect(stdout).toContain("class: loopback");
    expect(stdout).toContain("decision: allow");
    expect(stdout).toContain("nothing was executed");
  });

  it("allows any loopback database name, because a loopback host cannot be shared", () => {
    const { status } = run([], { DATABASE_URL: "postgresql://postgres:pw@localhost:5432/backup_src" });
    expect(status).toBe(0);
  });

  it("prefers --url over the environment", () => {
    const { status, stdout } = run(["--url", LOCAL], { DIRECT_URL: DIRECT, SAAS_ENVIRONMENT: "saas" });
    expect(status).toBe(0);
    expect(stdout).toContain("127.0.0.1");
  });
});

describe("db-integrity — remote access is denied by default", () => {
  it("refuses a remote host without --allow-remote-target", () => {
    const { status, stderr } = run(["--url", DIRECT]);
    expect(status).toBe(1);
    expect(stderr).toContain("Refusing to inspect");
    expect(stderr).toContain("--allow-remote-target");
  });

  it("refuses a remote host without --allow-remote-target even when the identity is correct", () => {
    const { status } = run(["--url", DIRECT], {
      SAAS_ENVIRONMENT: "saas",
      SAAS_DATABASE_IDENTIFIER: REF,
    });
    expect(status).toBe(1);
  });
});

describe("db-integrity — --allow-remote-target does not bypass identity", () => {
  it("refuses a remote host when SAAS_ENVIRONMENT is missing", () => {
    const { status, stderr } = run(["--url", DIRECT, "--allow-remote-target"], {
      SAAS_DATABASE_IDENTIFIER: REF,
    });
    expect(status).toBe(1);
    expect(stderr).toContain("SAAS_ENVIRONMENT");
  });

  it("refuses a remote host when the identifier is missing", () => {
    const { status, stderr } = run(["--url", DIRECT, "--allow-remote-target"], {
      SAAS_ENVIRONMENT: "saas",
    });
    expect(status).toBe(1);
    expect(stderr).toContain("SAAS_DATABASE_IDENTIFIER");
  });

  it("refuses a remote host whose project does not match the identifier", () => {
    const { status, stderr } = run(["--url", DIRECT_OTHER, "--allow-remote-target"], {
      SAAS_ENVIRONMENT: "saas",
      SAAS_DATABASE_IDENTIFIER: REF,
    });
    expect(status).toBe(1);
    expect(stderr).toContain("does not match the approved SAAS_DATABASE_IDENTIFIER");
  });

  it("refuses a remote host outside Supabase even when the identifier matches its database name", () => {
    const { status, stderr } = run(["--url", `postgresql://postgres:pw@db.example.test:5432/${REF}`, "--allow-remote-target"], {
      SAAS_ENVIRONMENT: "saas",
      SAAS_DATABASE_IDENTIFIER: REF,
    });
    expect(status).toBe(1);
    expect(stderr).toContain("not a recognisable Supabase endpoint");
  });

  it("accepts a remote host only when the flag and the identity both hold", () => {
    const { status, stdout } = run(["--url", DIRECT, "--allow-remote-target"], {
      SAAS_ENVIRONMENT: "saas",
      SAAS_DATABASE_IDENTIFIER: REF,
    });
    expect(status).toBe(0);
    expect(stdout).toContain("class: supabase-direct");
    expect(stdout).toContain(`project: ${REF}`);
  });

  it("classifies a pooler target as supabase-pooler", () => {
    const { status, stdout } = run(["--url", POOLED, "--allow-remote-target"], {
      SAAS_ENVIRONMENT: "saas",
      SAAS_DATABASE_IDENTIFIER: REF,
    });
    expect(status).toBe(0);
    expect(stdout).toContain("class: supabase-pooler");
  });
});

describe("db-integrity — no connection is attempted while deciding", () => {
  it("never resolves psql in --print-target mode", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--print-target", "--url", LOCAL], {
      encoding: "utf8",
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH ?? "",
        PSQL_BIN: "/definitely/not/a/psql/binary",
      },
      timeout: 20_000,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
  });

  it("keeps --help working without any environment", () => {
    const result = spawnSync(process.execPath, [SCRIPT, "--help"], {
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "" },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--print-target");
    expect(result.stdout).toContain("SAAS_DATABASE_IDENTIFIER");
  });
});
