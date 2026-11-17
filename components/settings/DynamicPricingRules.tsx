"use client";

import { useCallback, useEffect, useState } from "react";
import { apiErrorMessage, requestJson } from "@/lib/client-api";

type Meal = { id: string; code: string; name: string; pricePerNight: number; perGuest: boolean; isActive: boolean };
type Occupancy = { id: string; occupancyType: string; label: string; includedAdults: number; surchargeAmount: number; extraAdultRate: number; isActive: boolean };
type Bundle = { useCustomRateRules: boolean; activationAvailable: boolean; mealPlanRates: Meal[]; occupancyRateRules: Occupancy[] };
type MealDraft = Omit<Meal, "pricePerNight"> & { pricePerNight: string };
type OccupancyDraft = Omit<Occupancy, "includedAdults" | "surchargeAmount" | "extraAdultRate"> & { includedAdults: string; surchargeAmount: string; extraAdultRate: string };
const emptyMeal = (): MealDraft => ({ id: "", code: "", name: "", pricePerNight: "0", perGuest: true, isActive: true });
const emptyOccupancy = (): OccupancyDraft => ({ id: "", occupancyType: "", label: "", includedAdults: "1", surchargeAmount: "0", extraAdultRate: "0", isActive: true });
const field = "mt-1 w-full rounded-control border border-border bg-surface p-2 text-sm";
const endpoint = "/api/settings/pricing/rules";

