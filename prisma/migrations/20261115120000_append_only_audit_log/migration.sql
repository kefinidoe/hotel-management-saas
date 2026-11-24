-- Protect audit history from ordinary DML. This is defense in depth: table
-- owners / privileged administrators can remove these protections. A separate
-- non-owner runtime role and independently protected audit export are required.
-- Block deletion or ID changes of linked hotels/users rather than cascading
-- changes into audit history. Review retention and privacy requirements before
-- using with real data. This statement is atomic and acquires strong locks.
DO $migration$
DECLARE
  fk RECORD;
  actual RECORD;
BEGIN
  LOCK TABLE public."Hotel", public."User", public."AuditLog" IN ACCESS EXCLUSIVE MODE;

  FOR fk IN SELECT * FROM (VALUES
    ('AuditLog_hotelId_fkey', 'FOREIGN KEY ("hotelId") REFERENCES "Hotel"(id) ON UPDATE CASCADE ON DELETE CASCADE', 'hotelId', 'Hotel'),
    ('AuditLog_userId_fkey', 'FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE SET NULL', 'userId', 'User')
  ) AS expected(name, definition, column_name, parent_table)
  LOOP
    SELECT c.contype, c.convalidated, pg_get_constraintdef(c.oid) AS definition INTO actual
    FROM pg_constraint c WHERE c.conrelid = 'public."AuditLog"'::regclass AND c.conname = fk.name;
    IF NOT FOUND OR actual.contype <> 'f' OR NOT actual.convalidated OR actual.definition <> fk.definition THEN
      RAISE EXCEPTION 'Audit foreign key % is missing or differs from the expected validated definition; review schema drift', fk.name;
    END IF;
  END LOOP;

  IF to_regprocedure('public.reject_audit_log_mutation()') IS NOT NULL OR EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgrelid = 'public."AuditLog"'::regclass
      AND tgname IN ('AuditLog_reject_mutation', 'AuditLog_reject_truncate')
  ) THEN
    RAISE EXCEPTION 'Audit protection function or trigger already exists; review schema drift';
  END IF;

  FOR fk IN SELECT * FROM (VALUES
    ('AuditLog_hotelId_fkey', 'hotelId', 'Hotel'),
    ('AuditLog_userId_fkey', 'userId', 'User')
  ) AS expected(name, column_name, parent_table)
  LOOP
    EXECUTE format('ALTER TABLE public."AuditLog" DROP CONSTRAINT %I', fk.name);
    EXECUTE format('ALTER TABLE public."AuditLog" ADD CONSTRAINT %I FOREIGN KEY (%I) REFERENCES public.%I(id) ON UPDATE RESTRICT ON DELETE RESTRICT', fk.name, fk.column_name, fk.parent_table);
  END LOOP;

  EXECUTE $function$
    CREATE FUNCTION public.reject_audit_log_mutation() RETURNS trigger
    LANGUAGE plpgsql AS $body$
    BEGIN
      RAISE EXCEPTION 'AuditLog is append-only; updates, deletes and truncation are not permitted' USING ERRCODE = '55000';
    END
    $body$
  $function$;
  EXECUTE 'CREATE TRIGGER "AuditLog_reject_mutation" BEFORE UPDATE OR DELETE ON public."AuditLog" FOR EACH ROW EXECUTE FUNCTION public.reject_audit_log_mutation()';
  EXECUTE 'CREATE TRIGGER "AuditLog_reject_truncate" BEFORE TRUNCATE ON public."AuditLog" FOR EACH STATEMENT EXECUTE FUNCTION public.reject_audit_log_mutation()';
END
$migration$;
