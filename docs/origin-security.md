# API origin protection and security headers

Inventory is against commit `109e70e71266f66f91705c51e55c529f4ff8d14f`. Before this change, only `POST api/auth/invitations/[id]` and `POST api/auth/switch-hotel` explicitly called `isSameOriginRequest`. The NextAuth handler also has its own CSRF token enforcement, independent of that helper. Other exports below had no explicit origin check.

The middleware passes all `/api/auth/` routes through before the global origin check, allowing NextAuth sign-in and external identity-provider callbacks that omit or send a cross-site Origin. This exemption includes application handlers such as registration, invitations and hotel switching; NextAuth's own protections do not automatically cover those handlers. Invitation and hotel-switch handlers retain their pre-existing origin checks, while registration did not have one at this base. Middleware pass-through does not guarantee a handler accepts a request: its own session, role, tenant, origin and other checks still apply.

For other `/api/` routes, middleware enforces a canonical `Origin` matching `NEXTAUTH_URL` and the existing fetch-metadata check on POST, PUT, PATCH and DELETE before the existing authentication logic. Missing or mismatched Origin returns 403. The request-host preview opt-in in the existing helper does not widen this global check. Production must set `NEXTAUTH_URL` to the public HTTPS origin. Authentication, roles and tenant checks are not replaced by this check.

Strict Origin enforcement on non-auth routes can reject legitimate browser or proxy requests that omit the header. Do not deploy without testing real browser, proxy and auth flows.

CSP: `default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'`. Inline and eval allowances reduce XSS protection but accommodate Next.js; actual compatibility remains unverified. HSTS is one year without subdomains or preload; use HTTPS on the real host. X-Frame-Options DENY, nosniff, strict-origin-when-cross-origin, and a restrictive Permissions-Policy are also configured. NextAuth production cookies use its secure HttpOnly SameSite=Lax defaults; real-host Set-Cookie behavior remains unverified.

## Mutating route exports before the change

- `DELETE api/inventory/[id]`
- `DELETE api/menu/categories/[id]`
- `DELETE api/menu/items/[id]`
- `DELETE api/pricing/[entity]`
- `DELETE api/recipes/[id]`
- `DELETE api/reservations/[id]`
- `DELETE api/room-types/[id]`
- `DELETE api/rooms/[id]`
- `DELETE api/staff/[id]`
- `PATCH api/expenses/[id]`
- `PATCH api/guests/[id]`
- `PATCH api/hotel/settings`
- `PATCH api/inventory/[id]`
- `PATCH api/notifications`
- `PATCH api/platform/hotels/[id]/status`
- `PATCH api/platform/hotels/[id]/subscription`
- `PATCH api/pricing`
- `PATCH api/pricing/[entity]`
- `PATCH api/recipes/[id]`
- `PATCH api/staff/[id]`
- `POST api/auth/[...nextauth]` — NextAuth CSRF token
- `POST api/auth/invitations/[id]` — existing helper check
- `POST api/auth/register`
- `POST api/auth/switch-hotel` — existing helper check
- `POST api/check-in`
- `POST api/check-out`
- `POST api/expenses`
- `POST api/hotel/onboarding`
- `POST api/inventory`
- `POST api/maintenance`
- `POST api/menu`
- `POST api/menu/categories`
- `POST api/payments`
- `POST api/pricing/[entity]`
- `POST api/pricing/room-rates`
- `POST api/profile/password`
- `POST api/purchases`
- `POST api/recipes`
- `POST api/reservations`
- `POST api/reservations/[id]/check-in`
- `POST api/reservations/[id]/check-out`
- `POST api/reservations/[id]/extend`
- `POST api/reservations/[id]/reprice`
- `POST api/reservations/quote`
- `POST api/restaurant/charge-to-room`
- `POST api/restaurant/pay-now`
- `POST api/room-types`
- `POST api/rooms`
- `POST api/staff`
- `POST api/wastage`
- `PUT api/housekeeping/[id]`
- `PUT api/maintenance/[id]`
- `PUT api/menu/items/[id]`
- `PUT api/reservations/[id]`
- `PUT api/room-types/[id]`
- `PUT api/rooms/[id]`
