import { validateIdempotencyKey, validateFinancialMutation, payNowSchema } from "@/lib/financial-mutation-validation";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { paymentReferenceExists } from "@/lib/payment-reference";
import {
  cartTotal,
  computePosFingerprint,
  type CartLine,
  readCartRequest,
  resolveCartLines,
  round2,
} from "@/lib/restaurant";
import { deductRecipeStock } from "@/lib/recipe-stock";
import { syncLowStockAlerts } from "@/lib/notifications";

const WALK_IN_GUEST = "Walk-in Guest";

class PosNotCommittedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosNotCommittedError";
  }
}

class PosIdempotencyError extends Error {
  constructor(
    message: string,
    readonly status = 409,
    readonly code = "IDEMPOTENCY_CONFLICT"
  ) {
    super(message);
  }
}

function isPaymentIdempotencyConstraint(target: unknown): boolean {
  if (!target) return false;

  if (Array.isArray(target)) {
    if (target.length === 1 && typeof target[0] === "string") {
      return isPaymentIdempotencyConstraint(target[0]);
    }
    const normalized = target.map((field) =>
      typeof field === "string" ? field.toLowerCase().replace(/[^a-z0-9]/g, "") : ""
    );
    const hasHotel = normalized.includes("hotelid");
    const hasIdempotency = normalized.includes("idempotencykey");
    return hasHotel && hasIdempotency;
  }

  if (typeof target === "string") {
    const normalized = target.toLowerCase().replace(/[^a-z0-9]/g, "");
    const hasHotel = normalized.includes("hotelid");
    const hasIdempotency = normalized.includes("idempotencykey");
    return hasHotel && hasIdempotency;
  }

  return false;
}

