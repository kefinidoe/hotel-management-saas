import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";
import SubscriptionClient from "@/components/subscription/SubscriptionClient";

export const dynamic = "force-dynamic";

export default async function SubscriptionPage() {
  await requirePageRole(ROLE_GROUPS.STAFF_ADMIN);

  return (
    <div className="p-6">
      <SubscriptionClient />
    </div>
  );
}
