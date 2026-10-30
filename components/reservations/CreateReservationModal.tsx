"use client";

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { apiErrorMessage, requestJson } from "@/lib/client-api";
import { addDays, isoDay } from "@/lib/dates";
import type { RoomStatus } from "@prisma/client";
import {
  isBookableToday,
  notBookableReason,
  roomStatusClasses,
  roomStatusDotClasses,
  ROOM_STATUS_LABELS,
  roomStatusRank,
} from "@/lib/room-status";
import {
  MEAL_PLAN_LABELS,
  MEAL_PLANS,
  OCCUPANCY_LABELS,
  OCCUPANCIES,
  resolveApprovedRate,
  type MealPlanCode,
  type Occupancy,
} from "@/lib/tariffs";

type Room = {
  id: string;
  number: string;
  roomTypeId?: string;
  roomTypeName: string;
  baseRate: number;
  status: RoomStatus;
};
type RoomTypeTariff = { id: string; name: string; baseRate: number | string; mealPlan: string | null };

function inputClass() {
  return "w-full rounded-control border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent";
}

/** Whole nights between two date-input values, or null when they are not a stay. */
function nightsBetween(checkIn: string, checkOut: string): number | null {
  const start = new Date(checkIn);
  const end = new Date(checkOut);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return null;
  const nights = Math.round((end.getTime() - start.getTime()) / 86_400_000);
  return Number.isInteger(nights) && nights >= 1 ? nights : null;
}

function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-KE", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // An unknown/blank currency code must not blank the screen.
    return `${currency} ${amount.toLocaleString()}`.trim();
  }
}

