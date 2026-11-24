// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
const sql = (name: string) => readFileSync(`prisma/migrations/${name}/migration.sql`, "utf8");
const repair = sql("20261114120000_repair_pricing_check_constraints");
const names = ["HotelMealPricing_nonnegative", "MealPlanRate_price_check", "OccupancyRateRule_includedAdults_check", "OccupancyRateRule_amounts_check"];
let db: PGlite;

async function fixture() {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE "Hotel" ("id" TEXT PRIMARY KEY);
    CREATE TABLE "RoomType" ("id" TEXT PRIMARY KEY, "capacity" INTEGER NOT NULL);
    CREATE TYPE "PricingModel" AS ENUM ('LEGACY_BASE_RATE');
  `);
  await db.exec(sql("20261108120000_universal_meal_pricing"));
  await db.exec(sql("20261112120000_custom_rate_rules"));
  await db.exec(`
    INSERT INTO "Hotel" (id) VALUES ('hotel-1');
    INSERT INTO "RoomType" (id,capacity,"maxAdults") VALUES ('room-1',3,3);
    INSERT INTO "HotelMealPricing" (id,"hotelId","mealPlan","adultSurcharge","childSurcharge") VALUES ('meal-1','hotel-1','BED_BREAKFAST',120,75);
    INSERT INTO "MealPlanRate" (id,"hotelId",code,name,"pricePerNight","updatedAt") VALUES ('rate-1','hotel-1','BB','Breakfast',200,now());
    INSERT INTO "OccupancyRateRule" (id,"hotelId","occupancyType",label,"includedAdults","surchargeAmount","extraAdultRate","updatedAt") VALUES ('occ-1','hotel-1','DOUBLE','Double',2,100,50,now());
  `);
}
async function dropChecks() {
  await db.exec(`ALTER TABLE "HotelMealPricing" DROP CONSTRAINT "HotelMealPricing_nonnegative";
    ALTER TABLE "MealPlanRate" DROP CONSTRAINT "MealPlanRate_price_check";
    ALTER TABLE "OccupancyRateRule" DROP CONSTRAINT "OccupancyRateRule_includedAdults_check", DROP CONSTRAINT "OccupancyRateRule_amounts_check";`);
}
async function checks() {
  const result = await db.query<{ conname: string; convalidated: boolean }>(
    `SELECT conname, convalidated FROM pg_constraint WHERE conname = ANY($1::text[]) ORDER BY conname`, [names]
  );
  return result.rows;
}
async function values() {
  return (await db.query(`SELECT
    (SELECT "adultSurcharge" FROM "HotelMealPricing" WHERE id='meal-1') AS meal,
    (SELECT "pricePerNight" FROM "MealPlanRate" WHERE id='rate-1') AS rate,
    (SELECT "includedAdults" FROM "OccupancyRateRule" WHERE id='occ-1') AS adults,
    (SELECT "extraAdultRate" FROM "OccupancyRateRule" WHERE id='occ-1') AS extra,
    (SELECT "maxAdults" FROM "RoomType" WHERE id='room-1') AS room_adults`)).rows;
}
afterEach(async () => { if (db) await db.close(); });

describe("pricing check repair on disposable in-memory PostgreSQL", () => {
  it("accepts the original checks on a fresh schema and is repeatable", async () => {
    await fixture(); const before = await values();
    await db.exec(repair); await db.exec(repair);
    expect(await checks()).toHaveLength(4);
    expect((await checks()).every((row) => row.convalidated)).toBe(true);
    expect(await values()).toEqual(before);
  });
  it("restores missing checks without rewriting existing pricing or room data", async () => {
    await fixture(); const before = await values(); await dropChecks();
    expect(await checks()).toHaveLength(0);
    await db.exec(repair);
    expect(await checks()).toHaveLength(4);
    expect((await checks()).every((row) => row.convalidated)).toBe(true);
    expect(await values()).toEqual(before);
    for (const statement of [
      `UPDATE "HotelMealPricing" SET "adultSurcharge" = -1 WHERE id = 'meal-1'`,
      `UPDATE "HotelMealPricing" SET "childSurcharge" = -1 WHERE id = 'meal-1'`,
      `UPDATE "MealPlanRate" SET "pricePerNight" = -1 WHERE id = 'rate-1'`,
      `UPDATE "MealPlanRate" SET "pricePerNight" = 100000000 WHERE id = 'rate-1'`,
      `UPDATE "OccupancyRateRule" SET "includedAdults" = 0 WHERE id = 'occ-1'`,
      `UPDATE "OccupancyRateRule" SET "surchargeAmount" = -1 WHERE id = 'occ-1'`,
      `UPDATE "OccupancyRateRule" SET "extraAdultRate" = 100000000 WHERE id = 'occ-1'`,
    ]) await expect(db.exec(statement)).rejects.toThrow();
    expect(await values()).toEqual(before);
  });
  it("fails atomically on invalid pre-existing data without changing it", async () => {
    await fixture(); await dropChecks();
    await db.exec(`UPDATE "OccupancyRateRule" SET "includedAdults" = 0 WHERE id = 'occ-1'`);
    const before = await values();
    await expect(db.exec(repair)).rejects.toThrow();
    expect(await checks()).toHaveLength(0);
    expect(await values()).toEqual(before);
  });
  it("fails atomically when an existing named check has a different definition", async () => {
    await fixture(); await dropChecks();
    await db.exec(`ALTER TABLE "OccupancyRateRule" ADD CONSTRAINT "OccupancyRateRule_amounts_check" CHECK ("extraAdultRate" >= 0)`);
    const before = await values();
    await expect(db.exec(repair)).rejects.toThrow(/different or unvalidated definition/);
    expect((await checks()).map((row) => row.conname)).toEqual(["OccupancyRateRule_amounts_check"]);
    expect(await values()).toEqual(before);
  });
  it("fails closed if an existing check has not been validated", async () => {
    await fixture(); await dropChecks();
    await db.exec(`ALTER TABLE "HotelMealPricing" ADD CONSTRAINT "HotelMealPricing_nonnegative" CHECK ("adultSurcharge" >= 0 AND "childSurcharge" >= 0) NOT VALID`);
    await expect(db.exec(repair)).rejects.toThrow(/different or unvalidated definition/);
    expect((await checks()).map((row) => [row.conname, row.convalidated])).toEqual([["HotelMealPricing_nonnegative", false]]);
  });
});
