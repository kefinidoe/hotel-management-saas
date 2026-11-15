import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { AuditPersistenceError, recordAudit } from "@/lib/audit";
import { rangesOverlap } from "@/lib/dates";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { stayNights } from "@/lib/billing";
import {
  canTransitionReservation,
  isReservationStatus,
} from "@/lib/reservation-status";

class ReservationUpdateError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

async function retryWriteConflict<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const canRetry =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2034" &&
        attempt < 3;
      if (!canRetry) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 50));
    }
  }
  throw new Error("Reservation update retry limit reached.");
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.GUEST_STAYS);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  const hotelId = tenant.hotelId;

  const reservation = await prisma.reservation.findUnique({
    where: { id_hotelId: { id, hotelId } },
    include: {
      guest: true,
      rooms: { include: { room: true } },
      folios: {
        where: { hotelId },
        include: {
          items: true,
          payments: { where: { status: "COMPLETED" } },
        },
      },
      // Pricing and extension history: the frozen agreement (version 1 is what
      // the guest booked), any explicit repricings, and every approved stay
      // extension with who approved it. Read-only evidence.
      priceSnapshots: { orderBy: { version: "asc" } },
      priceChanges: { orderBy: { createdAt: "asc" } },
      stayExtensions: {
        orderBy: { createdAt: "asc" },
        include: { approvedBy: { select: { id: true, name: true } } },
      },
    },
  });

  if (!reservation) {
    return NextResponse.json({ error: "Reservation not found." }, { status: 404 });
  }

  return NextResponse.json(reservation);
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.GUEST_STAYS);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  const hotelId = tenant.hotelId;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const hasStatusChange = body?.status !== undefined;
  const hasScheduleChange =
    body?.checkInDate !== undefined ||
    body?.checkOutDate !== undefined ||
    body?.roomId !== undefined;

  if (hasStatusChange && hasScheduleChange) {
    return NextResponse.json(
      { error: "Change reservation status and schedule in separate actions." },
      { status: 400 }
    );
  }
  if (!hasStatusChange && !hasScheduleChange) {
    return NextResponse.json(
      { error: "No supported reservation changes were provided." },
      { status: 400 }
    );
  }
  if (hasStatusChange && !isReservationStatus(body.status)) {
    return NextResponse.json({ error: "Reservation status is invalid." }, { status: 400 });
  }

  try {
    const result = await retryWriteConflict(() =>
      prisma.$transaction(
        async (tx) => {
          // Serialize operations per hotel to prevent races with room deletion and bookings
          const lockKey = `hotel-${hotelId}-reservation-create`;
          await tx.$queryRaw<Array<{ locked: string }>>`
            SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked
          `;

          const reservation = await tx.reservation.findUnique({
            where: { id_hotelId: { id, hotelId } },
            include: { rooms: { include: { room: true } } },
          });
          if (!reservation) throw new ReservationUpdateError("Reservation not found.", 404);

          if (hasStatusChange && isReservationStatus(body.status)) {
            if (!canTransitionReservation(reservation.status, body.status)) {
              throw new ReservationUpdateError(
                `Reservation cannot change from ${reservation.status} to ${body.status}. Use the dedicated check-in or checkout workflow when applicable.`
              );
            }

            const updated = await tx.reservation.update({
              where: { id_hotelId: { id: reservation.id, hotelId } },
              data: { status: body.status },
            });
            return { id: updated.id, status: updated.status };
          }

          if (reservation.status !== "PENDING" && reservation.status !== "CONFIRMED") {
            throw new ReservationUpdateError(
              "Only a pending or confirmed reservation can be rescheduled. Manage an active stay from Front Desk."
            );
          }
          if (reservation.rooms.length !== 1) {
            throw new ReservationUpdateError(
              "This reservation's room assignment requires manager review before rescheduling."
            );
          }

          const checkIn =
            body.checkInDate === undefined
              ? reservation.checkInDate
              : new Date(body.checkInDate);
          const checkOut =
            body.checkOutDate === undefined
              ? reservation.checkOutDate
              : new Date(body.checkOutDate);
          const roomId =
            body.roomId === undefined
              ? reservation.rooms[0].roomId
              : typeof body.roomId === "string"
              ? body.roomId.trim()
              : "";

          if (
            !Number.isFinite(checkIn.getTime()) ||
            !Number.isFinite(checkOut.getTime()) ||
            !roomId
          ) {
            throw new ReservationUpdateError("Enter valid reservation dates and room.");
          }
          try {
            stayNights(checkIn, checkOut);
          } catch (error) {
            throw new ReservationUpdateError(
              error instanceof Error ? error.message : "The reservation dates are invalid."
            );
          }

          // Validate targetRoom belongs to THIS hotel
          const targetRoom = await tx.room.findUnique({
            where: { id_hotelId: { id: roomId, hotelId } },
            select: { id: true, number: true, isActive: true },
          });
          if (!targetRoom) throw new ReservationUpdateError("Room not found in this hotel.", 404);
          if (!targetRoom.isActive) {
            throw new ReservationUpdateError("That room is no longer part of the active hotel inventory.");
          }

          const existing = await tx.reservationRoom.findMany({
            where: {
              roomId,
              reservation: {
                hotelId,
                id: { not: reservation.id },
                status: { in: ["PENDING", "CONFIRMED", "CHECKED_IN"] },
              },
            },
            include: { reservation: true },
          });
          const conflict = existing.find((reservationRoom) =>
            rangesOverlap(
              checkIn,
              checkOut,
              reservationRoom.reservation.checkInDate,
              reservationRoom.reservation.checkOutDate
            )
          );
          if (conflict) {
            throw new ReservationUpdateError(
              `Room ${targetRoom.number} is already booked for part of those dates (${conflict.reservation.code}).`,
              409
            );
          }

          const datesChanged =
            checkIn.getTime() !== reservation.checkInDate.getTime() ||
            checkOut.getTime() !== reservation.checkOutDate.getTime();
          const roomChanged = roomId !== reservation.rooms[0].roomId;

          await tx.reservation.update({
            where: { id_hotelId: { id: reservation.id, hotelId } },
            data: { checkInDate: checkIn, checkOutDate: checkOut },
          });
          if (roomChanged) {
            await tx.reservationRoom.update({
              where: { id: reservation.rooms[0].id },
              data: { roomId },
            });
          }

          // A frozen price is an agreement about specific nights in a specific
          // room. Moving the stay does not silently recalculate it (that is what
          // an explicit, audited repricing is for), but the manager is told the
          // agreed price no longer describes this booking.
          const pricingSnapshot = await tx.reservationPriceSnapshot.findFirst({
            where: { reservationId: reservation.id, hotelId },
            orderBy: { version: "desc" },
            select: { version: true },
          });
          const pricingNeedsReview = Boolean(pricingSnapshot) && (datesChanged || roomChanged);
          if (pricingNeedsReview) {
            await recordAudit(
              {
                hotelId,
                userId: tenant.userId,
                action: "RESERVATION_RATE_REVIEW_REQUIRED",
                entity: "Reservation",
                entityId: reservation.id,
                metadata: {
                  priceVersion: pricingSnapshot?.version ?? null,
                  previousCheckInDate: reservation.checkInDate.toISOString(),
                  previousCheckOutDate: reservation.checkOutDate.toISOString(),
                  checkInDate: checkIn.toISOString(),
                  checkOutDate: checkOut.toISOString(),
                  previousRoomId: reservation.rooms[0].roomId,
                  roomId,
                },
              },
              tx
            );
          }

          return {
            id: reservation.id,
            status: reservation.status,
            checkInDate: checkIn.toISOString(),
            checkOutDate: checkOut.toISOString(),
            roomId,
            pricingNeedsReview,
          };
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          timeout: 15_000,
        }
      )
    );

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ReservationUpdateError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2034") {
      return NextResponse.json(
        { error: "The reservation changed at the same time. Refresh and try again." },
        { status: 409 }
      );
    }
    console.error("Reservation update failed:", error);
    return NextResponse.json({ error: "Could not update the reservation." }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  const hotelId = tenant.hotelId;

  try {
    const outcome = await prisma.$transaction(
      async (tx) => {
        const lockKey = `hotel-${hotelId}-reservation-create`;
        await tx.$queryRaw<Array<{ locked: string }>>`
          SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked
        `;

        // Everything the decision depends on is read under the same hotel lock
        // that payments, check-in/out, rescheduling, extensions and repricing
        // take, so a charge cannot be posted between the check and the delete.
        const reservation = await tx.reservation.findUnique({
          where: { id_hotelId: { id, hotelId } },
          include: {
            rooms: { select: { id: true, roomId: true } },
            folios: {
              where: { hotelId },
              select: {
                id: true,
                isClosed: true,
                // No status filter: PENDING, COMPLETED, FAILED and REFUNDED all
                // represent money that was promised, taken or given back.
                items: { select: { id: true, type: true, total: true } },
                payments: { select: { id: true, status: true, amount: true } },
              },
            },
            priceSnapshots: { select: { version: true }, orderBy: { version: "desc" } },
            priceChanges: { select: { id: true } },
            stayExtensions: { select: { id: true } },
          },
        });

        if (!reservation) {
          throw new ReservationUpdateError("Reservation not found.", 404);
        }

        if (reservation.status === "CHECKED_IN") {
          throw new ReservationUpdateError(
            "Cannot delete an active checked-in stay. Check out the guest first.",
            409
          );
        }
        if (reservation.status === "CHECKED_OUT") {
          throw new ReservationUpdateError(
            "Cannot delete a stay that has been checked out. Its financial record must be kept.",
            409
          );
        }

        const items = reservation.folios.flatMap((folio) => folio.items);
        const payments = reservation.folios.flatMap((folio) => folio.payments);
        const repriced =
          reservation.priceChanges.length > 0 ||
          reservation.priceSnapshots.some((snapshot) => snapshot.version > 1);

        // Only genuinely unused drafts may be deleted. Every other case has a
        // record somebody may need later: what was charged, what was paid, what
        // was re-agreed, or what was extended.
        const reasons: string[] = [];
        if (items.length > 0) {
          reasons.push(`${items.length} folio charge${items.length === 1 ? "" : "s"}`);
        }
        if (payments.length > 0) {
          const byStatus = payments.reduce<Record<string, number>>((counts, payment) => {
            counts[payment.status] = (counts[payment.status] ?? 0) + 1;
            return counts;
          }, {});
          const detail = Object.entries(byStatus)
            .map(([status, count]) => `${count} ${status.toLowerCase()}`)
            .join(", ");
          reasons.push(`${payments.length} payment${payments.length === 1 ? "" : "s"} (${detail})`);
        }
        if (reservation.folios.length > 0 && items.length === 0 && payments.length === 0) {
          reasons.push(`${reservation.folios.length} folio${reservation.folios.length === 1 ? "" : "s"}`);
        }
        if (repriced) {
          reasons.push("a repricing history");
        }
        if (reservation.stayExtensions.length > 0) {
          reasons.push(
            `${reservation.stayExtensions.length} stay extension${reservation.stayExtensions.length === 1 ? "" : "s"}`
          );
        }

        if (reasons.length > 0) {
          throw new ReservationUpdateError(
            `This reservation has ${reasons.join(", ")}. Financial records cannot be deleted — ` +
              "cancel the reservation instead so its history is preserved.",
            409
          );
        }

        // What remains is an unused draft: no charges, no money, no repricing and
        // no extension. The frozen quote (version 1) and the room block belong to
        // the draft itself and are removed with it, deliberately and by name —
        // never by a cascade from another table.
        const snapshotCount = await tx.reservationPriceSnapshot.deleteMany({
          where: { reservationId: id, hotelId },
        });

        await tx.reservationRoom.deleteMany({
          where: { reservationId: id },
        });

        // Strict audit: a deletion nobody can account for must not happen.
        await recordAudit(
          {
            hotelId,
            userId: tenant.userId,
            action: "RESERVATION_DELETED",
            entity: "Reservation",
            entityId: id,
            metadata: {
              code: reservation.code,
              status: reservation.status,
              guestId: reservation.guestId,
              checkInDate: reservation.checkInDate.toISOString(),
              checkOutDate: reservation.checkOutDate.toISOString(),
              rooms: reservation.rooms.map((room) => room.roomId),
              priceSnapshotsRemoved: snapshotCount.count,
            },
          },
          tx,
          { strict: true }
        );

        await tx.reservation.delete({
          where: { id_hotelId: { id, hotelId } },
        });

        return { code: reservation.code };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      }
    );

    return NextResponse.json({
      ok: true,
      message: `Draft reservation ${outcome.code} deleted. No financial records existed.`,
    });
  } catch (error) {
    if (error instanceof ReservationUpdateError) {
      return NextResponse.json(
        { error: error.message, ...(error.status === 409 ? { code: "RESERVATION_HAS_FINANCIAL_RECORDS" } : {}) },
        { status: error.status }
      );
    }
    if (error instanceof AuditPersistenceError) {
      console.error("Reservation deletion rolled back: the audit record could not be written.", error);
      return NextResponse.json(
        {
          error:
            "The reservation was not deleted because the deletion could not be recorded in the audit trail. Nothing was changed.",
          code: "AUDIT_UNAVAILABLE",
        },
        { status: 500 }
      );
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2034" || error.code === "P2003")
    ) {
      return NextResponse.json(
        {
          error:
            "The reservation could not be deleted because a related record still references it. Nothing was changed.",
          code: "RESERVATION_HAS_FINANCIAL_RECORDS",
        },
        { status: 409 }
      );
    }
    console.error("Reservation deletion failed:", error);
    return NextResponse.json({ error: "Could not delete reservation." }, { status: 500 });
  }
}
