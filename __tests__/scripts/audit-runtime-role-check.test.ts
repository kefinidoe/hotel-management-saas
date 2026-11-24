// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { spawnSync } from "node:child_process";
import { AUDIT_RUNTIME_QUERY, configuredRoleName, evaluateAuditRuntime } from "../../scripts/audit-runtime-role-check.mjs";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
let db: PGlite;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE TABLE "AuditLog" (id text PRIMARY KEY, action text);
    REVOKE CREATE ON SCHEMA public FROM PUBLIC;
    CREATE ROLE audit_test_reader NOLOGIN;
    GRANT USAGE ON SCHEMA public TO audit_test_reader;
    GRANT SELECT, INSERT ON "AuditLog" TO audit_test_reader;`);
});
afterAll(async () => { await db.close(); });

describe("audit runtime role diagnostic", () => {
  it("extracts only a safe role name from validated connection configuration", () => {
    expect(configuredRoleName("postgresql://hotel_runtime.jhablmqphfcjwealyxxr:secret@aws-0-eu-west-1.pooler.supabase.com:6543/postgres", "supabase-pooler")).toBe("hotel_runtime");
    expect(configuredRoleName("postgresql://postgres:secret@127.0.0.1:55434/demo", "loopback")).toBe("postgres");
    expect(() => configuredRoleName("postgresql://%0Asecret:password@127.0.0.1/demo", "loopback")).toThrow();
  });
  it("config-only performs no connection and does not print the password or URL", () => {
    const databaseUrl = "postgresql://hotel_runtime:fictional-secret@127.0.0.1:1/disposable_test";
    const child = spawnSync(process.execPath, ["scripts/audit-runtime-role-check.mjs", "--config-only"], {
      encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", NODE_ENV: "test", SAAS_ENVIRONMENT: "saas",
        SAAS_DATABASE_IDENTIFIER: "disposable_test", DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl },
    });
    expect(child.status).toBe(0);
    expect(child.stdout).toContain("Configured DATABASE_URL role: hotel_runtime");
    expect(child.stdout).toContain("no connection was made");
    expect(child.stdout + child.stderr).not.toContain("fictional-secret");
    expect(child.stdout + child.stderr).not.toContain(databaseUrl);
  });
  it("fails closed if the result is missing or not confirmed read-only", () => {
    expect(evaluateAuditRuntime(undefined).ok).toBe(false);
    expect(evaluateAuditRuntime({ read_only: "off" }).ok).toBe(false);
  });
  it("identifies the owner as dangerous on a read-only transaction", async () => {
    await db.exec("BEGIN READ ONLY");
    const result = await db.query(AUDIT_RUNTIME_QUERY);
    const verdict = evaluateAuditRuntime(result.rows[0]);
    expect(verdict.ok).toBe(false);
    expect(verdict.riskyRoles?.length).toBeGreaterThan(0);
    await db.exec("ROLLBACK");
  });
  it("passes a read-and-insert-only login and catches inherited write privileges", async () => {
    for (const risk of ["none", "inherited-update", "security-definer"]) {
      const instance = new PGlite();
      try {
        await instance.exec(`CREATE TABLE "AuditLog" (id text PRIMARY KEY, action text);
          REVOKE CREATE ON SCHEMA public FROM PUBLIC;
          CREATE ROLE audit_test_reader NOLOGIN;
          GRANT USAGE ON SCHEMA public TO audit_test_reader;
          GRANT SELECT, INSERT ON "AuditLog" TO audit_test_reader;`);
        if (risk === "inherited-update") await instance.exec(`CREATE ROLE audit_test_writer NOLOGIN; GRANT UPDATE(action) ON "AuditLog" TO audit_test_writer; GRANT audit_test_writer TO audit_test_reader`);
        if (risk === "security-definer") await instance.exec(`CREATE FUNCTION public.owner_function() RETURNS int LANGUAGE sql SECURITY DEFINER AS 'SELECT 1'`);
        await instance.exec("SET SESSION AUTHORIZATION audit_test_reader; BEGIN READ ONLY");
        const result = await instance.query(AUDIT_RUNTIME_QUERY);
        expect(evaluateAuditRuntime(result.rows[0]).ok, risk).toBe(risk === "none");
      } finally { await instance.close(); }
    }
  });
  it("does not treat a role-switched session as the actual runtime login", () => {
    expect(evaluateAuditRuntime({ read_only: "on", audit_table_exists: true, can_select: true, can_insert: true,
      runtime_role: "reader", session_role: "owner", replication_role: "origin", risky_roles: [] }).ok).toBe(false);
  });
  it("rejects dangerous grants and non-origin trigger modes", () => {
    const baseline = { read_only: "on", audit_table_exists: true, can_select: true, can_insert: true,
      runtime_role: "reader", session_role: "reader", replication_role: "origin", risky_roles: [] };
    expect(evaluateAuditRuntime(baseline).ok).toBe(true);
    expect(evaluateAuditRuntime({ ...baseline, risky_roles: ["owner"] }).ok).toBe(false);
    expect(evaluateAuditRuntime({ ...baseline, replication_role: "replica" }).ok).toBe(false);
    expect(evaluateAuditRuntime({ ...baseline, can_insert: false }).ok).toBe(false);
  });
});