export default function CreateReservationModal({
  rooms,
  roomTypes,
  defaultRoomId,
  defaultDate,
  currency,
  canApplyDiscount,
  onClose,
  onCreated,
  onError,
}: {
  rooms: Room[];
  roomTypes: RoomTypeTariff[];
  defaultRoomId: string;
  defaultDate: Date;
  currency: string;
  canApplyDiscount: boolean;
  onClose: () => void;
  onCreated: (reservationId: string) => void;
  onError: (e: string | null) => void;
}) {
  // Captures the common hotel check-in details: guest identity, stay dates,
  // and room/tariff. Actual payment is recorded at check-in.
  const [guestName, setGuestName] = useState("");
  const [guestPhone, setGuestPhone] = useState("");
  const [idNumber, setIdNumber] = useState("");
  const [nationality, setNationality] = useState("");
  const [vehicleRegistration, setVehicleRegistration] = useState("");
  const [roomId, setRoomId] = useState(defaultRoomId);
  const [checkInDate, setCheckInDate] = useState(isoDay(defaultDate));
  const [checkOutDate, setCheckOutDate] = useState(isoDay(addDays(defaultDate, 1)));
  const [occupancy, setOccupancy] = useState<Occupancy>("SINGLE");
  const [mealPlan, setMealPlan] = useState<MealPlanCode>("BED_ONLY");
  const [adults, setAdults] = useState("1");
  const [children, setChildren] = useState("0");
  const [discount, setDiscount] = useState("");
  const [loading, setLoading] = useState(false);
  const tariffs = roomTypes;

  const room = rooms.find((r) => r.id === roomId);

  // The rate comes from the occupancy/meal-plan tariff when the hotel has one,
  // otherwise from the selected room's own room type. Both are resolved here and
  // re-derived on the server, so the figure on screen is never what is trusted.
  const approved = useMemo(
    () =>
      resolveApprovedRate({
        tariffs,
        occupancy,
        mealPlan,
        roomTypeId: room?.roomTypeId ?? null,
      }),
    [tariffs, occupancy, mealPlan, room?.roomTypeId]
  );
  const rate = approved.ok ? approved.rate : 0;
  const nights = nightsBetween(checkInDate, checkOutDate);
  const total = approved.ok && nights ? rate * nights : null;

  // Status is a "right now" fact, so it is enforced only when the stay starts
  // today -- a room being cleaned today says nothing about next month.
  const startsToday = checkInDate === isoDay(new Date());
  const selectable = (candidate: Room) => !startsToday || isBookableToday(candidate.status);
  const selectedRoomBlocked = room ? startsToday && !isBookableToday(room.status) : false;
  const roomsForPicker = useMemo(
    () =>
      [...rooms].sort(
        (left, right) =>
          roomStatusRank(left.status) - roomStatusRank(right.status) ||
          left.number.localeCompare(right.number, undefined, { numeric: true })
      ),
    [rooms]
  );

  // Everything the button depends on, phrased so the person can act on it.
  const problems: string[] = [];
  if (!guestName.trim()) problems.push("Enter the guest's full name.");
  if (!room) problems.push("Choose a room.");
  if (selectedRoomBlocked && room) {
    problems.push(`Room ${room.number} is ${ROOM_STATUS_LABELS[room.status]}. Choose an available room.`);
  }
  if (!checkInDate || !checkOutDate) {
    problems.push("Choose both a check-in and a check-out date.");
  } else if (!nights) {
    problems.push("Check-out must be at least one night after check-in.");
  }
  if (!Number.isInteger(Number(adults)) || Number(adults) < 1) {
    problems.push("Adults must be at least 1.");
  }
  if (!approved.ok) {
    problems.push(
      approved.reason === "NO_TARIFF"
        ? "This hotel has no nightly rate for the selected room. Set one on the Rooms page."
        : "The nightly rate for this room is not a valid amount. Correct it on the Rooms page."
    );
  }
  const canSubmit = problems.length === 0 && !loading;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // The button is disabled in these cases; this is the belt-and-braces path for
    // a submit that arrives anyway (Enter key, assistive tech, stale markup).
    if (!approved.ok || problems.length > 0) {
      onError(problems[0] ?? "Complete the reservation details before submitting.");
      return;
    }
    if (selectedRoomBlocked && room) {
      onError(`Room ${room.number} is ${ROOM_STATUS_LABELS[room.status]}. Choose an available room.`);
      return;
    }
    setLoading(true);
    onError(null);
    try {
      const data = await requestJson<{ id: string; code: string }>("/api/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          guestName,
          guestPhone,
          idNumber,
          nationality,
          vehicleRegistration,
          checkInDate: new Date(checkInDate).toISOString(),
          checkOutDate: new Date(checkOutDate).toISOString(),
          roomId,
          tariffId: approved.tariff.id,
          occupancy,
          mealPlan,
          adults: Number(adults) || 1,
          children: Number(children) || 0,
          discount: canApplyDiscount && discount ? Number(discount) : null,
        }),
      });
      onCreated(data.id);
      onClose();
    } catch (submitError) {
      onError(apiErrorMessage(submitError, "Could not create reservation."));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/30 p-4">
      <div className="card w-full max-w-md max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2>New Reservation</h2>
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary">
            <X size={18} />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-text-muted">Guest</p>
          <div>
            <label className="block text-sm font-medium mb-1.5">Full Name</label>
            <input value={guestName} onChange={(e) => setGuestName(e.target.value)} required className={inputClass()} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1.5">Phone</label>
              <input value={guestPhone} onChange={(e) => setGuestPhone(e.target.value)} className={inputClass()} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">National ID No.</label>
              <input value={idNumber} onChange={(e) => setIdNumber(e.target.value)} className={inputClass()} />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1.5">Nationality</label>
              <input value={nationality} onChange={(e) => setNationality(e.target.value)} className={inputClass()} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Vehicle Reg. (optional)</label>
              <input value={vehicleRegistration} onChange={(e) => setVehicleRegistration(e.target.value)} className={inputClass()} />
            </div>
          </div>

          <p className="text-xs font-medium uppercase tracking-wide text-text-muted pt-2">Stay</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1.5">Check-in</label>
              <input type="date" value={checkInDate} onChange={(e) => setCheckInDate(e.target.value)} required className={inputClass()} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Check-out</label>
              <input type="date" value={checkOutDate} onChange={(e) => setCheckOutDate(e.target.value)} required className={inputClass()} />
            </div>
          </div>
          <p className="text-xs text-text-muted">Check-out is strictly at 10:00 AM.</p>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1.5">Adults</label>
              <input type="number" min="1" value={adults} onChange={(e) => setAdults(e.target.value)} className={inputClass()} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Children</label>
              <input type="number" min="0" value={children} onChange={(e) => setChildren(e.target.value)} className={inputClass()} />
            </div>
          </div>

          <p className="text-xs font-medium uppercase tracking-wide text-text-muted pt-2">Room &amp; Tariff</p>

          <div>
            <div className="flex items-baseline justify-between mb-1.5">
              <label className="block text-sm font-medium">Room</label>
              {startsToday && <span className="text-xs text-text-muted">Status is as of now</span>}
            </div>
            <div className="grid grid-cols-2 gap-2 max-h-56 overflow-y-auto rounded-control border border-border p-2">
              {roomsForPicker.map((r) => {
                const usable = selectable(r);
                const chosen = r.id === roomId;
                return (
                  <button
                    type="button"
                    key={r.id}
                    disabled={!usable}
                    title={usable ? undefined : notBookableReason(r.status)}
                    onClick={() => setRoomId(r.id)}
                    className={[
                      "flex items-center justify-between gap-2 rounded-control border px-2.5 py-2 text-left",
                      chosen ? "border-primary-500 ring-1 ring-primary-500" : "border-border",
                      usable ? "hover:border-primary-300" : "opacity-60 cursor-not-allowed",
                    ].join(" ")}
                  >
                    <span className="text-sm font-medium">Room {r.number}</span>
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium ${roomStatusClasses(r.status)}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${roomStatusDotClasses(r.status)}`} />
                      {ROOM_STATUS_LABELS[r.status]}
                    </span>
                  </button>
                );
              })}
            </div>
            {selectedRoomBlocked && room && (
              <p className="text-xs text-danger mt-1.5">
                Room {room.number} is {ROOM_STATUS_LABELS[room.status]} — {notBookableReason(room.status)}{" "}
                Choose an available room.
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5">Occupancy</label>
            <select
              value={occupancy}
              onChange={(e) => setOccupancy(e.target.value as Occupancy)}
              className={inputClass()}
            >
              {OCCUPANCIES.map((option) => (
                <option key={option} value={option}>
                  {OCCUPANCY_LABELS[option]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-1.5">Meal Plan</label>
            <select
              value={mealPlan}
              onChange={(e) => setMealPlan(e.target.value as MealPlanCode)}
              className={inputClass()}
            >
              {MEAL_PLANS.map((option) => (
                <option key={option} value={option}>
                  {MEAL_PLAN_LABELS[option]}
                </option>
              ))}
            </select>
          </div>

          <div className={canApplyDiscount ? "grid grid-cols-2 gap-3" : ""}>
            <div>
              <label className="block text-sm font-medium mb-1.5" htmlFor="approved-rate">
                Approved rate per night ({currency})
              </label>
              <p
                id="approved-rate"
                data-testid="approved-rate"
                aria-live="polite"
                className={`${inputClass()} bg-bg font-medium`}
              >
                {approved.ok ? money(rate, currency) : "--"}
              </p>
              {approved.ok && (
                <p className="mt-1 text-xs text-text-muted" data-testid="approved-rate-source">
                  {approved.source === "OCCUPANCY_TARIFF"
                    ? `${approved.tariff.name} · ${MEAL_PLAN_LABELS[mealPlan]}`
                    : `${room?.roomTypeName ?? approved.tariff.name} room rate`}
                </p>
              )}
            </div>
            {canApplyDiscount && (
              <div>
                <label className="block text-sm font-medium mb-1.5">
                  Discount ({currency}, optional)
                </label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={discount}
                  onChange={(e) => setDiscount(e.target.value)}
                  className={inputClass()}
                />
              </div>
            )}
          </div>

          {approved.ok && total !== null && (
            <p className="text-sm text-text-secondary" data-testid="stay-total">
              {nights} night{nights === 1 ? "" : "s"} × {money(rate, currency)} ={" "}
              <span className="font-medium text-text-primary">{money(total, currency)}</span>
              {canApplyDiscount && discount ? " before discount" : ""}
            </p>
          )}

          {!canApplyDiscount && (
            <p className="text-xs text-text-muted">
              Only an owner, admin or manager can apply a discount.
            </p>
          )}

          {problems.length > 0 && (
            <div className="rounded-control border border-border bg-bg p-2.5" role="status">
              <p className="text-xs font-medium text-text-primary mb-1">
                To create this reservation:
              </p>
              <ul className="list-disc pl-4 text-xs text-text-secondary space-y-0.5">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}

          <button type="submit" disabled={!canSubmit} className="btn-primary w-full mt-2">
            {loading ? "Creating..." : "Create Reservation"}
          </button>
        </form>
      </div>
    </div>
  );
}