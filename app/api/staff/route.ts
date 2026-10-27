import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { HotelRole, MembershipStatus } from "@prisma/client";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PERMITTED_HOTEL_ROLES = Object.values(HotelRole);

export const dynamic = "force-dynamic";

// List staff members belonging to the active hotel only
export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.STAFF_VIEW);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  const isManagement =
    tenant.role === HotelRole.HOTEL_OWNER ||
    tenant.role === HotelRole.HOTEL_ADMIN ||
    tenant.role === HotelRole.MANAGER;

  try {
    const memberships = await prisma.hotelMembership.findMany({
      where: {
        hotelId: tenant.hotelId,
        ...(isManagement ? {} : { status: MembershipStatus.ACTIVE }),
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            phone: true,
            isActive: true,
            lastLoginAt: true,
            createdAt: true,
          },
        },
      },
      orderBy: {
        user: { name: "asc" },
      },
    });

    const result = memberships.map((m) => ({
      id: m.id,
      userId: m.user.id,
      name: m.user.name,
      email: isManagement ? m.user.email : undefined,
      phone: isManagement ? m.user.phone : undefined,
      role: m.role,
      department: isManagement ? m.department : undefined,
      status: m.status,
      isActive: m.user.isActive && m.status === MembershipStatus.ACTIVE,
      lastLoginAt: isManagement && m.user.lastLoginAt ? m.user.lastLoginAt.toISOString() : null,
      createdAt: m.createdAt.toISOString(),
    }));

    return NextResponse.json(result);
  } catch (error) {
    console.error("Failed to query hotel staff members:", error);
    return NextResponse.json(
      { error: "Could not retrieve staff members." },
      { status: 500 }
    );
  }
}

// Add a staff member to the active hotel
export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.STAFF_ADMIN);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESERVATIONS");
  if (blocked) return blocked;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const requestedRole = typeof body?.role === "string" ? body.role.trim() : "";
  const department = typeof body?.department === "string" ? body.department.trim() : null;
  const phone = typeof body?.phone === "string" ? body.phone.trim() : null;

  if (!name || name.length < 2 || name.length > 100) {
    return NextResponse.json(
      { error: "Staff name is required (2-100 characters)." },
      { status: 400 }
    );
  }

  if (!email || !EMAIL_REGEX.test(email)) {
    return NextResponse.json({ error: "A valid email address is required." }, { status: 400 });
  }

  if (!password || password.length < 8) {
    return NextResponse.json(
      { error: "Initial password must be at least 8 characters long." },
      { status: 400 }
    );
  }

  if (department && department.length > 100) {
    return NextResponse.json({ error: "Department name must be 100 characters or fewer." }, { status: 400 });
  }

  // Role validation: Must be a legitimate HotelRole (never a platform role)
  if (!PERMITTED_HOTEL_ROLES.includes(requestedRole as HotelRole)) {
    return NextResponse.json(
      { error: `Invalid role. Permitted hotel roles: ${PERMITTED_HOTEL_ROLES.join(", ")}` },
      { status: 400 }
    );
  }

  // Security guard: Only HOTEL_OWNER can assign the HOTEL_OWNER role
  if (
    requestedRole === HotelRole.HOTEL_OWNER &&
    tenant.role !== HotelRole.HOTEL_OWNER
  ) {
    return NextResponse.json(
      { error: "Only hotel owners can grant the HOTEL_OWNER role." },
      { status: 403 }
    );
  }

  try {
    // Check if user account already exists globally
    const existingUser = await prisma.user.findFirst({
      where: { email: { equals: email, mode: "insensitive" } },
      select: { id: true, name: true, email: true, phone: true, isActive: true },
    });

    if (existingUser) {
      if (!existingUser.isActive) {
        return NextResponse.json(
          { error: "This account is inactive and cannot be added to the hotel." },
          { status: 403 }
        );
      }

      // Existing account credentials and global profile are never changed by
      // adding a hotel membership. Only the new membership receives hotel data.
      // Check if user is already a member of this hotel
      const existingMembership = await prisma.hotelMembership.findUnique({
        where: {
          userId_hotelId: {
            userId: existingUser.id,
            hotelId: tenant.hotelId,
          },
        },
      });

      if (existingMembership) {
        return NextResponse.json(
          { error: "This user is already a member of this hotel workspace." },
          { status: 409 }
        );
      }

      // Serialize the count and membership insertion under one hotel-scoped lock.
      const { withUsageLimitLock } = await import("@/lib/entitlements");
      const quotaResult = await withUsageLimitLock(tenant.hotelId, "maxStaff", 1, async (tx) => tx.hotelMembership.create({
        data: {
          userId: existingUser.id,
          hotelId: tenant.hotelId,
          role: requestedRole as HotelRole,
          department: department || null,
          status: MembershipStatus.ACTIVE,
        },
        include: { user: { select: { id: true, name: true, email: true, phone: true } } },
      }));
      if (!quotaResult.allowed) {
        return NextResponse.json(
          { error: quotaResult.limit.code || "PLAN_LIMIT_EXCEEDED", message: quotaResult.limit.reason },
          { status: quotaResult.limit.code === "SUBSCRIPTION_STATUS_UNAVAILABLE" || quotaResult.limit.code === "USAGE_LIMIT_UNAVAILABLE" ? 503 : 403 }
        );
      }
      const newMembership = quotaResult.value;

      return NextResponse.json(
        {
          id: newMembership.id,
          userId: newMembership.user.id,
          name: newMembership.user.name,
          email: newMembership.user.email,
          phone: newMembership.user.phone,
          role: newMembership.role,
          department: newMembership.department,
          status: newMembership.status,
          message: "Existing user added to hotel workspace.",
        },
        { status: 201 }
      );
    }

    // Create new User and HotelMembership atomically
    const passwordHash = await bcrypt.hash(password, 10);

    const { withUsageLimitLock } = await import("@/lib/entitlements");
    const quotaResult = await withUsageLimitLock(tenant.hotelId, "maxStaff", 1, async (tx) => {
      const newUser = await tx.user.create({
        data: { name, email, phone, passwordHash, isActive: true },
      });
      const newMembership = await tx.hotelMembership.create({
        data: {
          userId: newUser.id,
          hotelId: tenant.hotelId,
          role: requestedRole as HotelRole,
          department: department || null,
          status: MembershipStatus.ACTIVE,
        },
      });
      return { user: newUser, membership: newMembership };
    });
    if (!quotaResult.allowed) {
      return NextResponse.json(
        { error: quotaResult.limit.code || "PLAN_LIMIT_EXCEEDED", message: quotaResult.limit.reason },
        { status: quotaResult.limit.code === "SUBSCRIPTION_STATUS_UNAVAILABLE" || quotaResult.limit.code === "USAGE_LIMIT_UNAVAILABLE" ? 503 : 403 }
      );
    }
    const result = quotaResult.value;

    return NextResponse.json(
      {
        id: result.membership.id,
        userId: result.user.id,
        name: result.user.name,
        email: result.user.email,
        phone: result.user.phone,
        role: result.membership.role,
        department: result.membership.department,
        status: result.membership.status,
        message: "Staff member created and assigned to hotel.",
      },
      { status: 201 }
    );
  } catch (error: any) {
    if (error?.code === "SUBSCRIPTION_STATUS_UNAVAILABLE" || error?.code === "USAGE_LIMIT_UNAVAILABLE") {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 503 });
    }
    console.error("Failed to add staff member:", error);
    return NextResponse.json(
      { error: "Could not add staff member. Please try again." },
      { status: 500 }
    );
  }
}