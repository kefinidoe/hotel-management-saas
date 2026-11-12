import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadEnvFiles, parseEnvFile, readEnvFiles, resolveEnvFilePaths } from "../../scripts/env-file.mjs";

const scratch: string[] = [];

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), "hms-envfile-"));
  scratch.push(root);
  return root;
}

afterEach(() => {
  delete process.env.HMS_ENVFILE_TEST_KEY;
  delete process.env.HMS_ENVFILE_OTHER_KEY;
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("parseEnvFile", () => {
  it("reads plain, quoted and exported assignments", () => {
    const parsed = parseEnvFile(
      [
        "# a comment",
        "",
        "PLAIN=value",
        'DOUBLE="quoted value"',
        "SINGLE='single value'",
        "export EXPORTED=yes",
        'ESCAPED="line1\\nline2"',
      ].join("\n")
    );

    expect(parsed).toEqual({
      PLAIN: "value",
      DOUBLE: "quoted value",
      SINGLE: "single value",
      EXPORTED: "yes",
      ESCAPED: "line1\nline2",
    });
  });

  it("handles CRLF files and a UTF-8 BOM", () => {
    const parsed = parseEnvFile("\uFEFFA=1\r\nB=2\r\n");
    expect(parsed).toEqual({ A: "1", B: "2" });
  });

  it("drops an inline comment on an unquoted value but keeps '#' inside quotes", () => {
    const parsed = parseEnvFile('UNQUOTED=value # trailing note\nQUOTED="value # kept"\nHASH=abc#def');
    expect(parsed.UNQUOTED).toBe("value");
    expect(parsed.QUOTED).toBe("value # kept");
    expect(parsed.HASH).toBe("abc#def");
  });

  it("ignores malformed lines instead of guessing", () => {
    expect(parseEnvFile("not an assignment\n=missing-key\nOK=1")).toEqual({ OK: "1" });
  });
});

describe("readEnvFiles", () => {
  it("returns nothing when no file exists", () => {
    const result = readEnvFiles({ rootDir: makeRoot() });
    expect(result.files).toEqual([]);
    expect(result.values).toEqual({});
    expect(result.conflicts).toEqual([]);
  });

  it("applies prisma/.env before .env so the schema-adjacent copy wins", () => {
    const root = makeRoot();
    mkdirSync(join(root, "prisma"), { recursive: true });
    writeFileSync(join(root, ".env"), "HMS_ENVFILE_TEST_KEY=root\nHMS_ENVFILE_OTHER_KEY=root-only\n");
    writeFileSync(join(root, "prisma", ".env"), "HMS_ENVFILE_TEST_KEY=schema\n");

    const result = readEnvFiles({ rootDir: root });
    expect(result.values.HMS_ENVFILE_TEST_KEY).toBe("schema");
    expect(result.values.HMS_ENVFILE_OTHER_KEY).toBe("root-only");
    expect(result.conflicts).toEqual(["HMS_ENVFILE_TEST_KEY"]);
  });

  it("lists the Prisma CLI's locations in resolution order", () => {
    expect(resolveEnvFilePaths("/repo")).toEqual([join("/repo", "prisma", ".env"), join("/repo", ".env")]);
  });
});

describe("loadEnvFiles", () => {
  it("never overrides a variable the caller already exported", () => {
    const root = makeRoot();
    writeFileSync(join(root, ".env"), "HMS_ENVFILE_TEST_KEY=from-file\nHMS_ENVFILE_OTHER_KEY=from-file\n");
    process.env.HMS_ENVFILE_TEST_KEY = "from-shell";

    loadEnvFiles({ rootDir: root, quiet: true });

    expect(process.env.HMS_ENVFILE_TEST_KEY).toBe("from-shell");
    expect(process.env.HMS_ENVFILE_OTHER_KEY).toBe("from-file");
  });

  it("reports conflicting keys but never prints their values", () => {
    const root = makeRoot();
    mkdirSync(join(root, "prisma"), { recursive: true });
    writeFileSync(join(root, "prisma", ".env"), "HMS_ENVFILE_TEST_KEY=secret-one\n");
    writeFileSync(join(root, ".env"), "HMS_ENVFILE_TEST_KEY=secret-two\n");

    // mockRestore() clears recorded calls, so collect the chunks while the spy is live.
    const warnings: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        warnings.push(String(chunk));
        return true;
      });

    try {
      loadEnvFiles({ rootDir: root });
    } finally {
      spy.mockRestore();
    }

    const joined = warnings.join("");
    expect(joined).toContain("HMS_ENVFILE_TEST_KEY differ");
    expect(joined).not.toContain("secret-one");
    expect(joined).not.toContain("secret-two");
  });
});
