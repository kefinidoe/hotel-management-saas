-- PROPOSAL ONLY. Do not apply to Supabase or production without a reviewed
-- role rollout, TLS/credential plan, full application permission testing, and
-- explicit deployment approval. CI applies this only to a verified disposable
-- PostgreSQL database. The role is deliberately NOLOGIN and has no password.
-- Database roles are cluster-wide; role-name collisions fail closed.
BEGIN;
DO $preflight$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hotel_saas_runtime') THEN
    RAISE EXCEPTION 'hotel_saas_runtime already exists; inspect before provisioning';
  END IF;
END
$preflight$;
CREATE ROLE hotel_saas_runtime NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO hotel_saas_runtime;
-- These are bounded application-table grants, not per-operation least privilege.
-- The existing shared-role architecture still relies on app tenant isolation.
-- New tables do not get grants automatically and require explicit review.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public."Hotel",
  public."Subscription",
  public."HotelMembership",
  public."User",
  public."HotelMealPricing",
  public."MealPlanRate",
  public."OccupancyRateRule",
  public."RoomType",
  public."Room",
  public."Guest",
  public."Reservation",
  public."ReservationRoom",
  public."Folio",
  public."FolioItem",
  public."PaymentMethod",
  public."Payment",
  public."HousekeepingTask",
  public."MaintenanceTicket",
  public."MenuCategory",
  public."MenuItem",
  public."Order",
  public."OrderItem",
  public."InventoryRequest",
  public."InventoryItem",
  public."Recipe",
  public."RecipeIngredient",
  public."StockMovement",
  public."Purchase",
  public."Wastage",
  public."Expense",
  public."Notification",
  public."OccupancyType",
  public."RoomTypeOccupancy",
  public."MealPlanConfig",
  public."MealPlanRoomType",
  public."RateAdjustment",
  public."ExtraBedRule",
  public."ChildPricingRule",
  public."TaxRule",
  public."HotelPricingSettings",
  public."ReservationPriceSnapshot",
  public."ReservationPriceChange",
  public."ReservationExtension",
  public."AuthRateLimitBucket"
TO hotel_saas_runtime;
GRANT SELECT, INSERT ON TABLE public."AuditLog" TO hotel_saas_runtime;
DO $verify$
DECLARE role_oid oid := 'hotel_saas_runtime'::regrole;
BEGIN
  IF has_schema_privilege(role_oid, 'public', 'CREATE') OR
     has_table_privilege(role_oid, 'public."AuditLog"', 'UPDATE') OR
     has_any_column_privilege(role_oid, 'public."AuditLog"', 'UPDATE') OR
     has_table_privilege(role_oid, 'public."AuditLog"', 'DELETE') OR
     has_table_privilege(role_oid, 'public."AuditLog"', 'TRUNCATE') OR
     has_table_privilege(role_oid, 'public."AuditLog"', 'TRIGGER') OR
     has_any_column_privilege(role_oid, 'public."_prisma_migrations"', 'SELECT') OR
     has_any_column_privilege(role_oid, 'public."_prisma_migrations"', 'INSERT') OR
     has_any_column_privilege(role_oid, 'public."_prisma_migrations"', 'UPDATE') OR
     has_table_privilege(role_oid, 'public."_prisma_migrations"', 'SELECT') OR
     has_table_privilege(role_oid, 'public."_prisma_migrations"', 'INSERT') OR
     has_table_privilege(role_oid, 'public."_prisma_migrations"', 'UPDATE') OR
     has_table_privilege(role_oid, 'public."_prisma_migrations"', 'DELETE') OR
     has_table_privilege(role_oid, 'public."_prisma_migrations"', 'TRUNCATE') OR
     EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.prosecdef AND has_function_privilege(role_oid, p.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'Existing PUBLIC grants or security-definer functions make the proposed role unsafe; review without changing grants automatically';
  END IF;
END
$verify$;
COMMIT;
