// @vitest-environment node
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CHECKPOINTS,
  PRISMA_LEDGER_DDL,
  assertLfMigrationFiles,
  SCHEMA_FEATURES,
  buildAdoptionPlan,
  buildFeatureQuery,
  buildReleaseManifest,
  checkpointMatches,
  checkpointPredicateSql,
  describeCheckpoints,
  evaluateCheckpoints,
  readMigrations,
  readReleaseManifest,
  sha256Hex,
  verifyReleaseManifest,
} from "../../scripts/migration-ledger.mjs";

type LedgerRow = {
  migration_name: string;
  checksum: string;
  finished_at: string | null;
  rolled_back_at: string | null;
  applied_steps_count: number;
};

const migrations = readMigrations();

/** Feature map that satisfies exactly one checkpoint. */
function featuresFor(checkpointId: string): Record<string, boolean> {
  const checkpoint = CHECKPOINTS.find((entry) => entry.id === checkpointId);
  if (!checkpoint) throw new Error(`Unknown checkpoint ${checkpointId}`);
  const features: Record<string, boolean> = {};
  for (const name of Object.keys(SCHEMA_FEATURES)) features[name] = false;
  for (const name of checkpoint.require ?? []) features[name] = true;
  for (const name of checkpoint.forbid ?? []) features[name] = false;
  return features;
}

function ledgerRowsFor(names: string[]): LedgerRow[] {
  return names.map((name) => {
    const migration = migrations.find((entry) => entry.name === name);
    return {
      migration_name: name,
      checksum: migration?.checksum ?? "0".repeat(64),
      finished_at: "2026-10-30T00:00:00.000Z",
      rolled_back_at: null,
      applied_steps_count: 1,
    };
  });
}

