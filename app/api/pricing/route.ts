import { NextResponse } from "next/server";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import {
  PricingConfigError,
  listPricingBundle,
  updatePricingSettings,
} from "@/lib/pricing/admin";

/**
 * The hotel's pricing configuration.
 *
 * Read and write are restricted to management roles and to hotels whose
 * subscription includes the reservations module. `hotelId` always comes from the
 * authenticated tenant, never from the request.
 */
async function authorize() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;
  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;
  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;
  return tenant;
}

export async function GET() {
  const tenant = await authorize();
  if (tenant instanceof NextResponse) return tenant;

  try {
    return NextResponse.json(await listPricingBundle(tenant.hotelId));
  } catch (error) {
    console.error("Failed to load pricing configuration:", error);
    return NextResponse.json({ error: "Could not load pricing configuration." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const tenant = await authorize();
  if (tenant instanceof NextResponse) return tenant;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const settings = await updatePricingSettings(tenant.hotelId, body);
    await recordAudit({
      hotelId: tenant.hotelId,
      userId: tenant.userId,
      action: "PRICING_SETTINGS_UPDATED",
      entity: "HotelPricingSettings",
      entityId: settings.id,
      metadata: body,
    });
    return NextResponse.json({ ok: true, settings });
  } catch (error) {
    if (error instanceof PricingConfigError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Failed to update pricing settings:", error);
    return NextResponse.json({ error: "Could not save pricing settings." }, { status: 500 });
  }
}
