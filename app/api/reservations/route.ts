import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { rangesOverlap } from "@/lib/dates";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { accommodationRequired, parseMoney, stayNights } from "@/lib/billing";
import { hasRole } from "@/lib/permissions";
import { nextReservationCode } from "@/lib/reservation-code";
import { isMealPlan, isOccupancy, tariffPricesStay } from "@/lib/tariffs";
import { blocksGuestPlacement, ROOM_STATUS_LABELS } from "@/lib/room-status";

const BOOKING_SOURCES = ["WALK_IN", "PHONE", "WEBSITE", "OTA", "CORPORATE", "OTHER"] as const;

class ReservationError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function GET(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.GUEST_STAYS);
  if (forbidden) return forbidden;
  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  const hotelId = tenant.hotelId;
  const { searchParams } = new URL(req.url);
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  const reservations = await prisma.reservation.findMany({
    where: {
      hotelId,
      ...(from && to
        ? {
            AND: [
              { checkInDate: { lt: new Date(to) } },
              { checkOutDate: { gt: new Date(from) } },
            ],
          }
        : {}),
    },
    include: { guest: true, rooms: { include: { room: true } } },
    orderBy: { checkInDate: "asc" },
  });

  return NextResponse.json(
    reservations.map((reservation) => ({
      id: reservation.id,
      code: reservation.code,
      status: reservation.status,
      checkInDate: reservation.checkInDate.toISOString(),
      checkOutDate: reservation.checkOutDate.toISOString(),
      guestName: reservation.guest.fullName,
      guestPhone: reservation.guest.phone,
      rooms: reservation.rooms.map((reservationRoom) => ({
        roomId: reservationRoom.roomId,
        roomNumber: reservationRoom.room.number,
        rate: Number(reservationRoom.rate),
      })),
    }))
  );
}

