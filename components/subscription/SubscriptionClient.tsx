"use client";

import { useEffect, useState } from "react";
import {
  CreditCard,
  Building2,
  BedDouble,
  Check,
  AlertTriangle,
  Sparkles,
  ShieldCheck,
  Info,
  DollarSign,
  ArrowRight,
  TrendingDown,
  RefreshCw,
  HelpCircle,
} from "lucide-react";
import clsx from "clsx";

export default function SubscriptionClient() {
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [billingInterval, setBillingInterval] = useState<"MONTHLY" | "YEARLY">("MONTHLY");

  const fetchSubscriptionData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/subscription");
      if (!res.ok) {
        throw new Error(`Failed to load subscription (${res.status})`);
      }
      const json = await res.json();
      setData(json);
      if (json?.subscription?.billingInterval) {
        setBillingInterval(json.subscription.billingInterval);
      }
    } catch (err: any) {
      setError(err.message || "Failed to load subscription details.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSubscriptionData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="flex items-center gap-3 text-text-secondary text-sm">
          <RefreshCw className="animate-spin text-primary-500" size={20} />
          <span>Loading subscription room-band details...</span>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 max-w-4xl mx-auto">
        <div className="p-4 rounded-card bg-red-50 border border-red-200 text-red-700 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <AlertTriangle size={20} />
            <span className="text-sm font-medium">{error || "Failed to load subscription."}</span>
          </div>
          <button
            onClick={fetchSubscriptionData}
            className="px-3 py-1.5 rounded-control bg-red-600 text-white text-xs font-semibold hover:bg-red-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const { hotel, subscription, billableBreakdown, pricingSchedule, roomBands } = data;
  const isUSD = (hotel?.currency || "KES").toUpperCase() === "USD";
  const currencySymbol = isUSD ? "$" : "KSh ";

  const activeRooms = billableBreakdown?.billableActiveRooms ?? 0;
  const maxRoomsInCurrentBand = subscription?.limits?.maxRooms;
  const hasFiniteMax = isFinite(maxRoomsInCurrentBand);
  const percentUsed = hasFiniteMax
    ? Math.min(100, Math.round((activeRooms / maxRoomsInCurrentBand) * 100))
    : 20;

  const isScheduleApproved = Boolean(pricingSchedule?.isScheduleApproved);
  const configuredDiscountPercent = pricingSchedule?.defaultAnnualDiscountPercent ?? 0;
  const roundedDiscountPercent = Math.round(configuredDiscountPercent);
  const annualSavingsCurrent = pricingSchedule?.options?.yearly?.savingsVsMonthly ?? 0;

  const totalConfigured = billableBreakdown?.totalConfiguredRooms ?? activeRooms;
  const decommissioned = billableBreakdown?.decommissionedRooms ?? 0;
  const outOfOrderRooms = billableBreakdown?.statusBreakdown?.outOfOrder ?? 0;
  const maintenanceRooms = billableBreakdown?.statusBreakdown?.maintenance ?? 0;
  const outOfServiceTotal = outOfOrderRooms + maintenanceRooms;
  const operationalInServiceRooms = Math.max(0, activeRooms - outOfServiceTotal);

  return (
    <div className="max-w-6xl mx-auto space-y-8 pb-16">
      {/* HEADER BANNER */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-border pb-6">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-xs font-bold uppercase tracking-wider text-primary-600 font-mono">
              MIK Tech Hotel SaaS • Subscription & Billing
            </span>
            <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">
              Room-Band Model
            </span>
            {!isScheduleApproved && (
              <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-300 flex items-center gap-1">
                <AlertTriangle size={12} className="text-amber-600" />
                Indicative Pricing (Unapproved)
              </span>
            )}
          </div>
          <h1 className="text-2xl font-bold text-text-primary tracking-tight mt-1 flex items-center gap-2.5">
            <Building2 className="text-primary-500" size={26} />
            {hotel.name} — Subscription
          </h1>
          <p className="text-sm text-text-secondary mt-1">
            Predictable room-band pricing. Full core platform access across all property sizes.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right">
            <span className="text-[11px] font-semibold text-text-secondary uppercase block">
              Subscription Status
            </span>
            <span
              className={clsx(
                "inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wide",
                subscription.effectiveStatus === "ACTIVE"
                  ? "bg-emerald-100 text-emerald-800"
                  : subscription.effectiveStatus === "TRIALING"
                  ? "bg-blue-100 text-blue-800"
                  : "bg-amber-100 text-amber-800"
              )}
            >
              <span className="w-2 h-2 rounded-full bg-current" />
              {subscription.effectiveStatus}
            </span>
          </div>
        </div>
      </div>

      {/* TOP SUMMARY METRICS & BILLABLE BREAKDOWN */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Card 1: Active Room Band */}
        <div className="card p-5 border border-border space-y-4 shadow-sm bg-surface">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider flex items-center gap-1.5">
              <CreditCard size={15} className="text-primary-500" />
              Current Room Band
            </span>
            <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-primary-100 text-primary-800">
              {subscription.bandName}
            </span>
          </div>

          <div>
            <div className="text-2xl font-bold text-text-primary">
              {activeRooms}{" "}
              <span className="text-sm font-normal text-text-secondary">
                / {hasFiniteMax ? `${maxRoomsInCurrentBand} Rooms` : "Unlimited Rooms"}
              </span>
            </div>
            <div className="w-full bg-surface-secondary rounded-full h-2 mt-2 overflow-hidden border border-border">
              <div
                className={clsx(
                  "h-full transition-all duration-300",
                  billableBreakdown?.isOverBandCapacity
                    ? "bg-red-500"
                    : percentUsed > 85
                    ? "bg-amber-500"
                    : "bg-primary-500"
                )}
                style={{ width: `${percentUsed}%` }}
              />
            </div>
            <p className="text-xs text-text-muted mt-2">
              {billableBreakdown?.isOverBandCapacity ? (
                <span className="text-red-600 font-semibold flex items-center gap-1">
                  <AlertTriangle size={13} />
                  Over capacity by {activeRooms - maxRoomsInCurrentBand} rooms. Upgrade required.
                </span>
              ) : hasFiniteMax ? (
                <span>{billableBreakdown?.roomsRemainingInBand} additional room(s) available in this band.</span>
              ) : (
                <span>Custom quote scale with unrestricted room capacity.</span>
              )}
            </p>
          </div>

          <div className="pt-3 border-t border-border flex items-center justify-between text-xs text-text-secondary">
            <span>Billing Schedule:</span>
            <strong className="text-text-primary uppercase">{subscription.billingInterval}</strong>
          </div>
        </div>

        {/* Card 2: Billable vs Non-Billable Breakdown (No Double-Counting) */}
        <div className="card p-5 border border-border space-y-3 shadow-sm bg-surface">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider flex items-center gap-1.5">
              <BedDouble size={15} className="text-primary-500" />
              Room Inventory Accounting
            </span>
            <span className="text-[11px] font-mono text-text-muted">
              Total: {totalConfigured} rooms
            </span>
          </div>

          <div className="space-y-2 text-xs">
            {/* Total Billable Active Rooms */}
            <div className="p-2.5 rounded bg-surface-secondary border border-border space-y-1.5">
              <div className="flex items-center justify-between">
                <div>
                  <span className="font-bold text-text-primary block">Active Inventory (Billable)</span>
                  <span className="text-[10px] text-text-muted">Total billable room count</span>
                </div>
                <span className="font-extrabold text-text-primary text-base">{activeRooms} rooms</span>
              </div>

              {/* Sub-breakdown explicitly showing that out-of-order & maintenance are included inside the active total */}
              <div className="pt-2 border-t border-border/70 space-y-1 text-[11px] text-text-secondary">
                <div className="flex items-center justify-between pl-2 border-l-2 border-emerald-400">
                  <span>Available / Occupied / In-Service:</span>
                  <span className="font-mono text-text-primary">{operationalInServiceRooms}</span>
                </div>
                <div className="flex items-center justify-between pl-2 border-l-2 border-blue-400">
                  <span className="flex items-center gap-1">
                    <Info size={11} className="text-blue-500" />
                    Temp. Out of Order / Maint. (included in active total):
                  </span>
                  <span className="font-mono text-text-primary">{outOfServiceTotal}</span>
                </div>
              </div>
            </div>

            {/* Decommissioned / Inactive */}
            <div className="flex items-center justify-between p-2.5 rounded bg-surface-secondary border border-border">
              <div>
                <span className="text-text-secondary block font-medium">Decommissioned / Archived</span>
                <span className="text-[10px] text-text-muted">Excluded from subscription quota</span>
              </div>
              <span className="font-bold text-emerald-600">
                {decommissioned} (Non-billable)
              </span>
            </div>
          </div>

          <p className="text-[11px] text-text-muted leading-tight">
            The active-room total ({activeRooms}) already includes active rooms temporarily out of order or under maintenance. Decommissioned rooms do not count toward subscription quotas.
          </p>
        </div>

        {/* Card 3: Pricing & Term Details */}
        <div className="card p-5 border border-border space-y-3 shadow-sm bg-surface">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold text-text-secondary uppercase tracking-wider flex items-center gap-1.5">
              <DollarSign size={15} className="text-primary-500" />
              Effective Subscription Rate
            </span>
            {!isScheduleApproved && (
              <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-200">
                Indicative • Unapproved
              </span>
            )}
          </div>

          <div>
            <div className="text-2xl font-bold text-text-primary flex items-baseline gap-1">
              <span>{currencySymbol}{subscription.amount?.toLocaleString() || "0"}</span>
              <span className="text-xs font-normal text-text-secondary">
                / {subscription.billingInterval === "YEARLY" ? "year" : "month"}
              </span>
            </div>
            {!isScheduleApproved && (
              <p className="text-[11px] text-amber-700 font-medium mt-0.5">
                Baseline rate pending executive approval
              </p>
            )}
            <p className="text-xs text-text-muted mt-1">
              {subscription.billingInterval === "YEARLY"
                ? `Normalized MRR: ${currencySymbol}${Math.round((subscription.amount || 0) / 12).toLocaleString()}/month`
                : "Standard monthly billing interval"}
            </p>
          </div>

          <div className="pt-2 border-t border-border space-y-1.5 text-xs text-text-secondary">
            <div className="flex justify-between">
              <span>Period Starts:</span>
              <span className="font-mono text-text-primary">
                {subscription.currentPeriodStartsAt
                  ? new Date(subscription.currentPeriodStartsAt).toLocaleDateString()
                  : "—"}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Next Renewal / Term End:</span>
              <span className="font-mono text-text-primary">
                {subscription.currentPeriodEndsAt
                  ? new Date(subscription.currentPeriodEndsAt).toLocaleDateString()
                  : "Automatic Monthly Renewal"}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* BILLING INTERVAL TOGGLE & ANNUAL SAVINGS BANNER */}
      <div className="bg-gradient-to-r from-primary-50 via-surface to-primary-50 border border-primary-200 rounded-card p-6 flex flex-col md:flex-row items-center justify-between gap-6 shadow-sm">
        <div>
          <div className="flex flex-wrap items-center gap-2 mb-2">
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold bg-primary-600 text-white">
              <Sparkles size={13} />
              Annual Discount Available
            </span>
            {!isScheduleApproved && (
              <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-amber-100 text-amber-800 border border-amber-300">
                Indicative Schedule
              </span>
            )}
          </div>
          <h3 className="text-lg font-bold text-text-primary">
            {roundedDiscountPercent > 0
              ? `Save ${roundedDiscountPercent}% with Annual Subscription Billing`
              : "Annual Subscription Billing"}
          </h3>
          <p className="text-xs text-text-secondary mt-1 max-w-xl">
            {annualSavingsCurrent > 0 ? (
              `Switching to an annual subscription saves your property ${currencySymbol}${annualSavingsCurrent.toLocaleString()} per year (${roundedDiscountPercent}% configured discount). Billed once annually with seamless continuity.`
            ) : roundedDiscountPercent > 0 ? (
              `Switching to an annual subscription saves ${roundedDiscountPercent}% per year compared to monthly billing. Billed once annually with seamless continuity.`
            ) : (
              "Annual subscription billing provides predictable yearly budgeting billed once annually with seamless continuity."
            )}
          </p>
        </div>

        {/* Toggle Switch */}
        <div className="flex flex-col items-center md:items-end gap-1.5">
          <div className="flex items-center gap-2 p-1 bg-surface-secondary border border-border rounded-full shadow-inner">
            <button
              type="button"
              onClick={() => setBillingInterval("MONTHLY")}
              className={clsx(
                "px-4 py-2 rounded-full text-xs font-bold transition-all",
                billingInterval === "MONTHLY"
                  ? "bg-white text-text-primary shadow-sm"
                  : "text-text-secondary hover:text-text-primary"
              )}
            >
              Monthly
            </button>
            <button
              type="button"
              onClick={() => setBillingInterval("YEARLY")}
              className={clsx(
                "px-4 py-2 rounded-full text-xs font-bold transition-all flex items-center gap-1.5",
                billingInterval === "YEARLY"
                  ? "bg-primary-600 text-white shadow-sm"
                  : "text-text-secondary hover:text-text-primary"
              )}
            >
              <span>Annual</span>
              {roundedDiscountPercent > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-[10px] bg-emerald-500 text-white font-extrabold">
                  Save {roundedDiscountPercent}%
                </span>
              )}
            </button>
          </div>
          <span className="text-[10px] text-text-muted">
            Comparison view only • Active saved plan: {subscription.billingInterval}
          </span>
        </div>
      </div>

      {/* ROOM BAND COMPARISON MATRIX */}
      <div className="space-y-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold text-text-primary">Configurable Room Bands</h2>
            {!isScheduleApproved && (
              <span className="px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-300 flex items-center gap-1">
                <AlertTriangle size={12} className="text-amber-600" />
                Indicative &amp; Unapproved Schedule
              </span>
            )}
          </div>
          <p className="text-xs text-text-secondary mt-1">
            {!isScheduleApproved
              ? "All room band rates shown below are indicative placeholder estimates pending final business approval. Core hotel management features are included across all room bands."
              : "Fixed room-band pricing schedule. Every tier includes the complete suite of hotel operations, restaurant POS, inventory, and reports."}
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {roomBands.map((band: any) => {
            const isCurrent = band.id === subscription.planId;
            const isRecommended = band.id === billableBreakdown?.recommendedBandId;
            const isAnnual = billingInterval === "YEARLY";

            const monthlyPrice = isUSD ? band.monthlyPriceUSD : band.monthlyPriceKES;
            const yearlyPrice = isUSD ? band.yearlyPriceUSD : band.yearlyPriceKES;

            const displayPrice = isAnnual ? yearlyPrice : monthlyPrice;

            const monthlyEquiv = isAnnual && !band.isCustomQuote
              ? Math.round(displayPrice / 12)
              : displayPrice;

            const bandSavings = (monthlyPrice * 12) - yearlyPrice;
            const bandDiscount = Math.round(band.annualDiscountPercentage || configuredDiscountPercent);

            return (
              <div
                key={band.id}
                className={clsx(
                  "card p-5 border rounded-card space-y-4 transition-all flex flex-col justify-between",
                  isCurrent
                    ? "border-primary-500 ring-2 ring-primary-500/20 bg-primary-50/20 shadow-md"
                    : "border-border bg-surface hover:border-text-secondary"
                )}
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-base font-bold text-text-primary">{band.name}</h4>
                        {isCurrent && (
                          <span className="px-2 py-0.5 rounded text-[10px] font-extrabold bg-primary-600 text-white">
                            Current
                          </span>
                        )}
                        {!isCurrent && isRecommended && (
                          <span className="px-2 py-0.5 rounded text-[10px] font-extrabold bg-emerald-600 text-white">
                            Recommended
                          </span>
                        )}
                      </div>
                      <span className="text-[11px] text-text-secondary font-mono block mt-0.5">
                        Capacity: {band.minRooms}–{band.maxRooms} Rooms
                      </span>
                    </div>

                    {band.badge && !isCurrent && !isRecommended && (
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-surface-secondary border border-border text-text-primary">
                        {band.badge}
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-text-secondary leading-relaxed min-h-[36px]">
                    {band.tagline}
                  </p>

                  {/* Pricing Box */}
                  <div className="p-3 rounded-card bg-surface-secondary border border-border/80">
                    {band.isCustomQuote ? (
                      <div>
                        <span className="text-lg font-bold text-text-primary">Custom Quote</span>
                        <p className="text-[11px] text-text-muted mt-0.5">
                          Enterprise negotiated pricing for multi-property resorts.
                        </p>
                      </div>
                    ) : (
                      <div>
                        <div className="flex items-baseline gap-1">
                          <span className="text-2xl font-extrabold text-text-primary">
                            {currencySymbol}{displayPrice.toLocaleString()}
                          </span>
                          <span className="text-xs text-text-secondary font-medium">
                            / {isAnnual ? "year" : "month"}
                          </span>
                        </div>
                        {!isScheduleApproved && (
                          <div className="text-[10px] font-semibold text-amber-700 uppercase tracking-wider mt-0.5 flex items-center gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
                            Indicative • Unapproved
                          </div>
                        )}
                        {isAnnual && bandSavings > 0 && (
                          <div className="text-[11px] text-emerald-600 font-semibold mt-1 flex items-center gap-1">
                            <TrendingDown size={13} />
                            <span>
                              {currencySymbol}{monthlyEquiv.toLocaleString()}/mo equivalent (Save {currencySymbol}{bandSavings.toLocaleString()}/yr{bandDiscount > 0 ? ` • ${bandDiscount}% off` : ""})
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* Modules Included Checklist */}
                  <div className="space-y-1.5 pt-2">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-text-secondary block">
                      All Core Modules Included:
                    </span>
                    <ul className="text-xs space-y-1 text-text-primary">
                      <li className="flex items-center gap-2">
                        <Check size={14} className="text-emerald-500 shrink-0" />
                        <span>Front Desk Reservations & Folios</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <Check size={14} className="text-emerald-500 shrink-0" />
                        <span>Housekeeping & Room Status</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <Check size={14} className="text-emerald-500 shrink-0" />
                        <span>Restaurant POS & Kitchen Orders</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <Check size={14} className="text-emerald-500 shrink-0" />
                        <span>Inventory, Recipes & Stock Depletion</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <Check size={14} className="text-emerald-500 shrink-0" />
                        <span>Expense Tracking & Operational Audits</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <Check size={14} className="text-emerald-500 shrink-0" />
                        <span>Maintenance Dispatching & Work Orders</span>
                      </li>
                      <li className="flex items-center gap-2">
                        <Check size={14} className="text-emerald-500 shrink-0" />
                        <span>Reports & Comprehensive Analytics</span>
                      </li>
                    </ul>
                  </div>
                </div>

                {/* Footer Action */}
                <div className="pt-4 border-t border-border">
                  {isCurrent ? (
                    <div className="w-full py-2 text-center text-xs font-semibold text-primary-700 bg-primary-100/60 rounded-control">
                      Active Property Band
                    </div>
                  ) : (
                    <div className="space-y-1.5">
                      <button
                        type="button"
                        disabled
                        className="w-full py-2 text-center text-xs font-semibold rounded-control border border-border bg-surface-secondary text-text-muted cursor-not-allowed flex items-center justify-center gap-1.5"
                        aria-disabled="true"
                        title="Adjustments are managed by your Platform Administrator or Billing Support."
                      >
                        <span>{band.isCustomQuote ? "Contact Sales" : "Selection Managed by Admin"}</span>
                        <ArrowRight size={13} />
                      </button>
                      <p className="text-[11px] text-text-muted text-center leading-tight">
                        Self-service switching disabled. Request band changes through Platform Admin.
                      </p>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* HOW TO REQUEST A ROOM BAND CHANGE */}
      <div className="card p-5 border border-border rounded-card bg-surface space-y-3 shadow-sm">
        <div className="flex items-center gap-2">
          <HelpCircle className="text-primary-500" size={18} />
          <h3 className="text-sm font-bold text-text-primary">
            How to Request a Room-Band Change
          </h3>
        </div>
        <p className="text-xs text-text-secondary leading-relaxed">
          Direct online self-service band switching is disabled to prevent quota misconfigurations and unverified billing changes. Room-band adjustments (upgrades or downgrades) are safely administered by Platform Billing Administrators.
        </p>
        <div className="p-3 bg-surface-secondary rounded border border-border text-xs text-text-secondary space-y-1.5">
          <div className="font-semibold text-text-primary">Workflow for requesting a band adjustment:</div>
          <ol className="list-decimal list-inside space-y-1 text-[11px] text-text-muted pl-1">
            <li>Verify your current billable active room count ({activeRooms} active rooms) to identify your required room band.</li>
            <li>Contact your property administrator or email Platform Billing Support.</li>
            <li>Provide your Hotel ID (<code className="font-mono text-text-primary font-semibold">{hotel.id}</code>) and requested band tier.</li>
            <li>The platform administrator will verify room quotas and update the room band non-destructively, preserving all existing reservations, folios, and historical data.</li>
          </ol>
        </div>
      </div>

      {/* POLICY & RULES ACCORDION */}
      <div className="card p-6 border border-border space-y-4 shadow-sm bg-surface">
        <h3 className="text-base font-bold text-text-primary flex items-center gap-2">
          <ShieldCheck className="text-primary-500" size={18} />
          Room Band Billing Policies & Lifecycle Guarantees
        </h3>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
          <div className="p-3.5 rounded-card bg-surface-secondary border border-border space-y-1.5">
            <h4 className="font-bold text-text-primary flex items-center gap-1.5">
              <Check className="text-emerald-500" size={15} /> Room Additions
            </h4>
            <p className="text-text-secondary leading-relaxed">
              Add rooms freely within your active band capacity. If your room additions exceed the current band limit, the platform prevents over-quota creation and prompts an upgrade to the next band.
            </p>
          </div>

          <div className="p-3.5 rounded-card bg-surface-secondary border border-border space-y-1.5">
            <h4 className="font-bold text-text-primary flex items-center gap-1.5">
              <Check className="text-emerald-500" size={15} /> Non-Destructive Downgrades
            </h4>
            <p className="text-text-secondary leading-relaxed">
              Decommissioning inactive rooms reduces your billable room count. Switching to a lower band preserves all historical reservations, folios, and past room records without destructive deletion.
            </p>
          </div>

          <div className="p-3.5 rounded-card bg-surface-secondary border border-border space-y-1.5">
            <h4 className="font-bold text-text-primary flex items-center gap-1.5">
              <Check className="text-emerald-500" size={15} /> Core Feature Parity
            </h4>
            <p className="text-text-secondary leading-relaxed">
              All room bands have unrestricted access to restaurant POS, inventory, recipe tracking, housekeeping, and analytics. Pricing scales by property room capacity, not artificial feature gating.
            </p>
          </div>
        </div>

        {/* Pricing Schedule Notice */}
        <div className="p-3.5 rounded bg-amber-50 border border-amber-200 text-amber-900 text-xs flex items-start gap-2.5">
          <Info className="text-amber-600 shrink-0 mt-0.5" size={16} />
          <div className="space-y-1">
            <div className="font-bold flex items-center gap-1.5">
              <span>Notice on Pricing Schedule:</span>
              {!isScheduleApproved && (
                <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-200 text-amber-800 font-semibold uppercase">
                  Indicative • Unapproved
                </span>
              )}
            </div>
            <p className="text-amber-800 leading-relaxed">
              {pricingSchedule?.notes || "Configurable baseline pricing schedule pending final business approval. Final prices to be set before commercial launch."}{" "}
              {!isScheduleApproved
                ? "Prices displayed across all room bands are indicative baseline estimates pending final executive approval. Live automated billing will be activated following official schedule sign-off."
                : "Final currency schedules are verified prior to commercial payment processing. Live payments are managed in an upcoming release."}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
