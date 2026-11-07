import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import {
  cartTotal,
  computeChargeToRoomFingerprint,
  readCartRequest,
  resolveCartLines,
  round2,
} from "@/lib/restaurant";
import { deductRecipeStock } from "@/lib/recipe-stock";
import { syncLowStockAlerts } from "@/lib/notifications";

type ChargeToRoomResult = {
  operation: "CHARGE_TO_ROOM";
  idempotencyKey: string;
  requestFingerprint: string;
  orderId: string;
  folioId: string;
  guestName: string;
  total: number;
  isIdempotentReplay?: boolean;
};

class ChargeToRoomRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChargeToRoomRejectedError";
  }
}

class ChargeToRoomConflictError extends Error {
  constructor(message = "Idempotency key was previously used with different charge details.") {
    super(message);
    this.name = "ChargeToRoomConflictError";
  }
}

function hasDefinitiveConstraintTarget(target: unknown): boolean {
  if (typeof target === "string") return target.trim().length > 0;
  return Array.isArray(target) && target.length > 0 && target.every((field) => typeof field === "string" && field.trim().length > 0);
}

function isOrderIdempotencyConstraint(target: unknown): boolean {
  const normalized = Array.isArray(target)
    ? target.map((field) => typeof field === "string" ? field.toLowerCase().replace(/[^a-z0-9]/g, "") : "")
    : typeof target === "string"
    ? [target.toLowerCase().replace(/[^a-z0-9]/g, "")]
    : [];
  return normalized.some((field) => field.includes("hotelid")) &&
    normalized.some((field) => field.includes("idempotencykey"));
}

function mayBeIdempotencyConstraint(target: unknown): boolean {
  const normalized = Array.isArray(target)
    ? target.map((field) => typeof field === "string" ? field.toLowerCase() : "")
    : typeof target === "string"
    ? [target.toLowerCase()]
    : [];
  return normalized.some((field) => field.includes("idempotency"));
}

function asChargeToRoomResult(
  order: any,
  idempotencyKey: string,
  requestFingerprint: string,
  isIdempotentReplay = false,
): ChargeToRoomResult | null {
  if (
    !order ||
    typeof order.id !== "string" || !order.id ||
    order.hotelId === undefined ||
    order.status !== "OPEN" ||
    typeof order.folioId !== "string" || !order.folioId ||
    !order.folio ||
    typeof order.folio.guest?.fullName !== "string"
  ) return null;

  const total = Number(order.total);
  if (!Number.isFinite(total)) return null;

  return {
    operation: "CHARGE_TO_ROOM",
    idempotencyKey,
    requestFingerprint,
    orderId: order.id,
    folioId: order.folioId,
    guestName: order.folio.guest.fullName,
    total,
    ...(isIdempotentReplay ? { isIdempotentReplay: true } : {}),
  };
}

function orderInclude() {
  return { folio: { include: { guest: { select: { fullName: true } } } } };
}

async function findCommittedOrder(hotelId: string, idempotencyKey: string) {
  return prisma.order.findUnique({
    where: {
      hotelId_idempotencyOperation_idempotencyKey: {
        hotelId, idempotencyOperation: "CHARGE_TO_ROOM", idempotencyKey,
      },
    },
    include: orderInclude(),
  });
}

async function resolveConcurrentResult(
  hotelId: string,
  folioId: string,
  idempotencyKey: string,
  requestFingerprint: string,
): Promise<NextResponse> {
  try {
    const winner = await findCommittedOrder(hotelId, idempotencyKey);
    if (winner) {
      if (
        winner.hotelId !== hotelId ||
        winner.idempotencyOperation !== "CHARGE_TO_ROOM" ||
        winner.folioId !== folioId ||
        winner.requestFingerprint !== requestFingerprint
      ) {
        return NextResponse.json(
          {
            error: "Idempotency key was previously used with different charge details.",
            code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD",
            outcome: "CONFLICT",
          },
          { status: 409 },
        );
      }
      const result = asChargeToRoomResult(winner, idempotencyKey, requestFingerprint, true);
      if (result) return NextResponse.json({ ok: true, ...result }, { status: 201 });
    }
  } catch {
    // A failed lookup cannot prove either success or non-commit. Keep the result
    // ambiguous so clients retain and retry the same operation key and payload.
  }

  return NextResponse.json(
    {
      error: "The charge may have been submitted concurrently. Retry this exact request to verify it.",
      code: "CONCURRENT_IDEMPOTENCY_RACE",
      outcome: "UNKNOWN",
    },
    { status: 409 },
  );
}

