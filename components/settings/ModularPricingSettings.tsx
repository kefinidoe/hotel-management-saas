"use client";

import { useEffect, useState } from "react";
import { apiErrorMessage, requestJson } from "@/lib/client-api";
import { UNIVERSAL_MEAL_PLAN_LABELS, type UniversalMealPlan } from "@/lib/pricing";

type Row = { mealPlan: UniversalMealPlan; adultSurcharge: number; childSurcharge: number; isActive: boolean };
type Draft = { mealPlan: UniversalMealPlan; adultSurcharge: string; childSurcharge: string; isActive: boolean };

export default function ModularPricingSettings({ currency }: { currency: string }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [rows, setRows] = useState<Draft[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([requestJson<{ useModularPricing: boolean }>("/api/settings/hotel"), requestJson<Row[]>("/api/settings/meals")])
      .then(([hotel, rates]) => {
        if (cancelled) return;
        setEnabled(hotel.useModularPricing);
        setRows(rates.map((row) => ({ ...row, adultSurcharge: String(row.adultSurcharge), childSurcharge: String(row.childSurcharge) })));
      })
      .catch((failure) => { if (!cancelled) setError(apiErrorMessage(failure, "Could not load meal pricing.")); });
    return () => { cancelled = true; };
  }, []);

  function update(code: UniversalMealPlan, patch: Partial<Draft>) {
    setRows((old) => old.map((row) => row.mealPlan === code ? { ...row, ...patch } : row));
  }
  async function save(row: Draft) {
    if (!row.adultSurcharge.trim() || !row.childSurcharge.trim()) { setError("Enter both surcharge amounts."); return; }
    setBusy(true); setError(null); setNotice(null);
    try {
      await requestJson("/api/settings/meals", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...row, adultSurcharge: Number(row.adultSurcharge), childSurcharge: Number(row.childSurcharge) }) });
      setNotice(`${UNIVERSAL_MEAL_PLAN_LABELS[row.mealPlan]} saved.`);
    } catch (failure) { setError(apiErrorMessage(failure, "Could not save meal pricing.")); }
    finally { setBusy(false); }
  }
  async function changeMode(next: boolean) {
    setBusy(true); setError(null); setNotice(null);
    try {
      const updated = await requestJson<{ useModularPricing: boolean }>("/api/settings/hotel", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ useModularPricing: next }) });
      setEnabled(updated.useModularPricing); setConfirm(null); setNotice("Pricing mode updated.");
    } catch (failure) { setError(apiErrorMessage(failure, "Could not update pricing mode.")); }
    finally { setBusy(false); }
  }

  return <section className="card border border-border p-5 space-y-4" aria-labelledby="modular-settings-title">
    <h2 id="modular-settings-title" className="text-base font-semibold">Meal Plans &amp; Modular Pricing</h2>
    <p className="text-sm text-text-secondary">Set nightly per-person surcharges in {currency}. Save each plan before enabling it.</p>
    {error && <p role="alert" className="text-sm text-danger">{error}</p>}
    {notice && <p role="status" className="text-sm text-success">{notice}</p>}
    {enabled === null && !error && <p>Loading pricing settings…</p>}
    {enabled !== null && <>
      <label className="flex gap-2 items-center font-medium text-sm">
        <input type="checkbox" checked={enabled} disabled={busy} onChange={(e) => setConfirm(e.target.checked)} /> Enable Modular Room &amp; Meal Pricing
      </label>
      <div className="space-y-3">{rows.map((row) => <div key={row.mealPlan} className="border border-border rounded-control p-3 space-y-2">
        <div className="flex justify-between gap-2"><strong className="text-sm">{UNIVERSAL_MEAL_PLAN_LABELS[row.mealPlan]}</strong>
          <label className="text-sm"><input type="checkbox" checked={row.isActive} onChange={(e) => update(row.mealPlan, { isActive: e.target.checked })} /> Active</label></div>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs">Adult / night ({currency})<input aria-label={`${UNIVERSAL_MEAL_PLAN_LABELS[row.mealPlan]} adult surcharge`} type="number" min="0" step="0.01" value={row.adultSurcharge} onChange={(e) => update(row.mealPlan, { adultSurcharge: e.target.value })} className="w-full rounded-control border border-border p-2" /></label>
          <label className="text-xs">Child / night ({currency})<input aria-label={`${UNIVERSAL_MEAL_PLAN_LABELS[row.mealPlan]} child surcharge`} type="number" min="0" step="0.01" value={row.childSurcharge} onChange={(e) => update(row.mealPlan, { childSurcharge: e.target.value })} className="w-full rounded-control border border-border p-2" /></label>
        </div><button type="button" className="btn-secondary text-sm" disabled={busy} onClick={() => void save(row)}>Save {UNIVERSAL_MEAL_PLAN_LABELS[row.mealPlan]}</button>
      </div>)}</div>
    </>}
    {confirm !== null && <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="pricing-confirm-title">
      <div className="card max-w-md p-5 space-y-4">
        <h3 id="pricing-confirm-title" className="font-semibold">{confirm ? "Enable" : "Disable"} modular pricing?</h3>
        <p className="text-sm">Existing bookings retain their saved rates. Future reservations use the selected pricing mode. Modular reservation repricing and automatic extensions are not yet available.</p>
        <div className="flex gap-2"><button type="button" className="btn-secondary" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button><button type="button" className="btn-primary" disabled={busy} onClick={() => void changeMode(confirm)}>Confirm</button></div>
      </div>
    </div>}
  </section>;
}
