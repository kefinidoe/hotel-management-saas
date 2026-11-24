import { NextResponse } from "next/server";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { pricingUnavailableResponse } from "@/lib/pricing/http";
import { PricingConfigError, setRoomTypeRates } from "@/lib/pricing/admin";

/** Bulk upsert of one room type's per-occupancy nightly rates. */
export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;
  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;
  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const rates = await prisma.$transaction(async (tx) => {
      const saved = await setRoomTypeRates(tenant.hotelId, body, tx);
      await recordAudit({
        hotelId: tenant.hotelId,
        userId: tenant.userId,
        action: "ROOM_RATES_UPDATED",
        entity: "RoomTypeOccupancy",
        entityId: typeof body.roomTypeId === "string" ? body.roomTypeId : null,
        metadata: { rates: body.rates },
      }, tx, { strict: true });
      return saved;
    }, { isolationLevel: "Serializable" });
    return NextResponse.json({ ok: true, rates });
  } catch (error) {
    if (error instanceof PricingConfigError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const unavailable = pricingUnavailableResponse(error, "POST /api/pricing/room-rates");
    if (unavailable) return unavailable;
    console.error("Failed to save room rates:", error);
    return NextResponse.json({ error: "Could not save room rates." }, { status: 500 });
  }
}
