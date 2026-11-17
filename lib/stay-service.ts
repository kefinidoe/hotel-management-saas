import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { currentPriceVersion } from "@/lib/pricing/versions";
import { recordAudit } from "@/lib/audit";
import { ROOM_BLOCKING_RESERVATION_STATUSES } from "@/lib/reservation-status";
import { rangesOverlap } from "@/lib/dates";
import { blocksGuestPlacement, isBookableToday, ROOM_STATUS_LABELS } from "@/lib/room-status";
import { accommodationRequired, folioTotals, parseMoney, roundMoney, stayNights } from "@/lib/billing";
import { hasRole } from "@/lib/permissions";
import { requireRole, ROLE_GROUPS } from "@/lib/authz";
import type { TenantContext } from "@/lib/tenant-context";

export class CheckInError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "CheckInError";
  }
}

export class CheckOutError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
    this.name = "CheckOutError";
  }
}

export interface CheckInOptions {
  reservationId: string;
  amountPaid?: number;
  paymentMethodId?: string;
  reference?: string;
  newRoomId?: string;
}

export async function executeCheckIn(tenant: TenantContext, options: CheckInOptions) {
  const forbidden = requireRole(tenant.role, ROLE_GROUPS.GUEST_STAYS);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;
  const reservationId = options.reservationId ? String(options.reservationId).trim() : "";
  if (!reservationId) {
    throw new CheckInError("Reservation is required.", 400);
  }

  let amountPaid: number;
  try {
    amountPaid = parseMoney(options.amountPaid ?? 0, "Amount paid", { allowZero: true });
  } catch (error) {
    throw new CheckInError(error instanceof Error ? error.message : "Amount paid is invalid.", 400);
  }

  const paymentMethodId = options.paymentMethodId ? String(options.paymentMethodId).trim() : "";
  const reference = options.reference ? String(options.reference).trim() : "";
  const newRoomId = options.newRoomId ? String(options.newRoomId).trim() : "";

  return await prisma.$transaction(
    async (tx) => {
      // Per-hotel lock compatible with reservation creation and room management
      const lockKey = `hotel-${hotelId}-reservation-create`;
      await tx.$queryRaw<Array<{ locked: string }>>`
        SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked
      `;

      const reservation = await tx.reservation.findUnique({
        where: { id_hotelId: { id: reservationId, hotelId } },
        include: {
          rooms: { include: { room: true } },
          folios: { where: { hotelId }, select: { id: true } },
          // The newest frozen price (version 1 at creation, higher after an
          // explicit repricing). It — not a recomputation — decides what the
          // guest owes.
          priceSnapshots: { orderBy: { version: "desc" }, take: 1 },
        },
      });

      if (!reservation) throw new CheckInError("Reservation not found.", 404);
      if (reservation.status !== "PENDING" && reservation.status !== "CONFIRMED") {
        throw new CheckInError("Only a pending or confirmed reservation can be checked in.", 400);
      }
      if (reservation.folios.length > 0) {
        throw new CheckInError("This reservation already has a folio and cannot be checked in again.", 400);
      }

      if (newRoomId && reservation.rooms.length > 1) {
        throw new CheckInError(
          "This reservation holds more than one room. Change rooms from the reservation instead.",
          400
        );
      }

      let assignedRoom: { id: string; number: string } | null =
        reservation.rooms[0]?.room ?? null;

      const changingRoom = Boolean(newRoomId && newRoomId !== assignedRoom?.id);
      if (changingRoom) {
        const target = await tx.room.findUnique({
          where: { id_hotelId: { id: newRoomId, hotelId } },
          select: { id: true, number: true, status: true, isActive: true },
        });
        if (!target) throw new CheckInError("The room you selected was not found in this hotel.", 404);
        if (!target.isActive) {
          throw new CheckInError(
            `Room ${target.number} is no longer part of the hotel's active rooms. Choose another.`,
            400
          );
        }
        if (!isBookableToday(target.status)) {
          throw new CheckInError(
            `Room ${target.number} is ${ROOM_STATUS_LABELS[target.status]}. Choose an available room.`,
            400
          );
        }

        const otherStays = await tx.reservationRoom.findMany({
          where: {
            roomId: target.id,
            reservation: {
              hotelId,
              status: { in: [...ROOM_BLOCKING_RESERVATION_STATUSES] },
              id: { not: reservation.id },
            },
          },
          include: { reservation: true },
        });

        const clash = otherStays.find((stay) =>
          rangesOverlap(
            reservation.checkInDate,
            reservation.checkOutDate,
            stay.reservation.checkInDate,
            stay.reservation.checkOutDate
          )
        );
        if (clash) {
          throw new CheckInError(
            `Room ${target.number} is already booked for these dates. Choose another room.`,
            409
          );
        }

        await tx.reservationRoom.update({
          where: { id: reservation.rooms[0].id },
          data: { roomId: target.id },
        });
        assignedRoom = { id: target.id, number: target.number };
      }

      if (assignedRoom) {
        const current = await tx.room.findUnique({
          where: { id_hotelId: { id: assignedRoom.id, hotelId } },
          select: { status: true, number: true },
        });
        if (current && !changingRoom && blocksGuestPlacement(current.status)) {
          throw new CheckInError(
            `Room ${current.number} is ${ROOM_STATUS_LABELS[current.status]}. Choose an available room, or ask housekeeping to finish it first.`,
            400
          );
        }
      }

      let nights: number;
      let required: number;
      const discount = Number(reservation.discount ?? 0);
      const snapshot = currentPriceVersion(reservation.priceSnapshots);
      try {
        nights = stayNights(reservation.checkInDate, reservation.checkOutDate);
        required = snapshot
          ? Number(snapshot.grandTotal)
          : accommodationRequired(
              reservation.rooms.map((room) => Number(room.rate)),
              nights,
              discount
            );
        if (!Number.isFinite(required) || required < 0) {
          throw new Error("The reservation charges are invalid.");
        }
      } catch (error) {
        throw new CheckInError(
          error instanceof Error ? error.message : "The accommodation charges are invalid.",
          400
        );
      }

      if (amountPaid > required) {
        throw new CheckInError(
          `Amount paid cannot exceed the required amount of KSh ${required.toLocaleString()}.`,
          400
        );
      }

      const method =
        amountPaid > 0
          ? await tx.paymentMethod.findFirst({
              where: { id: paymentMethodId, hotelId, isActive: true },
            })
          : null;
      if (amountPaid > 0 && !method) {
        throw new CheckInError("Choose an active payment method for the check-in payment.", 400);
      }

      const folio = await tx.folio.create({
        data: {
          hotelId,
          guestId: reservation.guestId,
          reservationId: reservation.id,
        },
      });

      let postedTotal = 0;
      for (const reservationRoom of reservation.rooms) {
        const unitPrice = Number(reservationRoom.rate);
        const roomNumber =
          assignedRoom && reservationRoom.roomId === reservation.rooms[0]?.roomId
            ? assignedRoom.number
            : reservationRoom.room.number;
        // The stored nightly rate is rounded to cents, which can lose pennies
        // over a multi-night stay. The frozen total is authoritative.
        const roomTotal = snapshot && reservation.rooms.length === 1
          ? roundMoney(Number(snapshot.roomTotal) + Number(snapshot.adjustmentsTotal))
          : roundMoney(unitPrice * nights);
        postedTotal = roundMoney(postedTotal + roomTotal);
        await tx.folioItem.create({
          data: {
            folioId: folio.id,
            type: "ROOM_CHARGE",
            description: `Room ${roomNumber} — ${nights} night(s)`,
            quantity: nights,
            unitPrice,
            taxRate: 0,
            total: roomTotal,
          },
        });
      }

      // Meals, extras and taxes were priced into the snapshot, so they are billed
      // as their own folio lines. Without this the folio would only contain the
      // room charge and the guest would appear to owe less than they were quoted.
      if (snapshot) {
        const breakdown = snapshot.breakdown as { lines?: Array<{ kind: string; label: string; amount: number; quantity: number; unitPrice: number }> } | null;
        if (!Array.isArray(breakdown?.lines)) throw new CheckInError("The frozen price breakdown is invalid. Check-in was not completed.", 409);
        const pricedLines = breakdown.lines;
        for (const line of pricedLines) {
          if (!line || typeof line.label !== "string" || typeof line.kind !== "string" || !Number.isFinite(line.amount)) {
            throw new CheckInError("The frozen price breakdown is invalid. Check-in was not completed.", 409);
          }
          if (line.kind === "ROOM" || line.kind === "ADJUSTMENT" || line.kind === "DISCOUNT") continue;
          // Inclusive tax lines are informational; the amount is already in the
          // room/meal charge. Exclusive tax lines still become folio charges.
          if (line.kind === "TAX" && line.label.endsWith(" (included)")) continue;
          if (line.amount === 0) continue;
          postedTotal = roundMoney(postedTotal + line.amount);
          await tx.folioItem.create({
            data: {
              folioId: folio.id,
              type: line.kind === "TAX" ? "TAX" : "OTHER_SERVICE",
              description: line.label,
              quantity: Math.max(1, Number(line.quantity) || 1),
              unitPrice: Number(line.unitPrice) || 0,
              // taxTotal is a monetary amount, not a percentage.
              taxRate: 0,
              total: Number(line.amount),
            },
          });
        }
      }

      const billingDiscount = snapshot ? Number(snapshot.discountTotal) : discount;
      if (billingDiscount > 0) {
        postedTotal = roundMoney(postedTotal - billingDiscount);
        await tx.folioItem.create({
          data: {
            folioId: folio.id,
            type: "DISCOUNT",
            description: "Discount",
            quantity: 1,
            unitPrice: billingDiscount,
            taxRate: 0,
            total: -billingDiscount,
          },
        });
      }

      if (!Number.isFinite(postedTotal) || Math.abs(roundMoney(postedTotal - required)) > 0.001) {
        throw new CheckInError("The frozen price does not match the folio charges. Check-in was not completed.", 409);
      }

      if (amountPaid > 0 && method) {
        await tx.payment.create({
          data: {
            hotelId,
            folioId: folio.id,
            paymentMethodId: method.id,
            amount: amountPaid,
            reference: reference || null,
            status: "COMPLETED",
            cashierId: tenant.userId,
          },
        });
      }

      await tx.reservation.update({
        where: { id_hotelId: { id: reservation.id, hotelId } },
        data: {
          status: "CHECKED_IN",
          paymentMode: method?.name ?? reservation.paymentMode,
        },
      });

      for (const reservationRoom of reservation.rooms) {
        const roomId =
          assignedRoom && reservationRoom.roomId === reservation.rooms[0]?.roomId
            ? assignedRoom.id
            : reservationRoom.roomId;
        await tx.room.update({
          where: { id_hotelId: { id: roomId, hotelId } },
          data: { status: "OCCUPIED" },
        });
      }

      return {
        folioId: folio.id,
        required,
        paid: amountPaid,
        balance: roundMoney(required - amountPaid),
      };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 15_000,
    }
  );
}

