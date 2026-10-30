import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SOURCE = readFileSync(resolve(__dirname, "../../scripts/clean-test-data.ts"), "utf8");

describe("test-data cleanup script safety", () => {
  it("requires the configured database safety check and an exact hotel ID confirmation", () => {
    expect(SOURCE).toContain("assertDatabaseSafety();");
    expect(SOURCE).toContain('valueAfter("--hotel-id")');
    expect(SOURCE).toContain('valueAfter("--confirm-hotel-id")');
    expect(SOURCE).toContain("hotelId !== confirmation");
  });

  it("does not contain unscoped deletes or a global room update", () => {
    expect(SOURCE).not.toMatch(/\.deleteMany\s*\(\s*\{\s*\}\s*\)/);
    expect(SOURCE).not.toMatch(/\.updateMany\s*\(\s*\{\s*data\s*:/);
    expect(SOURCE).toContain("where: { hotelId },\n      data: { status: \"AVAILABLE\", notes: null }");
  });

  it("runs cleanup as a single transaction", () => {
    expect(SOURCE).toContain("await prisma.$transaction(async (tx) => {");
    expect(SOURCE).not.toContain("prisma.payment.deleteMany");
  });
});
