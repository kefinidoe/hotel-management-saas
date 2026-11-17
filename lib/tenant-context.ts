
import { getServerSession } from "next-auth";
import { cookies } from "next/headers";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { HotelRole, HotelStatus, MembershipStatus, PlatformRole } from "@prisma/client";

export type TenantErrorCode =
  | "UNAUTHENTICATED"
  | "ACCOUNT_INACTIVE"
  | "NO_ACTIVE_MEMBERSHIP"
  | "INVALID_HOTEL_SELECTION"
  | "HOTEL_SELECTION_REQUIRED"
  | "MEMBERSHIP_SUSPENDED"
  | "HOTEL_SUSPENDED"
  | "FORBIDDEN";

export class TenantAuthError extends Error {
  code: TenantErrorCode;
  statusCode: number;
  clearCookie: boolean;

  constructor(code: TenantErrorCode, message: string, statusCode = 403, clearCookie = false) {
    super(message);
    this.name = "TenantAuthError";
    this.code = code;
    this.statusCode = statusCode;
    this.clearCookie = clearCookie;
  }
}

export interface TenantContext {
  userId: string;
  hotelId: string;
  hotel: {
    id: string;
    name: string;
    logoUrl: string | null;
    slug: string;
    currency: string;
    useModularPricing: boolean;
    useCustomRateRules: boolean;
    timezone: string;
    status: HotelStatus;
  };
  membership: {
    id: string;
    role: HotelRole;
    status: MembershipStatus;
  };
  role: HotelRole;
  isPlatformAdmin: boolean;
}

/**
 * Authoritatively resolves and validates the tenant context for the current request.
 * Wrapped in React cache() strictly for deduplication within a single Server Component render pass.
 * Never relies on caching for authorization correctness.
 */
export async function getTenantContext(
  { allowNonOperationalHotel = false }: { allowNonOperationalHotel?: boolean } = {}
): Promise<TenantContext> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    throw new TenantAuthError("UNAUTHENTICATED", "Authentication required", 401);
  }

  const userId = session.user.id;

  // 1. Authoritative check on User existence and active status
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, isActive: true, platformRole: true },
  });

  if (!user || !user.isActive) {
    throw new TenantAuthError("ACCOUNT_INACTIVE", "User account is deactivated or not found", 403, true);
  }

  // 2. Read active hotel selector from cookies
  const cookieStore = await cookies();
  const requestedHotelId = cookieStore.get("active_hotel_id")?.value;

  if (requestedHotelId) {
    // Explicit selection provided -> Must be strictly validated. Never silently fall back.
    const membership = await prisma.hotelMembership.findUnique({
      where: { userId_hotelId: { userId, hotelId: requestedHotelId } },
      include: { hotel: true },
    });

    if (!membership) {
      throw new TenantAuthError(
        "INVALID_HOTEL_SELECTION",
        "Requested hotel not found in user memberships",
        403,
        true
      );
    }

    if (membership.status !== MembershipStatus.ACTIVE) {
      throw new TenantAuthError(
        "MEMBERSHIP_SUSPENDED",
        "User membership in requested hotel is suspended",
        403,
        true
      );
    }

    if (
      !allowNonOperationalHotel &&
      membership.hotel.status !== HotelStatus.ACTIVE &&
      membership.hotel.status !== HotelStatus.TRIALING
    ) {
      throw new TenantAuthError(
        "HOTEL_SUSPENDED",
        "Requested hotel workspace is currently suspended",
        403,
        true
      );
    }

    return {
      userId,
      hotelId: membership.hotelId,
      hotel: {
        id: membership.hotel.id,
        name: membership.hotel.name,
        logoUrl: membership.hotel.logoUrl,
        slug: membership.hotel.slug,
        currency: membership.hotel.currency,
        useModularPricing: membership.hotel.useModularPricing,
        useCustomRateRules: membership.hotel.useCustomRateRules,
        timezone: membership.hotel.timezone,
        status: membership.hotel.status,
      },
      membership: {
        id: membership.id,
        role: membership.role,
        status: membership.status,
      },
      role: membership.role,
      isPlatformAdmin: user.platformRole !== null,
    };
  }

  // 3. No selection provided -> Query user's active memberships
  const activeMemberships = await prisma.hotelMembership.findMany({
    where: {
      userId,
      status: MembershipStatus.ACTIVE,
      ...(!allowNonOperationalHotel && {
        hotel: {
          status: { in: [HotelStatus.ACTIVE, HotelStatus.TRIALING] },
        },
      }),
    },
    include: { hotel: true },
    orderBy: { createdAt: "asc" },
  });

  if (activeMemberships.length === 0) {
    throw new TenantAuthError(
      "NO_ACTIVE_MEMBERSHIP",
      "User holds no active memberships in any operational hotel",
      403,
      false
    );
  }

  if (activeMemberships.length === 1) {
    // Exactly one active membership -> Safe to auto-select
    const sole = activeMemberships[0];
    return {
      userId,
      hotelId: sole.hotelId,
      hotel: {
        id: sole.hotel.id,
        name: sole.hotel.name,
        logoUrl: sole.hotel.logoUrl,
        slug: sole.hotel.slug,
        currency: sole.hotel.currency,
        useModularPricing: sole.hotel.useModularPricing,
        useCustomRateRules: sole.hotel.useCustomRateRules,
        timezone: sole.hotel.timezone,
        status: sole.hotel.status,
      },
      membership: {
        id: sole.id,
        role: sole.role,
        status: sole.status,
      },
      role: sole.role,
      isPlatformAdmin: user.platformRole !== null,
    };
  }

  // Multiple active memberships -> Require explicit selection (Fail Closed)
  throw new TenantAuthError(
    "HOTEL_SELECTION_REQUIRED",
    "Multiple active hotel memberships found. Please select an active hotel.",
    403,
    false
  );
}

/**
 * Resolves a member's tenant for read-only subscription/billing recovery views.
 * Membership and account checks remain mandatory, but hotel operational status
 * does not hide the information needed to resolve a billing suspension.
 */
export async function getBillingTenantContext(): Promise<TenantContext> {
  return getTenantContext({ allowNonOperationalHotel: true });
}

/**
 * Enforces hotel-level operational role authorization.
 */
export async function requireHotelRole(allowedRoles: readonly HotelRole[]): Promise<TenantContext> {
  const context = await getTenantContext();
  if (!allowedRoles.includes(context.role)) {
    throw new TenantAuthError("FORBIDDEN", "Insufficient hotel operational permissions", 403);
  }
  return context;
}

/**
 * Enforces platform-level administrative role authorization.
 * Platform roles are completely decoupled from hotel memberships.
 */
export async function requirePlatformRole(allowedRoles: readonly PlatformRole[]): Promise<{
  userId: string;
  platformRole: PlatformRole;
}> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    throw new TenantAuthError("UNAUTHENTICATED", "Authentication required", 401);
  }

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { id: true, isActive: true, platformRole: true },
  });

  if (!user || !user.isActive) {
    throw new TenantAuthError("ACCOUNT_INACTIVE", "User account deactivated", 403);
  }

  if (!user.platformRole || !allowedRoles.includes(user.platformRole)) {
    throw new TenantAuthError("FORBIDDEN", "Insufficient platform administrative permissions", 403);
  }

  return {
    userId: user.id,
    platformRole: user.platformRole,
  };
}
