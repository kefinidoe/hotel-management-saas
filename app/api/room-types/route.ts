import { validateRoomStayMutation, roomTypeCreateSchema } from "@/lib/room-stay-mutation-validation";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { isMealPlan } from "@/lib/tariffs";

export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  const roomTypes = await prisma.roomType.findMany({
    where: { hotelId: tenant.hotelId },
    orderBy: { name: "asc" },
  });
  return NextResponse.json(roomTypes.map((rt) => ({ ...rt, baseRate: Number(rt.baseRate) })));
}

export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  const validation = await validateRoomStayMutation(req, roomTypeCreateSchema, {});
  if (validation.response) return validation.response;
  const body = validation.data;

  const hotelId = tenant.hotelId;


  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const baseRate = Number(body?.baseRate);

  if (!name || isNaN(baseRate) || baseRate < 0) {
    return NextResponse.json({ error: "Valid name and positive base rate are required." }, { status: 400 });
  }

  // The meal plan is what lets the reservation screens match this rate to a
  // booking, so it is validated rather than stored blindly.
  const mealPlan = isMealPlan(body.mealPlan) ? body.mealPlan : null;

  const roomType = await prisma.roomType.create({
    data: {
      hotelId,
      name,
      description: body.description ? String(body.description).trim() : null,
      baseRate,
      capacity: typeof body.capacity === "number" && body.capacity > 0 ? body.capacity : 2,
      ...(body.maxAdults !== undefined && { maxAdults: body.maxAdults }),
      ...(body.maxChildren !== undefined && { maxChildren: body.maxChildren }),
      ...(body.extraAdultFee !== undefined && { extraAdultFee: body.extraAdultFee }),
      mealPlan,
    },
  });
  return NextResponse.json({ ...roomType, baseRate: Number(roomType.baseRate) }, { status: 201 });
}
