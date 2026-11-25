import { describe, expect, it } from "vitest";
import { AUDIT_MIGRATION, checkAuditRehearsalLedger } from "../../scripts/audit-rehearsal-ledger.mjs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const old = "20260101000000_initial";
const checksum = "a".repeat(64);
const manifest = { migrations: [{ name: old, sha256: checksum }, { name: AUDIT_MIGRATION, sha256: "b".repeat(64) }] };
const applied = { name: old, checksum, finished: true, rolledBack: false };

describe("offline audit rehearsal ledger preflight", () => {
  it("accepts exactly the reviewed prior migrations and a known rolled-back attempt", () => {
    expect(checkAuditRehearsalLedger(manifest, [{ ...applied, checksum: "c".repeat(64), finished: false, rolledBack: true }, applied]))
      .toEqual({ priorMigrations: 1, pending: AUDIT_MIGRATION, exceptions: [] });
  });
  it("rejects missing, duplicate, unknown or altered applied migrations", () => {
    for (const rows of [[], [applied, applied], [{ ...applied, name: "unknown" }], [{ ...applied, checksum: "d".repeat(64) }]]) {
      expect(() => checkAuditRehearsalLedger(manifest, rows)).toThrow();
    }
  });
  it("rejects unresolved attempts and any prior audit migration attempt", () => {
    expect(() => checkAuditRehearsalLedger(manifest, [{ ...applied, finished: false }])).toThrow(/unresolved/);
    for (const rolledBack of [false, true]) {
      expect(() => checkAuditRehearsalLedger(manifest, [applied, { name: AUDIT_MIGRATION, checksum: "b".repeat(64), finished: !rolledBack, rolledBack }])).toThrow(/already been attempted/);
    }
  });
  it("accepts only the explicitly approved exact CRLF historical checksum for a local rehearsal", () => {
    const name = "20261008123000_multi_tenant_saas_init";
    const sql = readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8").replace(/\r\n/g, "\n");
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const lf = sha(sql);
    const crlf = sha(sql.replace(/\n/g, "\r\n"));
    expect(lf).toBe("1699ad5263e6870210b92292bfde03aa10fb173f3ca4d39a59036a00f602663a");
    expect(crlf).toBe("6badbe313401501aeab622f7082f4182a0313c5149a02757a7afd166f533eccc");
    const m = { migrations: [{ name, sha256: lf }, manifest.migrations[1]] };
    const rows = [{ name, checksum: crlf, finished: true, rolledBack: false }];
    expect(() => checkAuditRehearsalLedger(m, rows)).toThrow(/checksum differs/);
    expect(checkAuditRehearsalLedger(m, rows, { allowKnownCrlf: true }).exceptions).toEqual([name]);
    expect(() => checkAuditRehearsalLedger(m, [{ ...rows[0], checksum: "c".repeat(64) }], { allowKnownCrlf: true })).toThrow();
    expect(() => checkAuditRehearsalLedger({ migrations: [{ name, sha256: "d".repeat(64) }, manifest.migrations[1]] }, rows, { allowKnownCrlf: true })).toThrow();
  });
  it("rejects an invalid manifest or malformed ledger", () => {
    expect(() => checkAuditRehearsalLedger({ migrations: [manifest.migrations[1], manifest.migrations[0]] }, [applied])).toThrow();
    expect(() => checkAuditRehearsalLedger(manifest, [{ ...applied, finished: "yes" }])).toThrow();
    expect(() => checkAuditRehearsalLedger({ migrations: [...manifest.migrations, manifest.migrations[1]] }, [applied])).toThrow();
  });
});
