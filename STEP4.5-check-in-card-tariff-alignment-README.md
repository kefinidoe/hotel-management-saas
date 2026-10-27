# Check-in Card and Tariff Fields — Historical Implementation Note

This note records the historical addition of configurable check-in details to
the hotel-management application. The capabilities described below are generic
hotel operations features, not product-wide defaults for a specific property.

## Fields and workflows added

- Guest records can include vehicle registration, identity number, and
  nationality.
- Reservations can record payment mode and a discount.
- Room types support occupancy and meal-plan variants.
- The reservation form captures guest counts, dates, room selection, rates,
  discounts, and payment mode; check-out time is shown as an operational
  reminder.
- Discounts are recorded as folio line items at check-in.

## Historical files touched

The implementation updated the Prisma schema, seed configuration, reservation
and check-in routes, guest profile, and reservation/front-desk components.

This is a historical summary, not an instruction to apply migrations, run
seeds, or modify any database. Any future schema or workflow change must use
the current approved review and database-safety process, and property-specific
rates or settings must be configured for the correct tenant.
