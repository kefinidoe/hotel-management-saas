import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { validateFinancialMutation, validateIdempotencyKey } from "@/lib/financial-mutation-validation";

const reversalSchema = z.strictObject({ reason: z.string().trim().min(5).max(2000), idempotencyKey: z.string().trim().min(4).max(128) });
class ReversalError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;
  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;
  const blocked = await requireModule(tenant.hotelId, "FOLIOS");
  if (blocked) return blocked;
  const parsed = await validateFinancialMutation(req, reversalSchema, { id });
  if (parsed.response) return parsed.response;
  const reason = parsed.data.reason.trim();
  const key = parsed.data.idempotencyKey.trim();
  const invalidKey = validateIdempotencyKey(key, "payment");
  if (invalidKey) return invalidKey;
  const hotelId = tenant.hotelId;
  const fingerprint = createHash("sha256").update(JSON.stringify({ scope: "payment-reversal-v1", hotelId, id, reason })).digest("hex");

  try {
    const result = await prisma.$transaction(async (tx) => {
      const lockKey = `hotel-${hotelId}-reservation-create`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked`;
      const original = await tx.payment.findUnique({ where: { id_hotelId: { id, hotelId } }, include: { folio: true } });
      if (!original) throw new ReversalError("Payment not found.", 404);
      const priorKey = await tx.payment.findUnique({ where: { hotelId_idempotencyKey: { hotelId, idempotencyKey: key } } });
      if (priorKey) {
        if (priorKey.requestFingerprint !== fingerprint || priorKey.reversalOfId !== original.id) {
          throw new ReversalError("Idempotency key was previously used for a different request.", 409);
        }
        return { id: priorKey.id, replay: true, folioId: original.folioId, closed: original.folio.isClosed };
      }
      if (original.reversalOfId || original.amount.lte(0) || original.status !== "COMPLETED") {
        throw new ReversalError("Only an original completed payment can be reversed.", 409);
      }
      const existing = await tx.payment.findFirst({ where: { hotelId, reversalOfId: original.id }, select: { id: true } });
      if (existing) throw new ReversalError("This payment has already been reversed.", 409);
      const sum = await tx.payment.aggregate({ where: { hotelId, folioId: original.folioId, status: "COMPLETED" }, _sum: { amount: true } });
      const paid = sum._sum.amount ?? new Prisma.Decimal(0);
      const paidAfter = paid.minus(original.amount);
      if (paidAfter.lt(0)) throw new ReversalError("This reversal would make the total paid negative.", 409);
      const charges = await tx.folioItem.aggregate({ where: { folioId: original.folioId, folio: { hotelId } }, _sum: { total: true } });
      const balanceAfter = (charges._sum.total ?? new Prisma.Decimal(0)).minus(paidAfter);
      const reversed = await tx.payment.create({ data: {
        hotelId, folioId: original.folioId, paymentMethodId: original.paymentMethodId,
        amount: original.amount.negated(), reference: null, reversalOfId: original.id,
        reversalReason: reason, idempotencyKey: key, requestFingerprint: fingerprint,
        status: "COMPLETED", cashierId: tenant.userId,
      } });
      await recordAudit({ hotelId, userId: tenant.userId, action: "PAYMENT_REVERSED", entity: "Payment", entityId: reversed.id,
        metadata: { originalPaymentId: original.id, folioId: original.folioId, reason, amount: reversed.amount.toFixed(2), folioWasClosed: original.folio.isClosed, balanceAfter: balanceAfter.toFixed(2) } }, tx, { strict: true });
      return { id: reversed.id, replay: false, folioId: original.folioId, closed: original.folio.isClosed };
    }, { isolationLevel: "Serializable", timeout: 10_000 });
    return NextResponse.json(result, { status: result.replay ? 200 : 201 });
  } catch (error) {
    if (error instanceof ReversalError) return NextResponse.json({ error: error.message }, { status: error.status });
    if (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code)) {
      return NextResponse.json({ error: "The payment changed or was reversed concurrently. Refresh and retry using the same idempotency key." }, { status: 409 });
    }
    console.error("Payment reversal failed:", error);
    return NextResponse.json({ error: "Could not reverse the payment." }, { status: 500 });
  }
}
