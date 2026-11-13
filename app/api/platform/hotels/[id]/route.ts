import { NextResponse } from "next/server";
import { getPlatformAdminFromRoute } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { SubscriptionStatusUnavailableError } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await getPlatformAdminFromRoute();
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  if (!id) {
    return NextResponse.json({ error: "Hotel ID is required" }, { status: 400 });
  }

  try {
    const hotel = await prisma.hotel.findUnique({
      where: { id },
      include: {
        _count: {
          select: {
            rooms: true,
            memberships: true,
            reservations: true,
            folios: true,
            guests: true,
          },
        },
        memberships: {
          take: 20,
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            role: true,
            status: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                phone: true,
                department: true,
                isActive: true,
                lastLoginAt: true,
              },
            },
          },
        },
        auditLogs: {
          take: 15,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            action: true,
            entity: true,
            entityId: true,
            metadata: true,
            createdAt: true,
            user: {
              select: {
                id: true,
                name: true,
                email: true,
              },
            },
          },
        },
      },
    });

    if (!hotel) {
      return NextResponse.json(
        { error: "NOT_FOUND", message: "Hotel not found." },
        { status: 404 }
      );
    }

    const settingsObj = (hotel.settings as Record<string, any>) || {};

    const { getOrBootstrapSubscription } = await import("@/lib/entitlements");
    const subContext = await getOrBootstrapSubscription(id);

    return NextResponse.json({
      hotel: {
        id: hotel.id,
        name: hotel.name,
        slug: hotel.slug,
        status: hotel.status,
        currency: hotel.currency,
        timezone: hotel.timezone,
        contactEmail: settingsObj.contactEmail || null,
        contactPhone: settingsObj.contactPhone || null,
        address: settingsObj.address || null,
        createdAt: hotel.createdAt.toISOString(),
        updatedAt: hotel.updatedAt.toISOString(),
      },
      subscription: {
        id: subContext.id,
        planId: subContext.planId,
        planName: subContext.plan.name,
        storedStatus: subContext.storedStatus,
        effectiveStatus: subContext.effectiveStatus,
        isOperational: subContext.isOperational,
        daysRemaining: subContext.daysRemaining,
        trialStartsAt: subContext.trialStartsAt.toISOString(),
        trialEndsAt: subContext.trialEndsAt?.toISOString() || null,
        currentPeriodStartsAt: subContext.currentPeriodStartsAt.toISOString(),
        currentPeriodEndsAt: subContext.currentPeriodEndsAt?.toISOString() || null,
        limits: subContext.plan.limits,
        modules: subContext.plan.modules,
      },
      stats: {
        roomsCount: hotel._count.rooms,
        membershipsCount: hotel._count.memberships,
        reservationsCount: hotel._count.reservations,
        foliosCount: hotel._count.folios,
        guestsCount: hotel._count.guests,
      },
      memberships: hotel.memberships.map((m) => ({
        id: m.id,
        role: m.role,
        status: m.status,
        createdAt: m.createdAt.toISOString(),
        user: {
          id: m.user.id,
          name: m.user.name,
          email: m.user.email,
          phone: m.user.phone,
          department: m.user.department,
          isActive: m.user.isActive,
          lastLoginAt: m.user.lastLoginAt ? m.user.lastLoginAt.toISOString() : null,
        },
      })),
      recentAuditLogs: hotel.auditLogs.map((log) => ({
        id: log.id,
        action: log.action,
        entity: log.entity,
        entityId: log.entityId,
        metadata: log.metadata,
        createdAt: log.createdAt.toISOString(),
        userName: log.user?.name || "System",
        userEmail: log.user?.email || null,
      })),
    });
  } catch (error) {
    if (error instanceof SubscriptionStatusUnavailableError) {
      return NextResponse.json(
        {
          error: error.code,
          message: "Subscription status is temporarily unavailable.",
        },
        { status: error.statusCode }
      );
    }

    console.error("Failed to inspect hotel details:", error);
    return NextResponse.json(
      { error: "SERVER_ERROR", message: "Failed to retrieve hotel details." },
      { status: 500 }
    );
  }
}
