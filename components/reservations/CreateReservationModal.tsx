"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { ApiRequestError, apiErrorMessage, requestJson } from "@/lib/client-api";
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
  tariffPricesStay,
  type MealPlanCode,
  type Occupancy,
} from "@/lib/tariffs";
import { calculateCustomNightlyRate } from "@/lib/pricing/custom-rate-rules";
import type { PriceBreakdown } from "@/lib/pricing/types";
import { calculateUniversalNightlyRate, UNIVERSAL_MEAL_PLAN_LABELS, type HotelMealRate, type UniversalMealPlan } from "@/lib/pricing";

type CustomMeal = { id: string; name: string; pricePerNight: number; perGuest: boolean; isActive: boolean };
type CustomOccupancy = { id: string; label: string; includedAdults: number; surchargeAmount: number; extraAdultRate: number; isActive: boolean };

type Room = {
  id: string;
  number: string;
  roomTypeId?: string;
  roomTypeName: string;
  baseRate: number;
  status: RoomStatus;
};
type RoomTypeTariff = { id: string; name: string; baseRate: number | string; mealPlan: string | null; capacity?: number | null; maxAdults?: number; maxChildren?: number; extraAdultFee?: number | string };

type QuoteResponse = PriceBreakdown & {
  roomId: string;
  roomNumber: string;
  availableOccupancies: {
    id: string;
    name: string;
    minAdults: number;
    maxAdults: number;
    nightlyRate: number;
  }[];
  availableMealPlans: { id: string; name: string; pricingBasis: string; charge: number }[];
};

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