export default function DynamicPricingRules() {
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [meal, setMeal] = useState<MealDraft>(emptyMeal);
  const [occupancy, setOccupancy] = useState<OccupancyDraft>(emptyOccupancy);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => { setBundle(await requestJson<Bundle>(endpoint)); }, []);
  useEffect(() => { let active = true; requestJson<Bundle>(endpoint).then((data) => { if (active) setBundle(data); }).catch((err) => { if (active) setError(apiErrorMessage(err, "Could not load dynamic pricing rules.")); }); return () => { active = false; }; }, []);
  async function mutate(method: "POST" | "PATCH" | "DELETE", data: object) {
    setBusy(true); setError(null); setNotice(null);
    try {
      await requestJson(endpoint, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
      await load(); setNotice("Pricing rules saved."); return true;
    } catch (err) { setError(apiErrorMessage(err, "Could not save pricing rules.")); return false; }
    finally { setBusy(false); }
  }
  async function saveMeal(event: React.FormEvent) {
    event.preventDefault();
    const { id, pricePerNight, ...rest } = meal;
    if (!pricePerNight.trim()) { setError("Enter a meal price."); return; }
    if (await mutate(id ? "PATCH" : "POST", { kind: "meal", ...(id ? { id } : {}), ...rest, pricePerNight: Number(pricePerNight) })) setMeal(emptyMeal());
  }
  async function saveOccupancy(event: React.FormEvent) {
    event.preventDefault();
    const { id, includedAdults, surchargeAmount, extraAdultRate, ...rest } = occupancy;
    if (![includedAdults, surchargeAmount, extraAdultRate].every((value) => value.trim())) { setError("Enter all occupancy amounts and included adults."); return; }
    if (await mutate(id ? "PATCH" : "POST", { kind: "occupancy", ...(id ? { id } : {}), ...rest, includedAdults: Number(includedAdults), surchargeAmount: Number(surchargeAmount), extraAdultRate: Number(extraAdultRate) })) setOccupancy(emptyOccupancy());
  }
  async function remove(kind: "meal" | "occupancy", id: string) {
    if (!window.confirm("Delete this pricing rule?")) return;
    if (await mutate("DELETE", { kind, id })) { if (kind === "meal" && meal.id === id) setMeal(emptyMeal()); if (kind === "occupancy" && occupancy.id === id) setOccupancy(emptyOccupancy()); }
  }
  return <section className="card border border-border p-5 space-y-5" aria-labelledby="dynamic-rules-title">
    <div><h2 id="dynamic-rules-title" className="text-lg font-semibold">Dynamic Pricing Rules</h2><p className="text-sm text-text-secondary">Configure rates for this property. When enabled, these rules override the existing pricing mode for new reservations; disabling them restores the previous mode. Existing bookings retain their agreed prices.</p></div>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="text-sm text-success">{notice}</p>}
    {!bundle && !error && <p>Loading pricing rules…</p>}
    {bundle && <>
      <label className="flex items-center gap-2 text-sm font-medium"><input type="checkbox" checked={bundle.useCustomRateRules} disabled={busy || (!bundle.activationAvailable && !bundle.useCustomRateRules)} onChange={(e) => { const enabled = e.target.checked; if (enabled && !window.confirm("Enable dynamic pricing rules for new bookings? Existing booking prices will not change.")) return; void mutate("PATCH", { kind: "mode", enabled }); }} /> Enable Dynamic Pricing Rules</label>
      {!bundle.activationAvailable && <p className="text-sm text-amber-700" role="note">Rules can be configured, but activation is unavailable until reservation pricing integration is complete. These rules are not yet used for bookings.</p>}
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="space-y-3"><h3 className="font-semibold">Meal Plan Rates</h3>
          {bundle.mealPlanRates.length === 0 && <p className="text-sm text-text-secondary">No meal plans configured.</p>}
          {bundle.mealPlanRates.map((row) => <div key={row.id} className="rounded-control border border-border p-3 flex items-center justify-between gap-2 text-sm"><span><strong>{row.name}</strong> ({row.code}) · {row.pricePerNight}/night {row.perGuest ? "per guest" : "per room"}{!row.isActive && " · inactive"}</span><span className="flex gap-2"><button type="button" className="btn-secondary" onClick={() => setMeal({ ...row, pricePerNight: String(row.pricePerNight) })}>Edit</button><button type="button" className="btn-secondary" disabled={busy} onClick={() => void remove("meal", row.id)}>Delete</button></span></div>)}
          <form className="space-y-2 rounded-control border border-border p-3" onSubmit={saveMeal}><h4 className="font-medium">{meal.id ? "Edit meal plan" : "Add meal plan"}</h4>
            <label className="block text-sm">Code<input className={field} required maxLength={60} value={meal.code} onChange={(e) => setMeal({ ...meal, code: e.target.value })} /></label>
            <label className="block text-sm">Name<input className={field} required maxLength={100} value={meal.name} onChange={(e) => setMeal({ ...meal, name: e.target.value })} /></label>
            <label className="block text-sm">Price per night<input className={field} type="number" required min="0" max="99999999.99" step="0.01" value={meal.pricePerNight} onChange={(e) => setMeal({ ...meal, pricePerNight: e.target.value })} /></label>
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={meal.perGuest} onChange={(e) => setMeal({ ...meal, perGuest: e.target.checked })} /> Per guest</label>
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={meal.isActive} onChange={(e) => setMeal({ ...meal, isActive: e.target.checked })} /> Active</label>
            <div className="flex gap-2"><button className="btn-primary" disabled={busy}>Save meal plan</button>{meal.id && <button type="button" className="btn-secondary" onClick={() => setMeal(emptyMeal())}>Cancel</button>}</div>
          </form>
        </div>
        <div className="space-y-3"><h3 className="font-semibold">Occupancy Rate Rules</h3>
          {bundle.occupancyRateRules.length === 0 && <p className="text-sm text-text-secondary">No occupancy rules configured.</p>}
          {bundle.occupancyRateRules.map((row) => <div key={row.id} className="rounded-control border border-border p-3 flex items-center justify-between gap-2 text-sm"><span><strong>{row.label}</strong> ({row.occupancyType}) · {row.includedAdults} adults · +{row.surchargeAmount}/night · +{row.extraAdultRate}/extra adult{!row.isActive && " · inactive"}</span><span className="flex gap-2"><button type="button" className="btn-secondary" onClick={() => setOccupancy({ ...row, includedAdults: String(row.includedAdults), surchargeAmount: String(row.surchargeAmount), extraAdultRate: String(row.extraAdultRate) })}>Edit</button><button type="button" className="btn-secondary" disabled={busy} onClick={() => void remove("occupancy", row.id)}>Delete</button></span></div>)}
          <form className="space-y-2 rounded-control border border-border p-3" onSubmit={saveOccupancy}><h4 className="font-medium">{occupancy.id ? "Edit occupancy rule" : "Add occupancy rule"}</h4>
            <label className="block text-sm">Occupancy type<input className={field} required maxLength={60} value={occupancy.occupancyType} onChange={(e) => setOccupancy({ ...occupancy, occupancyType: e.target.value })} /></label>
            <label className="block text-sm">Label<input className={field} required maxLength={100} value={occupancy.label} onChange={(e) => setOccupancy({ ...occupancy, label: e.target.value })} /></label>
            <label className="block text-sm">Included adults<input className={field} type="number" required min="1" max="100" step="1" value={occupancy.includedAdults} onChange={(e) => setOccupancy({ ...occupancy, includedAdults: e.target.value })} /></label>
            <label className="block text-sm">Extra adult rate<input className={field} type="number" required min="0" max="99999999.99" step="0.01" value={occupancy.extraAdultRate} onChange={(e) => setOccupancy({ ...occupancy, extraAdultRate: e.target.value })} /></label>
            <label className="block text-sm">Occupancy surcharge<input className={field} type="number" required min="0" max="99999999.99" step="0.01" value={occupancy.surchargeAmount} onChange={(e) => setOccupancy({ ...occupancy, surchargeAmount: e.target.value })} /></label>
            <label className="flex gap-2 text-sm"><input type="checkbox" checked={occupancy.isActive} onChange={(e) => setOccupancy({ ...occupancy, isActive: e.target.checked })} /> Active</label>
            <div className="flex gap-2"><button className="btn-primary" disabled={busy}>Save occupancy rule</button>{occupancy.id && <button type="button" className="btn-secondary" onClick={() => setOccupancy(emptyOccupancy())}>Cancel</button>}</div>
          </form>
        </div>
      </div>
    </>}
  </section>;
}
