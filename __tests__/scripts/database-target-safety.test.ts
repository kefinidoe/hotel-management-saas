import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertDatabaseTarget } from "../../scripts/database-target-safety.mjs";

const BACKUP_SCRIPT = readFileSync(resolve(__dirname, "../../scripts/backup-db.mjs"), "utf8");
const RESTORE_SCRIPT = readFileSync(resolve(__dirname, "../../scripts/restore-db.mjs"), "utf8");

describe("standalone maintenance database target guard", () => {
  it("binds a loopback target by database name", () => {
    expect(
      assertDatabaseTarget({
        environment: "saas",
        identifier: "hotel_stage",
        databaseUrl: "postgresql://operator:secret@127.0.0.1:5432/hotel_stage",
      })
    ).toMatchObject({ host: "127.0.0.1", database: "hotel_stage", kind: "loopback", identifierMatched: "hotel_stage" });
  });

  it("refuses a remote target that only matches by database name", () => {
    // Round 28: every Supabase project is called "postgres", so a database-name
    // match identifies nothing. A remote host must be a Supabase endpoint whose
    // project reference equals the identifier.
    expect(() =>
      assertDatabaseTarget({
        environment: "saas",
        identifier: "hotel_stage",
        databaseUrl: "postgresql://operator:secret@db.example.test:5432/hotel_stage",
      })
    ).toThrow(/does not match the approved SAAS_DATABASE_IDENTIFIER/);
  });

  it("accepts Supabase pooler targets only when the project reference matches", () => {
    expect(() =>
      assertDatabaseTarget({
        environment: "saas",
        identifier: "jhablmqphfcjwealyxxr",
        databaseUrl: "postgresql://postgres.jhablmqphfcjwealyxxr:secret@aws-0-region.pooler.supabase.com:6543/postgres",
      })
    ).not.toThrow();
  });

  it("is wired into backup and restore before any pg tool can run", () => {
    expect(BACKUP_SCRIPT).toContain("assertDatabaseTarget({");
    expect(BACKUP_SCRIPT).toContain("keep > 3650");
    expect(RESTORE_SCRIPT).toContain("assertDatabaseTarget({");
    expect(RESTORE_SCRIPT).toContain('arg("confirm-target") !== requiredConfirmation');
    expect(RESTORE_SCRIPT.indexOf("assertDatabaseTarget({")).toBeLessThan(RESTORE_SCRIPT.indexOf('findPgTool("pg_restore")'));
  });

  it("rejects absent, non-SaaS, malformed, and mismatched targets without echoing credentials", () => {
    expect(() => assertDatabaseTarget({ environment: "", identifier: "x", databaseUrl: "postgresql://u:p@x/x" })).toThrow(/SAAS_ENVIRONMENT/);
    expect(() => assertDatabaseTarget({ environment: "saas", identifier: "", databaseUrl: "postgresql://u:p@x/x" })).toThrow(/SAAS_DATABASE_IDENTIFIER/);
    expect(() => assertDatabaseTarget({ environment: "saas", identifier: "x", databaseUrl: "not-a-url" })).toThrow(/valid PostgreSQL URL/);

    let message = "";
    try {
      assertDatabaseTarget({
        environment: "saas",
        identifier: "approved",
        databaseUrl: "postgresql://sensitive-user:top-secret@unverified.example/db",
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("unverified.example");
    expect(message).not.toContain("top-secret");
    expect(message).not.toContain("sensitive-user");
  });
});
