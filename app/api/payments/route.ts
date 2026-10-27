import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { folioTotals, parseMoney, roundMoney } from "@/lib/billing";

class PaymentError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.ACCOMMODATION_PAYMENTS);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

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

  if (idempotencyKey !== undefined && (idempotencyKey.length < 4 || idempotencyKey.length > 128)) {
    return NextResponse.json(
      { error: "Idempotency key must be between 4 and 128 characters." },
      { status: 400 }
    );
  }

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
            // Verify payment parameters match original request
            const sameFolio = existingPayment.folioId === folioId;
            const sameMethod = existingPayment.paymentMethodId === paymentMethodId;
            const sameAmount = Math.abs(Number(existingPayment.amount) - amount) < 0.001;

            if (!sameFolio || !sameMethod || !sameAmount) {
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

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof PaymentError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
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
