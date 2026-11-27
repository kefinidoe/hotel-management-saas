import { NextResponse } from "next/server";
import { z } from "zod";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { hasRole } from "@/lib/permissions";
import { recordAudit } from "@/lib/audit";
import { prisma } from "@/lib/prisma";
import { hasMaxDecimalPlaces } from "@/lib/billing";
import { readMutationBody, validateMutation } from "@/lib/staff-settings-validation";

const amount = z.number().finite().min(0).max(99_999_999.99)
  .refine((n) => hasMaxDecimalPlaces(n, 2), "Use at most two decimal places.");
const code = z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9_-]+$/, "Use letters, numbers, underscores or hyphens.");
const label = z.string().trim().min(1).max(100);
const id = z.string().trim().min(1).max(200);
const meal = z.strictObject({ kind: z.literal("meal"), code, name: label, pricePerNight: amount, perGuest: z.boolean(), isActive: z.boolean() });
const occupancy = z.strictObject({ kind: z.literal("occupancy"), occupancyType: code, label, includedAdults: z.number().int().min(1).max(100), surchargeAmount: amount, extraAdultRate: amount, isActive: z.boolean() });
const createSchema = z.discriminatedUnion("kind", [meal, occupancy]);
const updateSchema = z.discriminatedUnion("kind", [meal.extend({ id }), occupancy.extend({ id }), z.strictObject({ kind: z.literal("mode"), enabled: z.boolean() })]);
const deleteSchema = z.strictObject({ kind: z.enum(["meal", "occupancy"]), id });

async function authorize(write = true) {
  const tenant = await getTenantFromRoute(write ? "write" : "read");
  if (tenant instanceof NextResponse) return tenant;
  const forbidden = requireRole(tenant.role, write ? ROLE_GROUPS.MANAGEMENT : ROLE_GROUPS.GUEST_STAYS);
  if (forbidden) return forbidden;
  return (await requireModule(tenant.hotelId, "RESERVATIONS", write ? "write" : "read")) || tenant;
}

export async function GET(req: Request) {
  const tenant = await authorize(false);
  if (tenant instanceof NextResponse) return tenant;
  const query = z.strictObject({}).safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return NextResponse.json({ error: "Invalid request.", issues: query.error.issues }, { status: 400 });
  try {
    const where = { hotelId: tenant.hotelId, ...(hasRole(tenant.role, ROLE_GROUPS.MANAGEMENT) ? {} : { isActive: true }) };
    const [hotel, mealPlanRates, occupancyRateRules] = await Promise.all([
      prisma.hotel.findUnique({ where: { id: tenant.hotelId }, select: { useCustomRateRules: true } }),
      prisma.mealPlanRate.findMany({ where, orderBy: { code: "asc" } }),
      prisma.occupancyRateRule.findMany({ where, orderBy: { occupancyType: "asc" } }),
    ]);
    if (!hotel) return NextResponse.json({ error: "Hotel not found." }, { status: 404 });
    return NextResponse.json({ ...hotel, mealPlanRates, occupancyRateRules, activationAvailable: true });
  } catch (error) {
    console.error("Could not load dynamic pricing rules", error);
    return NextResponse.json({ error: "Could not load dynamic pricing rules." }, { status: 500 });
  }
}

class NotFound extends Error {}
class MissingConfiguration extends Error {}
function failure(error: unknown) {
  if (error instanceof MissingConfiguration) return NextResponse.json({ error: "Add at least one active meal plan and occupancy rule before enabling dynamic pricing." }, { status: 409 });
  if (error instanceof NotFound) return NextResponse.json({ error: "Rule not found." }, { status: 404 });
  if (typeof error === "object" && error !== null && "code" in error && error.code === "P2002") return NextResponse.json({ error: "A rule with that code already exists." }, { status: 409 });
  console.error("Could not save dynamic pricing rules", error);
  return NextResponse.json({ error: "Could not save dynamic pricing rules." }, { status: 500 });
}

