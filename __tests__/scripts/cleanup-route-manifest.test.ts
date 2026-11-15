import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(__dirname, "../..");
const manifest = join(root, ".next/server/app-paths-manifest.json");

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = join(dir, entry.name);
    return entry.isDirectory() ? files(name) : [name];
  });
}

describe("removed admin cleanup endpoint", () => {
  it("has no admin API route source", () => {
    expect(files(join(root, "app/api/admin")).filter((name) => /[/\\]route\.(?:ts|tsx|js|jsx)$/.test(name))).toEqual([]);
  });

  it("does not import or reference the cleanup CLI from application source", () => {
    const appFiles = files(join(root, "app")).filter((name) => /\.(?:ts|tsx|js|jsx|mjs)$/.test(name));
    const references = appFiles.filter((name) => /clean-test-data/.test(readFileSync(name, "utf8")));
    expect(references).toEqual([]);
  });

  // A normal test run need not have build artifacts. The production build
  // verification must run this test again with its generated manifest present.
  it.skipIf(!existsSync(manifest))("has no admin API route in the production app manifest", () => {
    const routes = JSON.parse(readFileSync(manifest, "utf8")) as Record<string, string>;
    const adminRoutes = Object.keys(routes).filter((name) => /^\/api\/admin(?:\/|$)/.test(name));
    expect(adminRoutes).toEqual([]);
  });
});
