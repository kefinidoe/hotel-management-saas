/** Exercise audit insert/read in a transaction which must be rolled back.
 * Never delete or update an audit record: append-only protection rejects both.
 */
export async function probeAuditRollback(prisma, probe) {
  const rollback = new Error("Intentional native engine probe rollback");
  let createdId;
  try {
    await prisma.$transaction(async (tx) => {
      const created = await tx.auditLog.create({
        data: { action: "NATIVE_ENGINE_PROBE", entity: "SYSTEM", entityId: probe, metadata: { probe } },
      });
      createdId = created.id;
      const read = await tx.auditLog.findUnique({ where: { id: createdId } });
      if (!read || read.entityId !== probe) throw new Error("Probe audit row could not be read inside the transaction.");
      throw rollback;
    });
    return false; // The rollback signal must not be swallowed by the transaction implementation.
  } catch (error) {
    if (error !== rollback) throw error;
  }
  if (!createdId) return false;
  // A successful rollback must leave no probe row behind.
  return (await prisma.auditLog.findUnique({ where: { id: createdId } })) === null;
}
