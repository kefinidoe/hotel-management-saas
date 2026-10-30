import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { isDatabaseConfigured } from "@/lib/db-safety-guard";

export const dynamic = "force-dynamic";

/**
 * Accept or decline a membership invitation.
 *
 * Only the invitee can do this: the membership must belong to the signed-in
 * user and must still be an unaccepted invitation. Accepting is the only path
 * that turns an invitation into access, and it enforces the plan's staff limit
 * at that moment (an invitation does not reserve a seat).
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  // Offline preview: refuse before the Prisma-backed auth config is evaluated,
  // matching the other database-backed auth routes.
  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      { error: "DATABASE_UNAVAILABLE", message: "Invitations are unavailable while the database is not configured." },
      { status: 503 }
    );
  }

  const { authOptions } = await import("@/lib/auth");
  const { prisma } = await import("@/lib/prisma");
  const { withUsageLimitLock } = await import("@/lib/entitlements");
  const { isPendingInvitationFor, recordInvitationResolved, INVITATION_ACTIONS } = await import("@/lib/invitations");

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  let body: any = null;
  if (req.headers.get("content-type")?.includes("application/json")) {
    try {
      body = await req.json();
    } catch {
      body = null;
    }
  }
  const decision = body?.action === "decline" ? "decline" : "accept";

  // 404 rather than 403 for somebody else's invitation: do not confirm that an
  // arbitrary membership id exists.
  const pending = await isPendingInvitationFor(id, session.user.id);
  if (!pending) {
    return NextResponse.json({ error: "Invitation not found." }, { status: 404 });
  }

  const membership = await prisma.hotelMembership.findUnique({
    where: { id },
    include: { hotel: { select: { id: true, name: true, slug: true, status: true } } },
  });
  if (!membership) {
    return NextResponse.json({ error: "Invitation not found." }, { status: 404 });
  }
  if (!["ACTIVE", "TRIALING"].includes(membership.hotel.status)) {
    return NextResponse.json(
      { error: "HOTEL_UNAVAILABLE", message: "This hotel is not accepting members right now." },
      { status: 409 }
    );
  }

  if (decision === "decline") {
    // The membership never granted access, so it carries no history to protect.
    await prisma.hotelMembership.delete({ where: { id } });
    await recordInvitationResolved({
      hotelId: membership.hotelId,
      membershipId: id,
      userId: session.user.id,
      action: INVITATION_ACTIONS.DECLINED,
    });
    return NextResponse.json({ ok: true, decision: "declined" });
  }

  try {
    const result = await withUsageLimitLock(membership.hotelId, "maxStaff", 1, async (tx) =>
      tx.hotelMembership.update({
        where: { id },
        data: { status: "ACTIVE" },
        include: { hotel: { select: { id: true, name: true, slug: true } } },
      })
    );
    if (!result.allowed) {
      return NextResponse.json(
        {
          error: result.limit.code || "PLAN_LIMIT_EXCEEDED",
          message: result.limit.reason,
        },
        {
          status:
            result.limit.code === "SUBSCRIPTION_STATUS_UNAVAILABLE" ||
            result.limit.code === "USAGE_LIMIT_UNAVAILABLE"
              ? 503
              : 403,
        }
      );
    }

    await recordInvitationResolved({
      hotelId: membership.hotelId,
      membershipId: id,
      userId: session.user.id,
      action: INVITATION_ACTIONS.ACCEPTED,
    });

    return NextResponse.json({
      ok: true,
      decision: "accepted",
      membership: {
        id: result.value.id,
        hotelId: result.value.hotelId,
        hotelName: result.value.hotel.name,
        role: result.value.role,
        status: result.value.status,
      },
    });
  } catch (error: any) {
    if (error?.code === "SUBSCRIPTION_STATUS_UNAVAILABLE" || error?.code === "USAGE_LIMIT_UNAVAILABLE") {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 503 });
    }
    console.error("Failed to resolve invitation:", error);
    return NextResponse.json({ error: "Could not resolve the invitation." }, { status: 500 });
  }
}
