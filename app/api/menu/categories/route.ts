
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { REQUIRED_MENU_CATEGORIES } from "@/lib/menu-categories";

export async function POST(req: Request) {
  const tenant = await getTenantFromRoute();

  if (tenant instanceof NextResponse) {
    return tenant;
  }

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) {
    return forbidden;
  }
  const blocked = await requireModule(tenant.hotelId, "RESTAURANT_POS");
  if (blocked) return blocked;

  let body: unknown;

  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "Invalid JSON request body." },
      { status: 400 }
    );
  }

  const requestedName =
    typeof body === "object" &&
    body !== null &&
    "name" in body &&
    typeof body.name === "string"
      ? body.name.trim()
      : "";

  if (!requestedName) {
    return NextResponse.json(
      { error: "Category name is required." },
      { status: 400 }
    );
  }

  if (requestedName.length > 80) {
    return NextResponse.json(
      { error: "Category name is too long." },
      { status: 400 }
    );
  }

  const canonicalName =
    REQUIRED_MENU_CATEGORIES.find(
      (name) => name.toLowerCase() === requestedName.toLowerCase()
    ) ?? requestedName;

  // Check duplicates within this hotel only.
  const categories = await prisma.menuCategory.findMany({
    where: { hotelId: tenant.hotelId },
    select: { id: true, name: true },
  });

  const duplicate = categories.find(
    (category) =>
      category.name.trim().toLowerCase() === canonicalName.toLowerCase()
  );

  if (duplicate) {
    return NextResponse.json(
      { error: `A category named "${duplicate.name}" already exists.` },
      { status: 409 }
    );
  }

  const category = await prisma.menuCategory.create({
    data: {
      name: canonicalName,
      hotel: {
        connect: { id: tenant.hotelId },
      },
    },
  });

  return NextResponse.json(
    { id: category.id, name: category.name },
    { status: 201 }
  );
}
