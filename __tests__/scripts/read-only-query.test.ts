import { describe, expect, it, vi } from "vitest";
import { queryReadOnlyJson } from "../../scripts/read-only-query.mjs";

const options = { url: "postgresql://example.invalid/test", psqlBin: "psql", sql: 'SELECT \'{"ok":true}\'::text;' };

describe("server-verified read-only query", () => {
  it("uses one read-only transaction and returns its verified JSON result", () => {
    const runner = vi.fn((_args: { input?: string }) => 'BEGIN\n{"readOnly":"on","value":{"ok":true}}\nROLLBACK\n');
    expect(queryReadOnlyJson({ ...options, runner })).toEqual({ ok: true });
    const input = runner.mock.calls[0][0].input as string;
    expect(input).toMatch(/^BEGIN READ ONLY;\n/);
    expect(input).toContain("current_setting('transaction_read_only')");
    expect(input).toMatch(/ROLLBACK;\n$/);
    expect(runner).toHaveBeenCalledOnce();
  });
  it("fails closed if the server did not enforce read-only mode", () => {
    expect(() => queryReadOnlyJson({ ...options, runner: () => 'BEGIN\n{"readOnly":"off","value":{}}\nROLLBACK\n' })).toThrow(/did not confirm/);
  });
  it("fails closed on malformed output or incomplete rollback", () => {
    for (const output of ['BEGIN\n{}\n', 'BEGIN\nnot-json\nROLLBACK\n', 'BEGIN\n{"readOnly":"on","value":{}}\nCOMMIT\n']) {
      expect(() => queryReadOnlyJson({ ...options, runner: () => output })).toThrow();
    }
  });
  it("refuses write-shaped or multiple statements before invoking psql", () => {
    const runner = vi.fn();
    for (const sql of ['DELETE FROM "Hotel"', 'SELECT 1; DELETE FROM "Hotel"']) {
      expect(() => queryReadOnlyJson({ ...options, sql, runner })).toThrow(/one internal SELECT/);
    }
    expect(runner).not.toHaveBeenCalled();
  });
});
