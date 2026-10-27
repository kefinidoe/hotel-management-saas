import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { cartTotal, readCartRequest, resolveCartLines, round2 } from "@/lib/restaurant";
import { deductRecipeStock } from "@/lib/inventory";

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
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const folioId: string | undefined = typeof body?.folioId === "string" ? body.folioId.trim() : undefined;
  const tableNumber = typeof body?.tableNumber === "string" ? body.tableNumber.trim() : "";

  if (!folioId) {
    return NextResponse.json({ error: "Choose the guest to charge the order to." }, { status: 400 });
  }

  let requestedItems: ReturnType<typeof readCartRequest>;
  try {
    requestedItems = readCartRequest(body.items);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The order is invalid." },
      { status: 400 }
    );
  }
  if (requestedItems.length === 0) {
    return NextResponse.json({ error: "Add at least one item to the order." }, { status: 400 });
  }

  const prefix = tableNumber ? `Restaurant (Table ${tableNumber})` : "Restaurant";

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
          include: { guest: true },
        });
        if (!folio) throw new Error("Folio not found in this hotel.");
        if (folio.isClosed) {
          throw new Error("That folio is already closed — take payment for this order instead.");
        }

        const lines = await resolveCartLines(tx, requestedItems, hotelId);
        const total = cartTotal(lines);

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

        await deductRecipeStock(
          tx,
          lines,
          `Charged to ${folio.guest.fullName}`,
          tenant.userId,
          hotelId
        );

        return { guestName: folio.guest.fullName, total };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15000,
      }
    );

    return NextResponse.json({ ok: true, ...result }, { status: 201 });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return NextResponse.json(
        { error: "The folio or stock changed while completing the order. Please try again." },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not complete the order." },
      { status: 400 }
    );
  }
}
