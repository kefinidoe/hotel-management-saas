import { z } from "zod";
import { NextResponse } from "next/server";
import { RoomStatus } from "@prisma/client";
import { MEAL_PLANS } from "@/lib/tariffs";
import { hasMaxDecimalPlaces } from "@/lib/billing";

const id = z.string().trim().min(1).max(200);
const optionalText = z.string().max(2000).nullable().optional();
const rate = z.union([
  z.number().finite().nonnegative(),
  z.string().trim().min(1).regex(/^\d+(?:\.\d{1,2})?$/).transform(Number),
]);
const fields = {
  name: z.string().trim().min(1).max(200),
  description: optionalText,
  baseRate: rate,
  capacity: z.number().int().positive().max(1000).optional(),
  maxAdults: z.number().int().min(1).max(1000).optional(),
  maxChildren: z.number().int().min(0).max(1000).optional(),
  extraAdultFee: rate.refine(value => value <= 99_999_999.99 && hasMaxDecimalPlaces(value, 2), "Amount must fit currency precision and range.").optional(),
  mealPlan: z.enum(MEAL_PLANS).nullable().optional(),
};
export const roomTypeCreateSchema = z.strictObject(fields);
export const roomTypeUpdateSchema = z.strictObject({ ...fields, name: fields.name.optional(), baseRate: rate.optional() });
export const roomCreateSchema = z.strictObject({ number: id, roomTypeId: id, floor: optionalText });
export const roomUpdateSchema = z.strictObject({
  number: id.optional(), roomTypeId: id.optional(), floor: optionalText,
  notes: optionalText, status: z.enum(RoomStatus).optional(), isActive: z.boolean().optional(),
});
export const emptyMutationSchema = z.strictObject({});

/** Run only after the route's authentication, role and entitlement checks. */
export async function validateRoomStayMutation<T extends z.ZodType>(req: Request, schema: T, options: { emptyBody?: boolean; id?: string } = {}) {
  const query = z.strictObject({}).safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return { response: validationError(query.error.issues) } as const;
  if (options.id !== undefined) {
    const parsedId = id.safeParse(options.id);
    if (!parsedId.success) return { response: validationError(parsedId.error.issues.map(issue => ({ ...issue, path: ["id", ...issue.path] }))) } as const;
  }
  let body: unknown;
  try {
    const text = await req.text();
    body = options.emptyBody && !text.trim() ? {} : JSON.parse(text);
  } catch {
    return { response: validationError([{ code: "custom", path: ["body"], message: "Invalid JSON body." }]) } as const;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { response: validationError(parsed.error.issues) } as const;
  return { data: parsed.data as z.output<T> } as const;
}

function validationError(issues: readonly { code: string; path: PropertyKey[]; message: string }[]) {
  return NextResponse.json({ error: "Invalid request.", issues: issues.map(({ code, path, message }) => ({ code, path, message })) }, { status: 400 });
}
