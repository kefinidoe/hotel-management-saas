import { ROOM_BLOCKING_RESERVATION_STATUSES } from "@/lib/reservation-status";
import { validateRoomStayMutation } from "@/lib/room-stay-mutation-validation";
import { reservationExtensionSchema } from "@/lib/reservation-extension-validation";
import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { folioTotals, roundMoney, stayNights } from "@/lib/billing";
import { prisma } from "@/lib/prisma";
import { formatDisplayDate } from "@/lib/dates";
import { AuditPersistenceError, recordAudit } from "@/lib/audit";

/**
 * Extend a checked-in stay.
 *
 * An extension is a separate agreement, not a repricing:
 *
 *   * the booking's frozen price (`ReservationPriceSnapshot` version 1..N) is
 *     never touched — the guest keeps the rate they booked at;
 *   * each accepted extension is written to `ReservationExtension` with the
 *     previous and new check-out dates, the extra nights, the rooms affected,
 *     the agreed nightly rate, the additional charge, the currency, the folio
 *     lines it created, the booking price version it extended, and who approved
 *     it;
 *   * the extension row, the folio charge, the new check-out date and the
 *     `RESERVATION_EXTENDED` audit event commit in one transaction under the
 *     hotel's shared advisory lock. If the audit row cannot be written, the
 *     whole extension rolls back — a charge nobody can account for must not
 *     exist.
 *
 * Repeated or concurrent requests cannot double-charge: the advisory lock
 * serialises them, the state is re-read after the lock is taken, and
 * `UNIQUE (reservationId, previousCheckOut)` makes posting the same nights from
 * the same check-out moment a database error rather than a second line item.
 */

class ExtensionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code?: string
  ) {
    super(message);
    this.name = "ExtensionError";
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.GUEST_STAYS);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  const hotelId = tenant.hotelId;

  const validation = await validateRoomStayMutation(req, reservationExtensionSchema, { id });
  if (validation.response) return validation.response;
  const body = validation.data;

  const newCheckOut = new Date(body?.checkOutDate);
  if (!Number.isFinite(newCheckOut.getTime())) {
    return NextResponse.json({ error: "Choose a valid new check-out date." }, { status: 400 });
  }
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 200) : null;

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        // Same per-hotel lock as creation, check-in/out, payments, rescheduling
        // and repricing: nothing can post a charge while this decides.
        const lockKey = `hotel-${hotelId}-reservation-create`;
        await tx.$queryRaw<Array<{ locked: string }>>`
          SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked
        `;

        // Re-read after the lock: dates, rooms and the open folio may all have
        // changed while this request waited.
        const reservation = await tx.reservation.findUnique({
          where: { id_hotelId: { id, hotelId } },
          include: {
            rooms: { include: { room: true } },
            folios: {
              where: { hotelId, isClosed: false },
              include: {
                items: { select: { total: true } },
                payments: {
                  where: { hotelId, status: "COMPLETED" },
                  select: { amount: true },
                },
              },
            },
          },
        });
        if (!reservation) throw new ExtensionError("Reservation not found.", 404);
        if (reservation.status !== "CHECKED_IN") {
          throw new ExtensionError("Only a checked-in stay can be extended.");
        }
        if (reservation.rooms.length === 0) {
          throw new ExtensionError("This stay has no assigned room.");
        }
        if (newCheckOut.getTime() === reservation.checkOutDate.getTime()) {
          throw new ExtensionError(
            "This stay already ends on that date. A repeated request is not charged twice.",
            409,
            "EXTENSION_ALREADY_APPLIED"
          );
        }
        if (newCheckOut < reservation.checkOutDate) {
          throw new ExtensionError("The new check-out date must be after the current date.");
        }

        let additionalNights: number;
        try {
          additionalNights = stayNights(reservation.checkOutDate, newCheckOut);
        } catch (error) {
          throw new ExtensionError(
            error instanceof Error ? error.message : "The extension dates are invalid."
          );
        }

        // A duplicate can also arrive as a second, identical approval. Report it
        // as a conflict instead of posting the nights again.
        const alreadyRecorded = await tx.reservationExtension.findFirst({
          where: {
            reservationId: reservation.id,
            hotelId,
            previousCheckOut: reservation.checkOutDate,
          },
          select: { id: true },
        });
        if (alreadyRecorded) {
          throw new ExtensionError(
            "This extension has already been recorded for this stay.",
            409,
            "EXTENSION_ALREADY_APPLIED"
          );
        }

        const roomIds = reservation.rooms.map((reservationRoom) => reservationRoom.roomId);
        const conflict = await tx.reservationRoom.findFirst({
          where: {
            roomId: { in: roomIds },
            reservation: {
              hotelId,
              id: { not: reservation.id },
              status: { in: [...ROOM_BLOCKING_RESERVATION_STATUSES] },
              checkInDate: { lt: newCheckOut },
              checkOutDate: { gt: reservation.checkOutDate },
            },
          },
          include: {
            room: true,
            reservation: { select: { code: true, checkInDate: true } },
          },
        });
        if (conflict) {
          throw new ExtensionError(
            `Room ${conflict.room.number} is booked from ${formatDisplayDate(conflict.reservation.checkInDate)} (${conflict.reservation.code}).`,
            409
          );
        }

        const folio = reservation.folios[0];
        if (!folio) throw new ExtensionError("No open folio was found for this stay.");
        if (reservation.folios.length > 1) {
          throw new ExtensionError("This stay has more than one open folio. Ask a manager to review it.");
        }

        // The booking's own agreement: its frozen price version and currency.
        // Nothing here rewrites it; it is only referenced.
        const bookingVersion = await tx.reservationPriceSnapshot.findFirst({
          where: { reservationId: reservation.id, hotelId },
          orderBy: { version: "desc" },
          select: { version: true, currency: true, nights: true, grandTotal: true, pricingModel: true },
        });
        if (bookingVersion?.pricingModel === "MODULAR_PRICING" || bookingVersion?.pricingModel === "CUSTOM_RATE_RULES") {
          throw new ExtensionError("Modular and dynamic-rule reservations cannot yet be extended automatically; please contact a manager.", 400, "MODULAR_EXTENSION_UNAVAILABLE");
        }
        const currency = bookingVersion?.currency ?? tenant.hotel.currency;

        const rooms: Array<{
          roomId: string;
          number: string;
          roomTypeId: string;
          nightlyRate: number;
          nights: number;
          amount: number;
        }> = [];

        let additionalCharge = 0;
        for (const reservationRoom of reservation.rooms) {
          const unitPrice = Number(reservationRoom.rate);
          if (!Number.isFinite(unitPrice) || unitPrice < 0) {
            throw new ExtensionError(
              `The agreed rate for room ${reservationRoom.room.number} is invalid.`
            );
          }
          const lineTotal = roundMoney(unitPrice * additionalNights);
          additionalCharge = roundMoney(additionalCharge + lineTotal);
          rooms.push({
            roomId: reservationRoom.roomId,
            number: reservationRoom.room.number,
            roomTypeId: reservationRoom.room.roomTypeId,
            nightlyRate: unitPrice,
            nights: additionalNights,
            amount: lineTotal,
          });
        }

        // Every charge line is created inside this transaction; if anything
        // below fails they vanish with it.
        const folioItemIds: string[] = [];
        for (const room of rooms) {
          const item = await tx.folioItem.create({
            data: {
              folioId: folio.id,
              type: "ROOM_CHARGE",
              description: `Room ${room.number} — extension: ${additionalNights} night(s)`,
              quantity: additionalNights,
              unitPrice: room.nightlyRate,
              taxRate: 0,
              total: room.amount,
            },
          });
          folioItemIds.push(item.id);
        }

        const extension = await tx.reservationExtension.create({
          data: {
            hotelId,
            reservationId: reservation.id,
            previousCheckOut: reservation.checkOutDate,
            newCheckOut,
            additionalNights,
            nightlyRate: rooms[0].nightlyRate,
            additionalCharge,
            currency,
            rooms: rooms as unknown as Prisma.InputJsonValue,
            folioId: folio.id,
            folioItemIds: folioItemIds as unknown as Prisma.InputJsonValue,
            priceVersion: bookingVersion?.version ?? null,
            note,
            approvedById: tenant.userId,
          },
        });

        await tx.reservation.update({
          where: { id_hotelId: { id: reservation.id, hotelId } },
          data: { checkOutDate: newCheckOut },
        });

        // Strict: the charge and the record of who approved it are one thing.
        await recordAudit(
          {
            hotelId,
            userId: tenant.userId,
            action: "RESERVATION_EXTENDED",
            entity: "Reservation",
            entityId: reservation.id,
            metadata: {
              extensionId: extension.id,
              previousCheckOut: reservation.checkOutDate.toISOString(),
              newCheckOut: newCheckOut.toISOString(),
              additionalNights,
              rooms,
              nightlyRate: rooms[0].nightlyRate,
              additionalCharge,
              currency,
              folioId: folio.id,
              folioItemIds,
              priceVersion: bookingVersion?.version ?? null,
            },
          },
          tx,
          { strict: true }
        );

        const currentTotals = folioTotals(
          folio.items.map((item) => Number(item.total)),
          folio.payments.map((payment) => Number(payment.amount))
        );
        const required = roundMoney(currentTotals.required + additionalCharge);

        return {
          extensionId: extension.id,
          folioId: folio.id,
          additionalNights,
          additionalCharge,
          nightlyRate: rooms[0].nightlyRate,
          currency,
          previousCheckOut: reservation.checkOutDate.toISOString(),
          required,
          paid: currentTotals.paid,
          balance: roundMoney(required - currentTotals.paid),
          checkOutDate: newCheckOut.toISOString(),
          priceVersion: bookingVersion?.version ?? null,
        };
      },
      {
        // READ COMMITTED for the same reason as repricing: the snapshot has to be
        // taken after the advisory lock is granted, not while waiting for it.
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 15_000,
      }
    );

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof ExtensionError) {
      return NextResponse.json(
        { error: error.message, ...(error.code ? { code: error.code } : {}) },
        { status: error.status }
      );
    }
    if (error instanceof AuditPersistenceError) {
      console.error("Stay extension rolled back: the audit record could not be written.", error);
      return NextResponse.json(
        {
          error:
            "The extension was not saved because it could not be recorded in the audit trail. The stay and the folio were left unchanged.",
          code: "AUDIT_UNAVAILABLE",
        },
        { status: 500 }
      );
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return NextResponse.json(
        {
          error: "This extension has already been recorded for this stay.",
          code: "EXTENSION_ALREADY_APPLIED",
        },
        { status: 409 }
      );
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2034" || error.code === "P2010")
    ) {
      return NextResponse.json(
        { error: "The stay changed during the extension. Refresh and try again." },
        { status: 409 }
      );
    }
    console.error("Stay extension failed:", error);
    return NextResponse.json({ error: "Could not extend the stay." }, { status: 500 });
  }
}
