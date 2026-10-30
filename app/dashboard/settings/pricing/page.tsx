import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";
import { listPricingBundle } from "@/lib/pricing/admin";
import PricingClient from "@/components/pricing/PricingClient";

export const dynamic = "force-dynamic";

/**
 * Hotel Settings → Pricing & Rates.
 *
 * Management only: pricing is commercial configuration, so receptionists can sell
 * at these prices but cannot change them.
 */
export default async function PricingSettingsPage() {
  const context = await requirePageRole(ROLE_GROUPS.MANAGEMENT, "RESERVATIONS");
  const bundle = await listPricingBundle(context.hotelId);

  return (
    <PricingClient
      initialBundle={{
        ...bundle,
        settings: {
          pricingModel: bundle.settings.pricingModel,
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
