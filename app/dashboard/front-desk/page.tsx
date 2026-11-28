import Decimal from "decimal.js";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import FrontDeskClient from "@/components/frontdesk/FrontDeskClient";
import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";
import { isBookableToday } from "@/lib/room-status";
import {
  accommodationRequiredExact,
  folioTotalsExact,
  roundMoneyDecimal,
  stayNights,
} from "@/lib/billing";

export const dynamic = "force-dynamic";

function frontDeskInclude(hotelId: string) {
  return {
    guest: true,
    priceSnapshots: { where: { hotelId }, orderBy: { version: "desc" }, take: 1 },
    // ReservationRoom itself has no hotelId, so constrain the related Room as
    // well as the parent Reservation to avoid serializing an invalid cross-tenant link.
    rooms: {
      where: { room: { is: { hotelId } } },
      include: { room: true },
    },
    folios: {
      where: { hotelId },
      include: {
        items: { select: { description: true, total: true } },
        payments: {
          where: { hotelId, status: "COMPLETED" },
          select: { amount: true },
        },
      },
    },
  } satisfies Prisma.ReservationInclude;
}

type FrontDeskReservation = Prisma.ReservationGetPayload<{
  include: ReturnType<typeof frontDeskInclude>;
}>;

function startOfToday() {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function endOfToday() {
  const date = startOfToday();
  date.setDate(date.getDate() + 1);
  return date;
}

function serializeReservation(reservation: FrontDeskReservation) {
  const openFolio = reservation.folios.find((folio) => !folio.isClosed);
  const snapshot = reservation.priceSnapshots?.[0];
  const nights = stayNights(reservation.checkInDate, reservation.checkOutDate);
  const exactTotals = openFolio
    ? folioTotalsExact(
        openFolio.items.map((item) => String(item.total)),
        openFolio.payments.map((payment) => String(payment.amount))
      )
    : (() => {
        const required = snapshot
          ? new Decimal(String(snapshot.grandTotal))
          : accommodationRequiredExact(
              reservation.rooms.map((room) => String(room.rate)),
              nights,
              String(reservation.discount ?? 0)
            );
        return { required, paid: new Decimal(0), balance: required };
      })();
  const totals = {
    required: exactTotals.required.toNumber(),
    paid: exactTotals.paid.toNumber(),
    balance: exactTotals.balance.toNumber(),
  };

  const rawLines = snapshot?.breakdown && typeof snapshot.breakdown === "object" && !Array.isArray(snapshot.breakdown)
    ? snapshot.breakdown.lines : null;
  const reservationDiscount = new Decimal(String(reservation.discount ?? 0));
  const snapshotDiscount = new Decimal(String(snapshot?.discountTotal ?? 0));
  const pricingLines = openFolio
    ? openFolio.items.map((item) => ({ label: item.description, amount: Number(item.total) }))
    : Array.isArray(rawLines)
      ? [
          ...rawLines.flatMap((line) => {
            if (!line || typeof line !== "object" || Array.isArray(line) || typeof line.label !== "string" || typeof line.amount !== "number" || !Number.isFinite(line.amount)) return [];
            return [{ label: line.label, amount: line.amount }];
          }),
          // Older custom/modular snapshots stored discountTotal but omitted its line.
          ...(snapshotDiscount.gt(0) && !rawLines.some((line) =>
            line && typeof line === "object" && !Array.isArray(line) && line.kind === "DISCOUNT"
          ) ? [{ label: "Discount", amount: snapshotDiscount.neg().toNumber() }] : []),
        ]
      : !snapshot
        ? [
            ...reservation.rooms.map((room) => ({
              label: `Room ${room.room.number} — ${nights} night(s)`,
              amount: roundMoneyDecimal(new Decimal(String(room.rate)).mul(nights)).toNumber(),
            })),
            ...(reservationDiscount.gt(0) ? [{ label: "Discount", amount: reservationDiscount.neg().toNumber() }] : []),
          ]
        : [];

  return {
    id: reservation.id,
    code: reservation.code,
    guestName: reservation.guest.fullName,
    checkInDate: reservation.checkInDate.toISOString(),
    checkOutDate: reservation.checkOutDate.toISOString(),
    roomId: reservation.rooms[0]?.room.id ?? "",
    roomNumbers: reservation.rooms.map((room) => room.room.number).join(", "),
    openFolioId: openFolio?.id ?? null,
    hasFolio: reservation.folios.length > 0,
    pricingLines,
    requiredAmount: totals.required,
    paidAmount: totals.paid,
    balance: totals.balance,
    nightlyRateTotal: roundMoneyDecimal(
      reservation.rooms.reduce((sum, room) => sum.plus(String(room.rate)), new Decimal(0))
    ).toNumber(),
  };
}

export default async function FrontDeskPage() {
  const session = await requirePageRole(ROLE_GROUPS.FRONT_DESK, "RESERVATIONS");
  const todayStart = startOfToday();
  const todayEnd = endOfToday();

  const [reservations, rooms, roomTypes] = await Promise.all([
    prisma.reservation.findMany({
      relationLoadStrategy: "join",
      where: {
        hotelId: session.hotelId,
        OR: [
          {
            checkInDate: { gte: todayStart, lt: todayEnd },
            status: { in: ["CONFIRMED", "PENDING"] },
          },
          { status: "CHECKED_IN" },
        ],
      },
      include: frontDeskInclude(session.hotelId),
      orderBy: { checkInDate: "asc" },
    }),
    prisma.room.findMany({
      relationLoadStrategy: "join",
      // Retired rooms keep their history but are not part of the rooms a guest
      // can be given, so they never appear on the board.
      where: { hotelId: session.hotelId, isActive: true },
      include: { roomType: true },
      orderBy: { number: "asc" },
    }),
    prisma.roomType.findMany({
      where: { hotelId: session.hotelId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, baseRate: true, mealPlan: true, maxAdults: true, maxChildren: true, extraAdultFee: true },
    }),
  ]);

  const arrivals = reservations.filter(
    (reservation) =>
      (reservation.status === "CONFIRMED" || reservation.status === "PENDING") &&
      reservation.checkInDate >= todayStart &&
      reservation.checkInDate < todayEnd
  );
  const inHouse = reservations.filter(
    (reservation) => reservation.status === "CHECKED_IN"
  );
  const departures = inHouse
    .filter(
      (reservation) =>
        reservation.checkOutDate >= todayStart &&
        reservation.checkOutDate < todayEnd
    )
    .sort(
      (left, right) =>
        left.checkOutDate.getTime() - right.checkOutDate.getTime()
    );

  return (
    <FrontDeskClient
      activeTenantId={session.hotelId}
      currentUserRole={session.role}
      currency={session.hotel.currency}
      arrivals={arrivals.map(serializeReservation)}
      departures={departures.map(serializeReservation)}
      inHouse={inHouse.map(serializeReservation)}
      availableRoomsCount={rooms.filter((room) => isBookableToday(room.status)).length}
      roomTypes={roomTypes.map((type) => ({ ...type, baseRate: Number(type.baseRate), extraAdultFee: Number(type.extraAdultFee) }))}
      rooms={rooms.map((room) => ({
        id: room.id,
        number: room.number,
        roomTypeId: room.roomTypeId,
        floor: room.floor,
        status: room.status,
        roomTypeName: room.roomType.name,
        baseRate: Number(room.roomType.baseRate),
      }))}
    />
  );
}
