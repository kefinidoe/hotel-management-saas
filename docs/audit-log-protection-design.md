# Audit-log protection: review and decisions before implementation

## Current findings

The Prisma model and the connected **test** project use `ON DELETE CASCADE` for `AuditLog.hotelId` and `ON DELETE SET NULL` for `AuditLog.userId`; both use `ON UPDATE CASCADE`. There is no user-defined AuditLog trigger in that test project. Deleting a hotel can delete its audit rows; deleting a user can change their audit rows. The unique index on normalized manual-payment references cannot prevent reference reuse if a privileged writer changes or deletes the indexed row.

Manual payment activation uses one database transaction for the subscription change and audit insert, an advisory lock, and a unique index for new payment actions. This protects normal code paths but does not make the audit row immutable. Some other `recordAudit` callers intentionally use best-effort logging; audit completeness is a separate problem from immutability. The guarded local-only cleanup script explicitly deletes audit rows, so a blanket append-only change affects it too.

The targeted read-only test-project inspection found 54 audit rows, all hotel- and user-linked, and zero `PLATFORM_MANUAL_PAYMENT_ACTIVATED` rows at that moment. `AuditLog` is owned by `postgres`, has no explicit table ACL, and row-level security is disabled. A subsequent read-only effective table-privilege check found `postgres` can SELECT, INSERT, UPDATE, DELETE and TRUNCATE and is the owner; `anon`, `authenticated`, and `service_role` did not have any of those table-level privileges. `service_role` has BYPASSRLS. This is not a complete privilege review or proof of the app's actual database role: other roles, column privileges, schema privileges, and role membership matter. Do not infer that the API or a database role is safe merely from these checks. No write was performed during this inspection.

## Decision required: retention and deletion

A blanket trigger that rejects every UPDATE/DELETE makes audit records append-only under ordinary DML, but it also causes hotel deletion cascades and user deletion's SET NULL to fail. A statement-level TRUNCATE guard is separately required. It would also cause the local test-data cleanup transaction to fail unless its explicitly disposable workflow is revised. Do not silently weaken the trigger for cascades or delete audit data to make cleanup pass.

**Recommended default:** retain all audit rows, reject UPDATE, DELETE and TRUNCATE; restrict deletion or ID changes of a hotel/user while linked audit rows exist, with explicit application-facing errors and a documented archival/legal process. Consider soft deletion for hotels and users. A later legally reviewed retention/anonymization process is needed; an unreviewed bypass is not acceptable. This decision changes deletion behavior and may conflict with privacy or statutory deletion obligations. Do not deploy it before the owner confirms the desired behavior and a suitable retention policy.

Alternative: protect only manual-payment audit events. This narrows disruption but does not make the audit log append-only generally, still affects deletion of linked users/hotels for protected rows, and requires careful handling of transitions into/out of the protected action. A separate immutable payment ledger could eventually decouple payment-reference history from hotel and user lifecycle, but needs a reviewed data model and migration of historical references.

## Layered design (partially implemented; not deployed)

A candidate migration `20261115120000_append_only_audit_log` now implements layers 1 and 2 below. It is not applied to the connected test project. The disposable cleanup script now retains audit rows. The migration does not provision or restrict any role, protect against a table owner, or address retention and privacy policy; layers 3–5 remain open.

1. Add a new, reviewed migration, never rewrite historical migrations. Make explicit `AuditLog` foreign-key deletion/update rules compatible with the confirmed retention policy and update the Prisma model to match. Do not delete or rewrite existing rows. Preflight actual FK definitions and fail closed on unexpected drift.
2. Install row-level `BEFORE UPDATE OR DELETE` and statement-level `BEFORE TRUNCATE` rejecting triggers. Validate insert/select still work and mismatched existing function/trigger names fail closed instead of being replaced blindly. Provide explicit errors; ensure a transactional failure cannot leave partial protection. Verify any schema/table privileges needed for deployment.
3. Use a distinct least-privilege runtime role with only required schema/table privileges. Runtime must not own AuditLog, be superuser, inherit owner/admin privileges, have privileges to change schema or assume a more privileged role, or be able to disable or replace protections. Confirm INSERT and SELECT as needed and remove UPDATE/DELETE/TRUNCATE, including inherited or PUBLIC grants. Verify effective privileges and role memberships, not just direct GRANT lists. Keep a separate migration/maintenance role. Role names, provisioning and secrets must be operator-approved, not hard-coded from assumptions. Review all app tables and connection-pooler compatibility before changing credentials or role grants. Never revoke broadly from service/platform roles without a reviewed scope and rollback plan. A read-only, target-guarded diagnostic (`node scripts/audit-runtime-role-check.mjs --connect`) checks the actual role used by DATABASE_URL. It requires explicit permission to connect and does not configure a role; a PASS is limited to the checked privileges and does not prove full application access, trigger enforcement or production readiness.
4. A database owner or sufficiently privileged administrator can alter triggers, privileges, or table data; triggers do not protect against them. Off-database, separately administered append-only log export, monitoring and backup/restore are needed for stronger tamper evidence and disaster recovery. No absolute immutability claim.
5. Review every caller of `recordAudit` and determine which events need transactionally strict audit persistence. This is not automatically solved by triggers. Provide correction events rather than editing past records.

## Test plan

Test on fresh PostgreSQL and a drifted representative schema, plus representative existing rows. Disposable migration tests were authorized; the connected test project and production are not authorized for this migration. Confirm:

- application inserts and reads still work; manual-payment activation and duplicate rejection remain transactional and correct;
- direct UPDATE, DELETE and TRUNCATE fail, and row values remain unchanged; failed operations do not partially change unrelated data;
- user/hotel deletion and ID updates behave exactly as approved, with no lost history;
- payment correction uses a new audit event, not mutation; duplicate references cannot be reused after attempted mutation/deletion;
- the local test cleanup workflow fails safely or is revised only for isolated, positively identified disposable databases;
- checks cover the restricted runtime role, inherited privileges, table ownership and schema ownership; privileged administrative bypass limitations are documented;
- absent/mismatched objects fail closed and migration/deploy behavior is exercised against a real disposable PostgreSQL server, not just mocks;
- tenant isolation, authentication/authorization, billing recovery and audit-failure behavior remain intact; Prisma, build and regression tests pass.

## Deployment gates

The candidate migration has not been applied to the connected test project. Before deployment, review deletion/retention and privacy policy, inspect the actual runtime role and effective grants without disclosing credentials, validate a backup and restore plan, and separately approve any test-database deployment. Production requires its own explicit approval. The connected free-tier test project currently has no verified backup; previous consent for the pricing repair does not approve later database changes.
