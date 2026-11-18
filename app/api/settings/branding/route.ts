import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { isSafeLogoUrl } from "@/lib/branding";
import { prisma } from "@/lib/prisma";
import { readMutationBody, validateMutation } from "@/lib/staff-settings-validation";

const brandingSchema = z.strictObject({
  name: z.string().trim().min(2).max(100),
  logoUrl: z.string().trim().max(2048).refine(isSafeLogoUrl, "Use an HTTPS image URL without credentials.").nullable(),
});

async function authorize() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;
  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;
  return (await requireModule(tenant.hotelId, "RESERVATIONS")) || tenant;
}

export async function GET(req: Request) {
  const tenant = await authorize();
  if (tenant instanceof NextResponse) return tenant;
  const query = z.strictObject({}).safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return NextResponse.json({ error: "Invalid request.", issues: query.error.issues }, { status: 400 });
  try {
    const hotel = await prisma.hotel.findUnique({ 
      where: { id: tenant.hotelId }, 
      select: { name: true, logoUrl: true } 
    });
    return hotel ? NextResponse.json(hotel) : NextResponse.json({ error: "Hotel not found." }, { status: 404 });
  } catch (error) {
    console.error("Could not read hotel branding", error);
    return NextResponse.json({ error: "Could not load branding." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const tenant = await authorize();
  if (tenant instanceof NextResponse) return tenant;
  const parsed = validateMutation(req, brandingSchema, await readMutationBody(req));
  if (parsed.response) return parsed.response;
  try {
    const updated = await prisma.$transaction(async (tx) => {
      const hotel = await tx.hotel.update({ 
        where: { id: tenant.hotelId }, 
        data: parsed.data, 
        select: { name: true, logoUrl: true } 
      });
      await recordAudit({ 
        hotelId: tenant.hotelId, 
        userId: tenant.userId, 
        action: "HOTEL_BRANDING_UPDATED", 
        entity: "Hotel", 
        entityId: tenant.hotelId, 
        metadata: { fields: ["name", "logoUrl"] } 
      }, tx, { strict: true });
      return hotel;
    });
    return NextResponse.json(updated);
  } catch (error) {
    console.error("Could not update hotel branding", error);
    return NextResponse.json({ error: "Could not save branding." }, { status: 500 });
  }
}