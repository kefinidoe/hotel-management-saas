"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { ChevronLeft, ChevronRight, Plus, X } from "lucide-react";
import clsx from "clsx";
import type { HotelRole } from "@prisma/client";
import { startOfWeek, addDays, isoDay } from "@/lib/dates";
import { hasRole, ROLE_GROUPS } from "@/lib/permissions";
import type { RoomStatus } from "@prisma/client";
import CreateReservationModal from "./CreateReservationModal";
import { apiErrorMessage, requestJson } from "@/lib/client-api";

type Room = { id: string; number: string; roomTypeName: string; baseRate: number; status: RoomStatus };
type Reservation = {
  id: string;
  code: string;
  status: string;
  checkInDate: string;
  checkOutDate: string;
  guestName: string;
  guestPhone: string | null;
  rooms: { roomId: string; roomNumber: string; rate: number }[];
};

type ReservationMutationError = {
  weekOffset: number;
  weekLabel: string;
  message: string;
};

const RESERVATION_STATUSES = new Set([
  "PENDING",
  "CONFIRMED",
  "CHECKED_IN",
  "CHECKED_OUT",
  "CANCELLED",
  "NO_SHOW",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T.*)?$/.test(value)) return false;
  const datePart = value.slice(0, 10);
  const normalizedDay = new Date(`${datePart}T00:00:00.000Z`);
  return Number.isFinite(Date.parse(value)) &&
    Number.isFinite(normalizedDay.getTime()) &&
    normalizedDay.toISOString().slice(0, 10) === datePart;
}

function isReservationRecord(value: unknown): value is Reservation {
  if (!isObject(value)) return false;
  if (
    typeof value.id !== "string" || !value.id.trim() || value.id !== value.id.trim() ||
    typeof value.code !== "string" || !value.code.trim() ||
    typeof value.status !== "string" || !RESERVATION_STATUSES.has(value.status) ||
    typeof value.guestName !== "string" || !value.guestName.trim() ||
    !(value.guestPhone === null || typeof value.guestPhone === "string") ||
    !isValidCalendarDate(value.checkInDate) ||
    !isValidCalendarDate(value.checkOutDate) ||
    new Date(value.checkOutDate).getTime() <= new Date(value.checkInDate).getTime() ||
    !Array.isArray(value.rooms) || value.rooms.length === 0
  ) {
    return false;
  }

  const roomIds = new Set<string>();
  return value.rooms.every((room) => {
    if (
      !isObject(room) ||
      typeof room.roomId !== "string" || !room.roomId.trim() || room.roomId !== room.roomId.trim() ||
      typeof room.roomNumber !== "string" || !room.roomNumber.trim() ||
      typeof room.rate !== "number" || !Number.isFinite(room.rate) || room.rate < 0 ||
      roomIds.has(room.roomId)
    ) {
      return false;
    }
    roomIds.add(room.roomId);
    return true;
  });
}

function isReservationList(value: unknown): value is Reservation[] {
  if (!Array.isArray(value)) return false;
  const ids = new Set<string>();
  return value.every((reservation) => {
    if (!isReservationRecord(reservation) || ids.has(reservation.id)) return false;
    ids.add(reservation.id);
    return true;
  });
}

function isLoadedCalendarRoom(value: unknown): value is Room {
  return isObject(value) &&
    typeof value.id === "string" && Boolean(value.id.trim()) && value.id === value.id.trim() &&
    typeof value.number === "string" && Boolean(value.number.trim());
}

function canEditReservation(status: string) {
  return status === "PENDING" || status === "CONFIRMED";
}

function statusBarClasses(status: string) {
  switch (status) {
    case "CHECKED_IN":
      return "bg-primary-500 text-white";
    case "CONFIRMED":
      return "bg-primary-100 text-primary-700 border border-primary-300";
    case "PENDING":
      return "bg-accent-200 text-text-primary";
    default:
      return "bg-bg text-text-secondary border border-border";
  }
}

