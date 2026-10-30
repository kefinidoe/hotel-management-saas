# Membership invitations (consent before access)

**Status:** implemented (round 12) · **Code:** `lib/invitations.ts`, `app/api/staff/route.ts`,
`app/api/auth/invitations/[id]/route.ts`, `app/api/auth/memberships/route.ts`,
`app/select-hotel/page.tsx` · **Tests:** `__tests__/auth/membership-invitations.test.ts`,
`__tests__/staff/multi-tenant-staff.test.ts`, `__tests__/safety/offline-auth-routes.test.ts`

## 1. The problem (round-11 finding F-3)

Accounts are global, memberships are per hotel. A hotel administrator who wanted a colleague
onboarded could type that colleague's email into "add staff". If the email already belonged to a
`User` (for example somebody who works at another hotel on the same platform), the old handler
created a membership with **`status: ACTIVE`** and returned it immediately.

The consequences, in order of severity:

1. **A silent second workplace.** The account holder gained access to another hotel's operational
   and financial data with no notice, no prompt and no way to refuse — the invitation was
   indistinguishable from a normal sign-in once the switch-hotel list was rendered.
2. **An administrator-side oracle.** A 201 with an id, versus a 409 "email in use", told the
   administrator whether an arbitrary email address had an account on the platform.
3. **A cross-tenant credential hazard.** The old flow accepted a `password` field for an existing
   account. It was ignored, but anything that *stored* it would have let one hotel set another
   hotel's user password.

The round-11 mitigation was deliberately minimal: refuse to overwrite credentials, and record which
hotel an account was joined to. That is necessary but not sufficient — it still granted access
without consent.

## 2. The model

An invitation is **not a separate table**. It is a membership in the existing `SUSPENDED` state plus
an audit event that explains why it is suspended:

| Step | Database state | Audit event |
|---|---|---|
| Administrator adds an existing account | `HotelMembership.status = SUSPENDED`, `role` = requested role | `STAFF_INVITATION_CREATED` (actor = the administrator, metadata = invitee user id + email) |
| Invitee accepts | `status = ACTIVE` | `STAFF_INVITATION_ACCEPTED` (actor = the invitee) |
| Invitee declines | membership row deleted | `STAFF_INVITATION_DECLINED` (actor = the invitee) |
| Administrator later removes the member | `status = SUSPENDED` | `STAFF_MEMBERSHIP_SUSPENDED` |

Pending-ness is the **latest** event for that membership id:

```
STAFF_INVITATION_CREATED                 → pending
STAFF_INVITATION_ACCEPTED | DECLINED     → not pending
STAFF_MEMBERSHIP_SUSPENDED (or any later event) → not pending
```

That is what makes a revoked membership impossible to accept later: the suspension event is newer
than the invitation, so the invitation is gone. There is no time window, no token to leak and no
state machine to drift — the audit trail *is* the state, and it is the same trail an auditor reads.

### Why reuse `SUSPENDED` rather than a new status

Every authorisation path in the application already treats a non-`ACTIVE` membership as "no access"
(`lib/tenant-context.ts`, `lib/authz.ts`, the switch-hotel route, the staff list). Reusing it means a
pending invitation cannot leak data through a code path that forgot about invitations, and it needs
no migration. The alternative — a new `PENDING` enum value — would have required every one of those
paths to be updated and re-audited, with a failure mode of "forgot one".

The cost is that `SUSPENDED` is now overloaded ("invited" vs "removed"). It is disambiguated by the
audit event, which the API surfaces as `invitationPending` so the UI never has to guess.

## 3. API contract

```
POST /api/staff                         (admin; adding an existing account)
  → 202 { id, status: "SUSPENDED", invitationPending: true, ... }
  → 201 for a brand-new account (unchanged: the administrator created it, so there is nobody to ask)

GET  /api/auth/memberships              (any signed-in user)
  → { memberships: [...ACTIVE only...],
      pendingInvitations: [{ id, hotelId, hotelName, role, invitedAt }] }

POST /api/auth/invitations/:membershipId   { action: "accept" | "decline" }
  → 200 { decision: "accepted" | "declined" }
  → 401 unauthenticated
  → 404 not found / not yours / no longer pending
  → 403 PLAN_LIMIT_EXCEEDED (accept only)
  → 409 HOTEL_INACTIVE (the hotel is suspended or cancelled)
  → 503 DATABASE_UNAVAILABLE (offline preview; Prisma is never loaded)
```

