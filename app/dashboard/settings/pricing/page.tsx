import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";
import { listPricingBundle } from "@/lib/pricing/admin";
import { isPricingUnavailable } from "@/lib/pricing/errors";
import { logPricingFailure } from "@/lib/pricing/delegates";
import PricingClient from "@/components/pricing/PricingClient";

export const dynamic = "force-dynamic";

/**
 * Shown instead of the settings form when the server cannot serve the pricing
 * configuration at all (stale generated client, missing migration, unreadable
 * database). The cause is logged; the page states plainly that nothing can be
 * read or saved, so a manager does not sit on a form whose saves will fail.
 */
function PricingUnavailable({ message, code }: { message: string; code: string }) {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <div
        role="alert"
        data-testid="pricing-unavailable"
        className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-amber-900"
      >
        <h1 className="text-lg font-semibold">Pricing &amp; Rates is unavailable</h1>
        <p className="mt-2 text-sm">{message}</p>
        <p className="mt-3 text-xs uppercase tracking-wide text-amber-700">Reference: {code}</p>
        <p className="mt-3 text-sm">
          No prices were changed and no reservations were priced while this problem exists.
        </p>
      </div>
    </div>
  );
}

/**
 * Hotel Settings → Pricing & Rates.
 *
 * Management only: pricing is commercial configuration, so receptionists can sell
 * at these prices but cannot change them.
 */
export default async function PricingSettingsPage() {
  const context = await requirePageRole(ROLE_GROUPS.MANAGEMENT, "RESERVATIONS");

  let bundle: Awaited<ReturnType<typeof listPricingBundle>>;
  try {
    bundle = await listPricingBundle(context.hotelId);
  } catch (error) {
    if (!isPricingUnavailable(error)) throw error;
    // The full cause (which delegate is missing, which table, which driver error)
    // stays in the server log; the page only shows the safe message and a code.
    logPricingFailure(error, "GET /dashboard/settings/pricing");
    return <PricingUnavailable message={error.message} code={error.code} />;
  }

  return (
    <PricingClient
      initialBundle={{
        ...bundle,
        settings: {
          pricingModel: bundle.settings.pricingModel === "ROOM_TYPE_OCCUPANCY" ? "ROOM_TYPE_OCCUPANCY" : "LEGACY_BASE_RATE",
          useOccupancyRates: bundle.settings.useOccupancyRates,
          useMealPlans: bundle.settings.useMealPlans,
          useSeasonalPricing: bundle.settings.useSeasonalPricing,
          useWeekendPricing: bundle.settings.useWeekendPricing,
          useChildPricing: bundle.settings.useChildPricing,
          useExtraBeds: bundle.settings.useExtraBeds,
          useTaxes: bundle.settings.useTaxes,
          pricesIncludeTax: bundle.settings.pricesIncludeTax,
        },
      }}
    />
  );
}
