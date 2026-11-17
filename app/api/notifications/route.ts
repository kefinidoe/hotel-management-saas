import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";

/**
 * The signed-in user's notifications in the active hotel: everything addressed
 * to them personally plus hotel-wide broadcasts.
 *
 * Deliberately not module-gated: a hotel whose subscription has lapsed still
 * needs to be told why, and every other module is closed to it at that point.
 * The membership check in getTenantFromRoute is the boundary that matters here.
 */

export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const hotelId = tenant.hotelId;
  const where = {
    hotelId,
    OR: [{ userId: null }, { userId: tenant.userId }],
  };

  const [items, unread] = await Promise.all([
    prisma.notification.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 30,
      select: {
        id: true,
        type: true,
        title: true,
        message: true,
        isRead: true,
        createdAt: true,
      },
    }),
    prisma.notification.count({ where: { ...where, isRead: false } }),
  ]);

  return NextResponse.json({
    unread,
    notifications: items.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      message: item.message,
      isRead: item.isRead,
      createdAt: item.createdAt,
    })),
  });
}

export async function PATCH(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.ALL_STAFF);
  if (forbidden) return forbidden;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const payload = (body ?? {}) as { id?: unknown; all?: unknown };
  const wantsAll = payload.all === true;
  const singleId = typeof payload.id === "string" ? payload.id.trim() : "";
  if (!wantsAll && !singleId) {
    return NextResponse.json(
      { error: "Provide a notification id or { all: true }." },
      { status: 400 }
    );
  }

  const hotelId = tenant.hotelId;
  // Only rows this user can actually see may be marked: another user's targeted
  // notification is neither readable nor writable from here.
  const scope = {
    hotelId,
    OR: [{ userId: null }, { userId: tenant.userId }],
  };

  const result = wantsAll
    ? await prisma.notification.updateMany({
        where: { ...scope, isRead: false },
        data: { isRead: true },
      })
    : await prisma.notification.updateMany({
        where: { ...scope, id: singleId },
        data: { isRead: true },
      });

  return NextResponse.json({ updated: result.count });
}
