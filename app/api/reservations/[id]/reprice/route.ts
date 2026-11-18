import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { AuditPersistenceError, recordAudit } from "@/lib/audit";
import { roundMoney } from "@/lib/billing";
import { loadPricingConfig } from "@/lib/pricing/config";
import { pricingUnavailableResponse } from "@/lib/pricing/http";
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
 * Everything happens inside one serializable transaction that first takes the
 * hotel's reservation advisory lock and then locks the reservation row. The
 * request body supplies *intent* (occupancy, meal plan, guests, discount) but
 * never the pricing inputs: dates, room assignment, guest counts and the
 * current price are all re-read from the database after the lock is held, and
 * the price is computed from those values. A schedule change, a room move, a
 * payment or a check-in either commits before the lock is granted — in which
 * case this transaction sees it — or waits until this transaction is done.
 *
 * Money that has already moved is never silently repriced: a reservation with
 * any folio charge or any payment (pending, completed or refunded) is refused
 * with `409 RESERVATION_HAS_FINANCIAL_ACTIVITY`.
 *
 * If any write fails, including the strict audit record, nothing is committed:
 * the endpoint never reports a new price that was not fully recorded.
 */

class RepriceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string
  ) {
    super(message);
    this.name = "RepriceError";
  }
}

type LockedReservation = {
  id: string;
  status: string;
  checkInDate: Date;
  checkOutDate: Date;
  adults: number;
  children: number;
  discount: unknown;
  rooms: Array<{ id: string; roomId: string; room: { id: string; roomTypeId: string } }>;
  priceSnapshots: Array<{ version: number; pricingModel?: string; occupancyName: string | null; mealPlanName: string | null; grandTotal: unknown }>;
  folios: Array<{ id: string; items: unknown[]; payments: Array<{ id: string; status: string }> }>;
};

/**
 * PostgreSQL reports a serialization failure between two concurrent transactions
 * as SQLSTATE 40001/40P01, which Prisma surfaces either as P2034 or as a raw
 * query error (P2010) carrying the SQLSTATE. Both mean "nothing was committed,
 * the data changed underneath you": retrying re-reads the locked state.
 */
function isSerializationFailure(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === "P2034") return true;
  if (error.code === "P2010") {
    const meta = error.meta as { code?: string; message?: string } | undefined;
    return meta?.code === "40001" || meta?.code === "40P01" || /40001|40P01/.test(meta?.message ?? "");
  }
  return false;
}

