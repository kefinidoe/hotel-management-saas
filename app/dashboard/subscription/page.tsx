import { requireBillingPageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";
import SubscriptionClient from "@/components/subscription/SubscriptionClient";

export const dynamic = "force-dynamic";

export default async function SubscriptionPage() {
  const context = await requireBillingPageRole(ROLE_GROUPS.ALL_STAFF);
  const canViewBilling = ROLE_GROUPS.STAFF_ADMIN.includes(context.role);

  return (
    <div className="p-6">
      {canViewBilling ? (
        <SubscriptionClient />
      ) : (
        <div className="mx-auto max-w-2xl rounded-xl border border-border bg-surface p-6">
          <h1 className="text-xl font-bold text-text-primary">Subscription access is limited</h1>
          <p className="mt-2 text-sm text-text-secondary">
            Hotel owners and administrators can view subscription and billing details. Please contact your hotel owner or administrator for help restoring workspace access.
          </p>
        </div>
      )}
    </div>
  );
}
