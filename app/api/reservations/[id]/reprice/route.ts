import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { AuditPersistenceError, recordAudit } from "@/lib/audit";
import { roundMoney } from "@/lib/billing";
import { loadPricingConfig } from "@/lib/pricing/config";
import { priceStay } from "@/lib/pricing/engine";
import { currentPriceVersion, nextPriceVersion } from "@/lib/pricing/versions";

/**
 * Explicit repricing of an existing reservation.
 *
 * Existing reservations never follow later configuration changes on their own:
 * the agreed price is frozen as version 1 of `ReservationPriceSnapshot`. This
 * endpoint appends a new immutable version — the original row is never updated —
 * together with a `ReservationPriceChange`, the room/discount update on the
 * reservation and the `RESERVATION_REPRICED` audit event.
 *
 * All four writes share one serializable transaction. If any of them fails,
 * including the audit record, nothing is committed: the endpoint never reports a
 * new price that was not fully recorded.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;
  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  const hotelId = tenant.hotelId;
  const { id } = await params;

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }

  // The reservation is resolved through the tenant, so another hotel's id is
  // indistinguishable from one that does not exist.
  const reservation = await prisma.reservation.findUnique({
    where: { id_hotelId: { id, hotelId } },
    include: {
      rooms: { include: { room: true } },
      priceSnapshots: { orderBy: { version: "desc" }, take: 1 },
    },
  });
  if (!reservation) {
    return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
  }
  if (reservation.status !== "PENDING" && reservation.status !== "CONFIRMED") {
    return NextResponse.json(
      { error: "Only a pending or confirmed reservation can be repriced." },
      { status: 400 }
    );
  }
  if (reservation.rooms.length !== 1) {
    return NextResponse.json(
      { error: "Repricing is supported for single-room reservations." },
      { status: 400 }
    );
  }

  const room = reservation.rooms[0].room;
  const current = currentPriceVersion(reservation.priceSnapshots);
  const config = await loadPricingConfig(hotelId, tenant.hotel.currency);

  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const occupancyTypeId =
    text(body.occupancyTypeId) ||
    config.occupancies.find((option) => option.name === current?.occupancyName)?.id ||
    null;
  const mealPlanId =
    text(body.mealPlanId) ||
    config.mealPlans.find((plan) => plan.name === current?.mealPlanName)?.id ||
    null;

  const discount = Number(body.discount ?? reservation.discount ?? 0);
  const discountPercent =
    body.discountPercent === undefined || body.discountPercent === null || body.discountPercent === ""
      ? undefined
      : Number(body.discountPercent);

  const priced = priceStay(config, {
    roomTypeId: room.roomTypeId,
    occupancyTypeId,
    mealPlanId,
    checkIn: reservation.checkInDate,
    checkOut: reservation.checkOutDate,
    adults: body.adults === undefined ? reservation.adults : Number(body.adults),
    children: body.children === undefined ? reservation.children : Number(body.children),
    childAges: Array.isArray(body.childAges)
      ? (body.childAges as unknown[]).map((age) => Number(age)).filter((age) => Number.isFinite(age))
      : undefined,
    extraBeds: Number(body.extraBeds ?? 0),
    discount: Number.isFinite(discount) && discount > 0 ? discount : undefined,
    discountPercent,
  });

  if (!priced.ok) {
    return NextResponse.json({ error: priced.message, code: priced.code }, { status: 400 });
  }

  const nightlyRate = roundMoney((priced.totals.room + priced.totals.adjustments) / priced.nights);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : null;

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        // Two managers repricing at once must not compute the same version
        // number: lock the reservation row for the duration of the transaction.
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Reservation" WHERE id = ${id} AND "hotelId" = ${hotelId} FOR UPDATE
        `;

        const previous = await tx.reservationPriceSnapshot.findFirst({
          where: { reservationId: id, hotelId },
          orderBy: { version: "desc" },
        });
        const version = nextPriceVersion(previous);
        const previousTotal = previous ? Number(previous.grandTotal) : null;

        await tx.reservationRoom.update({
          where: { id: reservation.rooms[0].id },
          data: { rate: nightlyRate },
        });
        await tx.reservation.update({
          where: { id_hotelId: { id, hotelId } },
          data: { discount: priced.totals.discount || null },
        });

        // Append-only: the previous versions stay exactly as they were written.
        const snapshot = await tx.reservationPriceSnapshot.create({
          data: {
            version,
            hotelId,
            reservationId: id,
            pricingModel: priced.pricingModel,
            currency: priced.currency,
            occupancyName: priced.occupancyName,
            mealPlanName: priced.mealPlanName,
            mealPlanBasis: priced.mealPlanBasis,
            nightlyRate: priced.nightlyRate,
            nights: priced.nights,
            adults: priced.adults,
            children: priced.children,
            extraBeds: priced.extraBeds,
            roomTotal: priced.totals.room,
            mealsTotal: priced.totals.meals,
            extrasTotal: priced.totals.extras,
            adjustmentsTotal: priced.totals.adjustments,
            discountTotal: priced.totals.discount,
            taxTotal: priced.totals.tax,
            grandTotal: priced.totals.grandTotal,
            breakdown: priced as unknown as Prisma.InputJsonValue,
            createdById: tenant.userId,
          },
        });

        await tx.reservationPriceChange.create({
          data: {
            hotelId,
            reservationId: id,
            previousTotal: previousTotal ?? priced.totals.grandTotal,
            newTotal: priced.totals.grandTotal,
            previousVersion: previous?.version ?? null,
            newVersion: version,
            reason,
            breakdown: priced as unknown as Prisma.InputJsonValue,
            changedById: tenant.userId,
          },
        });

        // Strict: if the audit row cannot be written in this transaction the
        // whole repricing rolls back instead of committing an unexplained change.
        await recordAudit(
          {
            hotelId,
            userId: tenant.userId,
            action: "RESERVATION_REPRICED",
            entity: "Reservation",
            entityId: id,
            metadata: {
              previousTotal,
              newTotal: priced.totals.grandTotal,
              previousVersion: previous?.version ?? null,
              newVersion: version,
              reason,
            },
          },
          tx,
          { strict: true }
        );

        return { snapshot, previousTotal, version };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      }
    );

    return NextResponse.json({
      ok: true,
      reservationId: id,
      previousTotal: result.previousTotal,
      total: Number(result.snapshot.grandTotal),
      version: result.version,
      currency: result.snapshot.currency,
      breakdown: priced,
    });
  } catch (error) {
    if (error instanceof AuditPersistenceError) {
      console.error("Repricing rolled back: the audit record could not be written.", error);
      return NextResponse.json(
        {
          error:
            "Repricing was not saved because it could not be recorded in the audit trail. Nothing was changed.",
          code: "AUDIT_UNAVAILABLE",
        },
        { status: 500 }
      );
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2002" || error.code === "P2034")
    ) {
      return NextResponse.json(
        { error: "Another change to this reservation was saved at the same time. Please try again." },
        { status: 409 }
      );
    }
    console.error("Repricing failed:", error);
    return NextResponse.json({ error: "Could not reprice the reservation." }, { status: 500 });
  }
}
