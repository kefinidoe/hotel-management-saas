import { describe, expect, it } from "vitest";
import { AUDIT_MIGRATION, checkAuditRehearsalLedger } from "../../scripts/audit-rehearsal-ledger.mjs";

const old = "20260101000000_initial";
const checksum = "a".repeat(64);
const manifest = { migrations: [{ name: old, sha256: checksum }, { name: AUDIT_MIGRATION, sha256: "b".repeat(64) }] };
const applied = { name: old, checksum, finished: true, rolledBack: false };

describe("offline audit rehearsal ledger preflight", () => {
  it("accepts exactly the reviewed prior migrations and a known rolled-back attempt", () => {
    expect(checkAuditRehearsalLedger(manifest, [{ ...applied, checksum: "c".repeat(64), finished: false, rolledBack: true }, applied]))
      .toEqual({ priorMigrations: 1, pending: AUDIT_MIGRATION });
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
  it("rejects an invalid manifest or malformed ledger", () => {
    expect(() => checkAuditRehearsalLedger({ migrations: [manifest.migrations[1], manifest.migrations[0]] }, [applied])).toThrow();
    expect(() => checkAuditRehearsalLedger(manifest, [{ ...applied, finished: "yes" }])).toThrow();
    expect(() => checkAuditRehearsalLedger({ migrations: [...manifest.migrations, manifest.migrations[1]] }, [applied])).toThrow();
  });
});