export interface CheckOutOptions {
  reservationId: string;
  allowOutstandingBalance?: boolean;
}

export async function executeCheckOut(tenant: TenantContext, options: CheckOutOptions) {
  const forbidden = requireRole(tenant.role, ROLE_GROUPS.GUEST_STAYS);
  if (forbidden) return forbidden;

  const hotelId = tenant.hotelId;
  const reservationId = options.reservationId ? String(options.reservationId).trim() : "";
  if (!reservationId) {
    throw new CheckOutError("Reservation is required.", 400);
  }

  const allowOutstandingBalance = options.allowOutstandingBalance === true;

  return await prisma.$transaction(
    async (tx) => {
      const lockKey = `hotel-${hotelId}-reservation-create`;
      await tx.$queryRaw<Array<{ locked: string }>>`
        SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked
      `;

      const reservation = await tx.reservation.findUnique({
        where: { id_hotelId: { id: reservationId, hotelId } },
        include: {
          rooms: true,
          folios: {
            where: { hotelId },
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

      if (!reservation) throw new CheckOutError("Reservation not found.", 404);
      if (reservation.status !== "CHECKED_IN") {
        throw new CheckOutError("Only a checked-in reservation can be checked out.", 400);
      }

      const openFolio = reservation.folios.find((folio) => !folio.isClosed);
      if (!openFolio) {
        throw new CheckOutError("No open folio was found for this reservation.", 400);
      }

      const totals = folioTotals(
        openFolio.items.map((item) => Number(item.total)),
        openFolio.payments.map((payment) => Number(payment.amount))
      );

      if (totals.balance > 0) {
        if (!allowOutstandingBalance) {
          throw new CheckOutError(
            `KSh ${totals.balance.toLocaleString()} is still due before checkout.`,
            409
          );
        }
        if (!hasRole(tenant.role, ROLE_GROUPS.MANAGEMENT)) {
          throw new CheckOutError(
            "Only an Admin or Manager can check out a guest with an unpaid balance.",
            403
          );
        }
      }

      await tx.folio.update({
        where: { id_hotelId: { id: openFolio.id, hotelId } },
        data: { isClosed: true },
      });

      await tx.reservation.update({
        where: { id_hotelId: { id: reservation.id, hotelId } },
        data: { status: "CHECKED_OUT" },
      });

      for (const reservationRoom of reservation.rooms) {
        await tx.room.update({
          where: { id_hotelId: { id: reservationRoom.roomId, hotelId } },
          data: { status: "DIRTY" },
        });

        await tx.housekeepingTask.create({
          data: {
            hotelId,
            roomId: reservationRoom.roomId,
            status: "NEEDS_CLEANING",
            priority: "normal",
          },
        });
      }

      await recordAudit(
        {
          hotelId,
          userId: tenant.userId,
          action: allowOutstandingBalance ? "CHECK_OUT_WITH_BALANCE" : "CHECK_OUT",
          entity: "Reservation",
          entityId: reservation.id,
          metadata: { folioId: openFolio.id, balance: totals.balance },
        },
        tx
      );

      return { folioId: openFolio.id, ...totals };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      timeout: 15_000,
    }
  );
}
