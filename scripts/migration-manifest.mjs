#!/usr/bin/env node
/**
 * Read-only inventory of Prisma migration source files and their local Git state.
 * It never reads database configuration, executes SQL, or infers database history.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrationsRoot = path.join(repoRoot, "prisma", "migrations");
const historicalMigration = "20261008123000_multi_tenant_saas_init";
const proposalMigrations = new Set([
  "20261027100000_add_membership_department",
  "20261029120000_add_pos_charge_to_room_idempotency",
  "20261029130000_add_tenant_composite_join_fks",
]);

function gitLines(args) {
  return execFileSync("git", ["--no-optional-locks", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trimEnd().split("\n").filter(Boolean);
}

const trackedPaths = new Set(gitLines(["ls-files", "--", "prisma/migrations"]));
const gitStatusByPath = new Map();
for (const line of gitLines(["status", "--porcelain=v1", "--untracked-files=all", "--", "prisma/migrations"])) {
  const statusCode = line.slice(0, 2);
  const filePath = line.slice(3);
  gitStatusByPath.set(filePath, statusCode);
}

const migrationDirectories = fs.readdirSync(migrationsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const trackedMigrationDirectories = new Set(
  [...trackedPaths]
    .filter((filePath) => /^prisma\/migrations\/[^/]+\/migration\.sql$/.test(filePath))
    .map((filePath) => filePath.split("/")[2]),
);

const migrations = migrationDirectories.map((directory) => {
  const relativeSqlPath = `prisma/migrations/${directory}/migration.sql`;
  const absoluteSqlPath = path.join(repoRoot, relativeSqlPath);
  const migrationSqlPresent = fs.existsSync(absoluteSqlPath) && fs.statSync(absoluteSqlPath).isFile();
  const isTracked = trackedPaths.has(relativeSqlPath);
  const rawGitStatus = gitStatusByPath.get(relativeSqlPath) ?? "";
  const worktreeStatus = !migrationSqlPresent && isTracked
    ? "deleted"
    : rawGitStatus === "??"
      ? "untracked"
      : rawGitStatus.trim()
        ? "modified"
        : "clean";

  let sourceClassification = "tracked_migration";
  if (proposalMigrations.has(directory)) sourceClassification = "proposal";
  else if (directory === historicalMigration && worktreeStatus !== "clean") {
    sourceClassification = "modified_historical_migration";
  } else if (!isTracked) sourceClassification = "untracked_migration";

  return {
    directory,
    migrationSqlPresent,
    tracked: isTracked,
    worktreeStatus,
    sourceClassification,
    databaseApplicationStatus: "UNKNOWN",
  };
});

const manifest = {
  scope: "repository source and local Git metadata only",
  databaseConnected: false,
  sqlExecuted: false,
  migrationLedgerStatus: "UNKNOWN — no database evidence inspected",
  databaseApplicationStatus: "UNKNOWN — source files do not establish target state",
  migrationDirectoryCount: migrationDirectories.length,
  missingMigrationSql: migrations.filter((entry) => !entry.migrationSqlPresent).map((entry) => entry.directory),
  missingTrackedMigrationDirectories: [...trackedMigrationDirectories]
    .filter((directory) => !migrationDirectories.includes(directory))
    .sort(),
  migrations,
};

process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