export default function ReservationsClient({
  rooms,
  roomTypes,
  currentUserRole,
}: {
  rooms: Room[];
  roomTypes: { id: string; name: string; baseRate: number; mealPlan: string | null }[];
  currentUserRole: HotelRole;
}) {
  const canApplyDiscount = hasRole(currentUserRole, ROLE_GROUPS.MANAGEMENT);
  const [weekOffset, setWeekOffset] = useState(0);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<ReservationMutationError | null>(null);
  const [savingReservationId, setSavingReservationId] = useState<string | null>(null);
  const [createFor, setCreateFor] = useState<{ roomId: string; date: Date; weekOffset: number; weekLabel: string } | null>(null);
  const calendarRequestSequence = useRef(0);
  const weekOffsetRef = useRef(0);

  const weekStart = startOfWeek(addDays(new Date(), weekOffset * 7));
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const weekEnd = addDays(weekStart, 7);

  function formatWeekLabel(date: Date) {
    return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  }

  function reportMutationError(
    message: string,
    actionWeekOffset = weekOffset,
    actionWeekLabel = formatWeekLabel(weekStart),
  ) {
    setMutationError({ weekOffset: actionWeekOffset, weekLabel: actionWeekLabel, message });
  }

  function changeWeek(delta: number) {
    const nextWeekOffset = weekOffsetRef.current + delta;
    weekOffsetRef.current = nextWeekOffset;
    calendarRequestSequence.current += 1;
    setReservations([]);
    setError(null);
    setLoading(true);
    setWeekOffset(nextWeekOffset);
  }

  const load = useCallback(async () => {
    const requestedWeekOffset = weekOffset;
    if (requestedWeekOffset !== weekOffsetRef.current) return;
    const requestId = ++calendarRequestSequence.current;
    setLoading(true);
    setError(null);
    setReservations([]);
    try {
      const data = await requestJson<unknown>(
        `/api/reservations?from=${isoDay(weekStart)}&to=${isoDay(weekEnd)}`,
      );
      if (requestId !== calendarRequestSequence.current || requestedWeekOffset !== weekOffsetRef.current) return;
      if (!isReservationList(data)) {
        throw new Error("The server returned invalid reservation data. Refresh the calendar and try again.");
      }
      const weekStartTime = weekStart.getTime();
      const weekEndTime = weekEnd.getTime();
      setReservations(data.filter((reservation) =>
        new Date(reservation.checkInDate).getTime() < weekEndTime &&
        new Date(reservation.checkOutDate).getTime() > weekStartTime
      ));
    } catch (loadError) {
      if (requestId === calendarRequestSequence.current && requestedWeekOffset === weekOffsetRef.current) {
        setError(apiErrorMessage(loadError, "Could not load reservations."));
      }
    } finally {
      if (requestId === calendarRequestSequence.current && requestedWeekOffset === weekOffsetRef.current) {
        setLoading(false);
      }
    }
  }, [weekOffset]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
  }, [load]);

  function barsForRoom(roomId: string) {
    const weekStartTime = weekStart.getTime();
    const weekEndTime = weekEnd.getTime();
    return reservations
      .filter((r) => r.rooms.some((rr) => rr.roomId === roomId) && r.status !== "CANCELLED" && r.status !== "NO_SHOW")
      .filter((r) => new Date(r.checkInDate).getTime() < weekEndTime && new Date(r.checkOutDate).getTime() > weekStartTime)
      .map((r) => {
        const checkIn = new Date(r.checkInDate);
        const checkOut = new Date(r.checkOutDate);
        const rawStartCol = Math.round((checkIn.getTime() - weekStartTime) / 86400000);
        const rawEndCol = Math.round((checkOut.getTime() - weekStartTime) / 86400000);
        const startCol = Math.max(0, Math.min(6, rawStartCol));
        const endCol = Math.max(0, Math.min(7, rawEndCol));
        return { reservation: r, startCol, span: Math.max(1, endCol - startCol) };
      })
      .filter((bar) => bar.span > 0 && bar.startCol < 7);
  }

  async function handleDrop(targetRoomId: string, targetCol: number, e: React.DragEvent) {
    e.preventDefault();
    if (savingReservationId) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(e.dataTransfer.getData("text/plain"));
    } catch {
      reportMutationError("Could not read the dragged reservation. Refresh the calendar and try again.");
      return;
    }
    if (!isObject(parsed)) {
      reportMutationError("The dragged reservation data is incomplete. Refresh the calendar and try again.");
      return;
    }

    const draggedId = parsed.id;
    const sourceRoomId = parsed.sourceRoomId;
    const originalStartCol = parsed.originalStartCol;
    if (
      typeof draggedId !== "string" || !draggedId.trim() ||
      typeof sourceRoomId !== "string" || !sourceRoomId.trim() ||
      typeof originalStartCol !== "number" || !Number.isInteger(originalStartCol) ||
      originalStartCol < 0 || originalStartCol > 6
    ) {
      reportMutationError("The dragged reservation data is incomplete or invalid. Refresh the calendar and try again.");
      return;
    }

    const reservation = reservations.find((item) => item.id === draggedId);
    if (!reservation) {
      reportMutationError("That reservation is no longer on the loaded calendar. Refresh and try again.");
      return;
    }
    const sourceRoom = rooms.find((room) => isLoadedCalendarRoom(room) && room.id === sourceRoomId);
    const targetRoom = rooms.find((room) => isLoadedCalendarRoom(room) && room.id === targetRoomId);
    const sourceBar = sourceRoom ? barsForRoom(sourceRoom.id).find((bar) => bar.reservation.id === reservation.id) : undefined;
    if (!sourceBar || !reservation.rooms.some((room) => room.roomId === sourceRoomId) || sourceBar.startCol !== originalStartCol) {
      reportMutationError("The reservation's source position is no longer valid. Refresh the calendar and try again.");
      return;
    }
    if (!targetRoom || !Number.isInteger(targetCol) || targetCol < 0 || targetCol > 6) {
      reportMutationError("The target room or date is no longer available on the loaded calendar. Refresh and try again.");
      return;
    }

    const originalCheckIn = new Date(reservation.checkInDate);
    const originalCheckOut = new Date(reservation.checkOutDate);
    const dayDelta = targetCol - sourceBar.startCol;
    const newCheckIn = addDays(originalCheckIn, dayDelta);
    const newCheckOut = addDays(originalCheckOut, dayDelta);
    if (!Number.isFinite(newCheckIn.getTime()) || !Number.isFinite(newCheckOut.getTime())) {
      reportMutationError("The reservation dates are invalid. Refresh the calendar and try again.");
      return;
    }

    const actionWeekOffset = weekOffset;
    const actionWeekLabel = formatWeekLabel(weekStart);
    setSavingReservationId(reservation.id);
    setMutationError(null);
    try {
      await requestJson<{ id: string }>(`/api/reservations/${encodeURIComponent(reservation.id)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          checkInDate: newCheckIn.toISOString(),
          checkOutDate: newCheckOut.toISOString(),
          roomId: targetRoom.id,
        }),
      });
      await load();
    } catch (mutationError) {
      reportMutationError(
        apiErrorMessage(mutationError, "Could not move reservation."),
        actionWeekOffset,
        actionWeekLabel,
      );
    } finally {
      setSavingReservationId(null);
    }
  }

  async function cancelReservation(id: string) {
    if (savingReservationId || !confirm("Cancel this reservation?")) return;
    const actionWeekOffset = weekOffset;
    const actionWeekLabel = formatWeekLabel(weekStart);
    setSavingReservationId(id);
    setMutationError(null);
    try {
      await requestJson<{ id: string; status: string }>(`/api/reservations/${id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "CANCELLED" }),
      });
      await load();
    } catch (mutationError) {
      reportMutationError(
        apiErrorMessage(mutationError, "Could not cancel the reservation."),
        actionWeekOffset,
        actionWeekLabel,
      );
    } finally {
      setSavingReservationId(null);
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1>Reservations</h1>
          <p className="text-text-secondary text-sm mt-1">
            Drag a booking to a different day or room. Click an empty slot to create a new one.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button aria-label="Previous week" onClick={() => changeWeek(-1)} className="btn-secondary px-2">
            <ChevronLeft size={16} />
          </button>
          <span className="text-sm font-medium w-40 text-center">
            {weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} –{" "}
            {addDays(weekStart, 6).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </span>
          <button aria-label="Next week" onClick={() => changeWeek(1)} className="btn-secondary px-2">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {error && (
        <div role="alert" data-testid="calendar-load-error" className="text-sm text-danger bg-danger/5 border border-danger/20 rounded-control px-3 py-2 mb-4 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button type="button" onClick={load} disabled={loading} className="underline disabled:opacity-50">
            Retry
          </button>
        </div>
      )}

      {mutationError && (
        <div
          role="alert"
          data-testid="reservation-mutation-error"
          className="text-sm text-danger bg-danger/5 border border-danger/20 rounded-control px-3 py-2 mb-4 flex items-center justify-between gap-3"
        >
          <span>
            Reservation change failed for the week of {mutationError.weekLabel}: {mutationError.message}
          </span>
          <div className="flex shrink-0 items-center gap-3">
            {mutationError.weekOffset !== weekOffsetRef.current && (
              <button
                type="button"
                onClick={() => changeWeek(mutationError.weekOffset - weekOffsetRef.current)}
                className="underline"
              >
                View affected week
              </button>
            )}
            <button type="button" onClick={load} disabled={loading} className="underline disabled:opacity-50">
              Refresh calendar
            </button>
            <button type="button" onClick={() => setMutationError(null)} className="underline">
              Dismiss
            </button>
          </div>
        </div>
      )}

      <div className="card p-0 overflow-x-auto">
        <div className="min-w-[720px]">
          {/* Day header */}
          <div className="grid grid-cols-[120px_repeat(7,1fr)] border-b border-border">
            <div className="p-3 text-xs font-medium text-text-muted uppercase">Room</div>
            {days.map((d) => (
              <div key={d.toISOString()} className="p-3 text-center border-l border-border">
                <p className="text-xs text-text-muted uppercase">
                  {d.toLocaleDateString(undefined, { weekday: "short" })}
                </p>
                <p className="text-sm font-medium">{d.getDate()}</p>
              </div>
            ))}
          </div>

          {rooms.map((room) => (
            <div key={room.id} className="grid grid-cols-[120px_repeat(7,1fr)] border-b border-border last:border-0">
              <div className="p-3 border-r border-border">
                <p className="text-sm font-medium">{room.number}</p>
                <p className="text-xs text-text-secondary">{room.roomTypeName}</p>
              </div>

              <div className="relative col-span-7" style={{ height: 56 }}>
                <div className="absolute inset-0 grid grid-cols-7">
                  {days.map((d, colIndex) => (
                    <div
                      key={colIndex}
                      role="gridcell"
                      aria-label={`Room ${room.number}, ${isoDay(d)}`}
                      className="border-l border-border hover:bg-primary-50/40 cursor-pointer"
                      onClick={() => setCreateFor({
                        roomId: room.id,
                        date: d,
                        weekOffset,
                        weekLabel: formatWeekLabel(weekStart),
                      })}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => handleDrop(room.id, colIndex, e)}
                    />
                  ))}
                </div>

                {barsForRoom(room.id).map(({ reservation, startCol, span }) => (
                  <div
                    key={reservation.id}
                    draggable={canEditReservation(reservation.status) && savingReservationId !== reservation.id}
                    onDragStart={(e) => {
                      if (!canEditReservation(reservation.status)) return;
                      e.dataTransfer.setData(
                        "text/plain",
                        JSON.stringify({
                          id: reservation.id,
                          sourceRoomId: room.id,
                          originalStartCol: startCol,
                        })
                      );
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (canEditReservation(reservation.status) && !savingReservationId) {
                        void cancelReservation(reservation.id);
                      }
                    }}
                    title={
                      canEditReservation(reservation.status)
                        ? `${reservation.guestName} — ${reservation.code} (click to cancel)`
                        : `${reservation.guestName} — ${reservation.code} (manage from Front Desk)`
                    }
                    className={clsx(
                      "absolute top-1.5 bottom-1.5 rounded-control px-2 py-1 text-xs font-medium truncate",
                      canEditReservation(reservation.status) ? "cursor-grab" : "cursor-default",
                      statusBarClasses(reservation.status)
                    )}
                    style={{
                      left: `${(startCol / 7) * 100}%`,
                      width: `calc(${(span / 7) * 100}% - 4px)`,
                    }}
                  >
                    {reservation.guestName}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {rooms.length === 0 && (
            <p className="p-6 text-sm text-text-secondary">Add rooms first, then reservations can be created here.</p>
          )}
          {!loading && !error && rooms.length > 0 && reservations.length === 0 && (
            <p className="p-6 text-sm text-text-secondary">No reservations overlap this week.</p>
          )}
        </div>
      </div>

      {loading && <p className="text-sm text-text-secondary mt-3">Loading...</p>}

      {createFor && (
        <CreateReservationModal
          rooms={rooms}
          roomTypes={roomTypes}
          defaultRoomId={createFor.roomId}
          defaultDate={createFor.date}
          canApplyDiscount={canApplyDiscount}
          onClose={() => setCreateFor(null)}
          onCreated={load}
          onError={(message) => {
            if (message === null) {
              setMutationError(null);
              return;
            }
            reportMutationError(message, createFor.weekOffset, createFor.weekLabel);
          }}
        />
      )}
    </div>
  );
}
