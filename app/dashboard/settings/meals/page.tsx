import ModularPricingSettings from "@/components/settings/ModularPricingSettings";
import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";

export const dynamic = "force-dynamic";
export default async function MealPricingPage() {
  const tenant = await requirePageRole(ROLE_GROUPS.MANAGEMENT, "RESERVATIONS");
  return <div className="max-w-4xl space-y-5"><h1>Meal Plans &amp; Pricing</h1><ModularPricingSettings currency={tenant.hotel.currency} /></div>;
}
