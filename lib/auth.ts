import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

if (process.env.NEXTAUTH_SECRET) {
  process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET
    .replace(/^NEXTAUTH_SECRET\s*=\s*/i, "")
    .replace(/^["']+|["']+$/g, "")
    .trim();
}

if (process.env.NEXTAUTH_URL) {
  process.env.NEXTAUTH_URL = process.env.NEXTAUTH_URL
    .replace(/^NEXTAUTH_URL\s*=\s*/i, "")
    .replace(/^["']+|["']+$/g, "")
    .replace(/\/+$/, "")
    .trim();
}

export const authOptions: NextAuthOptions = {
  session: { strategy: "jwt", maxAge: 12 * 60 * 60, updateAge: 60 * 60 },
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;
        if (!process.env.DATABASE_URL?.trim()) {
          throw new Error("DATABASE_UNAVAILABLE");
        }
        const cleanEmail = credentials.email.trim();
        const user = await prisma.user.findFirst({
          where: {
            email: { equals: cleanEmail, mode: "insensitive" },
          },
        });
        if (!user || !user.isActive) return null;
        const valid = await bcrypt.compare(credentials.password, user.passwordHash);
        if (!valid) return null;
        try {
          await prisma.user.update({
            where: { id: user.id },
            data: { lastLoginAt: new Date() },
          });
        } catch {
          // Do not block sign-in if lastLoginAt update fails on pooled connections
        }
        return {
          id: user.id,
          name: user.name,
          email: user.email,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (!session.user) return session;
      if (!token.id) return null as unknown as typeof session;

      try {
        const user = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { id: true, name: true, email: true, isActive: true },
        });
        if (!user || !user.isActive) {
          return null as unknown as typeof session;
        }
        session.user.id = user.id;
        session.user.name = user.name;
        session.user.email = user.email;
      } catch {
        session.user.id = token.id as string;
      }
      return session;
    },
  },
};
