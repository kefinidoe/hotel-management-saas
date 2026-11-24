-- Add only the pricing checks missing from older adopted databases. Fresh
-- databases already have these constraints from the original migrations.
-- One DO statement makes this repair atomic even if a later check fails.
-- Adding a validated check scans the table and takes an ACCESS EXCLUSIVE lock;
-- schedule a reviewed deployment window and ensure a verified backup first.
DO $repair$
DECLARE
  expected RECORD;
  existing RECORD;
BEGIN
  LOCK TABLE public."HotelMealPricing", public."MealPlanRate", public."OccupancyRateRule" IN ACCESS EXCLUSIVE MODE;

  FOR expected IN
    SELECT * FROM (VALUES
      ('HotelMealPricing', 'HotelMealPricing_nonnegative',
       $def$CHECK ((("adultSurcharge" >= (0)::numeric) AND ("childSurcharge" >= (0)::numeric)))$def$,
       $expr$CHECK ("adultSurcharge" >= 0 AND "childSurcharge" >= 0)$expr$),
      ('MealPlanRate', 'MealPlanRate_price_check',
       $def$CHECK ((("pricePerNight" >= (0)::double precision) AND ("pricePerNight" <= (99999999.99)::double precision)))$def$,
       $expr$CHECK ("pricePerNight" >= 0 AND "pricePerNight" <= 99999999.99)$expr$),
      ('OccupancyRateRule', 'OccupancyRateRule_includedAdults_check',
       $def$CHECK (("includedAdults" >= 1))$def$,
       $expr$CHECK ("includedAdults" >= 1)$expr$),
      ('OccupancyRateRule', 'OccupancyRateRule_amounts_check',
       $def$CHECK ((("surchargeAmount" >= (0)::double precision) AND ("surchargeAmount" <= (99999999.99)::double precision) AND ("extraAdultRate" >= (0)::double precision) AND ("extraAdultRate" <= (99999999.99)::double precision)))$def$,
       $expr$CHECK ("surchargeAmount" >= 0 AND "surchargeAmount" <= 99999999.99 AND "extraAdultRate" >= 0 AND "extraAdultRate" <= 99999999.99)$expr$)
    ) AS specs(table_name, constraint_name, canonical_definition, create_expression)
  LOOP
    SELECT c.contype, c.convalidated, c.connoinherit, pg_get_constraintdef(c.oid) AS definition
      INTO existing
    FROM pg_constraint AS c
    JOIN pg_class AS t ON t.oid = c.conrelid
    JOIN pg_namespace AS n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = expected.table_name AND c.conname = expected.constraint_name;

    IF FOUND THEN
      IF existing.contype <> 'c' OR NOT existing.convalidated OR existing.connoinherit
         OR existing.definition <> expected.canonical_definition THEN
        RAISE EXCEPTION 'Constraint %.% exists with a different or unvalidated definition; review schema drift before repair',
          expected.table_name, expected.constraint_name;
      END IF;
    ELSE
      EXECUTE format('ALTER TABLE public.%I ADD CONSTRAINT %I %s',
        expected.table_name, expected.constraint_name, expected.create_expression);
    END IF;
  END LOOP;
END
$repair$;
