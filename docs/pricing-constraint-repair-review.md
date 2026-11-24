# Pricing check constraint repair — review before deployment

## Purpose and scope

The connected Supabase project was inspected read-only. Its Prisma ledger records the meal and custom-rate migrations as finished, but four expected CHECK constraints were absent. The read-only count query found no existing rows violating the four checks at inspection time; data can change afterward. Confirm the app's actual target, take and verify a backup/restore point, and repeat the data and schema checks immediately before any deployment.

The additive migration `20261114120000_repair_pricing_check_constraints` adds only:

| Table | Constraint | Condition |
| --- | --- | --- |
| HotelMealPricing | HotelMealPricing_nonnegative | Adult and child surcharges are non-negative. |
| MealPlanRate | MealPlanRate_price_check | Price per night is between 0 and 99,999,999.99. |
| OccupancyRateRule | OccupancyRateRule_includedAdults_check | Included adults is at least 1. |
| OccupancyRateRule | OccupancyRateRule_amounts_check | Surcharge and extra adult rate are each between 0 and 99,999,999.99. |

It does not rewrite prices, reservations, invoices, existing migration files, or the Prisma ledger itself. An applied migration does create the usual Prisma ledger entry when deployed by Prisma. It does not install audit-log immutability or change manual payment handling.

## Safety behavior

- Fresh schema: matching, validated pre-existing checks are left untouched. The migration requires their exact canonical PostgreSQL definitions; a semantically equivalent but differently rendered definition fails closed for manual review, not automatic replacement.
- Drifted schema: missing checks are added and validated against existing rows. An invalid row aborts the repair instead of being altered or deleted.
- Wrong or unvalidated named check: aborts for review; the migration never drops or replaces it.
- The repair is a single PostgreSQL DO statement: failure rolls back that statement's schema changes. Prisma's migration ledger may still record a failed attempt; stop and investigate rather than blindly resolving or retrying.
- It acquires ACCESS EXCLUSIVE locks on all three tables and adding checks scans existing rows. This can block normal application traffic. Assess table sizes, workload, timeout and maintenance window with the database operator before deployment.

## Verification and approval gates

The test suite includes real SQL execution against disposable in-memory PostgreSQL, not the connected Supabase project. Verify separately against the actual target PostgreSQL version and Prisma engine in an isolated production-like rehearsal; in-memory tests alone are not proof of Prisma deploy behavior, lock duration, data compatibility or production readiness. Confirm actual target identity, backup and restoration, schema and data checks, and a deployment/rollback plan before requesting approval. No production or Supabase repair is authorized merely by the presence of this file.

Strict append-only audit protection is a separate workstream and requires reviewed trigger/privilege policy. The payment reference index is intentionally outside this repair.
