import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";

export default async function Home() {
  // Frontend-only local preview has no DB URL. Do not import authOptions here:
  // lib/auth imports Prisma and must only load when a guarded DB target is set.
  if (!process.env.DATABASE_URL?.trim()) redirect("/login");

  const { authOptions } = await import("@/lib/auth");
  const session = await getServerSession(authOptions);
  redirect(session ? "/dashboard" : "/login");
}
