import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { assertDisposableDatabaseSafety } from "@/lib/db-safety-guard";

// The suite only runs inside a source copy beneath an explicitly marked cluster.
// Its child processes receive a complete, test-owned environment, never an
// ambient database URL or production settings.
const root = path.resolve(process.cwd(), "..");
const suite = existsSync(path.join(root, "DISPOSABLE")) ? describe : describe.skip;
const databaseUrl = "postgresql://postgres@127.0.0.1:55434/hotel_saas_disposable_audit";

type Pg = { connect(): Promise<void>; end(): Promise<void>; query(sql: string): Promise<{ rows: Array<{ data_directory: string; count: string }> }> };
const { Client } = require("pg") as { Client: new (config: { host: string; port: number; database: string; user: string }) => Pg };

function assertMarkedListener() {
  if (readFileSync(path.join(root, "DISPOSABLE"), "utf8").trim() !== "DISPOSABLE_HOTEL_SAAS_ONLY") throw new Error("REFUSED: missing disposable marker");
  const pidFile = readFileSync(path.join(root, "pgdata/postmaster.pid"), "utf8").split("\n");
  const pid = Number(pidFile[0]);
  if (!Number.isSafeInteger(pid) || pid < 1 || pidFile[1] !== path.join(root, "pgdata") || pidFile[3] !== "55434") throw new Error("REFUSED: postmaster identity mismatch");
  const row = readFileSync("/proc/net/tcp", "utf8").split("\n").map((line) => line.trim().split(/\s+/)).find((fields) => fields[1] === "0100007F:D88A" && fields[3] === "0A");
  if (!row) throw new Error("REFUSED: no verified loopback listener");
  const sockets = readdirSync(`/proc/${pid}/fd`).flatMap((fd) => {
    try { return [readlinkSync(`/proc/${pid}/fd/${fd}`)]; } catch { return []; }
  });
  if (!sockets.includes(`socket:[${row[9]}]`)) throw new Error("REFUSED: listener not owned by marked postmaster");
}

function setEnv(markerRoot = root) {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SAAS_ENVIRONMENT", "saas");
  vi.stubEnv("SAAS_DATABASE_IDENTIFIER", "hotel_saas_disposable_audit");
  vi.stubEnv("DATABASE_URL", databaseUrl);
  vi.stubEnv("DIRECT_URL", databaseUrl);
  vi.stubEnv("DISPOSABLE_DATABASE_ROOT", markerRoot);
}

function runCli(markerRoot: string, hotelId: string) {
  return spawnSync(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/clean-test-data.ts", "--hotel-id", hotelId, "--confirm-hotel-id", hotelId], {
    cwd: process.cwd(), encoding: "utf8", timeout: 30_000,
    env: {
      PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "/tmp", NODE_ENV: "test",
      SAAS_ENVIRONMENT: "saas", SAAS_DATABASE_IDENTIFIER: "hotel_saas_disposable_audit",
      DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl, DISPOSABLE_DATABASE_ROOT: markerRoot,
      PRISMA_QUERY_ENGINE_LIBRARY: path.resolve("node_modules/.prisma/client/libquery_engine.so.node"),
    },
  });
}

suite("disposable-only cleanup on real PostgreSQL", () => {
  beforeAll(async () => {
    assertMarkedListener();
    const db = new Client({ host: root, port: 55434, database: "hotel_saas_disposable_audit", user: "postgres" });
    await db.connect();
    try {
      const result = await db.query("SHOW data_directory");
      expect(result.rows[0].data_directory).toBe(path.join(root, "pgdata"));
    } finally { await db.end(); }
  });

  afterEach(() => { vi.unstubAllEnvs(); });

  it("accepts only the explicitly marked local target in the safety preflight", () => {
    setEnv();
    const target = assertDisposableDatabaseSafety();
    expect(target.database).toBe("hotel_saas_disposable_audit");
    expect(target.dataDirectory).toBe(path.join(root, "pgdata"));
    expect(lstatSync(path.join(root, "DISPOSABLE")).isFile()).toBe(true);
  });

  it("refuses missing markers, non-disposable databases, and production mode", () => {
    setEnv(path.join(root, "no-such-disposable-marker"));
    expect(() => assertDisposableDatabaseSafety()).toThrow(/disposable marker/i);
    setEnv();
    vi.stubEnv("DATABASE_URL", "postgresql://postgres@127.0.0.1:55434/ordinary_hotel");
    vi.stubEnv("DIRECT_URL", "postgresql://postgres@127.0.0.1:55434/ordinary_hotel");
    vi.stubEnv("SAAS_DATABASE_IDENTIFIER", "ordinary_hotel");
    expect(() => assertDisposableDatabaseSafety()).toThrow(/explicitly named disposable/i);
    setEnv();
    vi.stubEnv("NODE_ENV", "production");
    expect(() => assertDisposableDatabaseSafety()).toThrow(/local-only/i);
    setEnv();
    vi.stubEnv("DIRECT_URL", "postgresql://postgres@127.0.0.1:55435/hotel_saas_disposable_audit");
    expect(() => assertDisposableDatabaseSafety()).toThrow(/same local server/i);
  });

  it("rejects a marker whose pgdata entry is a symlink", () => {
    const fakeRoot = mkdtempSync(path.join(root, "symlink-disposable-marker-"));
    try {
      writeFileSync(path.join(fakeRoot, "DISPOSABLE"), "DISPOSABLE_HOTEL_SAAS_ONLY\n");
      symlinkSync(path.join(root, "pgdata"), path.join(fakeRoot, "pgdata"), "dir");
      setEnv(fakeRoot);
      expect(() => assertDisposableDatabaseSafety()).toThrow(/valid disposable marker/i);
    } finally { rmSync(fakeRoot, { recursive: true, force: true }); }
  });

  it("runs the guarded CLI against the real disposable cluster but refuses a nonexistent hotel before any deletion", () => {
    const result = runCli(root, randomUUID());
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("The confirmed hotel ID does not exist");
    expect(result.stdout).not.toContain("Cleanup transaction committed");
  }, 30_000);

  it("refuses a forged marker whose data directory is not the connected disposable server", () => {
    const fakeRoot = mkdtempSync(path.join(root, "wrong-disposable-marker-"));
    try {
      writeFileSync(path.join(fakeRoot, "DISPOSABLE"), "DISPOSABLE_HOTEL_SAAS_ONLY\n");
      mkdirSync(path.join(fakeRoot, "pgdata"));
      const result = runCli(fakeRoot, randomUUID());
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("connected PostgreSQL identity is not the marked disposable cluster");
      expect(result.stdout).not.toContain("Cleanup transaction committed");
    } finally { rmSync(fakeRoot, { recursive: true, force: true }); }
  }, 30_000);
});
