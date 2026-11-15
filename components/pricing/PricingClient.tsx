"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Save, Trash2 } from "lucide-react";
import { apiErrorMessage, requestJson } from "@/lib/client-api";

/**
 * Pricing & Rates configuration.
 *
 * A hotel configures only what it needs: room-type occupancy rates, its own meal
 * plans, optional seasonal/weekend adjustments, extra beds, child rules, taxes and
 * the feature switches that activate them. Nothing here is global — every request
 * is scoped to the signed-in user's hotel on the server.
 */

type Settings = {
  pricingModel: "ROOM_TYPE_OCCUPANCY" | "LEGACY_BASE_RATE";
  useOccupancyRates: boolean;
  useMealPlans: boolean;
  useSeasonalPricing: boolean;
  useWeekendPricing: boolean;
  useChildPricing: boolean;
  useExtraBeds: boolean;
  useTaxes: boolean;
  pricesIncludeTax: boolean;
};

type RoomTypeRates = {
  id: string;
  name: string;
  baseRate: number;
  capacity: number;
  rates: { id: string; occupancyTypeId: string; nightlyRate: number; isActive: boolean }[];
};
type Occupancy = {
  id: string;
  name: string;
  description: string | null;
  minAdults: number;
  maxAdults: number;
  maxChildren: number;
  sortOrder: number;
  isActive: boolean;
};
type MealPlan = {
  id: string;
  name: string;
  description: string | null;
  pricingBasis: string;
  charge: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  isActive: boolean;
  roomTypeIds: string[];
};
type Adjustment = {
  id: string;
  name: string;
  kind: "SEASONAL" | "WEEKEND";
  adjustmentType: "PERCENT" | "FIXED_PER_NIGHT" | "SET_RATE";
  amount: number;
  daysOfWeek: number[];
  startDate: string | null;
  endDate: string | null;
  roomTypeId: string | null;
  priority: number;
  isActive: boolean;
};
type ExtraBed = {
  id: string;
  name: string;
  roomTypeId: string | null;
  nightlyRate: number;
  childRate: number | null;
  maxPerRoom: number;
  isActive: boolean;
};
type ChildRule = {
  id: string;
  name: string;
  minAge: number;
  maxAge: number;
  chargeType: "FIXED_PER_NIGHT" | "PERCENT_OF_ADULT";
  amount: number;
  isActive: boolean;
};
type TaxRule = {
  id: string;
  name: string;
  basis: "PERCENT" | "FIXED";
  amount: number;
  appliesTo: "ROOM" | "MEALS" | "ALL";
  chargeBasis: "PER_NIGHT" | "PER_STAY" | "PER_PERSON_PER_NIGHT";
  isInclusive: boolean;
  sortOrder: number;
  isActive: boolean;
};

type Bundle = {
  currency: string;
  hotelName: string;
  settings: Settings;
  roomTypes: RoomTypeRates[];
  occupancies: Occupancy[];
  mealPlans: MealPlan[];
  adjustments: Adjustment[];
  extraBeds: ExtraBed[];
  childRules: ChildRule[];
  taxes: TaxRule[];
};

type EntityKey = "occupancy-types" | "meal-plans" | "adjustments" | "extra-beds" | "child-rules" | "tax-rules";

const TABS = [
  { key: "rates", label: "Room rates" },
  { key: "occupancies", label: "Occupancy options" },
  { key: "meals", label: "Meal plans" },
  { key: "adjustments", label: "Seasonal & weekend" },
  { key: "extras", label: "Extra beds & children" },
  { key: "taxes", label: "Taxes & service" },
  { key: "settings", label: "Settings" },
] as const;

const BASIS_OPTIONS = [
  { value: "PER_PERSON_PER_NIGHT", label: "Per person / night" },
  { value: "PER_ROOM_PER_NIGHT", label: "Per room / night" },
  { value: "PER_PERSON_PER_STAY", label: "Per person / stay" },
  { value: "PER_ROOM_PER_STAY", label: "Per room / stay" },
];