export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  // This is only a stale-client consistency guard. Authorization and tenant
  // selection remain derived exclusively from the authenticated request context.
  const expectedTenantId = req.headers.get("x-expected-hotel-id");
  if (expectedTenantId && expectedTenantId !== tenant.hotelId) {
    return NextResponse.json(
      { error: "The active hotel changed. Refresh the POS before retrying this saved attempt.", code: "TENANT_CONTEXT_MISMATCH", outcome: "UNKNOWN" },
      { status: 409 },
    );
  }

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.RESTAURANT_POS);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  // Enforce SaaS Subscription Plan Module Entitlement
  const blocked = await requireModule(tenant.hotelId, "RESTAURANT_POS");
  if (blocked) return blocked;

  const validation = await validateFinancialMutation(req, payNowSchema, { pos: true });
  if (validation.response) return validation.response;
  const body = validation.data;

  const rawIdempotencyKey =
    req.headers.get("x-idempotency-key") ||
    req.headers.get("idempotency-key") ||
    (typeof body?.idempotencyKey === "string" ? body.idempotencyKey : undefined);

  const idempotencyKey =
    typeof rawIdempotencyKey === "string" ? rawIdempotencyKey.trim() : "";

  const invalidKey = validateIdempotencyKey(idempotencyKey, "pos");
  if (invalidKey) return invalidKey;

  const paymentMethodId: string | undefined =
    typeof body?.paymentMethodId === "string" ? body.paymentMethodId.trim() : undefined;
  const customerName = typeof body?.customerName === "string" ? body.customerName.trim() : "";
  const customerPhone = typeof body?.customerPhone === "string" ? body.customerPhone.trim() : "";
  const reference = typeof body?.reference === "string" ? body.reference.trim() : "";
  const tableNumber = typeof body?.tableNumber === "string" ? body.tableNumber.trim() : "";

  if (!paymentMethodId) {
    return NextResponse.json({ error: "Choose how the guest is paying.", code: "MISSING_PAYMENT_METHOD", outcome: "NOT_COMMITTED" }, { status: 400 });
  }

  let requestedItems: ReturnType<typeof readCartRequest>;
  try {
    requestedItems = readCartRequest(body.items);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The order is invalid.", code: "INVALID_ORDER_ITEMS", outcome: "NOT_COMMITTED" },
      { status: 400 }
    );
  }
  if (requestedItems.length === 0) {
    return NextResponse.json({ error: "Add at least one item to the order.", code: "EMPTY_ORDER", outcome: "NOT_COMMITTED" }, { status: 400 });
  }

  const fingerprint = computePosFingerprint({
    hotelId,
    items: requestedItems,
    paymentMethodId,
    customerName,
    customerPhone,
    tableNumber,
    reference,
  });

  const successBody = (result: Record<string, unknown>) => ({
    ...result,
    ok: true,
    hotelId,
    operation: "PAY_NOW" as const,
    idempotencyKey,
    requestFingerprint: fingerprint,
  });

  const prefix = tableNumber ? `Restaurant (Table ${tableNumber})` : "Restaurant";

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        // Coordinated per-hotel advisory lock across stay and financial operations
        const lockKey = `hotel-${hotelId}-reservation-create`;
        await tx.$queryRaw<Array<{ locked: string }>>`
          SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked
        `;

        // Check if an existing payment with this idempotency key already exists for this hotel
        const existingPayment = await tx.payment.findUnique({
          where: {
            hotelId_idempotencyKey: {
              hotelId,
              idempotencyKey,
            },
          },
          include: {
            folio: { include: { guest: true } },
            paymentMethod: true,
          },
        });

        if (existingPayment) {
          if (existingPayment.requestFingerprint === fingerprint) {
            return {
              guestName: existingPayment.folio.guest.fullName,
              folioId: existingPayment.folioId,
              paymentId: existingPayment.id,
              total: Number(existingPayment.amount),
              method: existingPayment.paymentMethod.name,
              isIdempotentReplay: true,
            };
          }
          throw new PosIdempotencyError(
            "Idempotency key was previously used with different order details.",
            409,
            "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD"
          );
        }

        let lines: CartLine[];
        try {
          lines = await resolveCartLines(tx, requestedItems, hotelId);
        } catch (error) {
          // Cart resolution precedes all writes inside this transaction. These
          // business-rule failures are definitively rolled back and safe to clear.
          throw new PosNotCommittedError(error instanceof Error ? error.message : "The order items are invalid.");
        }
        const total = cartTotal(lines);

        const method = await tx.paymentMethod.findUnique({
          where: { id_hotelId: { id: paymentMethodId, hotelId } },
        });
        if (!method || !method.isActive) {
          throw new PosNotCommittedError("That payment method is unavailable in this hotel.");
        }

        let guest = customerPhone
          ? await tx.guest.findFirst({ where: { hotelId, phone: customerPhone } })
          : null;

        if (!guest && customerName) {
          guest = await tx.guest.create({
            data: { hotelId, fullName: customerName, phone: customerPhone || null },
          });
        }
        if (!guest) {
          guest =
            (await tx.guest.findFirst({ where: { hotelId, fullName: WALK_IN_GUEST } })) ??
            (await tx.guest.create({ data: { hotelId, fullName: WALK_IN_GUEST } }));
        }

        const folio = await tx.folio.create({
          data: { hotelId, guestId: guest.id, isClosed: true },
        });

        for (const line of lines) {
          await tx.folioItem.create({
            data: {
              folioId: folio.id,
              type: "RESTAURANT",
              description: `${prefix} — ${line.name}`,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              taxRate: 0,
              total: round2(line.quantity * line.unitPrice),
            },
          });
        }

        const payment = await tx.payment.create({
          data: {
            hotelId,
            folioId: folio.id,
            paymentMethodId: method.id,
            amount: total,
            reference: reference || null,
            idempotencyKey,
            requestFingerprint: fingerprint,
            status: "COMPLETED",
            cashierId: tenant.userId,
          },
        });

        await deductRecipeStock(tx, lines, `Sold to ${guest.fullName}`, tenant.userId, hotelId);

        return {
          guestName: guest.fullName,
          folioId: folio.id,
          paymentId: payment.id,
          total,
          method: method.name,
        };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15000,
      }
    );

    await syncLowStockAlerts(hotelId);

    return NextResponse.json(successBody(result), { status: 201 });
  } catch (error) {
    if (error instanceof PosNotCommittedError) {
      return NextResponse.json(
        { error: error.message, code: "POS_REQUEST_REJECTED", outcome: "NOT_COMMITTED" },
        { status: 400 },
      );
    }

    if (error instanceof PosIdempotencyError) {
      return NextResponse.json({ error: error.message, code: error.code, outcome: "CONFLICT" }, { status: error.status });
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = (error.meta as { target?: unknown } | undefined)?.target;
      const isIdempotencyConflict = isPaymentIdempotencyConstraint(target);

      if (isIdempotencyConflict) {
        // Look up winning result outside the failed transaction
        try {
          const winningPayment = await prisma.payment.findUnique({
            where: {
              hotelId_idempotencyKey: {
                hotelId,
                idempotencyKey,
              },
            },
            include: {
              folio: { include: { guest: true } },
              paymentMethod: true,
            },
          });

          if (winningPayment && winningPayment.hotelId === hotelId) {
            if (winningPayment.requestFingerprint === fingerprint) {
              return NextResponse.json(
                successBody({
                  guestName: winningPayment.folio.guest.fullName,
                  folioId: winningPayment.folioId,
                  paymentId: winningPayment.id,
                  total: Number(winningPayment.amount),
                  method: winningPayment.paymentMethod.name,
                  isIdempotentReplay: true,
                }),
                { status: 201 }
              );
            } else {
              return NextResponse.json(
                {
                  error: "Idempotency key was previously used with different order details.",
                  code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
                  outcome: "CONFLICT",
                },
                { status: 409 }
              );
            }
          }
        } catch (lookupErr) {
          console.error("Failed to query winning payment after P2002 conflict:", lookupErr);
        }

        return NextResponse.json(
          {
            error: "A payment with this idempotency key was submitted concurrently. Refresh and verify.",
            code: "CONCURRENT_IDEMPOTENCY_RACE",
            outcome: "UNKNOWN",
          },
          { status: 409 }
        );
      }

      try {
        if (await paymentReferenceExists(hotelId, reference)) return NextResponse.json({ error: "This payment reference has already been recorded for this hotel.", code: "PAYMENT_REFERENCE_ALREADY_USED", outcome: "CONFLICT" }, { status: 409 });
      } catch (lookupError) { console.error("Failed to inspect payment reference conflict:", lookupError); }
      // Unrelated or ambiguous unique constraint violation: do not misclassify as idempotency conflict
      return NextResponse.json(
        {
          error: "A unique record constraint violation occurred. Please verify your records.",
          code: "DATABASE_UNIQUE_CONSTRAINT_CONFLICT",
          outcome: "UNKNOWN",
        },
        { status: 409 }
      );
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      try {
        if (await paymentReferenceExists(hotelId, reference)) return NextResponse.json({ error: "This payment reference has already been recorded for this hotel.", code: "PAYMENT_REFERENCE_ALREADY_USED", outcome: "CONFLICT" }, { status: 409 });
      } catch (lookupError) { console.error("Failed to inspect payment reference conflict:", lookupError); }
      return NextResponse.json(
        {
          error: "The inventory or payment records changed. Refresh and try again.",
          code: "CONCURRENT_MUTATION_CONFLICT",
          outcome: "UNKNOWN",
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      {
        error: "Could not confirm the payment outcome. Retry this exact saved request to verify it.",
        code: "PAYMENT_OUTCOME_UNKNOWN",
        outcome: "UNKNOWN",
      },
      { status: 500 }
    );
  }
}
