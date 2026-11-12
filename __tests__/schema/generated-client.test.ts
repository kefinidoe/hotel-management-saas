import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Prisma } from "@prisma/client";
import { PRICING_MODEL_DELEGATES } from "@/lib/pricing/delegates";

/**
 * The generated Prisma Client is a build artifact: `postinstall` and `build` run
 * `prisma generate`, and everything else trusts the result. When that trust is
 * misplaced the failure is silent until a new model is touched — which is how the
 * Pricing & Rates page crashed with `undefined.findUnique`.
 *
 * These tests check the artifact that is actually installed, not a mock: every
 * model in prisma/schema.prisma must have a delegate in the generated client.
 */

const ROOT = process.cwd();
const SCHEMA = join(ROOT, "prisma", "schema.prisma");
const GENERATED_DIR = join(ROOT, "node_modules", ".prisma", "client");

function schemaModels(): string[] {
  const schema = readFileSync(SCHEMA, "utf8");
  return [...schema.matchAll(/^\s*model\s+(\w+)\s*\{/gm)].map((match) => match[1]);
}

const delegateName = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

/**
 * The delegates the installed client can serve.
 *
 * `Prisma.dmmf` is the runtime data model the client builds its delegates from.
 * Local verification harnesses that swap the client entry point for the WASM
 * engine hide it, so the generated type declarations are the fallback — they are
 * produced by the same `prisma generate` run.
 */
function clientModels(): { models: string[]; source: string } {
  // Accessing `.dmmf` throws on the WASM/edge runtime, so it needs a try/catch as
  // well as a null check.
  try {
    const fromDmmf = (Prisma as unknown as { dmmf?: { datamodel?: { models?: { name: string }[] } } })?.dmmf
      ?.datamodel?.models;
    if (fromDmmf && fromDmmf.length > 0) {
      return { models: fromDmmf.map((model) => model.name), source: "Prisma.dmmf" };
    }
  } catch {
    // Fall through to the generated type declarations below.
  }

  const declarations = join(GENERATED_DIR, "index.d.ts");
  if (!existsSync(declarations)) {
    throw new Error(
      `No generated Prisma Client at ${GENERATED_DIR} and no runtime data model. Run: npx prisma generate`
    );
  }
  const dts = readFileSync(declarations, "utf8");
  const models = [...dts.matchAll(/get (\w+)\(\): Prisma\.(\w+)Delegate/g)].map((match) => match[2]);
  return { models, source: "index.d.ts" };
}

describe("the installed Prisma Client matches prisma/schema.prisma", () => {
  it("exposes a delegate for every model in the schema", () => {
    const expected = schemaModels();
    expect(expected.length).toBeGreaterThan(0);

    const { models, source } = clientModels();
    expect(models.length, `no delegates found via ${source}`).toBeGreaterThan(0);

    const missing = expected.filter((model) => !models.includes(delegateName(model)) && !models.includes(model));
    expect(missing, `missing delegates (checked via ${source})`).toEqual([]);
  });

  it("exposes the pricing models the engine reads", () => {
    // `clientModels()` reports model names; the delegate is their camelCase form.
    const { models } = clientModels();
    for (const delegate of PRICING_MODEL_DELEGATES) {
      const model = delegate.charAt(0).toUpperCase() + delegate.slice(1);
      expect(models, `missing delegate ${delegate}`).toContain(model);
    }
  });

  it("maps HotelPricingSettings to prisma.hotelPricingSettings", () => {
    expect(schemaModels()).toContain("HotelPricingSettings");
    expect(delegateName("HotelPricingSettings")).toBe("hotelPricingSettings");
  });
});

describe("the application uses that client, once, with a guard", () => {
  const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

  it("imports PrismaClient from @prisma/client in lib/prisma.ts", () => {
    const source = read("lib/prisma.ts");
    expect(source).toContain('import { PrismaClient } from "@prisma/client"');
    expect(source).toMatch(/export const prisma\s*=/);
  });

  it("verifies the pricing delegates before the client is handed out", () => {
    const source = read("lib/prisma.ts");
    expect(source).toContain("assertPricingDelegates(prisma");
    // The guard must run at module scope: a page-level check would still allow an
    // unrelated route to run on a stale client.
    expect(source).toMatch(/^assertPricingDelegates\(prisma, "application start-up"\);/m);
  });

  it("creates exactly one PrismaClient outside the CLI scripts", () => {
    const roots = ["lib", "app", "components"];
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          const source = read(path);
          if (source.includes("new PrismaClient(") && path !== join("lib", "prisma.ts")) offenders.push(path);
        }
      }
    };
    roots.forEach(walk);
    expect(offenders).toEqual([]);
  });
});