function inputClass() {
  return "w-full rounded-control border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent";
}

function money(amount: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-KE", { style: "currency", currency, maximumFractionDigits: 2 }).format(amount);
  } catch {
    return `${currency} ${amount.toLocaleString()}`;
  }
}

export default function PricingClient({ initialBundle }: { initialBundle: Bundle }) {
  const [bundle, setBundle] = useState<Bundle>(initialBundle);
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("rates");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const currency = bundle.currency;

  const reload = useCallback(async () => {
    try {
      const fresh = await requestJson<Bundle>("/api/pricing");
      setBundle(fresh);
    } catch (loadError) {
      setError(apiErrorMessage(loadError, "Could not refresh pricing."));
    }
  }, []);

  const save = useCallback(
    async (path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown, message = "Saved.") => {
      setBusy(true);
      setError(null);
      setNotice(null);
      try {
        await requestJson(path, {
          method,
          headers: body ? { "Content-Type": "application/json" } : undefined,
          body: body ? JSON.stringify(body) : undefined,
        });
        await reload();
        setNotice(message);
        return true;
      } catch (saveError) {
        setError(apiErrorMessage(saveError, "Could not save this setting."));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [reload]
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1>Pricing &amp; Rates</h1>
          <p className="text-sm text-text-secondary">
            Configure how {bundle.hotelName || "this hotel"} prices rooms. All amounts are in {currency}.
          </p>
        </div>
        <div className="text-right text-xs text-text-muted">
          <p>
            Model:{" "}
            <span className="font-medium text-text-primary">
              {bundle.settings.pricingModel === "ROOM_TYPE_OCCUPANCY"
                ? "Occupancy rates"
                : "Room type base rate"}
            </span>
          </p>
          <p>{bundle.settings.useTaxes ? "Taxes configured" : "No taxes configured"}</p>
        </div>
      </div>

      {error && (
        <div className="card border-danger/40 text-sm text-danger" role="alert">
          {error}
        </div>
      )}
      {notice && !error && (
        <div className="card border-success/40 text-sm text-success" role="status">
          {notice}
        </div>
      )}

      <div className="flex flex-wrap gap-1 border-b border-border pb-2">
        {TABS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setTab(entry.key)}
            className={`rounded-control px-3 py-1.5 text-sm ${
              tab === entry.key
                ? "bg-primary-600 text-white"
                : "text-text-secondary hover:bg-bg"
            }`}
          >
            {entry.label}
          </button>
        ))}
      </div>

      {tab === "rates" && (
        <RoomRatesPanel bundle={bundle} onSave={save} busy={busy} currency={currency} />
      )}
      {tab === "occupancies" && (
        <EntityPanel
          entity="occupancy-types"
          title="Occupancy options"
          description="The occupancies this hotel sells. Add your own names — nothing is fixed by the platform."
          rows={bundle.occupancies.map((option) => ({
            id: option.id,
            primary: option.name,
            secondary: `${option.minAdults}–${option.maxAdults} adults · up to ${option.maxChildren} children`,
            active: option.isActive,
            values: option,
          }))}
          fields={[
            { name: "name", label: "Name", type: "text", required: true },
            { name: "description", label: "Description", type: "text" },
            { name: "minAdults", label: "Minimum adults", type: "number", defaultValue: 1 },
            { name: "maxAdults", label: "Maximum adults", type: "number", defaultValue: 2 },
            { name: "maxChildren", label: "Maximum children", type: "number", defaultValue: 0 },
            { name: "sortOrder", label: "Order", type: "number", defaultValue: 0 },
          ]}
          onSave={save}
          busy={busy}
        />
      )}
      {tab === "meals" && (
        <EntityPanel
          entity="meal-plans"
          title="Meal plans"
          description="Each plan has its own price and pricing basis. Leave room types unselected to offer it everywhere."
          rows={bundle.mealPlans.map((plan) => ({
            id: plan.id,
            primary: plan.name,
            secondary: `${money(plan.charge, currency)} ${
              BASIS_OPTIONS.find((option) => option.value === plan.pricingBasis)?.label.toLowerCase() ??
              plan.pricingBasis
            }`,
            active: plan.isActive,
            values: plan,
          }))}
          fields={[
            { name: "name", label: "Name", type: "text", required: true },
            { name: "description", label: "Description", type: "text" },
            { name: "pricingBasis", label: "Pricing basis", type: "select", options: BASIS_OPTIONS, defaultValue: "PER_PERSON_PER_NIGHT" },
            { name: "charge", label: `Charge (${currency})`, type: "money", defaultValue: 0 },
            { name: "roomTypeIds", label: "Applicable room types", type: "roomTypes", help: "None selected = all room types." },
            { name: "effectiveFrom", label: "Valid from", type: "date" },
            { name: "effectiveTo", label: "Valid to", type: "date" },
          ]}
          onSave={save}
          busy={busy}
        />
      )}
      {tab === "adjustments" && (
        <EntityPanel
          entity="adjustments"
          title="Seasonal & weekend pricing"
          description="Seasonal rows apply between two dates; weekend rows apply on the weekdays you tick. Percent, fixed nightly amount, or a set nightly rate."
          rows={bundle.adjustments.map((row) => ({
            id: row.id,
            primary: row.name,
            secondary: `${row.kind === "SEASONAL" ? "Seasonal" : "Weekend"} · ${
              row.adjustmentType === "PERCENT"
                ? `${row.amount > 0 ? "+" : ""}${row.amount}%`
                : row.adjustmentType === "SET_RATE"
                  ? `set ${money(row.amount, currency)}`
                  : `${row.amount > 0 ? "+" : ""}${money(row.amount, currency)}/night`
            }`,
            active: row.isActive,
            values: row,
          }))}
          fields={[
            { name: "name", label: "Name", type: "text", required: true },
            { name: "kind", label: "Kind", type: "select", required: true, options: [{ value: "SEASONAL", label: "Seasonal (date range)" }, { value: "WEEKEND", label: "Weekend (weekdays)" }], defaultValue: "SEASONAL" },
            { name: "adjustmentType", label: "Adjustment", type: "select", options: [{ value: "PERCENT", label: "Percentage" }, { value: "FIXED_PER_NIGHT", label: "Fixed per night" }, { value: "SET_RATE", label: "Set nightly rate" }], defaultValue: "PERCENT" },
            { name: "amount", label: "Amount", type: "number", defaultValue: 0 },
            { name: "daysOfWeek", label: "Weekend days", type: "days" },
            { name: "startDate", label: "Start date", type: "date" },
            { name: "endDate", label: "End date", type: "date" },
            { name: "roomTypeId", label: "Room type", type: "roomType" },
            { name: "priority", label: "Priority", type: "number", defaultValue: 0 },
          ]}
          onSave={save}
          busy={busy}
        />
      )}
      {tab === "extras" && (
        <div className="space-y-6">
          <EntityPanel
            entity="extra-beds"
            title="Extra beds"
            description="Nightly price for an extra bed, and how many a room may take."
            rows={bundle.extraBeds.map((rule) => ({
              id: rule.id,
              primary: rule.name,
              secondary: `${money(rule.nightlyRate, currency)} / night · max ${rule.maxPerRoom} per room`,
              active: rule.isActive,
              values: rule,
            }))}
            fields={[
              { name: "name", label: "Name", type: "text", required: true },
              { name: "nightlyRate", label: `Nightly rate (${currency})`, type: "money", defaultValue: 0 },
              { name: "childRate", label: `Child nightly rate (${currency})`, type: "money" },
              { name: "maxPerRoom", label: "Maximum per room", type: "number", defaultValue: 1 },
              { name: "roomTypeId", label: "Room type", type: "roomType" },
            ]}
            onSave={save}
            busy={busy}
          />
          <EntityPanel
            entity="child-rules"
            title="Child pricing"
            description="Age bands with a fixed nightly charge or a percentage of the adult rate."
            rows={bundle.childRules.map((rule) => ({
              id: rule.id,
              primary: rule.name,
              secondary: `ages ${rule.minAge}–${rule.maxAge} · ${
                rule.chargeType === "PERCENT_OF_ADULT" ? `${rule.amount}% of adult rate` : `${money(rule.amount, currency)} / night`
              }`,
              active: rule.isActive,
              values: rule,
            }))}
            fields={[
              { name: "name", label: "Name", type: "text", required: true },
              { name: "minAge", label: "Minimum age", type: "number", defaultValue: 0 },
              { name: "maxAge", label: "Maximum age", type: "number", defaultValue: 12 },
              { name: "chargeType", label: "Charge", type: "select", options: [{ value: "FIXED_PER_NIGHT", label: "Fixed per night" }, { value: "PERCENT_OF_ADULT", label: "Percent of adult rate" }], defaultValue: "FIXED_PER_NIGHT" },
              { name: "amount", label: "Amount", type: "number", defaultValue: 0 },
            ]}
            onSave={save}
            busy={busy}
          />
        </div>
      )}
      {tab === "taxes" && (
        <EntityPanel
          entity="tax-rules"
          title="Taxes & service charges"
          description="Percentage or fixed. Choose what it applies to, whether it is included in your rates, and how it is charged."
          rows={bundle.taxes.map((rule) => ({
            id: rule.id,
            primary: rule.name,
            secondary: `${rule.basis === "PERCENT" ? `${rule.amount}%` : money(rule.amount, currency)} · ${rule.appliesTo.toLowerCase()}${
              rule.isInclusive ? " · included" : ""
            }`,
            active: rule.isActive,
            values: rule,
          }))}
          fields={[
            { name: "name", label: "Name", type: "text", required: true },
            { name: "basis", label: "Basis", type: "select", options: [{ value: "PERCENT", label: "Percentage" }, { value: "FIXED", label: "Fixed amount" }], defaultValue: "PERCENT" },
            { name: "amount", label: "Amount", type: "number", defaultValue: 0 },
            { name: "appliesTo", label: "Applies to", type: "select", options: [{ value: "ALL", label: "Everything" }, { value: "ROOM", label: "Room charges" }, { value: "MEALS", label: "Meal plans" }], defaultValue: "ALL" },
            { name: "chargeBasis", label: "Charged", type: "select", options: [{ value: "PER_STAY", label: "Per stay" }, { value: "PER_NIGHT", label: "Per night" }, { value: "PER_PERSON_PER_NIGHT", label: "Per person per night" }], defaultValue: "PER_STAY" },
            { name: "isInclusive", label: "Included in displayed rates", type: "toggle" },
          ]}
          onSave={save}
          busy={busy}
        />
      )}
      {tab === "settings" && <SettingsPanel settings={bundle.settings} onSave={save} busy={busy} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Room type × occupancy rate matrix
// ---------------------------------------------------------------------------
function RoomRatesPanel({
  bundle,
  onSave,
  busy,
  currency,
}: {
  bundle: Bundle;
  onSave: (path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown, message?: string) => Promise<boolean>;
  busy: boolean;
  currency: string;
}) {
  const [openId, setOpenId] = useState<string | null>(bundle.roomTypes[0]?.id ?? null);
  const [draft, setDraft] = useState<Record<string, string>>({});

  useEffect(() => {
    const roomType = bundle.roomTypes.find((type) => type.id === openId);
    if (!roomType) return;
    const next: Record<string, string> = {};
    for (const option of bundle.occupancies) {
      const rate = roomType.rates.find((row) => row.occupancyTypeId === option.id);
      next[option.id] = rate ? String(rate.nightlyRate) : "";
    }
    setDraft(next);
  }, [openId, bundle]);

  if (bundle.occupancies.length === 0) {
    return (
      <div className="card text-sm text-text-secondary">
        Add at least one occupancy option first, then set a nightly rate for each room type.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-text-secondary">
        Set the nightly rate for every occupancy this room type is sold as. Leave a field empty if
        the room type is never sold that way.
      </p>
      {bundle.roomTypes.map((roomType) => {
        const open = openId === roomType.id;
        return (
          <div key={roomType.id} className="card">
            <button
              type="button"
              className="flex w-full items-center justify-between text-left"
              onClick={() => setOpenId(open ? null : roomType.id)}
            >
              <span>
                <span className="font-medium">{roomType.name}</span>
                <span className="ml-2 text-xs text-text-muted">
                  sleeps {roomType.capacity} · base {money(roomType.baseRate, currency)}
                </span>
              </span>
              <span className="text-xs text-text-muted">{open ? "Hide" : "Edit rates"}</span>
            </button>

            {open && (
              <div className="mt-3 space-y-3">
                <div className="grid gap-2 sm:grid-cols-2">
                  {bundle.occupancies.map((option) => (
                    <label key={option.id} className="block text-sm">
                      <span className="mb-1 block text-text-secondary">
                        {option.name} ({currency})
                      </span>
                      <input
                        type="number"
                        min="0"
                        step="0.01"
                        className={inputClass()}
                        value={draft[option.id] ?? ""}
                        placeholder="Not sold"
                        onChange={(event) =>
                          setDraft((current) => ({ ...current, [option.id]: event.target.value }))
                        }
                      />
                    </label>
                  ))}
                </div>
                <button
                  type="button"
                  disabled={busy}
                  className="btn-primary"
                  onClick={() =>
                    onSave(
                      "/api/pricing/room-rates",
                      "POST",
                      {
                        roomTypeId: roomType.id,
                        rates: bundle.occupancies.map((option) => ({
                          occupancyTypeId: option.id,
                          nightlyRate: draft[option.id] === "" ? null : Number(draft[option.id]),
                        })),
                      },
                      `Rates saved for ${roomType.name}.`
                    )
                  }
                >
                  <Save size={14} className="mr-1.5 inline" /> Save rates
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
function SettingsPanel({
  settings,
  onSave,
  busy,
}: {
  settings: Settings;
  onSave: (path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown, message?: string) => Promise<boolean>;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<Settings>(settings);

  useEffect(() => setDraft(settings), [settings]);

  const flags: { key: keyof Settings; label: string; help: string }[] = [
    { key: "useOccupancyRates", label: "Occupancy rates", help: "Price each room type per occupancy option (recommended)." },
    { key: "useMealPlans", label: "Meal plans", help: "Add meal plan charges to reservations." },
    { key: "useSeasonalPricing", label: "Seasonal pricing", help: "Apply date-range adjustments." },
    { key: "useWeekendPricing", label: "Weekend pricing", help: "Apply weekday-based adjustments." },
    { key: "useChildPricing", label: "Child pricing", help: "Charge children by age band." },
    { key: "useExtraBeds", label: "Extra beds", help: "Allow extra beds at a nightly price." },
    { key: "useTaxes", label: "Taxes & service charges", help: "Add configured taxes to reservations." },
    { key: "pricesIncludeTax", label: "Rates include tax", help: "Show totals as tax-inclusive." },
  ];

  return (
    <div className="card space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1.5">Pricing model</label>
        <select
          className={inputClass()}
          value={draft.pricingModel}
          onChange={(event) =>
            setDraft({ ...draft, pricingModel: event.target.value as Settings["pricingModel"] })
          }
        >
          <option value="LEGACY_BASE_RATE">Room type base rate</option>
          <option value="ROOM_TYPE_OCCUPANCY">Occupancy rates</option>
        </select>
        <p className="mt-1 text-xs text-text-muted">
          Base rate keeps selling at the room type&apos;s single price. Occupancy rates use the matrix
          in the Room rates tab.
        </p>
      </div>

      <div className="space-y-2">
        {flags.map((flag) => (
          <label key={String(flag.key)} className="flex items-start gap-3">
            <input
              type="checkbox"
              checked={Boolean(draft[flag.key])}
              onChange={(event) => setDraft({ ...draft, [flag.key]: event.target.checked })}
              className="mt-1"
            />
            <span>
              <span className="block text-sm font-medium">{flag.label}</span>
              <span className="block text-xs text-text-muted">{flag.help}</span>
            </span>
          </label>
        ))}
      </div>

      <button
        type="button"
        disabled={busy}
        className="btn-primary"
        onClick={() => onSave("/api/pricing", "PATCH", draft, "Pricing settings saved.")}
      >
        <Save size={14} className="mr-1.5 inline" /> Save settings
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generic entity list + form
// ---------------------------------------------------------------------------
type FieldDef = {
  name: string;
  label: string;
  type: "text" | "number" | "money" | "select" | "toggle" | "date" | "days" | "roomType" | "roomTypes";
  options?: { value: string; label: string }[];
  defaultValue?: string | number | boolean;
  required?: boolean;
  help?: string;
};

function EntityPanel({
  entity,
  title,
  description,
  rows,
  fields,
  onSave,
  busy,
}: {
  entity: EntityKey;
  title: string;
  description: string;
  rows: { id: string; primary: string; secondary: string; active: boolean; values: Record<string, unknown> }[];
  fields: FieldDef[];
  onSave: (path: string, method: "POST" | "PATCH" | "DELETE", body?: unknown, message?: string) => Promise<boolean>;
  busy: boolean;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});

  const blank = useMemo(() => {
    const next: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.type === "toggle") next[field.name] = field.defaultValue ?? true;
      else if (field.type === "days") next[field.name] = [];
      else if (field.type === "roomTypes") next[field.name] = [];
      else if (field.defaultValue !== undefined) next[field.name] = field.defaultValue;
      else next[field.name] = "";
    }
    return next;
  }, [fields]);

  const startCreate = () => {
    setEditingId(null);
    setDraft({ ...blank });
    setFormOpen(true);
  };

  const startEdit = (row: { id: string; values: Record<string, unknown> }) => {
    const next: Record<string, unknown> = { ...blank };
    for (const field of fields) {
      const value = row.values[field.name];
      if (value === null || value === undefined) continue;
      if (field.type === "date") next[field.name] = String(value).slice(0, 10);
      else if (field.type === "roomTypes") next[field.name] = Array.isArray(value) ? value : [];
      else next[field.name] = value;
    }
    setEditingId(row.id);
    setDraft(next);
    setFormOpen(true);
  };

  const submit = async () => {
    const payload: Record<string, unknown> = { ...draft };
    if (editingId) payload.id = editingId;
    for (const field of fields) {
      if (payload[field.name] === "") delete payload[field.name];
    }
    const ok = await onSave(
      `/api/pricing/${entity}`,
      editingId ? "PATCH" : "POST",
      payload,
      editingId ? "Updated." : "Added."
    );
    if (ok) {
      setFormOpen(false);
      setEditingId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-medium">{title}</h2>
          <p className="text-sm text-text-secondary">{description}</p>
        </div>
        <button type="button" className="btn-secondary whitespace-nowrap" onClick={startCreate}>
          <Plus size={14} className="mr-1 inline" /> Add
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="card text-sm text-text-muted">Nothing configured yet.</div>
      ) : (
        <div className="card divide-y divide-border p-0">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-3 p-3">
              <div>
                <p className="text-sm font-medium">
                  {row.primary}
                  {!row.active && <span className="ml-2 text-xs text-text-muted">(inactive)</span>}
                </p>
                <p className="text-xs text-text-secondary">{row.secondary}</p>
              </div>
              <div className="flex gap-2">
                <button type="button" className="text-xs text-primary-700 underline" onClick={() => startEdit(row)}>
                  Edit
                </button>
                <button
                  type="button"
                  className="text-xs text-danger underline"
                  disabled={busy}
                  onClick={() => onSave(`/api/pricing/${entity}?id=${row.id}`, "DELETE", undefined, "Deleted.")}
                >
                  <Trash2 size={12} className="inline" /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {formOpen && (
        <div className="card space-y-3">
          <h3 className="text-sm font-medium">{editingId ? "Edit" : "Add"} {title.toLowerCase()}</h3>
          <div className="grid gap-3 sm:grid-cols-2">
            {fields.map((field) => (
              <div key={field.name} className={field.type === "roomTypes" ? "sm:col-span-2" : ""}>
                {field.type === "toggle" ? (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={Boolean(draft[field.name])}
                      onChange={(event) => setDraft({ ...draft, [field.name]: event.target.checked })}
                    />
                    {field.label}
                  </label>
                ) : field.type === "select" ? (
                  <>
                    <label className="block text-sm font-medium mb-1.5">{field.label}</label>
                    <select
                      className={inputClass()}
                      value={String(draft[field.name] ?? "")}
                      onChange={(event) => setDraft({ ...draft, [field.name]: event.target.value })}
                    >
                      <option value="">Choose…</option>
                      {field.options?.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </>
                ) : field.type === "days" ? (
                  <>
                    <span className="block text-sm font-medium mb-1.5">{field.label}</span>
                    <div className="flex flex-wrap gap-2">
                      {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((label, index) => {
                        const selected = Array.isArray(draft[field.name]) && (draft[field.name] as number[]).includes(index);
                        return (
                          <label key={label} className="flex items-center gap-1 text-xs">
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={(event) => {
                                const current = Array.isArray(draft[field.name]) ? [...(draft[field.name] as number[])] : [];
                                const next = event.target.checked
                                  ? [...current, index]
                                  : current.filter((day) => day !== index);
                                setDraft({ ...draft, [field.name]: next });
                              }}
                            />
                            {label}
                          </label>
                        );
                      })}
                    </div>
                  </>
                ) : field.type === "roomTypes" ? (
                  <>
                    <span className="block text-sm font-medium mb-1.5">{field.label}</span>
                    <div className="flex flex-wrap gap-2">
                      {/* Room type ids come from the bundle, so the options are always this hotel's own. */}
                      <RoomTypePicker
                        value={Array.isArray(draft[field.name]) ? (draft[field.name] as string[]) : []}
                        onChange={(next) => setDraft({ ...draft, [field.name]: next })}
                      />
                    </div>
                    {field.help && <p className="mt-1 text-xs text-text-muted">{field.help}</p>}
                  </>
                ) : (
                  <>
                    <label className="block text-sm font-medium mb-1.5">{field.label}</label>
                    <input
                      type={field.type === "number" || field.type === "money" ? "number" : field.type === "date" ? "date" : "text"}
                      step={field.type === "money" ? "0.01" : undefined}
                      className={inputClass()}
                      value={String(draft[field.name] ?? "")}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          [field.name]:
                            field.type === "number" || field.type === "money"
                              ? event.target.value
                              : event.target.value,
                        })
                      }
                    />
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <button type="button" className="btn-primary" disabled={busy} onClick={submit}>
              <Save size={14} className="mr-1.5 inline" /> Save
            </button>
            <button type="button" className="btn-secondary" onClick={() => setFormOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Room type multi-select. The identifiers are taken from the server-provided
 * bundle rather than typed in, so a meal plan can only be attached to this
 * hotel's own room types.
 */
function RoomTypePicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [options, setOptions] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    let active = true;
    requestJson<Bundle>("/api/pricing")
      .then((bundle) => {
        if (active) setOptions(bundle.roomTypes.map((type) => ({ id: type.id, name: type.name })));
      })
      .catch(() => {
        /* the parent already surfaces load errors */
      });
    return () => {
      active = false;
    };
  }, []);

  if (options.length === 0) {
    return <p className="text-xs text-text-muted">Loading room types…</p>;
  }

  return (
    <div className="flex flex-wrap gap-3">
      {options.map((option) => (
        <label key={option.id} className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={value.includes(option.id)}
            onChange={(event) =>
              onChange(
                event.target.checked ? [...value, option.id] : value.filter((id) => id !== option.id)
              )
            }
          />
          {option.name}
        </label>
      ))}
    </div>
  );
}
