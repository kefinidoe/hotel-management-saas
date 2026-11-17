import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { isDatabaseConfigured } from "@/lib/db-safety-guard";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isUniqueConstraintViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "P2002"
  );
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request body." },
      { status: 400 }
    );
  }

  const name = typeof body?.name === "string" ? body.name.trim() : "";
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  const phone = typeof body?.phone === "string" ? body.phone.trim() : null;

  // Count parseable registration attempts before field validation, while
  // preserving the existing offline-preview responses when no DB is configured.
  if (isDatabaseConfigured()) {
    const { limitAuthRequest } = await import("@/lib/auth-rate-limit");
    const limited = await limitAuthRequest(req, "registration", email);
    if (limited) return limited;
  }

  if (!name || name.length < 2 || name.length > 100) {
    return NextResponse.json(
      { error: "Full name is required (2-100 characters)." },
      { status: 400 }
    );
  }

  if (!email || !EMAIL_REGEX.test(email) || email.length > 150) {
    return NextResponse.json(
      { error: "A valid email address is required." },
      { status: 400 }
    );
  }

  if (!password || password.length < 8) {
    return NextResponse.json(
      { error: "Password must be at least 8 characters long." },
      { status: 400 }
    );
  }

  if (!isDatabaseConfigured()) {
    return NextResponse.json(
      { error: "DATABASE_UNAVAILABLE", message: "Account creation is unavailable while the database is not configured." },
      { status: 503 }
    );
  }

  try {
    // Load Prisma only after the blank-URL fast path above. Without this lazy
    // import, an offline preview can fail while loading the generated client
    // before the handler gets a chance to return its intentional 503 response.
    const { prisma } = await import("@/lib/prisma");
    const existing = await prisma.user.findFirst({
      where: {
        email: { equals: email, mode: "insensitive" },
      },
    });

    if (existing) {
      return NextResponse.json(
        { error: "An account with this email address already exists. Please sign in." },
        { status: 409 }
      );
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        phone,
        passwordHash,
        isActive: true,
      },
      select: {
        id: true,
        name: true,
        email: true,
        createdAt: true,
      },
    });

    return NextResponse.json(
      {
        user,
        message: "Account registered successfully. You may now sign in.",
      },
      { status: 201 }
    );
  } catch (error) {
    if (isUniqueConstraintViolation(error)) {
      return NextResponse.json(
        { error: "An account with this email address already exists. Please sign in." },
        { status: 409 }
      );
    }

    console.error("Error creating user account:", error);
    return NextResponse.json(
      { error: "Could not create account. Please try again." },
      { status: 500 }
    );
  }
}