Accepting runs inside `withUsageLimitLock(hotelId, "maxStaff", 1, …)`, the same serialised quota path
used by every other seat-consuming write, so concurrent acceptances cannot exceed the plan. An
invitation therefore **does not reserve a seat**: an administrator can invite beyond the plan's seat
count, and the invitee is told why acceptance failed.

## 4. Threat analysis

| Threat | Before | Now | Residual |
|---|---|---|---|
| Administrator silently grants a foreign account access to their hotel | 201 `ACTIVE` | 202 `SUSPENDED`; only the invitee can activate it | None: the membership cannot be used and cannot be switched to |
| Prefix/foreign invitation acceptance (IDOR) | n/a (no accept step) | Route filters on `userId = session.user.id` **and** pending state; foreign ids return 404, not 403, so no existence oracle | None |
| Replay after revocation | n/a | A later `STAFF_MEMBERSHIP_SUSPENDED` makes the invitation non-pending; acceptance returns 404 | None |
| Seat-limit bypass by inviting many, accepting later | n/a | Limit enforced at acceptance under the advisory lock | An attacker with admin rights can hold many `SUSPENDED` rows — they consume no seat and grant nothing |
| Email-enumeration oracle at invite time | 201 vs 409 | Still distinguishable by design: an administrator is told whether an email has an account | Accepted: the administrator must be able to invite. Mitigated by the audit trail (`STAFF_INVITATION_CREATED` names the actor) and by never returning profile data |
| Cross-hotel password overwrite | Guarded in round 11 (403 on `newPassword`) | Unchanged; the invitation path never writes `User` | None |
| Privilege escalation by inviting an admin | Role is chosen by the inviter, but nothing activates without the invitee | Invitee sees the offered role before accepting | Accepted: an inviter who is an administrator can offer admin; that is within their authority |
| Offline preview loading the DB | n/a | `isDatabaseConfigured()` returns 503 before `@/lib/auth` or `@/lib/prisma` are imported; asserted by test | None |
| Audit row forgery | n/a | Only `recordAudit` writes; the accept route derives the actor from the session, never from the body | Same trust boundary as the rest of the audit trail |

**What this does not claim.** Consent is proven by possession of the account's credentials at the
moment of acceptance; there is no out-of-band email confirmation. An account whose password is known
to a third party can therefore be made to accept an invitation by that third party. That is a
pre-existing property of password authentication, not a property of this flow, and it is why
`docs/production-recovery.md` §10 forbids one hotel's administrator from setting another user's
password.

## 5. Operations

- An invitation is visible to the invitee at `/select-hotel` ("Pending invitations") and in
  `GET /api/auth/memberships`.
- An administrator can withdraw an invitation by removing the staff row (`DELETE /api/staff/:id`),
  which suspends the membership and therefore cancels the pending invitation.
- To answer "who invited whom, and who accepted": the `AuditLog` rows with entity
  `HOTEL_MEMBERSHIP`, actions `STAFF_INVITATION_*`; each carries the actor's user id.
- Pending invitations appear in `GET /api/staff` as `invitationPending: true`, so an operator can see
  outstanding invitations without reading the audit table.

## 6. Evidence

| Check | Result |
|---|---|
| `npx vitest run __tests__/auth/membership-invitations.test.ts` | 11 passed |
| `npx vitest run __tests__/staff/multi-tenant-staff.test.ts` | 14 passed (invitation expectations updated) |
| `npx vitest run __tests__/safety/offline-auth-routes.test.ts` | 4 passed (includes 503-before-Prisma for the new route) |
| `node scripts/e2e-smoke.mjs --base http://127.0.0.1:3100` | 46/46, including: invite → not switchable → foreign accept refused → accept → switch → Hotel B data, no Hotel A data |
| Manual browser walkthrough | **NOT TESTED** — no browser automation in this environment (see round-12 report) |
