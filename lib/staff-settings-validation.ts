import { NextResponse } from "next/server";
import { z } from "zod";
import { passwordProblem } from "@/lib/password";

const roles = ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER", "RECEPTIONIST", "ACCOUNTANT", "HOUSEKEEPER", "WAITER", "CASHIER", "TECHNICIAN"] as const;
const currencies = ["KES", "USD", "EUR", "GBP", "TZS", "UGX", "RWF", "ZAR", "AED"] as const;
const id = z.string().trim().min(1).max(200);
const optionalText = (max: number) => z.string().max(max).nullable().optional();
const hotelName = z.string().trim().min(2).max(100);
const email = z.string().trim().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "Invalid email format.");
const currency = z.string().trim().refine(v => currencies.includes(v.toUpperCase() as typeof currencies[number]), "Unsupported currency.");
const timezone = z.string().trim().min(2).max(60).refine(value => {
  try { new Intl.DateTimeFormat("en-US", { timeZone: value }); return true; } catch { return false; }
}, "A valid IANA timezone identifier is required.");
const contactEmail = z.union([email, z.literal(""), z.null()]).optional();
const staffRole = z.enum(roles);
const password = z.string().superRefine((value, ctx) => { const problem = passwordProblem(value); if (problem) ctx.addIssue({ code: "custom", message: problem }); });
const nonempty = <T extends z.ZodType>(schema: T) => schema.refine(value => Object.keys(value as object).length > 0, "At least one field is required.");
export const initialPasswordSchema = z.strictObject({ password });
export const staffCreateSchema = z.strictObject({ name: hotelName, email, password: z.string().max(200).optional(), role: staffRole, department: optionalText(100), phone: optionalText(100) });
export const staffUpdateSchema = nonempty(z.strictObject({ role: staffRole.optional(), isActive: z.boolean().optional(), status: z.enum(["ACTIVE", "SUSPENDED", "INVITED"]).optional(), department: optionalText(100), reinvite: z.boolean().optional() }).superRefine((value, ctx) => {
  if (value.reinvite === true && Object.keys(value).length !== 1) ctx.addIssue({ code: "custom", path: ["reinvite"], message: "Re-invitation cannot be combined with other updates." });
  if (value.isActive !== undefined && value.status !== undefined && (value.isActive !== (value.status === "ACTIVE"))) ctx.addIssue({ code: "custom", path: ["status"], message: "Status and active flag conflict." });
}));
export const housekeepingSchema = nonempty(z.strictObject({ status: z.enum(["NEEDS_CLEANING", "IN_PROGRESS", "READY_FOR_INSPECTION", "READY"]).optional(), priority: z.enum(["low", "normal", "high"]).optional(), assigneeId: z.string().max(200).nullable().optional() }));
// Client-supplied hotelId is accepted for compatibility but is never used for authorization or writes.
export const settingsSchema = nonempty(z.strictObject({ hotelId: z.unknown().optional(), name: hotelName.optional(), email: contactEmail, phone: optionalText(100), address: optionalText(2000), currency: currency.optional(), timezone: timezone.optional() }));
const slug = z.string().trim().max(60).refine(v => !v || (v.length >= 2 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v.toLowerCase())), "Invalid workspace slug.");
export const onboardingSchema = z.strictObject({ name: hotelName, slug: slug.optional(), currency: currency.optional(), timezone: timezone.optional(), email: contactEmail, phone: optionalText(100), address: optionalText(2000) }).superRefine((value, ctx) => {
  const slugValue = value.slug?.trim().toLowerCase() || value.name.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (slugValue.length < 2 || slugValue.length > 60 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slugValue)) ctx.addIssue({ code: "custom", path: ["slug"], message: "Invalid workspace slug." });
});
export const passwordSchema = z.strictObject({ currentPassword: z.string().min(1).max(200), newPassword: password });
export const emptySchema = z.strictObject({});
export const INVALID_JSON = Symbol("invalid-json");
export async function readMutationBody(req: Request, allowEmpty = false): Promise<unknown> {
  try { const text = await req.text(); return allowEmpty && !text.trim() ? {} : JSON.parse(text); }
  catch { return INVALID_JSON; }
}
function invalid(issues: readonly { code: string; path: PropertyKey[]; message: string }[], onboarding: boolean) {
  const first = issues[0];
  const errors: Record<string, string> = { name: "INVALID_NAME", slug: "INVALID_SLUG", currency: "INVALID_CURRENCY", timezone: "INVALID_TIMEZONE", body: "INVALID_REQUEST_BODY" };
  return NextResponse.json({ error: onboarding ? (errors[String(first?.path[0])] || "VALIDATION_ERROR") : (first?.path[0] === "role" ? `Invalid role. Permitted hotel roles: ${roles.join(", ")}` : "Invalid request."), ...(onboarding ? { message: first?.message || "Invalid request." } : {}), issues: issues.map(({ code, path, message }) => ({ code, path, message })) }, { status: 400 });
}
/** Call after the route's security checks, including database-backed checks. */
export function validateMutation<T extends z.ZodType>(req: Request, schema: T, body: unknown, options: { id?: string; onboarding?: boolean } = {}) {
  const query = z.strictObject({}).safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return { response: invalid(query.error.issues, !!options.onboarding) } as const;
  if (options.id !== undefined) {
    const parsed = id.safeParse(options.id);
    if (!parsed.success) return { response: invalid(parsed.error.issues.map(issue => ({ ...issue, path: ["id", ...issue.path] })), !!options.onboarding) } as const;
  }
  if (body === INVALID_JSON) return { response: invalid([{ code: "custom", path: ["body"], message: "Malformed JSON body." }], !!options.onboarding) } as const;
  const parsed = schema.safeParse(body);
  if (!parsed.success) return { response: invalid(parsed.error.issues, !!options.onboarding) } as const;
  return { data: parsed.data } as const;
}