const BASIS_LABELS: Record<string, string> = {
  PER_PERSON_PER_NIGHT: "per person / night",
  PER_ROOM_PER_NIGHT: "per room / night",
  PER_PERSON_PER_STAY: "per person / stay",
  PER_ROOM_PER_STAY: "per room / stay",
};

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
  // Captures the common hotel check-in details: guest identity, stay dates, and
  // room/occupancy/meal plan. Server quotes remain authoritative; a local
  // estimate is only a fallback and is never submitted as an approved price.
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
  const [occupancyTypeId, setOccupancyTypeId] = useState("");
  const [mealPlanId, setMealPlanId] = useState("");
  const [adults, setAdults] = useState("1");
  const [children, setChildren] = useState("0");
  const [extraBeds, setExtraBeds] = useState("0");
  const [discount, setDiscount] = useState("");
  const [loading, setLoading] = useState(false);
  const [custom, setCustom] = useState(false);
  const [customMeals, setCustomMeals] = useState<CustomMeal[]>([]);
  const [customOccupancies, setCustomOccupancies] = useState<CustomOccupancy[]>([]);
  const [modular, setModular] = useState<boolean | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);
  const [modularMeals, setModularMeals] = useState<HotelMealRate[]>([]);
  const [modularMealPlan, setModularMealPlan] = useState<UniversalMealPlan | "">("");
  const [quoteResult, setQuote] = useState<{ key: string; data: QuoteResponse } | null>(null);
  // The options the server offered for the current room type. Kept separately
  // from the quote so a failing price (bad dates, capacity) does not blank the
  // occupancy/meal-plan pickers — that is exactly when they are needed.
  const [catalog, setCatalog] = useState<{
    roomTypeId: string;
    pricingModel: string;
    occupancies: QuoteResponse["availableOccupancies"];
    mealPlans: QuoteResponse["availableMealPlans"];
  } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteRefusal, setQuoteRefusal] = useState(false);
  const [quoting, setQuoting] = useState(false);
  const tariffs = roomTypes;

  useEffect(() => {
    let cancelled = false;
    async function loadMode() {
      try {
        const mode = await requestJson<{ useModularPricing: boolean; useCustomRateRules?: boolean }>("/api/settings/hotel");
        if (typeof mode.useModularPricing !== "boolean") throw new Error("Invalid pricing mode response.");
        const customEnabled = mode.useCustomRateRules === true;
        const rules = customEnabled ? await requestJson<{ mealPlanRates: CustomMeal[]; occupancyRateRules: CustomOccupancy[] }>("/api/settings/pricing/rules") : null;
        const meals = mode.useModularPricing && !customEnabled ? await requestJson<HotelMealRate[]>("/api/settings/meals") : [];
        if (cancelled) return;
        if (!Array.isArray(meals)) throw new Error("Invalid meal pricing response.");
        if (rules) {
          if (!Array.isArray(rules.mealPlanRates) || !Array.isArray(rules.occupancyRateRules)) throw new Error("Invalid pricing rules response.");
          const activeMeals = rules.mealPlanRates.filter((row) => row.isActive);
          const activeOccupancies = rules.occupancyRateRules.filter((row) => row.isActive);
          setCustomMeals(activeMeals); setCustomOccupancies(activeOccupancies);
          setMealPlanId(activeMeals[0]?.id ?? ""); setOccupancyTypeId(activeOccupancies[0]?.id ?? "");
        }
        setCustom(customEnabled);
        setModularMeals(meals);
        setModularMealPlan(meals.find((row) => row.isActive)?.mealPlan ?? "");
        setModular(mode.useModularPricing && !customEnabled);
      } catch (error) {
        if (!cancelled) setModeError(apiErrorMessage(error, "Could not load pricing settings."));
      }
    }
    void loadMode();
    return () => { cancelled = true; };
  }, []);

  const room = rooms.find((r) => r.id === roomId);
  const nights = nightsBetween(checkInDate, checkOutDate);

  // Status is a "right now" fact, so it is enforced only when the stay starts
  // today — a room being cleaned today says nothing about next month.
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

  // ---------------------------------------------------------------------
  // Live quote. Re-runs whenever any priced input changes, so changing the room,
  // occupancy, meal plan, guests or dates updates every amount immediately.
  // ---------------------------------------------------------------------
  const quoteSequence = useRef(0);
  const requestKey = JSON.stringify({
    roomId,
    occupancyTypeId,
    mealPlanId,
    modular,
    custom,
    modularMealPlan,
    checkInDate,
    checkOutDate,
    adults,
    children,
    extraBeds,
    discount: canApplyDiscount ? discount : "",
  });

  const quote = quoteResult?.key === requestKey ? quoteResult.data : null;

  useEffect(() => {
    const sequence = ++quoteSequence.current;
    if (!room || !nights || modular === null || (modular && !modularMealPlan) || (custom && (!occupancyTypeId || !mealPlanId))) {
      setQuote(null);
      setQuoteError(null);
      setQuoting(false);
      return;
    }
    // Adopting a default already included in the server response changes the
    // request key, but does not require another quote for the same selection.
    if (quoteResult?.key === requestKey) {
      setQuoting(false);
      return;
    }
    setQuote(null);
    setQuoteError(null);
    setQuoteRefusal(false);
    setQuoting(true);
    const timer = setTimeout(async () => {
      try {
        const data = await requestJson<QuoteResponse>("/api/reservations/quote", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            roomId,
            mealPlanCode: modular ? modularMealPlan : undefined,
            occupancyTypeId: occupancyTypeId || undefined,
            mealPlanId: mealPlanId || undefined,
            checkInDate: new Date(checkInDate).toISOString(),
            checkOutDate: new Date(checkOutDate).toISOString(),
            adults: Number(adults) || 1,
            children: Number(children) || 0,
            extraBeds: Number(extraBeds) || 0,
            discount: canApplyDiscount && discount ? Number(discount) : undefined,
          }),
        });
        if (sequence !== quoteSequence.current) return;
        const resolvedKey = JSON.stringify({
          roomId,
          occupancyTypeId: occupancyTypeId || data.occupancyTypeId || "",
          mealPlanId: mealPlanId || data.mealPlanId || "",
          modular,
          custom,
          modularMealPlan,
          checkInDate, checkOutDate, adults, children, extraBeds,
          discount: canApplyDiscount ? discount : "",
        });
        setQuote({ key: resolvedKey, data });
        setQuoteError(null);
        setCatalog({
          roomTypeId: room.roomTypeId ?? "",
          pricingModel: data.pricingModel,
          occupancies: data.availableOccupancies,
          mealPlans: data.availableMealPlans,
        });
        // Adopt the server's defaults on the first quote so the selects always
        // show something that is actually configured.
        if (!custom && !occupancyTypeId && data.occupancyTypeId) setOccupancyTypeId(data.occupancyTypeId);
        if (!custom && !mealPlanId && data.mealPlanId) setMealPlanId(data.mealPlanId);
      } catch (error) {
        if (sequence !== quoteSequence.current) return;
        const message = apiErrorMessage(error, "Could not price this stay.");
        // The chosen occupancy may no longer fit — the receptionist changed the
        // guest count. Drop the selection and let the server pick a fitting
        // option rather than insisting on one it just refused. Anything that
        // still fails is reported by the next quote.
        if (
          !custom && occupancyTypeId &&
          /allows \d+[-–]\d+ adults|is not sold as|no nightly rate|not available in this hotel/i.test(message)
        ) {
          setOccupancyTypeId("");
          setQuoteError(null);
          return;
        }
        setQuote(null);
        setQuoteError(message);
        // Missing pricing setup is not a reason to hide a usable room-base
        // estimate. The reservation endpoint still prices and validates the
        // booking itself; it may reject this attempt with the same message.
        const missingPricing = error instanceof ApiRequestError && error.status === 400 &&
          /no nightly rate configured|choose an occupancy for this room/i.test(message);
        setQuoteRefusal(error instanceof ApiRequestError && error.status !== undefined &&
          error.status >= 400 && error.status < 500 && !missingPricing);
      } finally {
        if (sequence === quoteSequence.current) setQuoting(false);
      }
    }, 200);

    return () => {
      clearTimeout(timer);
      if (quoteSequence.current === sequence) quoteSequence.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const roomTypeId = room?.roomTypeId ?? "";
  const currentCatalog = catalog && catalog.roomTypeId === roomTypeId ? catalog : null;
  const usesConfiguredPricing = currentCatalog?.pricingModel === "ROOM_TYPE_OCCUPANCY";
  const occupancies = currentCatalog?.occupancies ?? [];
  const mealPlans = currentCatalog?.mealPlans ?? [];

  // Different room types are sold as different occupancies with different meal
  // plans: drop the previous selection so the server's default for the new type
  // applies instead of a stale id that would be refused.
  useEffect(() => {
    if (!custom) { setOccupancyTypeId(""); setMealPlanId(""); }
    // Custom rules belong to the hotel, not a specific room type.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomTypeId]);

  // Legacy pricing charges the room type's rate without occupancy or meal-plan
  // markups. Use a neutral (1x) multiplier rather than inventing hotel prices.
  // Configured pricing, taxes and discounts can make the server price differ.
  const resolved = resolveApprovedRate({ tariffs, occupancy, mealPlan, roomTypeId });
  const roomBaseRate = Number(room?.baseRate);
  const usableRoomBaseRate = Number.isFinite(roomBaseRate) && roomBaseRate > 0 ? roomBaseRate : null;
  // Never replace the selected room's usable base rate with a coincidental
  // match from a different room type when its own tariff row is absent.
  const fallbackTariff = resolved.ok && tariffPricesStay(resolved.tariff, roomTypeId, occupancy, mealPlan) &&
    (resolved.tariff.id === roomTypeId || usableRoomBaseRate === null)
    ? resolved.tariff : undefined;
  const fallbackRate = fallbackTariff && resolved.ok ? resolved.rate : usableRoomBaseRate;
  const quotedRate = quote && Number.isFinite(quote.effectiveNightlyRate) && quote.effectiveNightlyRate > 0
    ? quote.effectiveNightlyRate : null;
  const modularRoomType = roomTypes.find((type) => type.id === roomTypeId);
  let modularEstimate: number | null = null;
  if (modular && room && modularRoomType && modularMealPlan && modularMeals.some((plan) => plan.mealPlan === modularMealPlan && plan.isActive)) {
    try {
      modularEstimate = calculateUniversalNightlyRate({
        baseRate: room.baseRate, extraAdultFee: modularRoomType.extraAdultFee ?? 0,
        mealPlan: modularMealPlan, adults: Number(adults), children: Number(children), hotelMealRates: modularMeals,
      });
    } catch { /* Invalid input is explained below. */ }
  }
  let customEstimate: ReturnType<typeof calculateCustomNightlyRate> | null = null;
  if (custom && room) {
    const selectedMeal = customMeals.find((row) => row.id === mealPlanId);
    const selectedOccupancy = customOccupancies.find((row) => row.id === occupancyTypeId);
    if (selectedMeal && selectedOccupancy) {
      try { customEstimate = calculateCustomNightlyRate({ baseRate: room.baseRate, adults: Number(adults), children: Number(children), meal: selectedMeal, occupancy: selectedOccupancy }); } catch { /* Invalid inputs are rejected by the quote. */ }
    }
  }
  const displayedRate = quotedRate ?? (custom ? customEstimate?.nightlyRate ?? null : modular ? modularEstimate : fallbackRate);
  const estimateTotal = modular && modularEstimate !== null && nights
    ? modularEstimate * nights - (canApplyDiscount ? Number(discount || 0) : 0) : null;

  // Everything the button depends on, phrased so the person can act on it.
  const problems: string[] = [];
  if (modular === null) problems.push(modeError ?? "Loading pricing settings…");
  if (custom && (!mealPlanId || !occupancyTypeId)) problems.push("Configure an active meal plan and occupancy rule.");
  if (custom && !quote) problems.push(quoteError ?? "Waiting for an approved price.");
  if (modular && !modularMealPlan) problems.push("No active meal plan is available.");
  if (modular && modularRoomType && (Number(adults) > (modularRoomType.maxAdults ?? 0) || Number(children) > (modularRoomType.maxChildren ?? 0))) problems.push("Guest counts exceed this room type's capacity.");
  if (modular && estimateTotal !== null && (!Number.isFinite(estimateTotal) || estimateTotal < 0)) problems.push("Discount cannot exceed the estimated stay total.");
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
  if (!Number.isInteger(Number(children)) || children.trim() === "" || Number(children) < 0) {
    problems.push("Children must be a non-negative whole number.");
  }
  if (!Number.isInteger(Number(extraBeds)) || extraBeds.trim() === "" || Number(extraBeds) < 0) {
    problems.push("Extra beds must be a non-negative whole number.");
  }
  if (canApplyDiscount && discount && (!Number.isFinite(Number(discount)) || Number(discount) < 0)) {
    problems.push("Discount must be a non-negative amount.");
  }
  if (quoteError && quoteRefusal) problems.push(quoteError);
  if (!displayedRate && room) problems.push("Set a valid room rate before creating a reservation.");
  if (quote && (!Number.isFinite(quote.totals.grandTotal) || quote.totals.grandTotal <= 0)) {
    problems.push("This stay prices at zero. Set a rate on the Pricing page before selling it.");
  }
  const canSubmit = problems.length === 0 && !loading;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    // The button is disabled in these cases; this is the belt-and-braces path for
    // a submit that arrives anyway (Enter key, assistive tech, stale markup).
    if (!canSubmit) {
      onError(problems[0] ?? "Complete the reservation details before submitting.");
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
          // Configured pricing sends the hotel's own occupancy and meal plan; a
          // hotel still on room-type rates sends the legacy fields instead.
          mealPlanCode: modular ? modularMealPlan : undefined,
          approvedRate: custom ? quote?.effectiveNightlyRate : undefined,
          occupancyTypeId: custom || (!modular && usesConfiguredPricing) ? occupancyTypeId || undefined : undefined,
          mealPlanId: custom || (!modular && usesConfiguredPricing) ? mealPlanId || undefined : undefined,
          tariffId: custom || modular || usesConfiguredPricing ? undefined : fallbackTariff?.id ?? room?.roomTypeId,
          occupancy: custom || modular || usesConfiguredPricing ? undefined : occupancy,
          mealPlan: custom || modular || usesConfiguredPricing ? undefined : mealPlan,
          adults: Number(adults) || 1,
          children: Number(children) || 0,
          extraBeds: Number(extraBeds) || 0,
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
          <button onClick={onClose} className="text-text-secondary hover:text-text-primary" aria-label="Close">
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

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-medium mb-1.5">Adults</label>
              <input type="number" data-testid="adults" min="1" value={adults} onChange={(e) => setAdults(e.target.value)} className={inputClass()} />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1.5">Children</label>
              <input type="number" data-testid="children" min="0" value={children} onChange={(e) => setChildren(e.target.value)} className={inputClass()} />
            </div>
            {!modular && !custom && <div>
              <label className="block text-sm font-medium mb-1.5">Extra beds</label>
              <input type="number" data-testid="extra-beds" min="0" value={extraBeds} onChange={(e) => setExtraBeds(e.target.value)} className={inputClass()} />
            </div>}
          </div>

          <p className="text-xs font-medium uppercase tracking-wide text-text-muted pt-2">Room &amp; Rate</p>

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

          {custom ? (
            <div className="grid grid-cols-2 gap-3">
              <label className="block text-sm font-medium">Occupancy<select data-testid="custom-occupancy" className={inputClass()} value={occupancyTypeId} onChange={(e) => setOccupancyTypeId(e.target.value)}><option value="">Choose…</option>{customOccupancies.map((row) => <option key={row.id} value={row.id}>{row.label}</option>)}</select></label>
              <label className="block text-sm font-medium">Meal Plan<select data-testid="custom-meal" className={inputClass()} value={mealPlanId} onChange={(e) => setMealPlanId(e.target.value)}><option value="">Choose…</option>{customMeals.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>
            </div>
          ) : modular ? (
            <div>
              <label htmlFor="modular-meal-plan" className="block text-sm font-medium mb-1.5">Meal Plan</label>
              <select id="modular-meal-plan" data-testid="modular-meal-plan" value={modularMealPlan} onChange={(e) => setModularMealPlan(e.target.value as UniversalMealPlan)} className={inputClass()}>
                {modularMeals.filter((plan) => plan.isActive).map((plan) => <option key={plan.mealPlan} value={plan.mealPlan}>{UNIVERSAL_MEAL_PLAN_LABELS[plan.mealPlan]} (+{money(Number(plan.adultSurcharge), currency)}/adult, +{money(Number(plan.childSurcharge), currency)}/child per night)</option>)}
              </select>
            </div>
          ) : usesConfiguredPricing ? (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1.5">Occupancy</label>
                <select
                  data-testid="occupancy-select"
                  value={occupancyTypeId}
                  onChange={(e) => setOccupancyTypeId(e.target.value)}
                  className={inputClass()}
                >
                  <option value="">Choose…</option>
                  {occupancies.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1.5">Meal plan</label>
                <select
                  data-testid="meal-plan-select"
                  value={mealPlanId}
                  onChange={(e) => setMealPlanId(e.target.value)}
                  className={inputClass()}
                >
                  <option value="">None</option>
                  {mealPlans.map((plan) => (
                    <option key={plan.id} value={plan.id}>
                      {plan.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
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
            </div>
          )}

          <div className={canApplyDiscount ? "grid grid-cols-2 gap-3" : ""}>
            <div>
              <label className="block text-sm font-medium mb-1.5" htmlFor="approved-rate">
                {quotedRate ? "Approved rate" : "Estimated rate"} per night ({currency})
              </label>
              <p
                id="approved-rate"
                data-testid="approved-rate"
                aria-live="polite"
                className={`${inputClass()} bg-bg font-medium`}
              >
                {money(displayedRate ?? 0, quote?.currency || currency)}
              </p>
              {!quotedRate && room && (
                <p className="mt-1 text-xs text-text-muted" role="status">
                  {quoting ? "Checking the server price. " : quoteError && !quoteRefusal ? `${quoteError} ` : ""}
                  Estimate only; the server determines the final price and may reject the booking.
                </p>
              )}
              {quote && (
                <p className="mt-1 text-xs text-text-muted" data-testid="approved-rate-source">
                  {quote.roomTypeName}
                  {quote.occupancyName ? ` · ${quote.occupancyName}` : ""}
                  {quote.nights > 1 ? ` · average over ${quote.nights} nights` : ""}
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

          {custom && !quote && customEstimate && <div className="rounded-control border border-border p-3 text-sm" data-testid="price-breakdown"><p className="font-medium">Estimated price breakdown</p><p>Room: {money(customEstimate.base, currency)}</p><p>Occupancy: {money(customEstimate.occupancyTotal, currency)}</p><p>Meals: {money(customEstimate.mealTotal, currency)}</p><p>Per night: {money(customEstimate.nightlyRate, currency)}</p><p className="text-xs text-text-muted">Subject to server confirmation.</p></div>}
          {modular && !quote && estimateTotal !== null && Number.isFinite(estimateTotal) && estimateTotal >= 0 && <p className="text-sm" data-testid="estimated-stay-total">Estimated stay total: {money(estimateTotal, currency)} (subject to server confirmation)</p>}
          {quote && (
            <div className="rounded-control border border-border p-3 text-sm" data-testid="price-breakdown">
              <p className="text-xs font-medium uppercase tracking-wide text-text-muted mb-2">
                Price breakdown
              </p>
              <ul className="space-y-1">
                {quote.lines.map((line) => (
                  <li key={line.code} className="flex items-start justify-between gap-3">
                    <span className="text-text-secondary">
                      {line.label}
                      {line.kind === "TAX" ? "" : line.quantity > 1 ? ` × ${line.quantity}` : ""}
                    </span>
                    <span className={line.amount < 0 ? "text-success" : "text-text-primary"}>
                      {money(line.amount, quote.currency || currency)}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-2 border-t border-border pt-2 space-y-1">
                <div className="flex justify-between text-xs text-text-muted">
                  <span>Subtotal</span>
                  <span data-testid="price-subtotal">
                    {money(quote.totals.subtotal, quote.currency || currency)}
                  </span>
                </div>
                {quote.totals.discount > 0 && (
                  <div className="flex justify-between text-xs text-text-secondary">
                    <span>Discount</span>
                    <span>-{money(quote.totals.discount, quote.currency || currency)}</span>
                  </div>
                )}
                {quote.totals.tax > 0 && (
                  <div className="flex justify-between text-xs text-text-secondary">
                    <span>Taxes &amp; service{quote.taxInclusive ? " (included)" : ""}</span>
                    <span>{money(quote.totals.tax, quote.currency || currency)}</span>
                  </div>
                )}
                <div className="flex justify-between font-medium">
                  <span>Total for {quote.nights} night{quote.nights === 1 ? "" : "s"}</span>
                  <span data-testid="price-total">{money(quote.totals.grandTotal, quote.currency || currency)}</span>
                </div>
                <div className="flex justify-between text-xs text-text-muted">
                  <span>Average per night</span>
                  <span>{money(quote.totals.averagePerNight, quote.currency || currency)}</span>
                </div>
              </div>
            </div>
          )}

          {quote?.mealPlanName && quote.mealPlanBasis && (
            <p className="text-xs text-text-muted" data-testid="meal-plan-basis">
              {quote.mealPlanName} · {BASIS_LABELS[quote.mealPlanBasis] ?? quote.mealPlanBasis}
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
