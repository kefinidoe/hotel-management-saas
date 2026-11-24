import { describe, expect, it, vi } from "vitest";
import { probeAuditRollback } from "../../scripts/native-engine-audit-probe.mjs";

describe("native engine append-only audit probe", () => {
  it("inserts and reads inside a transaction, rolls back, then checks no row remains", async () => {
    const create = vi.fn().mockResolvedValue({ id: "probe-id" });
    const read = vi.fn().mockResolvedValue({ id: "probe-id", entityId: "probe" });
    const outside = vi.fn().mockResolvedValue(null);
    const prisma = {
      auditLog: { findUnique: outside },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ auditLog: { create, findUnique: read } }),
    };
    await expect(probeAuditRollback(prisma, "probe")).resolves.toBe(true);
    expect(create).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledWith({ where: { id: "probe-id" } });
    expect(outside).toHaveBeenCalledWith({ where: { id: "probe-id" } });
  });

  it("does not mistake an unrelated database failure containing rollback for success", async () => {
    const error = new Error("rollback failed: database unavailable");
    const prisma = { auditLog: { findUnique: vi.fn() }, $transaction: async () => { throw error; } };
    await expect(probeAuditRollback(prisma, "probe")).rejects.toBe(error);
  });

  it("fails if the row is still visible after the rollback", async () => {
    const prisma = {
      auditLog: { findUnique: vi.fn().mockResolvedValue({ id: "probe-id" }) },
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ auditLog: {
        create: vi.fn().mockResolvedValue({ id: "probe-id" }),
        findUnique: vi.fn().mockResolvedValue({ id: "probe-id", entityId: "probe" }),
      } }),
    };
    await expect(probeAuditRollback(prisma, "probe")).resolves.toBe(false);
  });
});