/** Charges or money on a folio mean the price is no longer a paper agreement. */
function financialActivity(reservation: LockedReservation) {
  const folios = reservation.folios ?? [];
  const chargeCount = folios.reduce((total, folio) => total + (folio.items?.length ?? 0), 0);
  const payments = folios.flatMap((folio) => folio.payments ?? []);
  return { chargeCount, payments, folioCount: folios.length };
}

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

  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
  const requestedOccupancyId = text(body.occupancyTypeId);
  const requestedMealPlanId = text(body.mealPlanId);
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 200) : null;

  const runRepricing = () =>
    prisma.$transaction(
      async (tx) => {
        // Same per-hotel advisory lock that reservation create/update, check-in,
        // check-out, payments, charge-to-room and rescheduling already take.
        // Repricing therefore cannot interleave with any operation that can move
        // the reservation's dates, occupants, room or money.
        const lockKey = `hotel-${hotelId}-reservation-create`;
        await tx.$queryRaw<Array<{ locked: string }>>`
          SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked
        `;

        // Row lock as well: it keeps a direct write (script, migration, future
        // endpoint that forgets the advisory lock) from slipping in underneath.
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM "Reservation" WHERE id = ${id} AND "hotelId" = ${hotelId} FOR UPDATE
        `;
        if (locked.length === 0) {
          throw new RepriceError("Reservation not found.", 404, "NOT_FOUND");
        }

        // Everything the price depends on is read *after* the locks are held.
        const reservation = (await tx.reservation.findUnique({
          where: { id_hotelId: { id, hotelId } },
          include: {
            rooms: { include: { room: { select: { id: true, roomTypeId: true } } } },
            priceSnapshots: { orderBy: { version: "desc" }, take: 1 },
            folios: {
              where: { hotelId },
              select: {
                id: true,
                items: { select: { id: true } },
                payments: { select: { id: true, status: true } },
              },
            },
          },
        })) as LockedReservation | null;

        if (!reservation) {
          throw new RepriceError("Reservation not found.", 404, "NOT_FOUND");
        }
        // Re-validate the status under the lock: a concurrent check-in or
        // cancellation must not be able to reprice a stay that already started.
        if (reservation.status !== "PENDING" && reservation.status !== "CONFIRMED") {
          throw new RepriceError(
            "Only a pending or confirmed reservation can be repriced.",
            400,
            "INVALID_STATUS"
          );
        }
        if (reservation.rooms.length !== 1) {
          throw new RepriceError(
            "Repricing is supported for single-room reservations.",
            400,
            "MULTI_ROOM"
          );
        }

        const money = financialActivity(reservation);
        if (money.chargeCount > 0 || money.payments.length > 0) {
          const detail = [
            money.chargeCount > 0 ? `${money.chargeCount} folio charge${money.chargeCount === 1 ? "" : "s"}` : null,
            money.payments.length > 0
              ? `${money.payments.length} payment${money.payments.length === 1 ? "" : "s"}`
              : null,
          ]
            .filter(Boolean)
            .join(" and ");
          throw new RepriceError(
            `This reservation already has ${detail}. A price that money has already been taken against cannot be changed. ` +
              "Adjust the folio instead, or cancel this reservation and rebook it at the new price.",
            409,
            "RESERVATION_HAS_FINANCIAL_ACTIVITY"
          );
        }

        const room = reservation.rooms[0].room;
        const current = currentPriceVersion(reservation.priceSnapshots);
        if (current?.pricingModel === "MODULAR_PRICING" || current?.pricingModel === "CUSTOM_RATE_RULES") {
          throw new RepriceError("Modular and dynamic-rule reservations cannot yet be repriced. The agreed price remains unchanged.", 400, "MODULAR_REPRICE_UNAVAILABLE");
        }
        const config = await loadPricingConfig(hotelId, tenant.hotel.currency, tx);

        const occupancyTypeId =
          requestedOccupancyId ||
          config.occupancies.find((option) => option.name === current?.occupancyName)?.id ||
          null;
        const mealPlanId =
          requestedMealPlanId ||
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
          throw new RepriceError(priced.message, 400, priced.code);
        }

        const nightlyRate = roundMoney((priced.totals.room + priced.totals.adjustments) / priced.nights);

        // The previous version is the one read under the lock, so two managers
        // cannot both append version 2 and the unique (reservationId, version)
        // constraint is a second line of defence for direct writers.
        const version = nextPriceVersion(current);
        const previousTotal = current ? Number(current.grandTotal) : null;

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
            previousVersion: current?.version ?? null,
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
              previousVersion: current?.version ?? null,
              newVersion: version,
              reason,
            },
          },
          tx,
          { strict: true }
        );

        return { snapshot, previousTotal, version, priced };
      },
      {
        // READ COMMITTED on purpose. The critical section is already exclusive:
        // every reservation and financial writer in the hotel takes the same
        // advisory lock before touching anything, the reservation row is locked
        // with SELECT ... FOR UPDATE, and (reservationId, version) is unique.
        // Serializable would take its snapshot at the *first statement* — which
        // is the advisory lock itself, i.e. before it blocks. A payment or
        // reschedule that commits while this request waits would then be
        // invisible to the re-read below, which is exactly the stale-data hole
        // this endpoint has to close. READ COMMITTED makes every statement after
        // the lock observe what was actually committed.
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 15_000,
      }
    );

  try {
    // A concurrent check-in, payment or reschedule can abort this transaction
    // with a serialization failure. Nothing was committed, so retrying re-reads
    // the locked state instead of returning a price computed from dead data.
    let result: Awaited<ReturnType<typeof runRepricing>> | null = null;
    for (let attempt = 1; attempt <= 3 && result === null; attempt += 1) {
      try {
        result = await runRepricing();
      } catch (error) {
        if (attempt === 3 || !isSerializationFailure(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, attempt * 40));
      }
    }
    if (result === null) {
      throw new RepriceError(
        "The reservation changed while it was being repriced. Please try again.",
        409,
        "WRITE_CONFLICT"
      );
    }

    return NextResponse.json({
      ok: true,
      reservationId: id,
      previousTotal: result.previousTotal,
      total: Number(result.snapshot.grandTotal),
      version: result.version,
      currency: result.snapshot.currency,
      breakdown: result.priced,
    });
  } catch (error) {
    // Repricing re-reads the configuration inside the locked transaction. If that
    // read fails, nothing was written and the caller gets a 503 rather than a
    // price computed from incomplete rules.
    const unavailable = pricingUnavailableResponse(error, "POST /api/reservations/[id]/reprice");
    if (unavailable) return unavailable;
    if (error instanceof RepriceError) {
      return NextResponse.json(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: error.status }
      );
    }
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
      (error.code === "P2002" || isSerializationFailure(error))
    ) {
      return NextResponse.json(
        { error: "Another change to this reservation was saved at the same time. Please try again." },
        { status: 409 }
      );
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025") {
      return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
    }
    console.error("Repricing failed:", error);
    return NextResponse.json({ error: "Could not reprice the reservation." }, { status: 500 });
  }
}
