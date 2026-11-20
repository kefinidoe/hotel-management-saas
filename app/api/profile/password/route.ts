import { readMutationBody, validateMutation, passwordSchema } from "@/lib/staff-settings-validation";
import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { requireAuth } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

// Change YOUR OWN password. Any signed-in user, and it requires the current
// password -- so a borrowed or stolen session alone isn't enough to lock the
// real owner out of their account.
//
// NOTE: sessions are JWTs, so a session already open elsewhere stays valid until
// it expires. This stops the OLD password being used to sign in again; it does
// not kick out a session someone already holds. If you're rotating because you
// suspect compromise, also deactivate and re-enable the account.
export async function POST(req: Request) {
  const auth = await requireAuth();
  if (auth instanceof NextResponse) return auth;

  const { limitAuthRequest } = await import("@/lib/auth-rate-limit");
  const limited = await limitAuthRequest(req, "password", auth.user.id);
  if (limited) return limited;

  const input = await readMutationBody(req);

  // Account state and the current-password check are security checks; keep
  // them ahead of validation of the requested new password.
  const user = await prisma.user.findUnique({ where: { id: auth.user.id } });
  if (!user) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  if (!user.isActive) {
    return NextResponse.json({ error: "This account is deactivated." }, { status: 403 });
  }

  const current = input && typeof input === "object" && "currentPassword" in input
    ? input.currentPassword : undefined;
  if (typeof current === "string" && current.length > 0 && current.length <= 200) {
    if (!(await bcrypt.compare(current, user.passwordHash))) {
      return NextResponse.json({ error: "That current password isn't right." }, { status: 400 });
    }
  }

  const validation = validateMutation(req, passwordSchema, input);
  if (validation.response) return validation.response;
  const newPassword = validation.data.newPassword;

  // Re-using the same password is the most common way a forced rotation ends up
  // meaning nothing.
  const sameAsBefore = await bcrypt.compare(newPassword, user.passwordHash);
  if (sameAsBefore) {
    return NextResponse.json(
      { error: "The new password must be different from the current one." },
      { status: 400 }
    );
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash: await bcrypt.hash(newPassword, 10) },
  });

  return NextResponse.json({ ok: true });
}
