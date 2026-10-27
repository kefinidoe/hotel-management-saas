import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { rangesOverlap } from "@/lib/dates";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";
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

          await tx.reservation.update({
            where: { id_hotelId: { id: reservation.id, hotelId } },
            data: { checkInDate: checkIn, checkOutDate: checkOut },
          });
          if (roomId !== reservation.rooms[0].roomId) {
            await tx.reservationRoom.update({
              where: { id: reservation.rooms[0].id },
              data: { roomId },
            });
          }

          return {
            id: reservation.id,
            status: reservation.status,
            checkInDate: checkIn.toISOString(),
            checkOutDate: checkOut.toISOString(),
            roomId,
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

  const hotelId = tenant.hotelId;

  try {
    await prisma.$transaction(
      async (tx) => {
        const lockKey = `hotel-${hotelId}-reservation-create`;
        await tx.$queryRaw<Array<{ locked: string }>>`
          SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked
        `;

        const reservation = await tx.reservation.findUnique({
          where: { id_hotelId: { id, hotelId } },
          include: {
            folios: {
              where: { hotelId },
              include: {
                payments: { where: { hotelId, status: "COMPLETED" } },
              },
            },
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

        const hasPayments = reservation.folios.some((f) => f.payments.length > 0);
        if (hasPayments) {
          throw new ReservationUpdateError(
            "Cannot delete a reservation that has recorded payments. Cancel it instead.",
            409
          );
        }

        await tx.reservationRoom.deleteMany({
          where: { reservationId: id },
        });

        await tx.folio.deleteMany({
          where: { reservationId: id, hotelId },
        });

        await tx.reservation.delete({
          where: { id_hotelId: { id, hotelId } },
        });
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      }
    );

    return NextResponse.json({ ok: true, message: "Reservation deleted." });
  } catch (error) {
    if (error instanceof ReservationUpdateError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Reservation deletion failed:", error);
    return NextResponse.json({ error: "Could not delete reservation." }, { status: 500 });
  }
}
