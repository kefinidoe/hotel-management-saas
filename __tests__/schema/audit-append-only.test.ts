// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const migration = readFileSync("prisma/migrations/20261115120000_append_only_audit_log/migration.sql", "utf8");
let db: PGlite;

async function fixture() {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Hotel" (id text PRIMARY KEY);
    CREATE TABLE "User" (id text PRIMARY KEY);
    CREATE TABLE "AuditLog" (
      id text PRIMARY KEY, "hotelId" text, "userId" text, action text NOT NULL,
      entity text NOT NULL, "entityId" text, metadata jsonb,
      CONSTRAINT "AuditLog_hotelId_fkey" FOREIGN KEY ("hotelId") REFERENCES "Hotel"(id) ON UPDATE CASCADE ON DELETE CASCADE,
      CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE SET NULL
    );
    CREATE UNIQUE INDEX "AuditLog_manual_payment_reference_unique" ON "AuditLog" (UPPER(BTRIM(metadata->>'referenceCode')))
      WHERE action = 'PLATFORM_MANUAL_PAYMENT_ACTIVATED' AND entity = 'Subscription' AND metadata->>'referenceCode' IS NOT NULL;
    INSERT INTO "Hotel" VALUES ('hotel-1'), ('hotel-empty');
    INSERT INTO "User" VALUES ('user-1'), ('user-empty');
    INSERT INTO "AuditLog" VALUES ('audit-1', 'hotel-1', 'user-1', 'PLATFORM_MANUAL_PAYMENT_ACTIVATED', 'Subscription', 'sub-1', '{"referenceCode":"REF-1"}');
  `);
}
async function rows() { return (await db.query(`SELECT * FROM "AuditLog" ORDER BY id`)).rows; }
async function fkDefinitions() {
  return (await db.query<{ definition: string }>(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='"AuditLog"'::regclass AND contype='f' ORDER BY conname`)).rows.map((r) => r.definition);
}
afterEach(async () => { if (db) await db.close(); });

describe("audit protection migration — disposable in-memory PostgreSQL", () => {
  it("preserves existing rows, permits inserts, and rejects updates, deletes and truncate", async () => {
    await fixture(); const before = await rows(); await db.exec(migration);
    expect(await rows()).toEqual(before);
    for (const query of [
      `UPDATE "AuditLog" SET metadata = '{"referenceCode":"CHANGED"}' WHERE id='audit-1'`,
      `UPDATE "AuditLog" SET action = 'OTHER' WHERE id='audit-1'`,
      `DELETE FROM "AuditLog" WHERE id='audit-1'`,
      `TRUNCATE "AuditLog"`,
    ]) await expect(db.exec(query)).rejects.toThrow(/append-only/);
    expect(await rows()).toEqual(before);
    await expect(db.exec(`INSERT INTO "AuditLog" VALUES ('audit-2','hotel-1','user-1','PLATFORM_MANUAL_PAYMENT_ACTIVATED','Subscription','sub-2','{"referenceCode":" ref-1 "}')`)).rejects.toThrow();
    await db.exec(`INSERT INTO "AuditLog" VALUES ('audit-2','hotel-1','user-1','CORRECTION','Subscription','sub-1','{}')`);
    expect(await rows()).toHaveLength(2);
  });
  it("blocks deletion and identity changes of linked parents without affecting history", async () => {
    await fixture(); await db.exec(migration); const before = await rows();
    for (const query of [
      `DELETE FROM "Hotel" WHERE id='hotel-1'`, `DELETE FROM "User" WHERE id='user-1'`,
      `UPDATE "Hotel" SET id='hotel-changed' WHERE id='hotel-1'`, `UPDATE "User" SET id='user-changed' WHERE id='user-1'`,
    ]) await expect(db.exec(query)).rejects.toThrow();
    expect(await rows()).toEqual(before);
    await db.exec(`DELETE FROM "Hotel" WHERE id='hotel-empty'; DELETE FROM "User" WHERE id='user-empty';`);
  });
  it("rolls back without changing foreign keys if expected schema differs", async () => {
    await fixture();
    await db.exec(`ALTER TABLE "AuditLog" DROP CONSTRAINT "AuditLog_userId_fkey"; ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"(id) ON DELETE RESTRICT`);
    const before = await fkDefinitions(); const data = await rows();
    await expect(db.exec(migration)).rejects.toThrow(/schema drift/);
    expect(await fkDefinitions()).toEqual(before); expect(await rows()).toEqual(data);
    const triggers = await db.query(`SELECT 1 FROM pg_trigger WHERE tgrelid='"AuditLog"'::regclass AND NOT tgisinternal`);
    expect(triggers.rows).toHaveLength(0);
  });
  it("fails closed on a pre-existing protection function", async () => {
    await fixture(); const before = await fkDefinitions();
    await db.exec(`CREATE FUNCTION public.reject_audit_log_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`);
    await expect(db.exec(migration)).rejects.toThrow(/already exists/);
    expect(await fkDefinitions()).toEqual(before);
  });
  it("supports a separately configured non-owner read-and-insert-only runtime role", async () => {
    await fixture(); await db.exec(migration);
    await db.exec(`CREATE ROLE audit_runtime NOLOGIN; GRANT USAGE ON SCHEMA public TO audit_runtime; GRANT SELECT, INSERT ON "AuditLog" TO audit_runtime; SET ROLE audit_runtime;`);
    try {
      expect(await rows()).toHaveLength(1);
      await db.exec(`INSERT INTO "AuditLog" VALUES ('runtime-1','hotel-1','user-1','TEST','Hotel','hotel-1','{}')`);
      await expect(db.exec(`UPDATE "AuditLog" SET action='OTHER' WHERE id='audit-1'`)).rejects.toThrow();
      await expect(db.exec(`DELETE FROM "AuditLog" WHERE id='audit-1'`)).rejects.toThrow();
      await expect(db.exec(`TRUNCATE "AuditLog"`)).rejects.toThrow();
    } finally { await db.exec(`RESET ROLE`); }
    expect(await rows()).toHaveLength(2);
  });
});
