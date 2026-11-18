import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import FrontDeskClient from "@/components/frontdesk/FrontDeskClient";
import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";
import { isBookableToday } from "@/lib/room-status";
import {
  accommodationRequired,
  folioTotals,
  roundMoney,
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
  const totals = openFolio
    ? folioTotals(
        openFolio.items.map((item) => Number(item.total)),
        openFolio.payments.map((payment) => Number(payment.amount))
      )
    : (() => {
        const required = snapshot ? Number(snapshot.grandTotal) : accommodationRequired(
          reservation.rooms.map((room) => Number(room.rate)),
          stayNights(reservation.checkInDate, reservation.checkOutDate),
          Number(reservation.discount ?? 0)
        );
        return { required, paid: 0, balance: required };
      })();

  const rawLines = snapshot?.breakdown && typeof snapshot.breakdown === "object" && !Array.isArray(snapshot.breakdown)
    ? snapshot.breakdown.lines : null;
  const pricingLines = openFolio
    ? openFolio.items.map((item) => ({ label: item.description, amount: Number(item.total) }))
    : Array.isArray(rawLines)
      ? [
          ...rawLines.flatMap((line) => {
            if (!line || typeof line !== "object" || Array.isArray(line) || typeof line.label !== "string" || typeof line.amount !== "number" || !Number.isFinite(line.amount)) return [];
            return [{ label: line.label, amount: line.amount }];
          }),
          // Older custom/modular snapshots stored discountTotal but omitted its line.
          ...(Number(snapshot?.discountTotal ?? 0) > 0 && !rawLines.some((line) =>
            line && typeof line === "object" && !Array.isArray(line) && line.kind === "DISCOUNT"
          ) ? [{ label: "Discount", amount: -Number(snapshot!.discountTotal) }] : []),
        ]
      : !snapshot
        ? [
            ...reservation.rooms.map((room) => ({
              label: `Room ${room.room.number} — ${stayNights(reservation.checkInDate, reservation.checkOutDate)} night(s)`,
              amount: roundMoney(Number(room.rate) * stayNights(reservation.checkInDate, reservation.checkOutDate)),
            })),
            ...(Number(reservation.discount ?? 0) > 0 ? [{ label: "Discount", amount: -Number(reservation.discount) }] : []),
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
    nightlyRateTotal: roundMoney(
      reservation.rooms.reduce((sum, room) => sum + Number(room.rate), 0)
    ),
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
