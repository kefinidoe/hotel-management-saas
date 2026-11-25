import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";
import { z } from "zod";
import Decimal from "decimal.js";
import { parseMoney } from "@/lib/billing";

const id = z.string().trim().min(1).max(200);
const text = z.string().max(2000);
const optionalText = text.nullable().optional();
const numberInput = z.union([z.number().finite(), z.string().trim().min(1).max(100)]);
const money = numberInput.superRefine((value, ctx) => {
  try { parseMoney(value, "Amount"); }
  catch (error) { ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "Invalid amount." }); }
});
function decimal(places: number, allowZero: boolean, max: string) {
  return numberInput.superRefine((value, ctx) => {
    try {
      const n = new Prisma.Decimal(value);
      if (!n.isFinite() || (allowZero ? n.lessThan(0) : n.lessThanOrEqualTo(0)) || n.decimalPlaces() > places || n.greaterThan(max)) throw new Error();
    } catch { ctx.addIssue({ code: "custom", message: `Enter a ${allowZero ? "non-negative" : "positive"} number with at most ${places} decimal places.` }); }
  });
}
const date = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);
const quantity = numberInput.refine(value => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 && n <= 1000;
}, "Quantity must be a whole number between 1 and 1000.");
const items = z.array(z.strictObject({
  menuItemId: id, quantity,
  // Display-only values sent by the POS are deliberately ignored for pricing.
  name: z.unknown().optional(), unitPrice: z.unknown().optional(), price: z.unknown().optional(),
})).min(1).max(1000).superRefine((lines, ctx) => {
  const totals = new Map<string, number>();
  lines.forEach((line, index) => {
    const key = line.menuItemId.trim();
    const total = (totals.get(key) ?? 0) + Number(line.quantity);
    totals.set(key, total);
    if (total > 1000) ctx.addIssue({ code: "custom", path: [index, "quantity"], message: "Combined quantity for an item cannot exceed 1000." });
  });
});
const posCommon = { items, tableNumber: optionalText, idempotencyKey: z.string().optional() };
const paymentMoney = numberInput.refine(value => {
  try {
    const amount = new Decimal(String(value));
    return amount.isFinite() && amount.gt(0) && amount.decimalPlaces() <= 2 && amount.lte("99999999.99");
  } catch { return false; }
}, "Enter a positive amount with at most two decimal places.");
export const paymentSchema = z.strictObject({ folioId: id, paymentMethodId: id, amount: paymentMoney, reference: optionalText, idempotencyKey: z.string().optional(), cashierId: z.unknown().optional(), hotelId: z.unknown().optional(), status: z.unknown().optional() });
export const chargeSchema = z.strictObject({ ...posCommon, folioId: id });
export const payNowSchema = z.strictObject({ ...posCommon, paymentMethodId: id, customerName: optionalText, customerPhone: optionalText, reference: optionalText });
export const expenseSchema = z.strictObject({ category: id, description: z.string().trim().min(1).max(2000), amount: money, paymentMethod: id, supplier: optionalText, reference: optionalText, status: z.enum(["PENDING_APPROVAL", "APPROVED", "REJECTED"]).optional() });
export const expenseReviewSchema = z.strictObject({ status: z.enum(["APPROVED", "REJECTED"]) });
export const purchaseSchema = z.strictObject({ inventoryItemId: id, supplier: id, invoiceNumber: optionalText, quantity: decimal(2, false, "9999999999.99"), unitCost: decimal(4, true, "999999.9999"), purchaseDate: date.optional() }).superRefine((body, ctx) => {
  try {
    if (new Prisma.Decimal(body.quantity).mul(body.unitCost).toDecimalPlaces(2).greaterThan("99999999.99"))
      ctx.addIssue({ code: "custom", path: ["unitCost"], message: "Purchase total exceeds the supported amount." });
  } catch { /* Field-level validation reports malformed numbers. */ }
});

function invalid(issues: readonly { code: string; path: PropertyKey[]; message: string }[], pos: boolean) {
  return NextResponse.json({ error: "Invalid request.", ...(pos ? { code: "VALIDATION_ERROR", outcome: "NOT_COMMITTED" } : {}), issues: issues.map(({ code, path, message }) => ({ code, path, message })) }, { status: 400 });
}
/** Invoke after session, role, entitlement and stale-context security checks. */
export async function validateFinancialMutation<T extends z.ZodType>(req: Request, schema: T, options: { id?: string; pos?: boolean } = {}) {
  const query = z.strictObject({}).safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return { response: invalid(query.error.issues, !!options.pos) } as const;
  if (options.id !== undefined) {
    const result = id.safeParse(options.id);
    if (!result.success) return { response: invalid(result.error.issues.map(issue => ({ ...issue, path: ["id", ...issue.path] })), !!options.pos) } as const;
  }
  let body: unknown;
  try { body = await req.json(); }
  catch { return { response: invalid([{ code: "custom", path: ["body"], message: "Invalid JSON body." }], !!options.pos) } as const; }
  const result = schema.safeParse(body);
  if (!result.success) return { response: invalid(result.error.issues, !!options.pos) } as const;
  // Keep original JSON for idempotency fingerprint compatibility; validation does not authorize client prices.
  return { data: body as z.input<T> } as const;
}

/** Match the existing inventory idempotency context guard before parsing. */
export function checkInventoryContext(req: Request, hotelId: string, actorId: string) {
  const expectedHotel = req.headers.get("x-expected-hotel-id");
  const expectedActor = req.headers.get("x-expected-actor-id");
  if ((expectedHotel && expectedHotel !== hotelId) || (expectedActor && expectedActor !== actorId)) {
    return NextResponse.json({ error: "The active hotel or user changed; recover this request in its original context.", code: "TENANT_CONTEXT_MISMATCH" }, { status: 409 });
  }
}

export function validateIdempotencyKey(value: unknown, kind: "payment" | "pos" | "charge" | "inventory") {
  const result = z.string().trim().min(4).max(128).safeParse(value);
  if (result.success) return;
  const missing = typeof value !== "string" || !value.trim();
  const message = kind === "payment"
    ? "An idempotency key between 4 and 128 characters is required."
    : kind === "inventory"
      ? "An idempotency key of 4–128 characters is required."
      : missing ? `An idempotency key is required for ${kind === "pos" ? "POS payments" : "room charges"}.` : "Idempotency key must be between 4 and 128 characters.";
  return NextResponse.json({ error: message, ...((kind === "pos" || kind === "charge") ? { code: missing ? "MISSING_IDEMPOTENCY_KEY" : "INVALID_IDEMPOTENCY_KEY_LENGTH", outcome: "NOT_COMMITTED" } : {}), issues: result.error.issues.map(issue => ({ code: issue.code, path: ["idempotencyKey", ...issue.path], message: issue.message })) }, { status: 400 });
}
