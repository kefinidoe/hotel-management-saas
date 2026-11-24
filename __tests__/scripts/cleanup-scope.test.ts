import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Line endings are a checkout artifact (Git stores LF; a Windows working copy may
// hold CRLF), not part of the code under test. Normalise them once so the exact
// whitespace assertions below still pin the script's structure on every platform.
const SOURCE = readFileSync(resolve(__dirname, "../../scripts/clean-test-data.ts"), "utf8").replace(/\r\n/g, "\n");

describe("test-data cleanup script safety", () => {
  it("requires the configured database safety check and an exact hotel ID confirmation", () => {
    expect(SOURCE).toContain("assertDisposableDatabaseSafety();");
    expect(SOURCE).toContain("assertDisposableDatabaseIdentity(disposableTarget, identity);");
    expect(SOURCE.indexOf("assertDisposableDatabaseIdentity(disposableTarget, identity);")).toBeLessThan(SOURCE.indexOf("tx.payment.deleteMany"));
    expect(SOURCE).toContain('valueAfter("--hotel-id")');
    expect(SOURCE).toContain('valueAfter("--confirm-hotel-id")');
    expect(SOURCE).toContain("hotelId !== confirmation");
  });

  it("does not contain unscoped deletes or a global room update", () => {
    expect(SOURCE).not.toMatch(/\.deleteMany\s*\(\s*\{\s*\}\s*\)/);
    expect(SOURCE).not.toMatch(/\.updateMany\s*\(\s*\{\s*data\s*:/);
    expect(SOURCE).toContain("where: { hotelId },\n      data: { status: \"AVAILABLE\", notes: null }");
  });

  it("preserves append-only audit records", () => {
    expect(SOURCE).not.toMatch(/auditLog\.(delete|deleteMany|update|updateMany)\s*\(/);
    expect(SOURCE).toContain("Preserved audit logs");
  });

  it("runs cleanup as a single transaction", () => {
    expect(SOURCE).toContain("await prisma.$transaction(async (tx) => {");
    expect(SOURCE).not.toContain("prisma.payment.deleteMany");
  });
});
