import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * `npm run owner:env -- reset` drops a database. The only thing standing between
 * a mistyped environment variable and somebody's real data is the name guard in
 * `scripts/owner-test-env.mjs`, so it is tested by running the script the way an
 * operator would rather than by importing it (importing executes the command).
 *
 * The `url` command is used because it is the only one that does no work: it
 * prints the connection string it would use and exits.
 */

const SCRIPT = resolve(__dirname, "../../scripts/owner-test-env.mjs");

function runWith(database: string | undefined) {
  const env = { ...process.env };
  delete env.OWNER_TEST_DB;
  if (database !== undefined) env.OWNER_TEST_DB = database;
  return spawnSync(process.execPath, [SCRIPT, "url"], {
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
}

describe("owner demo environment database guard", () => {
  it("accepts a demo database name", () => {
    const result = runWith("hotel_saas_demo_owner");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("postgresql://postgres@127.0.0.1:");
    expect(result.stdout).toContain("/hotel_saas_demo_owner");
  });

  it.each([
    ["a production-sounding name", "hotel_production"],
    ["the application's own database", "hotel_saas"],
    ["a name that merely contains the prefix", "prod_hotel_saas_demo_owner"],
    ["an empty name", ""],
  ])("refuses %s", (_label, name) => {
    const result = runWith(name);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("hotel_saas_demo_*");
    expect(result.stdout).not.toContain("postgresql://");
  });

  it("only ever builds a loopback connection string", () => {
    const result = runWith("hotel_saas_demo_owner");
    expect(result.stdout).toMatch(/postgresql:\/\/postgres@127\.0\.0\.1:\d+\//);
  });
});