export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.GUEST_STAYS);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;

  // Enforce SaaS Subscription Plan Module Entitlement
  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const guestName = text(body?.guestName);
  const guestPhone = text(body?.guestPhone);
  const guestEmail = text(body?.guestEmail);
  const idNumber = text(body?.idNumber);
  const nationality = text(body?.nationality);
  const vehicleRegistration = text(body?.vehicleRegistration);
  const roomId = text(body?.roomId);
  const tariffId = text(body?.tariffId);
  const occupancy = isOccupancy(body?.occupancy) ? body.occupancy : undefined;
  const mealPlan = isMealPlan(body?.mealPlan) ? body.mealPlan : undefined;
  const notes = text(body?.notes);

  if (
    !guestName ||
    !body?.checkInDate ||
    !body?.checkOutDate ||
    !roomId ||
    !tariffId ||
    !occupancy ||
    !mealPlan
  ) {
    return NextResponse.json({ error: "Missing required reservation fields." }, { status: 400 });
  }

  const checkIn = new Date(body.checkInDate);
  const checkOut = new Date(body.checkOutDate);
  if (!Number.isFinite(checkIn.getTime()) || !Number.isFinite(checkOut.getTime())) {
    return NextResponse.json({ error: "Enter valid check-in and check-out dates." }, { status: 400 });
  }

  let discount: number;
  let nights: number;
  try {
    discount = parseMoney(body.discount ?? 0, "Discount", { allowZero: true });
    nights = stayNights(checkIn, checkOut);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "The reservation charges are invalid." },
      { status: 400 }
    );
  }

  if (discount > 0 && !hasRole(tenant.role, ROLE_GROUPS.MANAGEMENT)) {
    return NextResponse.json(
      { error: "Only an Admin or Manager can apply an accommodation discount." },
      { status: 403 }
    );
  }

  const adults = Number(body.adults ?? 1);
  const children = Number(body.children ?? 0);
  if (!Number.isInteger(adults) || adults < 1 || !Number.isInteger(children) || children < 0) {
    return NextResponse.json(
      { error: "Adults and children must be valid whole numbers." },
      { status: 400 }
    );
  }

  const source = BOOKING_SOURCES.find((value) => value === body.source) ?? "WALK_IN";

  try {
    const result = await prisma.$transaction(
      async (tx) => {
        // Serialize reservation creation per hotel. Matches room deletion lock.
        const lockKey = `hotel-${hotelId}-reservation-create`;
        await tx.$queryRaw<Array<{ locked: string }>>`
          SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked
        `;

        // Validate that both room and tariff belong to THIS tenant hotel
        const [room, tariff] = await Promise.all([
          tx.room.findUnique({
            where: { id_hotelId: { id: roomId, hotelId } },
            // roomTypeId is needed to price a hotel that sells its rooms at the
            // room type's own rate instead of per occupancy/meal-plan tariffs.
            select: { id: true, number: true, status: true, isActive: true, roomTypeId: true },
          }),
          tx.roomType.findUnique({
            where: { id_hotelId: { id: tariffId, hotelId } },
          }),
        ]);
        if (!room) throw new ReservationError("Room not found in this hotel.", 404);
        if (!room.isActive) {
          throw new ReservationError("That room is no longer part of the active hotel inventory.");
        }
        if (!tariff) throw new ReservationError("The selected tariff is unavailable in this hotel.", 404);

        // A stay starting today needs a room that is fit to receive a guest.
        const startOf = (date: Date) =>
          new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        if (startOf(checkIn) === startOf(new Date()) && blocksGuestPlacement(room.status)) {
          throw new ReservationError(
            `Room ${room.number} is ${ROOM_STATUS_LABELS[room.status]}. Choose an available room.`
          );
        }

        // The price must come from either the tariff for this occupancy and meal
        // plan, or the selected room's own room type. Anything else is refused so
        // a client cannot price a room at another type's rate.
        if (!tariffPricesStay(tariff, room.roomTypeId, occupancy, mealPlan)) {
          throw new ReservationError(
            "The selected tariff does not match the occupancy and meal plan."
          );
        }

        let rate: number;
        try {
          rate = parseMoney(Number(tariff.baseRate), "Configured nightly rate", {
            allowZero: true,
          });
          if (rate <= 0) {
            // A hotel that never set a rate must not be able to give rooms away
            // silently: say what is wrong and where to fix it.
            throw new ReservationError(
              "This room has no nightly rate configured. Set a rate on the Rooms page before selling it."
            );
          }
          accommodationRequired([rate], nights, discount);
        } catch (error) {
          if (error instanceof ReservationError) throw error;
          throw new ReservationError(
            error instanceof Error ? error.message : "The configured tariff is invalid."
          );
        }

        // Tenant-scoped room overlap check
        const existing = await tx.reservationRoom.findMany({
          where: {
            roomId,
            reservation: {
              hotelId,
              status: { notIn: ["CANCELLED", "NO_SHOW"] },
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
          throw new ReservationError(
            `Room is already booked for part of that date range (${conflict.reservation.code}).`,
            409
          );
        }

        // Guest lookup or creation scoped strictly to this hotel
        const existingGuest = guestPhone
          ? await tx.guest.findFirst({
              where: { hotelId, phone: guestPhone },
            })
          : null;
        const guest = existingGuest
          ? await tx.guest.update({
              where: { id_hotelId: { id: existingGuest.id, hotelId } },
              data: {
                idNumber: idNumber || existingGuest.idNumber,
                nationality: nationality || existingGuest.nationality,
                vehicleRegistration: vehicleRegistration || existingGuest.vehicleRegistration,
                email: guestEmail || existingGuest.email,
              },
            })
          : await tx.guest.create({
              data: {
                hotelId,
                fullName: guestName,
                phone: guestPhone || null,
                email: guestEmail || null,
                idNumber: idNumber || null,
                nationality: nationality || null,
                vehicleRegistration: vehicleRegistration || null,
              },
            });

        // Reservation code generated per hotel
        const year = checkIn.getUTCFullYear();
        const prefix = `RES-${year}-`;
        const existingCodes = await tx.reservation.findMany({
          where: { hotelId, code: { startsWith: prefix } },
          select: { code: true },
        });
        const code = nextReservationCode(
          year,
          existingCodes.map((reservation) => reservation.code)
        );

        const reservation = await tx.reservation.create({
          data: {
            hotelId,
            code,
            guestId: guest.id,
            checkInDate: checkIn,
            checkOutDate: checkOut,
            status: "CONFIRMED",
            source,
            adults,
            children,
            discount: discount || null,
            notes: notes || null,
            createdById: tenant.userId,
            rooms: { create: [{ roomId: room.id, rate }] },
          },
        });

        return { id: reservation.id, code: reservation.code };
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        timeout: 15_000,
      }
    );

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    if (error instanceof ReservationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2002" || error.code === "P2034")
    ) {
      return NextResponse.json(
        { error: "Another reservation was saved at the same time. Please try again." },
        { status: 409 }
      );
    }
    console.error("Reservation creation failed:", error);
    return NextResponse.json({ error: "Could not create the reservation." }, { status: 500 });
  }
}
