import AuditTrailClient from "@/components/audit/AuditTrailClient";
import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";

export const dynamic = "force-dynamic";

export default async function AuditTrailPage() {
  const tenant = await requirePageRole(ROLE_GROUPS.STAFF_ADMIN);
  return <AuditTrailClient hotelName={tenant.hotel.name} />;
}
