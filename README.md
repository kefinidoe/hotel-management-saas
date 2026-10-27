# Hotel Management SaaS

## Safe local frontend-only preview (no database)

The login screen and unauthenticated homepage can be previewed without a database. In PowerShell, from the project folder, run:

```powershell
$env:DATABASE_URL = ''
$env:DIRECT_URL = ''
$env:NEXTAUTH_URL = 'http://localhost:3000'
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$env:NEXTAUTH_SECRET = [Convert]::ToBase64String($bytes)
$rng.Dispose()
npm run dev
```

The empty database URL values take precedence over any `.env*` values for this process. Prisma's safety guard remains enabled: with no database URL it does not validate or connect to a database. The random NextAuth secret is local-only and does not create a user or authenticate anyone. Do not sign in, register, or expect dashboard/business data in this mode; those features require a database and should fail rather than fabricate data.

Stop the dev server with `Ctrl+C`. To clear these process-scoped values afterward, run:

```powershell
'DATABASE_URL', 'DIRECT_URL', 'NEXTAUTH_URL', 'NEXTAUTH_SECRET' | ForEach-Object {
  Remove-Item "Env:$_" -ErrorAction SilentlyContinue
}
```

## Database-backed local development

Only use a separately provisioned local PostgreSQL database and credentials. Never point this project at the live Axis Hotel system or the existing SaaS Supabase database. `SAAS_ENVIRONMENT` must be exactly `saas`; `SAAS_DATABASE_IDENTIFIER` must match the configured database target as enforced by `lib/db-safety-guard.ts`. Do not satisfy the guard by copying an unknown or production URL into the environment.

The repository's migration history is under review. Do not run `prisma migrate dev`, `prisma migrate deploy`, `prisma migrate resolve`, `prisma db push`, or seed scripts until a safe local migration path has been reviewed. Database-backed authentication, APIs, and dashboard routes are not available in the frontend-only preview above.

## What's in this step
- Next.js + TypeScript project scaffold
- Tailwind design system (colors, spacing, buttons, cards, badges) matching the
  premium hospitality brief
- Full Prisma database schema: users/roles, rooms, room types, guests,
  reservations, folios, folio items, payments, housekeeping, maintenance,
  restaurant menu, inventory, expenses, notifications, audit log

## Run locally

1. Install Node.js (v18+) if needed: https://nodejs.org.
2. Open this folder in VS Code and install dependencies using the repository's lockfile.
3. For an offline frontend preview, follow **Safe local frontend-only preview (no database)** above. Do not copy a database URL from another environment.
4. Database-backed testing requires a separately provisioned local PostgreSQL instance and a reviewed migration plan. The migration chain is under review; do not run `prisma migrate dev`, `prisma migrate deploy`, `prisma migrate resolve`, `prisma db push`, or seed scripts against an existing or shared database.

The login screen can be inspected without a database. Authentication, registration, dashboard data, and operational modules require a configured local database and are intentionally unavailable in frontend-only mode. No successful sign-in or business data is fabricated.

## What's next (Step 2)
- Authentication (NextAuth) + role-based access
- The application shell: collapsible sidebar, topbar, active-page highlighting
- Seed script with realistic sample data (18 rooms, guests, reservations)
  so the dashboard isn't empty

Come back to this chat and say "let's do step 2" when you're ready and I'll
give you the next batch of files the same way.
