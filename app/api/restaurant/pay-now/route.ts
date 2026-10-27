import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  cartTotal,
  computePosFingerprint,
  readCartRequest,
  resolveCartLines,
  round2,
} from "@/lib/restaurant";
import { deductRecipeStock } from "@/lib/inventory";

const WALK_IN_GUEST = "Walk-in Guest";

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

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.RESTAURANT_POS);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  // Enforce SaaS Subscription Plan Module Entitlement
  const { checkModuleEntitlement } = await import("@/lib/entitlements");
  const moduleCheck = await checkModuleEntitlement(hotelId, "RESTAURANT_POS");
  if (!moduleCheck.allowed) {
    return NextResponse.json(
      {
        error: moduleCheck.code || "MODULE_NOT_ENTITLED",
        message: moduleCheck.reason,
      },
      { status: 403 }
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body.", code: "INVALID_JSON_BODY" }, { status: 400 });
  }

  const rawIdempotencyKey =
    req.headers.get("x-idempotency-key") ||
    req.headers.get("idempotency-key") ||
    (typeof body?.idempotencyKey === "string" ? body.idempotencyKey : undefined);

  const idempotencyKey =
    typeof rawIdempotencyKey === "string" ? rawIdempotencyKey.trim() : "";

  if (!idempotencyKey) {
    return NextResponse.json(
      { error: "An idempotency key is required for POS payments.", code: "MISSING_IDEMPOTENCY_KEY" },
      { status: 400 }
    );
  }

  if (idempotencyKey.length < 4 || idempotencyKey.length > 128) {
    return NextResponse.json(
      { error: "Idempotency key must be between 4 and 128 characters.", code: "INVALID_IDEMPOTENCY_KEY_LENGTH" },
      { status: 400 }
    );
  }

  const paymentMethodId: string | undefined =
    typeof body?.paymentMethodId === "string" ? body.paymentMethodId.trim() : undefined;
  const customerName = typeof body?.customerName === "string" ? body.customerName.trim() : "";
  const customerPhone = typeof body?.customerPhone === "string" ? body.customerPhone.trim() : "";
  const reference = typeof body?.reference === "string" ? body.reference.trim() : "";
  const tableNumber = typeof body?.tableNumber === "string" ? body.tableNumber.trim() : "";

  if (!paymentMethodId) {
    return NextResponse.json({ error: "Choose how the guest is paying.", code: "MISSING_PAYMENT_METHOD" }, { status: 400 });
  }

  let requestedItems: ReturnType<typeof readCartRequest>;
  try {
    requestedItems = readCartRequest(body.items);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The order is invalid.", code: "INVALID_ORDER_ITEMS" },
      { status: 400 }
    );
  }
  if (requestedItems.length === 0) {
    return NextResponse.json({ error: "Add at least one item to the order.", code: "EMPTY_ORDER" }, { status: 400 });
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

        const lines = await resolveCartLines(tx, requestedItems, hotelId);
        const total = cartTotal(lines);

        const method = await tx.paymentMethod.findUnique({
          where: { id_hotelId: { id: paymentMethodId, hotelId } },
        });
        if (!method || !method.isActive) {
          throw new Error("That payment method is unavailable in this hotel.");
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

    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    if (error instanceof PosIdempotencyError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
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
                {
                  ok: true,
                  guestName: winningPayment.folio.guest.fullName,
                  folioId: winningPayment.folioId,
                  paymentId: winningPayment.id,
                  total: Number(winningPayment.amount),
                  method: winningPayment.paymentMethod.name,
                  isIdempotentReplay: true,
                },
                { status: 201 }
              );
            } else {
              return NextResponse.json(
                {
                  error: "Idempotency key was previously used with different order details.",
                  code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
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
          },
          { status: 409 }
        );
      }

      // Unrelated or ambiguous unique constraint violation: do not misclassify as idempotency conflict
      return NextResponse.json(
        {
          error: "A unique record constraint violation occurred. Please verify your records.",
          code: "DATABASE_UNIQUE_CONSTRAINT_CONFLICT",
        },
        { status: 409 }
      );
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return NextResponse.json(
        {
          error: "The inventory or payment records changed. Refresh and try again.",
          code: "CONCURRENT_MUTATION_CONFLICT",
        },
        { status: 409 }
      );
    }

    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not complete the order.",
        code: "PRE_COMMIT_VALIDATION_ERROR",
      },
      { status: 400 }
    );
  }
}
