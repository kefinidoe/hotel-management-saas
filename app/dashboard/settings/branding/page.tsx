import BrandingSettings from "@/components/settings/BrandingSettings";
import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function PropertyBrandingPage() {
  await requirePageRole(ROLE_GROUPS.MANAGEMENT, "RESERVATIONS");

  return (
    <div className="max-w-4xl space-y-5">
      <h1>Property Settings</h1>
      <BrandingSettings />
    </div>
  );
}
