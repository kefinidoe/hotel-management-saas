-- Run ONLY on the explicitly verified disposable CI database. The surrounding
-- transaction is rolled back: no test role, audit row, or fixture is retained.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '10s';
INSERT INTO "Hotel" (id, name, slug, "updatedAt") VALUES ('ci-audit-guard-hotel', 'Fictional audit test', 'ci-audit-guard', now());
INSERT INTO "User" (id, name, email, "passwordHash", "updatedAt") VALUES ('ci-audit-guard-user', 'Fictional user', 'ci-audit-guard@example.invalid', 'not-a-real-hash', now());
INSERT INTO "AuditLog" (id, "hotelId", "userId", action, entity, "entityId", metadata)
VALUES ('ci-audit-guard-row', 'ci-audit-guard-hotel', 'ci-audit-guard-user', 'PLATFORM_MANUAL_PAYMENT_ACTIVATED', 'Subscription', 'ci-fake-subscription', '{"referenceCode":"CI-AUDIT-REF-1"}');

DO $test$
DECLARE blocked boolean;
BEGIN
  blocked := false;
  BEGIN UPDATE "AuditLog" SET metadata='{"referenceCode":"CHANGED"}' WHERE id='ci-audit-guard-row';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'audit UPDATE was not blocked'; END IF;

  blocked := false;
  BEGIN DELETE FROM "AuditLog" WHERE id='ci-audit-guard-row';
  EXCEPTION WHEN object_not_in_prerequisite_state THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'audit DELETE was not blocked'; END IF;

  blocked := false;
  BEGIN TRUNCATE "AuditLog";
  EXCEPTION WHEN object_not_in_prerequisite_state THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'audit TRUNCATE was not blocked'; END IF;

  blocked := false;
  BEGIN DELETE FROM "Hotel" WHERE id='ci-audit-guard-hotel';
  EXCEPTION WHEN restrict_violation THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'linked hotel DELETE was not blocked'; END IF;

  blocked := false;
  BEGIN DELETE FROM "User" WHERE id='ci-audit-guard-user';
  EXCEPTION WHEN restrict_violation THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'linked user DELETE was not blocked'; END IF;

  blocked := false;
  BEGIN INSERT INTO "AuditLog" (id, action, entity, metadata) VALUES ('ci-audit-duplicate', 'PLATFORM_MANUAL_PAYMENT_ACTIVATED', 'Subscription', '{"referenceCode":" ci-audit-ref-1 "}');
  EXCEPTION WHEN unique_violation THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'duplicate payment reference was not blocked'; END IF;

  IF (SELECT metadata->>'referenceCode' FROM "AuditLog" WHERE id='ci-audit-guard-row') IS DISTINCT FROM 'CI-AUDIT-REF-1' THEN
    RAISE EXCEPTION 'audit row changed during blocked operations';
  END IF;
END
$test$;

-- This role is a disposable test fixture, not the application's real role.
CREATE ROLE ci_audit_runtime NOLOGIN;
GRANT USAGE ON SCHEMA public TO ci_audit_runtime;
GRANT SELECT, INSERT ON "AuditLog" TO ci_audit_runtime;
SET LOCAL ROLE ci_audit_runtime;
INSERT INTO "AuditLog" (id, action, entity) VALUES ('ci-audit-runtime-insert', 'TEST', 'Subscription');
DO $test$
DECLARE blocked boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "AuditLog" WHERE id='ci-audit-runtime-insert') THEN
    RAISE EXCEPTION 'runtime could not read its audit event';
  END IF;
  blocked := false;
  BEGIN UPDATE "AuditLog" SET action='OTHER' WHERE id='ci-audit-runtime-insert';
  EXCEPTION WHEN insufficient_privilege THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'runtime UPDATE privilege was not blocked'; END IF;
  blocked := false;
  BEGIN DELETE FROM "AuditLog" WHERE id='ci-audit-runtime-insert';
  EXCEPTION WHEN insufficient_privilege THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'runtime DELETE privilege was not blocked'; END IF;
  blocked := false;
  BEGIN TRUNCATE "AuditLog";
  EXCEPTION WHEN insufficient_privilege THEN blocked := true; END;
  IF NOT blocked THEN RAISE EXCEPTION 'runtime TRUNCATE privilege was not blocked'; END IF;
END
$test$;
RESET ROLE;
ROLLBACK;