export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  // Consistency guard only; authorization is still exclusively session-derived.
  const expectedTenantId = req.headers.get("x-expected-hotel-id");
  if (expectedTenantId && expectedTenantId !== tenant.hotelId) {
    return NextResponse.json(
      { error: "The active hotel changed. Refresh the POS before retrying this saved attempt.", code: "TENANT_CONTEXT_MISMATCH", outcome: "UNKNOWN" },
      { status: 409 },
    );
  }

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.RESTAURANT_POS);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESTAURANT_POS");
  if (blocked) return blocked;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body.", code: "INVALID_JSON_BODY", outcome: "NOT_COMMITTED" }, { status: 400 });
  }

  const folioId = typeof body?.folioId === "string" ? body.folioId.trim() : "";
  const tableNumber = typeof body?.tableNumber === "string" ? body.tableNumber.trim() : "";
  const rawIdempotencyKey =
    req.headers.get("x-idempotency-key") ||
    req.headers.get("idempotency-key") ||
    (typeof body?.idempotencyKey === "string" ? body.idempotencyKey : undefined);
  const idempotencyKey = typeof rawIdempotencyKey === "string" ? rawIdempotencyKey.trim() : "";

  if (!idempotencyKey) {
    return NextResponse.json(
      { error: "An idempotency key is required for room charges.", code: "MISSING_IDEMPOTENCY_KEY", outcome: "NOT_COMMITTED" },
      { status: 400 },
    );
  }
  if (idempotencyKey.length < 4 || idempotencyKey.length > 128) {
    return NextResponse.json(
      { error: "Idempotency key must be between 4 and 128 characters.", code: "INVALID_IDEMPOTENCY_KEY_LENGTH", outcome: "NOT_COMMITTED" },
      { status: 400 },
    );
  }
  if (!folioId) {
    return NextResponse.json(
      { error: "Choose the guest to charge the order to.", code: "MISSING_FOLIO", outcome: "NOT_COMMITTED" },
      { status: 400 },
    );
  }

  let requestedItems: ReturnType<typeof readCartRequest>;
  try {
    requestedItems = readCartRequest(body?.items);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The order is invalid.", code: "INVALID_ORDER_ITEMS", outcome: "NOT_COMMITTED" },
      { status: 400 },
    );
  }
  if (requestedItems.length === 0) {
    return NextResponse.json(
      { error: "Add at least one item to the order.", code: "EMPTY_ORDER", outcome: "NOT_COMMITTED" },
      { status: 400 },
    );
  }

  const hotelId = tenant.hotelId;
  const requestFingerprint = computeChargeToRoomFingerprint({
    hotelId,
    folioId,
    items: requestedItems,
    tableNumber,
  });
  const prefix = tableNumber ? `Restaurant (Table ${tableNumber})` : "Restaurant";

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        try {
          // Keep this hotel-level lock coordinated with POS payment and stay
          // transactions. The unique Order constraint remains the final race guard.
          const lockKey = `hotel-${hotelId}-reservation-create`;
          await tx.$queryRaw<Array<{ locked: string }>>`
            SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked
          `;

          const existingOrder = await tx.order.findUnique({
            where: {
      hotelId_idempotencyOperation_idempotencyKey: {
        hotelId, idempotencyOperation: "CHARGE_TO_ROOM", idempotencyKey,
      },
    },
            include: orderInclude(),
          });
          if (existingOrder) {
            if (
              existingOrder.hotelId !== hotelId ||
              existingOrder.idempotencyOperation !== "CHARGE_TO_ROOM" ||
              existingOrder.folioId !== folioId ||
              existingOrder.requestFingerprint !== requestFingerprint
            ) throw new ChargeToRoomConflictError();

            const replay = asChargeToRoomResult(existingOrder, idempotencyKey, requestFingerprint, true);
            if (!replay) throw new ChargeToRoomConflictError("The prior charge result is incomplete; retain the key and verify the record.");
            return replay;
          }

          const folio = await tx.folio.findUnique({
            where: { id_hotelId: { id: folioId, hotelId } },
            include: { guest: { select: { fullName: true } } },
          });
          if (!folio) throw new Error("Folio not found in this hotel.");
          if (folio.isClosed) throw new Error("That folio is already closed — take payment for this order instead.");

          const lines = await resolveCartLines(tx, requestedItems, hotelId);
          const total = cartTotal(lines);
          const order = await tx.order.create({
            data: {
              hotelId,
              status: "OPEN",
              folioId: folio.id,
              total,
              idempotencyOperation: "CHARGE_TO_ROOM",
              idempotencyKey,
              requestFingerprint,
            },
          });

          for (const line of lines) {
            await tx.orderItem.create({
              data: {
                orderId: order.id,
                hotelId,
                menuItemId: line.menuItemId,
                name: line.name,
                unitPrice: line.unitPrice,
                quantity: line.quantity,
                total: round2(line.quantity * line.unitPrice),
              },
            });
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

          await deductRecipeStock(tx, lines, `Charged to ${folio.guest.fullName}`, tenant.userId, hotelId);

          return {
            operation: "CHARGE_TO_ROOM" as const,
            idempotencyKey,
            requestFingerprint,
            orderId: order.id,
            folioId: folio.id,
            guestName: folio.guest.fullName,
            total,
          };
        } catch (error) {
          // Throwing from the interactive transaction callback forces rollback;
          // only idempotency/serialization errors need outside-winner resolution.
          if (
            error instanceof ChargeToRoomRejectedError ||
            error instanceof ChargeToRoomConflictError ||
            (error instanceof Prisma.PrismaClientKnownRequestError && ["P2002", "P2034"].includes(error.code))
          ) throw error;
          throw new ChargeToRoomRejectedError(error instanceof Error ? error.message : "Could not complete the room charge.");
        }
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15000,
      },
    );

    await syncLowStockAlerts(hotelId);

    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    if (error instanceof ChargeToRoomConflictError) {
      return NextResponse.json(
        { error: error.message, code: "IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD", outcome: "CONFLICT" },
        { status: 409 },
      );
    }
    if (error instanceof ChargeToRoomRejectedError) {
      return NextResponse.json(
        { error: error.message, code: "CHARGE_REJECTED", outcome: "NOT_COMMITTED" },
        { status: 400 },
      );
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const target = (error.meta as { target?: unknown } | undefined)?.target;
      if (
        isOrderIdempotencyConstraint(target) ||
        mayBeIdempotencyConstraint(target) ||
        !hasDefinitiveConstraintTarget(target)
      ) {
        // Missing/ambiguous metadata cannot prove this wasn't the idempotency
        // index. Resolve the committed winner or retain an UNKNOWN outcome.
        return resolveConcurrentResult(hotelId, folioId, idempotencyKey, requestFingerprint);
      }
      return NextResponse.json(
        { error: "A unique database constraint rejected the room charge.", code: "DATABASE_UNIQUE_CONSTRAINT_CONFLICT", outcome: "NOT_COMMITTED" },
        { status: 409 },
      );
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return resolveConcurrentResult(hotelId, folioId, idempotencyKey, requestFingerprint);
    }

    return NextResponse.json(
      { error: "Could not confirm the room charge. Retry this exact request to verify it.", code: "CHARGE_OUTCOME_UNKNOWN", outcome: "UNKNOWN" },
      { status: 500 },
    );
  }
}
