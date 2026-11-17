import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { isDatabaseConfigured } from "@/lib/db-safety-guard";
import { isSameOriginRequest } from "@/lib/request-origin";

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

  if (!isSameOriginRequest(req)) return NextResponse.json({ error: "CSRF_ORIGIN_INVALID" }, { status: 403 });

  const { authOptions } = await import("@/lib/auth");
  const { prisma } = await import("@/lib/prisma");
  const { withUsageLimitLock } = await import("@/lib/entitlements");
  const { isPendingInvitationFor, recordInvitationResolved, INVITATION_ACTIONS } = await import("@/lib/invitations");

  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  }

  const { limitAuthRequest } = await import("@/lib/auth-rate-limit");
  const limited = await limitAuthRequest(req, "invitation", session.user.id);
  if (limited) return limited;

  let body: any;
  try { body = await req.json(); } catch {
    return NextResponse.json({ error: "INVALID_REQUEST_BODY" }, { status: 400 });
  }
  if (!body || (body.action !== "accept" && body.action !== "decline")) {
    return NextResponse.json({ error: "An explicit invitation decision is required." }, { status: 400 });
  }
  const decision = body.action;


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

  // Recheck ownership, state, expiry, and hotel status inside the transaction.
  // Conditional writes ensure that a replay or concurrent resolution cannot
  // transition a membership which is no longer suspended.
  const resolve = async (tx: any) => {
    const activeUser = await tx.user.findUnique({ where: { id: session.user.id }, select: { isActive: true } });
    if (!activeUser?.isActive) throw new Error("INVITATION_NOT_AVAILABLE");
    const pendingNow = await isPendingInvitationFor(id, session.user.id, tx);
    const current = await tx.hotelMembership.findUnique({
      where: { id },
      include: { hotel: { select: { id: true, name: true, slug: true, status: true } } },
    });
    if (!pendingNow || !current || current.userId !== session.user.id || current.hotelId !== membership.hotelId ||
        !["ACTIVE", "TRIALING"].includes(current.hotel.status)) throw new Error("INVITATION_NOT_AVAILABLE");
    const where = { id, userId: session.user.id, hotelId: membership.hotelId, status: "SUSPENDED" as const };
    const changed = await tx.hotelMembership.updateMany({ where, data: { status: decision === "decline" ? "SUSPENDED" : "ACTIVE" } });
    if (changed.count !== 1) throw new Error("INVITATION_NOT_AVAILABLE");
    await recordInvitationResolved({
      hotelId: membership.hotelId, membershipId: id, userId: session.user.id,
      action: decision === "decline" ? INVITATION_ACTIONS.DECLINED : INVITATION_ACTIONS.ACCEPTED,
      client: tx,
    });
    return current;
  };

  try {
    if (decision === "decline") {
      await prisma.$transaction(resolve, { isolationLevel: "Serializable" });
      return NextResponse.json({ ok: true, decision: "declined" });
    }
    const result = await withUsageLimitLock(membership.hotelId, "maxStaff", 1, resolve);
    if (!result.allowed) {
      return NextResponse.json(
        { error: result.limit.code || "PLAN_LIMIT_EXCEEDED", message: result.limit.reason },
        { status: result.limit.code === "SUBSCRIPTION_STATUS_UNAVAILABLE" || result.limit.code === "USAGE_LIMIT_UNAVAILABLE" ? 503 : 403 }
      );
    }
    return NextResponse.json({
      ok: true, decision: "accepted",
      membership: {
        id: result.value.id, hotelId: result.value.hotelId,
        hotelName: result.value.hotel.name, role: result.value.role, status: "ACTIVE",
      },
    });
  } catch (error: any) {
    if (error?.message === "INVITATION_NOT_AVAILABLE") return NextResponse.json({ error: "Invitation not found." }, { status: 404 });
    if (error?.code === "SUBSCRIPTION_STATUS_UNAVAILABLE" || error?.code === "USAGE_LIMIT_UNAVAILABLE") {
      return NextResponse.json({ error: error.code, message: error.message }, { status: 503 });
    }
    console.error("Failed to resolve invitation:", error);
    return NextResponse.json({ error: "Could not resolve the invitation." }, { status: 500 });
  }
}
