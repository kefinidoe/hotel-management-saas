import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { readMutationBody, validateMutation } from "@/lib/staff-settings-validation";

async function authorize(write: boolean) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;
  const forbidden = requireRole(tenant.role, write ? ROLE_GROUPS.MANAGEMENT : ROLE_GROUPS.GUEST_STAYS);
  if (forbidden) return forbidden;
  return (await requireModule(tenant.hotelId, "RESERVATIONS")) || tenant;
}

export async function GET(req: Request) {
  const tenant = await authorize(false);
  if (tenant instanceof NextResponse) return tenant;
  const parsed = z.strictObject({}).safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request.", issues: parsed.error.issues }, { status: 400 });
  try {
    const hotel = await prisma.hotel.findUnique({ where: { id: tenant.hotelId }, select: { useModularPricing: true } });
    return hotel ? NextResponse.json(hotel) : NextResponse.json({ error: "Hotel not found." }, { status: 404 });
  } catch (error) {
    console.error("Could not read pricing mode", error);
    return NextResponse.json({ error: "Could not load pricing mode." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const tenant = await authorize(true);
  if (tenant instanceof NextResponse) return tenant;
  const validation = validateMutation(req, z.strictObject({ useModularPricing: z.boolean() }), await readMutationBody(req));
  if (validation.response) return validation.response;
  try {
    const hotel = await prisma.$transaction(async (tx) => {
      const lockKey = `hotel-${tenant.hotelId}-reservation-create`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const previous = await tx.hotel.findUnique({ where: { id: tenant.hotelId }, select: { useModularPricing: true } });
      if (!previous) throw new Error("Hotel not found");
      const updated = await tx.hotel.update({ where: { id: tenant.hotelId }, data: validation.data, select: { useModularPricing: true } });
      await recordAudit({ hotelId: tenant.hotelId, userId: tenant.userId, action: "MODULAR_PRICING_MODE_UPDATED", entity: "Hotel", entityId: tenant.hotelId, metadata: { previous: previous.useModularPricing, next: updated.useModularPricing } }, tx, { strict: true });
      return updated;
    });
    return NextResponse.json(hotel);
  } catch (error) {
    console.error("Could not update pricing mode", error);
    return NextResponse.json({ error: "Could not update pricing mode." }, { status: 500 });
  }
}