describe("migration release manifest", () => {
  it("lists every migration directory in timestamp order with its SHA-256", () => {
    const manifest = readReleaseManifest();
    expect(manifest).not.toBeNull();
    const names = manifest.migrations.map((entry: { name: string }) => entry.name);
    expect(names).toEqual(migrations.map((migration) => migration.name));
    expect(names).toHaveLength(24);
    expect(names[0]).toBe("20260915161717_init");
    expect(names[names.length - 1]).toBe("20261107120000_auth_rate_limit");
    expect(names).toContain("20261029120000_add_pos_charge_to_room_idempotency");
    expect(names).toContain("20261029130000_add_tenant_composite_join_fks");
  });

  it("matches the files on disk", () => {
    expect(verifyReleaseManifest(migrations, readReleaseManifest()).problems).toEqual([]);
  });

  it("flags an edited, added or removed migration file", () => {
    const manifest = readReleaseManifest();
    const edited = migrations.map((migration, index) =>
      index === 3 ? { ...migration, checksum: "f".repeat(64) } : migration
    );
    expect(verifyReleaseManifest(edited, manifest).problems.join(" ")).toContain("does not match the reviewed checksum");

    const added = [...migrations, { name: "20261101000000_added", checksum: "a".repeat(64), sqlPath: "", sql: "" }];
    expect(verifyReleaseManifest(added, manifest).problems.join(" ")).toContain("not listed in the release manifest");

    const removed = migrations.filter((_, index) => index !== 0);
    expect(verifyReleaseManifest(removed, manifest).problems.join(" ")).toContain("no longer exists");

    expect(verifyReleaseManifest(migrations, null).problems.join(" ")).toContain("is missing");
  });

  it("builds a manifest from migration bytes using Prisma's checksum definition", () => {
    expect(sha256Hex(Buffer.from(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const rebuilt = buildReleaseManifest(migrations, { prismaVersion: "5.17.0" });
    expect(rebuilt.prismaVersion).toBe("5.17.0");
    expect(rebuilt.migrations[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("Prisma ledger compatibility", () => {
  it("creates the exact columns Prisma's migration engine expects", () => {
    for (const column of [
      '"id"',
      '"checksum"',
      '"finished_at"',
      '"migration_name"',
      '"logs"',
      '"rolled_back_at"',
      '"started_at"',
      '"applied_steps_count"',
    ]) {
      expect(PRISMA_LEDGER_DDL).toContain(column);
    }
    expect(PRISMA_LEDGER_DDL).toContain('"_prisma_migrations"');
    expect(PRISMA_LEDGER_DDL).toContain("IF NOT EXISTS");
  });
});

describe("schema checkpoints", () => {
  it("classifies each checkpoint's own feature map unambiguously", () => {
    for (const checkpoint of CHECKPOINTS) {
      const features = featuresFor(checkpoint.id);
      expect(evaluateCheckpoints(features), checkpoint.id).toEqual([checkpoint.id]);
      expect(checkpointMatches(checkpoint, features), checkpoint.id).toBe(true);
    }
  });

  it("reports an unrecognised state instead of guessing", () => {
    const features = featuresFor("saas_through_17");
    features.table_Subscription = false;
    features.column_Payment_requestFingerprint = true;
    expect(evaluateCheckpoints(features)).toEqual([]);
  });

  it("exports the SQL guard that mirrors each JavaScript predicate", () => {
    for (const checkpoint of CHECKPOINTS) {
      const sql = checkpointPredicateSql(checkpoint);
      if ((checkpoint.require ?? []).length === 0 && (checkpoint.forbid ?? []).length === 0) {
        expect(sql).toBe("true");
        continue;
      }
      const featureSql = SCHEMA_FEATURES as Record<string, string>;
      for (const name of checkpoint.require ?? []) expect(sql).toContain(featureSql[name]);
      for (const name of checkpoint.forbid ?? []) expect(sql).toContain(`NOT (${featureSql[name]})`);
    }
  });

  it("builds one SQL statement that returns every feature", () => {
    const sql = buildFeatureQuery();
    expect(sql.trim().startsWith("SELECT (json_build_object(")).toBe(true);
    for (const [name, predicate] of Object.entries(SCHEMA_FEATURES)) {
      expect(sql).toContain(`'${name}'`);
      expect(sql).toContain(predicate as string);
    }
    expect(describeCheckpoints()).toHaveLength(CHECKPOINTS.length);
  });

  it("only relies on features that survive the tenancy conversion", () => {
    // Migration 081 drops these indexes and migration 10 drops Room.isTwin, so
    // they may be forbidden but must never be required for a SaaS checkpoint.
    const excluded = ["index_Reservation_status_checkInDate", "column_Room_isTwin"];
    for (const checkpoint of CHECKPOINTS.filter((entry) => entry.id.startsWith("saas"))) {
      for (const name of excluded) expect(checkpoint.require ?? []).not.toContain(name);
    }
  });
});

describe("adoption planning", () => {
  const names = migrations.map((migration) => migration.name);

  it("baselines the whole chain and leaves everything pending on an empty database", () => {
    const plan = buildAdoptionPlan({ migrations, features: featuresFor("empty"), ledgerRows: [] });
    expect(plan.checkpoint?.id).toBe("empty");
    expect(plan.baseline).toEqual([]);
    expect(plan.pending).toEqual(names);
    expect(plan.problems).toEqual([]);
  });

  it("baselines 11 migrations for the legacy schema and leaves 8 pending", () => {
    const plan = buildAdoptionPlan({ migrations, features: featuresFor("legacy_single_hotel_through_11"), ledgerRows: [] });
    expect(plan.checkpoint?.id).toBe("legacy_single_hotel_through_11");
    expect(plan.baseline).toEqual(names.slice(0, 11));
    // Migration 12 is a data-only, idempotent tariff insert and is always
    // re-deployed rather than baselined (see the checkpoint comment).
    expect(plan.pending).toEqual(names.slice(11));
    expect(plan.problems).toEqual([]);
  });

  it("baselines 13 to 16 migrations for the intermediate SaaS states", () => {
    const expectations: Array<[string, number]> = [
      ["saas_through_081", 13],
      ["saas_through_14", 14],
      ["saas_through_15", 15],
      ["saas_through_16", 16],
    ];
    for (const [checkpoint, applied] of expectations) {
      const plan = buildAdoptionPlan({ migrations, features: featuresFor(checkpoint), ledgerRows: [] });
      expect(plan.checkpoint?.id, checkpoint).toBe(checkpoint);
      expect(plan.baseline.length, checkpoint).toBe(applied);
      expect(plan.pending, checkpoint).toEqual(names.slice(applied));
      expect(plan.problems, checkpoint).toEqual([]);
    }
  });

  it("baselines 17 migrations for an unmanaged SaaS database and leaves later ones pending", () => {
    const plan = buildAdoptionPlan({ migrations, features: featuresFor("saas_through_17"), ledgerRows: [] });
    expect(plan.checkpoint?.id).toBe("saas_through_17");
    expect(plan.baseline).toEqual(names.slice(0, 17));
    expect(plan.pending).toEqual([
      "20261029120000_add_pos_charge_to_room_idempotency",
      "20261029130000_add_tenant_composite_join_fks",
      "20261031120000_add_pricing_engine",
      "20261031160000_price_version_history",
      "20261101120000_add_reservation_extension_history",
      "20261104120000_inventory_request_ledger",
      "20261107120000_auth_rate_limit",
    ]);
    expect(plan.problems).toEqual([]);
  });

  it("baselines 19 migrations for a database that predates the pricing engine", () => {
    const plan = buildAdoptionPlan({ migrations, features: featuresFor("saas_through_19"), ledgerRows: [] });
    expect(plan.checkpoint?.id).toBe("saas_through_19");
    expect(plan.baseline).toEqual(names.slice(0, 19));
    expect(plan.pending).toEqual([
      "20261031120000_add_pricing_engine",
      "20261031160000_price_version_history",
      "20261101120000_add_reservation_extension_history",
      "20261104120000_inventory_request_ledger",
      "20261107120000_auth_rate_limit",
    ]);
    expect(plan.problems).toEqual([]);
  });

  it("baselines 20 migrations for a database whose pricing engine has no version history", () => {
    const plan = buildAdoptionPlan({ migrations, features: featuresFor("saas_through_20"), ledgerRows: [] });
    expect(plan.checkpoint?.id).toBe("saas_through_20");
    expect(plan.baseline).toEqual(names.slice(0, 20));
    expect(plan.pending).toEqual([
      "20261031160000_price_version_history",
      "20261101120000_add_reservation_extension_history",
      "20261104120000_inventory_request_ledger",
      "20261107120000_auth_rate_limit",
    ]);
    expect(plan.problems).toEqual([]);
  });

  it("keeps inventory migration pending for a pre-ledger database", () => {
    const plan = buildAdoptionPlan({ migrations, features: featuresFor("saas_through_22"), ledgerRows: [] });
    expect(plan.pending).toEqual(["20261104120000_inventory_request_ledger", "20261107120000_auth_rate_limit"]);
    expect(plan.problems).toEqual([]);
  });

  it("leaves the rate-limit migration pending after adopting the prior current schema", () => {
    const plan = buildAdoptionPlan({ migrations, features: featuresFor("saas_current"), ledgerRows: [] });
    expect(plan.baseline).toEqual(names.slice(0, 23));
    expect(plan.pending).toEqual(["20261107120000_auth_rate_limit"]);
    expect(plan.problems).toEqual([]);
  });

  it("is idempotent when the ledger already records the detected state", () => {
    const plan = buildAdoptionPlan({
      migrations,
      features: featuresFor("saas_through_17"),
      ledgerRows: ledgerRowsFor(names.slice(0, 17)),
    });
    expect(plan.baseline).toEqual([]);
    expect(plan.pending).toEqual(names.slice(17));
    expect(plan.problems).toEqual([]);
  });

  it("stops on an unrecognised schema", () => {
    const features = featuresFor("saas_current");
    features.fk_OrderItem_menuItem = false;
    const plan = buildAdoptionPlan({ migrations, features, ledgerRows: [] });
    expect(plan.checkpoint).toBeNull();
    expect(plan.problems.join(" ")).toContain("does not match any approved checkpoint");
  });

  it("stops on a checksum mismatch instead of re-baselining an edited migration", () => {
    const rows = ledgerRowsFor(names.slice(0, 17));
    rows[12] = { ...rows[12], checksum: "b".repeat(64) };
    const plan = buildAdoptionPlan({ migrations, features: featuresFor("saas_through_17"), ledgerRows: rows });
    expect(plan.problems.join(" ")).toContain("Checksum mismatch");
  });

  it("stops on ledger rows the repository does not know about", () => {
    const rows = [...ledgerRowsFor(names.slice(0, 5)), { ...ledgerRowsFor(names.slice(0, 1))[0], migration_name: "20990101000000_x" }];
    const plan = buildAdoptionPlan({ migrations, features: featuresFor("saas_through_17"), ledgerRows: rows });
    expect(plan.problems.join(" ")).toContain("not in prisma/migrations");
  });

  it("stops on a migration recorded as applied that the schema does not contain", () => {
    const rows = ledgerRowsFor(names.slice(0, 17));
    const plan = buildAdoptionPlan({ migrations, features: featuresFor("saas_through_17"), ledgerRows: rows });
    expect(plan.problems).toEqual([]);

    const ahead = buildAdoptionPlan({
      migrations,
      features: featuresFor("saas_through_17"),
      ledgerRows: ledgerRowsFor(names.slice(0, 18)),
    });
    expect(ahead.problems.join(" ")).toContain("does not contain its effects");
  });

  it("stops on an unfinished or failed ledger row", () => {
    const rows = ledgerRowsFor(names.slice(0, 17));
    rows[3] = { ...rows[3], finished_at: null };
    const plan = buildAdoptionPlan({ migrations, features: featuresFor("saas_through_17"), ledgerRows: rows });
    expect(plan.problems.join(" ")).toContain("started but not finished");
  });

  it("stops on gaps in the recorded history", () => {
    const rows = ledgerRowsFor(names.slice(0, 17)).filter((row) => row.migration_name !== names[5]);
    const plan = buildAdoptionPlan({ migrations, features: featuresFor("saas_through_17"), ledgerRows: rows });
    expect(plan.problems.join(" ")).toContain("has gaps");
  });

  it("stops on duplicate ledger rows", () => {
    const rows = ledgerRowsFor(names.slice(0, 17));
    rows.push({ ...rows[0] });
    const plan = buildAdoptionPlan({ migrations, features: featuresFor("saas_through_17"), ledgerRows: rows });
    expect(plan.problems.join(" ")).toContain("duplicate rows");
  });
});

describe("migration sources", () => {
  it("contains no proposal-only wording in a released migration", () => {
    for (const migration of migrations) {
      const sql = fs.readFileSync(migration.sqlPath, "utf8");
      expect(sql, migration.name).not.toMatch(/PROPOSAL ONLY/i);
    }
  });

  it("keeps the tenant join-key migration fail-closed and re-runnable", () => {
    const sql = fs.readFileSync(
      path.join("prisma", "migrations", "20261029130000_add_tenant_composite_join_fks", "migration.sql"),
      "utf8"
    );
    const firstPrecheck = sql.indexOf("Tenant-integrity precheck failed");
    const firstDdl = sql.indexOf("ALTER TABLE");
    expect(firstPrecheck).toBeGreaterThan(-1);
    expect(firstPrecheck).toBeLessThan(firstDdl);
    expect(sql).toContain("IF NOT EXISTS");
    expect(sql).toContain("DROP CONSTRAINT IF EXISTS");
  });

  it("documents the charge-to-room idempotency guard", () => {
    const sql = fs.readFileSync(
      path.join("prisma", "migrations", "20261029120000_add_pos_charge_to_room_idempotency", "migration.sql"),
      "utf8"
    );
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS "Order_hotelId_idempotencyOperation_idempotencyKey_key"');
    expect(sql).toContain('CONSTRAINT "Order_idempotency_triple_check"');
  });
});

describe("line-ending independence (Windows/Linux checkouts)", () => {
  /**
   * Git stores migration SQL as LF and `.gitattributes` keeps it that way, but a
   * Windows working copy cloned under `core.autocrlf=true` can still hold CRLF.
   * Prisma checksums raw bytes, so that checkout must not corrupt the reviewed
   * digests — and it must never be used to write ledger rows either.
   */
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "migration-eol-"));
  const lfSql = 'CREATE TABLE "Widget" (\n  "id" TEXT PRIMARY KEY\n);\n';
  const crlfSql = lfSql.replace(/\n/g, "\r\n");

  const lfDir = path.join(root, "20260101000000_lf");
  const crlfDir = path.join(root, "20260102000000_crlf");
  fs.mkdirSync(lfDir, { recursive: true });
  fs.mkdirSync(crlfDir, { recursive: true });
  fs.writeFileSync(path.join(lfDir, "migration.sql"), lfSql);
  fs.writeFileSync(path.join(crlfDir, "migration.sql"), crlfSql);

  it("reports the same reviewed digest for LF and CRLF copies of the same file", () => {
    const entries = readMigrations(root);
    expect(entries.map((entry: { name: string }) => entry.name)).toEqual([
      "20260101000000_lf",
      "20260102000000_crlf",
    ]);

    const [lf, crlf] = entries;
    expect(lf.hasCrlfEol).toBe(false);
    expect(crlf.hasCrlfEol).toBe(true);
    expect(lf.checksum).toBe(sha256Hex(Buffer.from(lfSql)));
    expect(crlf.checksum).toBe(lf.checksum);
    // The raw bytes still have their own digest: this is what Prisma would record
    // if it deployed from the CRLF checkout.
    expect(crlf.onDiskChecksum).toBe(sha256Hex(Buffer.from(crlfSql)));
    expect(crlf.onDiskChecksum).not.toBe(crlf.checksum);
  });

  it("passes the manifest check for a CRLF checkout but warns instead of staying silent", () => {
    const entries = readMigrations(root);
    const manifest = buildReleaseManifest(entries, { prismaVersion: "5.17.0" });
    expect(manifest.migrations.map((entry: { sha256: string }) => entry.sha256)).toEqual([
      sha256Hex(Buffer.from(lfSql)),
      sha256Hex(Buffer.from(lfSql)),
    ]);

    const result = verifyReleaseManifest(entries, manifest);
    expect(result.problems).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("20260102000000_crlf");
    expect(result.warnings[0]).toContain("CRLF");
  });

  it("still flags real edits and additions, CRLF or not", () => {
    const entries = readMigrations(root).map((entry) => ({ ...entry, checksum: "0".repeat(64) }));
    const manifest = buildReleaseManifest(readMigrations(root));
    expect(verifyReleaseManifest(entries, manifest).problems).toHaveLength(2);
  });

  it("refuses to check a CRLF tree into a ledger", () => {
    expect(() => assertLfMigrationFiles(readMigrations(root))).toThrow(/CRLF line endings/);
    // The LF-only tree is accepted.
    const lfOnly = fs.mkdtempSync(path.join(os.tmpdir(), "migration-eol-"));
    fs.mkdirSync(path.join(lfOnly, "20260101000000_lf"), { recursive: true });
    fs.writeFileSync(path.join(lfOnly, "20260101000000_lf", "migration.sql"), lfSql);
    expect(() => assertLfMigrationFiles(readMigrations(lfOnly))).not.toThrow();
  });

  it("holds for the repository itself, whatever this checkout's line endings are", () => {
    const result = verifyReleaseManifest(readMigrations(), readReleaseManifest());
    expect(result.problems).toEqual([]);
  });
});
