import { validateIdempotencyKey, validateFinancialMutation, paymentSchema } from "@/lib/financial-mutation-validation";
import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { folioTotals, parseMoney, roundMoney } from "@/lib/billing";

class PaymentError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

type PaymentRequest = {
  hotelId: string;
  folioId: string;
  paymentMethodId: string;
  amount: number;
  reference: string;
};

function paymentRequestFingerprint(request: PaymentRequest): string {
  // Use a domain/version marker so this cannot be mistaken for the restaurant
  // POS fingerprint stored in the shared Payment.requestFingerprint column.
  const canonical = {
    scope: "accommodation-payment-v1",
    hotelId: request.hotelId,
    folioId: request.folioId,
    paymentMethodId: request.paymentMethodId,
    amount: request.amount.toFixed(2),
    reference: request.reference || null,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function isSamePaymentRequest(
  existing: {
    folioId: string;
    paymentMethodId: string;
    amount: unknown;
    reference: string | null;
    requestFingerprint?: string | null;
  },
  request: PaymentRequest,
  fingerprint: string,
): boolean {
  if (existing.requestFingerprint) return existing.requestFingerprint === fingerprint;

  // Compatibility for accommodation payments created before fingerprints were
  // written: compare every field represented by this endpoint's payload.
  return (
    existing.folioId === request.folioId &&
    existing.paymentMethodId === request.paymentMethodId &&
    Math.abs(Number(existing.amount) - request.amount) < 0.001 &&
    (existing.reference ?? null) === (request.reference || null)
  );
}

export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  // A stale client may reject a tenant-context switch, but cannot select the
  // authorized tenant. All ownership and queries remain session-derived.
  const expectedTenantId = req.headers.get("x-expected-hotel-id");
  if (expectedTenantId && expectedTenantId !== tenant.hotelId) {
    return NextResponse.json(
      { error: "The active hotel changed. Refresh the folio before retrying this saved payment.", code: "TENANT_CONTEXT_MISMATCH", outcome: "UNKNOWN" },
      { status: 409 },
    );
  }

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.ACCOMMODATION_PAYMENTS);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "FOLIOS");
  if (blocked) return blocked;

  const hotelId = tenant.hotelId;

  const validation = await validateFinancialMutation(req, paymentSchema, {});
  if (validation.response) return validation.response;
  const body = validation.data;

  const folioId = typeof body?.folioId === "string" ? body.folioId.trim() : "";
  const paymentMethodId =
    typeof body?.paymentMethodId === "string" ? body.paymentMethodId.trim() : "";
  const reference = typeof body?.reference === "string" ? body.reference.trim() : "";

  if (!folioId || !paymentMethodId) {
    return NextResponse.json(
      { error: "Folio and payment method are required." },
      { status: 400 }
    );
  }

  let amount: number;
  try {
    amount = parseMoney(body?.amount, "Payment amount");
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Payment amount is invalid." },
      { status: 400 }
    );
  }

  const rawIdempotencyKey =
    req.headers.get("x-idempotency-key") ||
    req.headers.get("idempotency-key") ||
    (typeof body?.idempotencyKey === "string" ? body.idempotencyKey : undefined);

  const idempotencyKey =
    typeof rawIdempotencyKey === "string" ? rawIdempotencyKey.trim() : undefined;

  const invalidKey = validateIdempotencyKey(idempotencyKey, "payment");
  if (invalidKey) return invalidKey;

  const paymentRequest: PaymentRequest = {
    hotelId,
    folioId,
    paymentMethodId,
    amount,
    reference,
  };
  const requestFingerprint = paymentRequestFingerprint(paymentRequest);

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        // Coordinated per-hotel advisory lock across stay and financial operations
        const lockKey = `hotel-${hotelId}-reservation-create`;
        await tx.$queryRaw<Array<{ locked: string }>>`
          SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked
        `;

        const folio = await tx.folio.findUnique({
          where: { id_hotelId: { id: folioId, hotelId } },
          include: {
            items: { select: { total: true } },
            payments: {
              where: { hotelId, status: "COMPLETED" },
              select: { id: true, amount: true, paymentMethodId: true, idempotencyKey: true },
            },
          },
        });
        if (!folio) throw new PaymentError("Folio not found.", 404);

        // Check if a payment with this idempotency key already exists for this hotel
        if (idempotencyKey) {
          const existingPayment = await tx.payment.findUnique({
            where: {
              hotelId_idempotencyKey: {
                hotelId,
                idempotencyKey,
              },
            },
          });

          if (existingPayment) {
            if (!isSamePaymentRequest(existingPayment, paymentRequest, requestFingerprint)) {
              throw new PaymentError(
                "Idempotency key was previously used with different payment details.",
                409
              );
            }

            // Return original recorded result without creating duplicate payment
            const totals = folioTotals(
              folio.items.map((item) => Number(item.total)),
              folio.payments.map((payment) => Number(payment.amount))
            );

            return {
              id: existingPayment.id,
              required: totals.required,
              paid: totals.paid,
              balance: totals.balance,
              isIdempotentReplay: true,
            };
          }
        }

        if (folio.isClosed) throw new PaymentError("Payments cannot be added to a closed folio.");

        const method = await tx.paymentMethod.findUnique({
          where: { id_hotelId: { id: paymentMethodId, hotelId } },
        });
        if (!method || !method.isActive) {
          throw new PaymentError("That payment method is unavailable in this hotel.", 400);
        }

        const totals = folioTotals(
          folio.items.map((item) => Number(item.total)),
          folio.payments.map((payment) => Number(payment.amount))
        );
        if (totals.balance <= 0) {
          throw new PaymentError("This folio has no outstanding balance.");
        }
        if (amount > totals.balance) {
          throw new PaymentError(
            `Payment cannot exceed the outstanding balance of KSh ${totals.balance.toLocaleString()}.`
          );
        }

        const payment = await tx.payment.create({
          data: {
            hotelId,
            folioId,
            paymentMethodId: method.id,
            amount,
            reference: reference || null,
            idempotencyKey: idempotencyKey || null,
            requestFingerprint: idempotencyKey ? requestFingerprint : null,
            status: "COMPLETED",
            cashierId: tenant.userId,
          },
        });

        return {
          id: payment.id,
          required: totals.required,
          paid: roundMoney(totals.paid + amount),
          balance: roundMoney(totals.balance - amount),
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 10_000,
      }
    );

    await recordAudit({
      hotelId,
      userId: tenant.userId,
      action: "PAYMENT_RECORDED",
      entity: "Payment",
      entityId: result.id,
      metadata: { folioId: body.folioId, amount: result.paid, reference: body.reference ?? null },
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof PaymentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        if (idempotencyKey) {
          try {
            // The transaction that lost the unique-key race has rolled back.
            // Resolve the winner outside that transaction and replay only when
            // the complete request fingerprint matches.
            const winner = await prisma.payment.findUnique({
              where: { hotelId_idempotencyKey: { hotelId, idempotencyKey } },
            });
            if (winner) {
              if (!isSamePaymentRequest(winner, paymentRequest, requestFingerprint)) {
                return NextResponse.json(
                  { error: "Idempotency key was previously used with different payment details." },
                  { status: 409 }
                );
              }

              const winnerFolio = await prisma.folio.findUnique({
                where: { id_hotelId: { id: folioId, hotelId } },
                include: {
                  items: { select: { total: true } },
                  payments: { where: { hotelId, status: "COMPLETED" }, select: { amount: true } },
                },
              });
              if (winnerFolio) {
                const totals = folioTotals(
                  winnerFolio.items.map((item) => Number(item.total)),
                  winnerFolio.payments.map((payment) => Number(payment.amount))
                );
                return NextResponse.json(
                  {
                    id: winner.id,
                    required: totals.required,
                    paid: totals.paid,
                    balance: totals.balance,
                    isIdempotentReplay: true,
                  },
                  { status: 201 }
                );
              }
            }
          } catch (lookupError) {
            console.error("Failed to resolve payment idempotency race:", lookupError);
          }
        }
        return NextResponse.json(
          { error: "A payment with this idempotency key was submitted concurrently. Refresh and verify." },
          { status: 409 }
        );
      }
      if (error.code === "P2034") {
        return NextResponse.json(
          { error: "The folio changed while recording payment. Refresh and try again." },
          { status: 409 }
        );
      }
    }
    console.error("Payment recording failed:", error);
    return NextResponse.json({ error: "Could not record the payment." }, { status: 500 });
  }
}
