import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { UNIVERSAL_MEAL_PLANS } from "@/lib/pricing";
import { readMutationBody, validateMutation } from "@/lib/staff-settings-validation";

const amount = z.number().finite().min(0).max(99_999_999.99)
  .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.00001, "At most two decimal places are allowed.");
const mealSchema = z.strictObject({
  mealPlan: z.enum(UNIVERSAL_MEAL_PLANS),
  adultSurcharge: amount,
  childSurcharge: amount,
  isActive: z.boolean(),
});

async function authorize(write: boolean) {
  const tenant = await getTenantFromRoute(write ? "write" : "read");
  if (tenant instanceof NextResponse) return tenant;
  const forbidden = requireRole(tenant.role, write ? ROLE_GROUPS.MANAGEMENT : ROLE_GROUPS.GUEST_STAYS);
  if (forbidden) return forbidden;
  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS", write ? "write" : "read");
  return blocked || tenant;
}

export async function GET(req: Request) {
  const tenant = await authorize(false);
  if (tenant instanceof NextResponse) return tenant;
  const query = z.strictObject({}).safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return NextResponse.json({ error: "Invalid request.", issues: query.error.issues }, { status: 400 });
  try {
    const rows = await prisma.hotelMealPricing.findMany({ where: { hotelId: tenant.hotelId } });
    return NextResponse.json(UNIVERSAL_MEAL_PLANS.map((mealPlan) => {
      const row = rows.find((entry) => entry.mealPlan === mealPlan);
      return { mealPlan, adultSurcharge: Number(row?.adultSurcharge ?? 0), childSurcharge: Number(row?.childSurcharge ?? 0), isActive: row?.isActive ?? (mealPlan === "ROOM_ONLY") };
    }));
  } catch (error) {
    console.error("Failed to load hotel meal prices", error);
    return NextResponse.json({ error: "Could not load meal prices." }, { status: 500 });
  }
}

export async function PUT(req: Request) {
  const tenant = await authorize(true);
  if (tenant instanceof NextResponse) return tenant;
  const validated = validateMutation(req, mealSchema, await readMutationBody(req));
  if (validated.response) return validated.response;
  const { mealPlan, adultSurcharge, childSurcharge, isActive } = validated.data;
  try {
    const saved = await prisma.$transaction(async (tx) => {
      const lockKey = `hotel-${tenant.hotelId}-reservation-create`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const row = await tx.hotelMealPricing.upsert({
        where: { hotelId_mealPlan: { hotelId: tenant.hotelId, mealPlan } },
        create: { hotelId: tenant.hotelId, mealPlan, adultSurcharge, childSurcharge, isActive },
        update: { adultSurcharge, childSurcharge, isActive },
      });
      await recordAudit({ hotelId: tenant.hotelId, userId: tenant.userId, action: "MEAL_PRICING_UPDATED", entity: "HotelMealPricing", entityId: row.id, metadata: { mealPlan, adultSurcharge, childSurcharge, isActive } }, tx, { strict: true });
      return row;
    });
    return NextResponse.json({ mealPlan: saved.mealPlan, adultSurcharge: Number(saved.adultSurcharge), childSurcharge: Number(saved.childSurcharge), isActive: saved.isActive });
  } catch (error) {
    console.error("Failed to save hotel meal prices", error);
    return NextResponse.json({ error: "Could not save meal prices." }, { status: 500 });
  }
}

export const POST = PUT;
