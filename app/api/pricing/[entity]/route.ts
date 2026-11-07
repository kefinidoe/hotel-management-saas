import { NextResponse } from "next/server";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { pricingUnavailableResponse } from "@/lib/pricing/http";
import {
  PricingConfigError,
  createEntity,
  deleteEntity,
  isPricingEntity,
  updateEntity,
} from "@/lib/pricing/admin";

/**
 * Create, update and delete one pricing configuration entity
 * (occupancy types, meal plans, rate adjustments, extra beds, child rules,
 * taxes). The entity name is matched against a fixed allowlist, so the route can
 * never be pointed at an arbitrary table.
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

function errorResponse(error: unknown, fallback: string) {
  if (error instanceof PricingConfigError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  // A stale generated client or unreadable pricing configuration is an
  // infrastructure failure: 503 tells the UI nothing was saved, and the code
  // tells an operator what to fix.
  const unavailable = pricingUnavailableResponse(error, fallback);
  if (unavailable) return unavailable;
  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ entity: string }> }
) {
  const tenant = await authorize();
  if (tenant instanceof NextResponse) return tenant;

  const { entity } = await params;
  if (!isPricingEntity(entity)) {
    return NextResponse.json({ error: "Unknown pricing section." }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const created = await createEntity(entity, tenant.hotelId, body);
    await recordAudit({
      hotelId: tenant.hotelId,
      userId: tenant.userId,
      action: `PRICING_${entity.toUpperCase().replace(/-/g, "_")}_CREATED`,
      entity,
      entityId: (created as { id?: string }).id ?? null,
      metadata: body,
    });
    return NextResponse.json({ ok: true, record: created }, { status: 201 });
  } catch (error) {
    return errorResponse(error, "Could not save this pricing setting.");
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ entity: string }> }
) {
  const tenant = await authorize();
  if (tenant instanceof NextResponse) return tenant;

  const { entity } = await params;
  if (!isPricingEntity(entity)) {
    return NextResponse.json({ error: "Unknown pricing section." }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "Missing record id." }, { status: 400 });

  try {
    const updated = await updateEntity(entity, tenant.hotelId, id, body);
    await recordAudit({
      hotelId: tenant.hotelId,
      userId: tenant.userId,
      action: `PRICING_${entity.toUpperCase().replace(/-/g, "_")}_UPDATED`,
      entity,
      entityId: id,
      metadata: body,
    });
    return NextResponse.json({ ok: true, record: updated });
  } catch (error) {
    return errorResponse(error, "Could not update this pricing setting.");
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ entity: string }> }
) {
  const tenant = await authorize();
  if (tenant instanceof NextResponse) return tenant;

  const { entity } = await params;
  if (!isPricingEntity(entity)) {
    return NextResponse.json({ error: "Unknown pricing section." }, { status: 404 });
  }

  const id = new URL(req.url).searchParams.get("id") ?? "";
  if (!id) return NextResponse.json({ error: "Missing record id." }, { status: 400 });

  try {
    await deleteEntity(entity, tenant.hotelId, id);
    await recordAudit({
      hotelId: tenant.hotelId,
      userId: tenant.userId,
      action: `PRICING_${entity.toUpperCase().replace(/-/g, "_")}_DELETED`,
      entity,
      entityId: id,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Could not delete this pricing setting.");
  }
}
