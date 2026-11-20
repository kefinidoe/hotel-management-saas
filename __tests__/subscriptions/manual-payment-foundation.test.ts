import { describe, expect, it } from "vitest";
import { calculateManualPaymentPeriod, manualSubscriptionPaymentSchema } from "@/lib/manual-subscription-payment";
import { ORDERED_ROOM_BANDS, PRICING_CONFIG } from "@/lib/plans";

describe("manual subscription payment foundation", () => {
  it("sets a 30-day trial for each new room-band subscription", () => {
    expect(PRICING_CONFIG.trialDurationDays).toBe(30);
    expect(ORDERED_ROOM_BANDS.every((band) => band.trialDurationDays === 30)).toBe(true);
  });
  const valid = { action: "ACTIVATE_MANUAL_PAYMENT", referenceCode: " SJK89L2M1P ", amountPaid: 1500, reason: "Verified deposit" };
  it("validates payment evidence and defaults to 30 days", () => {
    expect(manualSubscriptionPaymentSchema.parse(valid)).toMatchObject({ referenceCode: "SJK89L2M1P", durationDays: 30 });
    expect(manualSubscriptionPaymentSchema.safeParse({ ...valid, durationDays: 365 }).success).toBe(true);
    expect(manualSubscriptionPaymentSchema.parse({ ...valid, referenceCode: "  abc123  ", durationDays: 31 }).referenceCode).toBe("ABC123");
  });
  it("rejects invalid values and unexpected fields", () => {
    for (const bad of [
      { referenceCode: " " }, { referenceCode: "bad/ref" }, { amountPaid: 0 },
      { amountPaid: -1 }, { amountPaid: 0.001 }, { durationDays: 0 }, { durationDays: 1.5 }, { reason: "no" }, { hotelId: "other" },
    ]) expect(manualSubscriptionPaymentSchema.safeParse({ ...valid, ...bad }).success).toBe(false);
  });
  it("extends an ongoing active period without losing prepaid days", () => {
    const result = calculateManualPaymentPeriod({ status: "ACTIVE", currentPeriodStartsAt: new Date("2026-01-01T00:00:00Z"), currentPeriodEndsAt: new Date("2026-02-01T00:00:00Z"), durationDays: 30, now: new Date("2026-01-15T00:00:00Z") });
    expect(result.currentPeriodStartsAt.toISOString()).toBe("2026-01-01T00:00:00.000Z");
    expect(result.currentPeriodEndsAt.toISOString()).toBe("2026-03-03T00:00:00.000Z");
  });
  it("extends a future period even when the stored status is suspended", () => {
    const result = calculateManualPaymentPeriod({ status: "SUSPENDED", currentPeriodStartsAt: new Date("2026-01-01T00:00:00Z"), currentPeriodEndsAt: new Date("2026-02-01T00:00:00Z"), durationDays: 30, now: new Date("2026-01-15T00:00:00Z") });
    expect(result.currentPeriodEndsAt.toISOString()).toBe("2026-03-03T00:00:00.000Z");
  });
  it("starts an expired period from the payment date", () => {
    const now = new Date("2026-02-10T00:00:00Z");
    const result = calculateManualPaymentPeriod({ status: "ACTIVE", currentPeriodStartsAt: new Date("2026-01-01T00:00:00Z"), currentPeriodEndsAt: new Date("2026-02-01T00:00:00Z"), durationDays: 365, now });
    expect(result.currentPeriodStartsAt.toISOString()).toBe(now.toISOString());
    expect(result.currentPeriodEndsAt.toISOString()).toBe("2027-02-10T00:00:00.000Z");
  });
  it("fails closed on invalid dates", () => {
    expect(() => calculateManualPaymentPeriod({ status: "ACTIVE", currentPeriodStartsAt: new Date("invalid"), currentPeriodEndsAt: null, durationDays: 30, now: new Date() })).toThrow(/invalid date/i);
  });
});
