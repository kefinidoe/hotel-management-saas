import { z } from "zod";

/** Validates administrator-entered evidence; this does not verify a bank transfer. */
export const manualSubscriptionPaymentSchema = z.strictObject({
  action: z.literal("ACTIVATE_MANUAL_PAYMENT"),
  referenceCode: z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9-]+$/, "Use letters, numbers, or hyphens for the payment reference.").transform((value) => value.toUpperCase()),
  amountPaid: z.number().finite().positive().max(99_999_999.99).refine(
    (value) => Math.abs(value * 100 - Math.round(value * 100)) < 0.000001,
    "Amount must have at most two decimal places."
  ),
  durationDays: z.number().int().positive().max(365000).default(30),
  reason: z.string().trim().min(5).max(1000),
});

export type ManualSubscriptionPayment = z.infer<typeof manualSubscriptionPaymentSchema>;

/** Extend the existing future end even when the stored status is not active. */
export function calculateManualPaymentPeriod(input: {
  status: string;
  currentPeriodStartsAt: Date;
  currentPeriodEndsAt: Date | null;
  durationDays: number;
  now: Date;
}): { currentPeriodStartsAt: Date; currentPeriodEndsAt: Date } {
  const now = input.now.getTime();
  const start = input.currentPeriodStartsAt.getTime();
  const end = input.currentPeriodEndsAt?.getTime();
  if (!Number.isFinite(now) || !Number.isFinite(start) || (end !== undefined && !Number.isFinite(end))) {
    throw new Error("Subscription period contains an invalid date.");
  }
  const ongoing = end !== undefined && end > now;
  const newEnd = new Date((ongoing ? end : now) + input.durationDays * 86_400_000);
  if (!Number.isFinite(newEnd.getTime())) throw new Error("Subscription period exceeds supported dates.");
  return {
    currentPeriodStartsAt: ongoing ? new Date(start) : new Date(now),
    currentPeriodEndsAt: newEnd,
  };
}