export async function POST(req: Request) {
  const tenant = await authorize();
  if (tenant instanceof NextResponse) return tenant;
  const validated = validateMutation(req, createSchema, await readMutationBody(req));
  if (validated.response) return validated.response;
  try {
    const row = await prisma.$transaction(async (tx) => {
      const lockKey = `hotel-${tenant.hotelId}-reservation-create`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const data = validated.data;
      const saved = data.kind === "meal"
        ? await tx.mealPlanRate.create({ data: { hotelId: tenant.hotelId, code: data.code, name: data.name, pricePerNight: data.pricePerNight, perGuest: data.perGuest, isActive: data.isActive } })
        : await tx.occupancyRateRule.create({ data: { hotelId: tenant.hotelId, occupancyType: data.occupancyType, label: data.label, includedAdults: data.includedAdults, surchargeAmount: data.surchargeAmount, extraAdultRate: data.extraAdultRate, isActive: data.isActive } });
      await recordAudit({ hotelId: tenant.hotelId, userId: tenant.userId, action: "DYNAMIC_PRICING_RULE_CREATED", entity: data.kind, entityId: saved.id }, tx, { strict: true });
      return saved;
    });
    return NextResponse.json(row, { status: 201 });
  } catch (error) { return failure(error); }
}

export async function PATCH(req: Request) {
  const tenant = await authorize();
  if (tenant instanceof NextResponse) return tenant;
  const validated = validateMutation(req, updateSchema, await readMutationBody(req));
  if (validated.response) return validated.response;
  const data = validated.data;
  try {
    const result = await prisma.$transaction(async (tx) => {
      const lockKey = `hotel-${tenant.hotelId}-reservation-create`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      if (data.kind === "mode") {
        if (data.enabled) {
          const [meals, occupancies] = await Promise.all([tx.mealPlanRate.count({ where: { hotelId: tenant.hotelId, isActive: true } }), tx.occupancyRateRule.count({ where: { hotelId: tenant.hotelId, isActive: true } })]);
          if (!meals || !occupancies) throw new MissingConfiguration();
        }
        const hotel = await tx.hotel.update({ where: { id: tenant.hotelId }, data: { useCustomRateRules: data.enabled }, select: { useCustomRateRules: true } });
        await recordAudit({ hotelId: tenant.hotelId, userId: tenant.userId, action: "DYNAMIC_PRICING_MODE_UPDATED", entity: "Hotel", entityId: tenant.hotelId, metadata: { enabled: data.enabled } }, tx, { strict: true });
        return hotel;
      }
      const where = { id: data.id, hotelId: tenant.hotelId };
      const updated = data.kind === "meal"
        ? await tx.mealPlanRate.updateMany({ where, data: { code: data.code, name: data.name, pricePerNight: data.pricePerNight, perGuest: data.perGuest, isActive: data.isActive } })
        : await tx.occupancyRateRule.updateMany({ where, data: { occupancyType: data.occupancyType, label: data.label, includedAdults: data.includedAdults, surchargeAmount: data.surchargeAmount, extraAdultRate: data.extraAdultRate, isActive: data.isActive } });
      if (updated.count !== 1) throw new NotFound();
      await recordAudit({ hotelId: tenant.hotelId, userId: tenant.userId, action: "DYNAMIC_PRICING_RULE_UPDATED", entity: data.kind, entityId: data.id }, tx, { strict: true });
      return { id: data.id };
    });
    return NextResponse.json(result);
  } catch (error) { return failure(error); }
}

export async function DELETE(req: Request) {
  const tenant = await authorize();
  if (tenant instanceof NextResponse) return tenant;
  const validated = validateMutation(req, deleteSchema, await readMutationBody(req));
  if (validated.response) return validated.response;
  const data = validated.data;
  try {
    await prisma.$transaction(async (tx) => {
      const lockKey = `hotel-${tenant.hotelId}-reservation-create`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
      const where = { id: data.id, hotelId: tenant.hotelId };
      const deleted = data.kind === "meal" ? await tx.mealPlanRate.deleteMany({ where }) : await tx.occupancyRateRule.deleteMany({ where });
      if (deleted.count !== 1) throw new NotFound();
      await recordAudit({ hotelId: tenant.hotelId, userId: tenant.userId, action: "DYNAMIC_PRICING_RULE_DELETED", entity: data.kind, entityId: data.id }, tx, { strict: true });
    });
    return NextResponse.json({ ok: true });
  } catch (error) { return failure(error); }
}
