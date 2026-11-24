// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { applyPendingMigrations } from "./migration-runner";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const proposal = readFileSync("proposals/runtime-role.sql", "utf8");
let db: PGlite;
async function fixture() { db = new PGlite(); await applyPendingMigrations(db); }
afterEach(async () => { if (db) await db.close(); });

describe("candidate runtime role on disposable PostgreSQL", () => {
  it("explicitly lists every current Prisma model without granting the migration ledger", () => {
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((match) => match[1]).sort();
    const section = proposal.split("GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE")[1].split("TO hotel_saas_runtime;")[0];
    const listed = [...section.matchAll(/public\."([^"]+)"/g)].map((match) => match[1]);
    expect([...listed, "AuditLog"].sort()).toEqual(models);
    expect(listed).not.toContain("_prisma_migrations");
    expect(proposal).not.toMatch(/ALTER DEFAULT PRIVILEGES/i);
  });
  it("creates a no-login, non-owner role with read/insert-only audit access", async () => {
    await fixture(); await db.exec(proposal);
    const q = await db.query<{ canlogin: boolean; canselect: boolean; caninsert: boolean; canupdate: boolean; cancolumn: boolean; candelete: boolean; cantruncate: boolean; canledger: boolean; canschema: boolean; canuser: boolean }>(`
      SELECT r.rolcanlogin AS canlogin,
        has_table_privilege(r.oid, '"AuditLog"', 'SELECT') AS canselect,
        has_table_privilege(r.oid, '"AuditLog"', 'INSERT') AS caninsert,
        has_table_privilege(r.oid, '"AuditLog"', 'UPDATE') AS canupdate,
        has_any_column_privilege(r.oid, '"AuditLog"', 'UPDATE') AS cancolumn,
        has_table_privilege(r.oid, '"AuditLog"', 'DELETE') AS candelete,
        has_table_privilege(r.oid, '"AuditLog"', 'TRUNCATE') AS cantruncate,
        has_table_privilege(r.oid, '"_prisma_migrations"', 'SELECT') AS canledger,
        has_schema_privilege(r.oid, 'public', 'CREATE') AS canschema,
        has_table_privilege(r.oid, '"User"', 'SELECT,INSERT,UPDATE,DELETE') AS canuser
      FROM pg_roles r WHERE r.rolname='hotel_saas_runtime'`);
    expect(q.rows[0]).toEqual({ canlogin: false, canselect: true, caninsert: true, canupdate: false, cancolumn: false, candelete: false, cantruncate: false, canledger: false, canschema: false, canuser: true });
    await db.exec(`SET ROLE hotel_saas_runtime; INSERT INTO "AuditLog" (id, action, entity) VALUES ('role-test-event', 'TEST', 'Subscription')`);
    await expect(db.exec(`UPDATE "AuditLog" SET action='changed' WHERE id='role-test-event'`)).rejects.toThrow();
    await expect(db.exec(`DELETE FROM "AuditLog" WHERE id='role-test-event'`)).rejects.toThrow();
    await expect(db.exec(`TRUNCATE "AuditLog"`)).rejects.toThrow();
    await db.exec(`RESET ROLE`);
  });
  it("fails without changing an existing role", async () => {
    await fixture(); await db.exec(`CREATE ROLE hotel_saas_runtime NOLOGIN`);
    await expect(db.exec(proposal)).rejects.toThrow(/already exists/);
    await db.exec("ROLLBACK");
    const q = await db.query<{ canselect: boolean }>(`SELECT has_table_privilege('hotel_saas_runtime', '"AuditLog"', 'SELECT') AS canselect`);
    expect(q.rows[0].canselect).toBe(false);
  });
  it.each([
    `GRANT UPDATE ON "AuditLog" TO PUBLIC`,
    `GRANT TRIGGER ON "AuditLog" TO PUBLIC`,
    `GRANT UPDATE (migration_name) ON "_prisma_migrations" TO PUBLIC`,
  ])("rolls back if a PUBLIC grant undermines the proposed role: %s", async (grant) => {
    await fixture(); await db.exec(grant);
    await expect(db.exec(proposal)).rejects.toThrow(/make the proposed role unsafe/);
    await db.exec("ROLLBACK");
    expect((await db.query(`SELECT 1 FROM pg_roles WHERE rolname='hotel_saas_runtime'`)).rows).toHaveLength(0);
  });
});
