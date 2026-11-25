import { describe, expect, it } from "vitest";
import { folioTotalsExact } from "@/lib/billing";

describe("exact folio arithmetic", () => {
  it("sums fractional amounts and reversals without binary float arithmetic", () => {
    const totals = folioTotalsExact(["0.1", "0.2", "1.005"], ["0.10", "0.20", "-0.10"]);
    expect(totals.required.toString()).toBe("1.305");
    expect(totals.paid.toString()).toBe("0.2");
    expect(totals.balance.toString()).toBe("1.105");
    expect(totals.balance.lt("1.106")).toBe(true);
  });
});
