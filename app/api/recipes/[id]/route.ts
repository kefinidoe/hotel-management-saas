import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";

type IngredientInput = { inventoryItemId: string; quantity: number };

function parseIngredients(value: unknown): IngredientInput[] | null {
  if (!Array.isArray(value)) return null;
  const ingredients: IngredientInput[] = [];
  for (const raw of value) {
    const candidate = raw as { inventoryItemId?: unknown; quantity?: unknown } | null;
    const inventoryItemId =
      typeof candidate?.inventoryItemId === "string" ? candidate.inventoryItemId.trim() : "";
    const quantity = Number(candidate?.quantity);
    if (!inventoryItemId || !Number.isFinite(quantity) || quantity <= 0) return null;
    ingredients.push({ inventoryItemId, quantity });
  }
  return ingredients;
}

async function allInventoryItemsBelongToHotel(hotelId: string, ingredients: IngredientInput[]) {
  const ids = [...new Set(ingredients.map((ingredient) => ingredient.inventoryItemId))];
  if (ids.length === 0) return true;
  const items = await prisma.inventoryItem.findMany({
    where: { hotelId, id: { in: ids } },
    select: { id: true },
  });
  return new Set(items.map((item) => item.id)).size === ids.length;
}

const recipeTenantFilter = (id: string, hotelId: string) => ({
  id,
  menuItem: { is: { hotelId } },
});

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESTAURANT_POS");
  if (blocked) return blocked;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const hasPortions = body?.portions !== undefined;
  const hasIngredients = body?.ingredients !== undefined;
  if (!hasPortions && !hasIngredients) {
    return NextResponse.json({ error: "No recipe changes were provided." }, { status: 400 });
  }

  let portions: number | undefined;
  if (hasPortions) {
    portions = Number(body.portions);
    if (!Number.isInteger(portions) || portions < 1) {
      return NextResponse.json(
        { error: "The portion count must be a whole number of at least 1." },
        { status: 400 }
      );
    }
  }

  let ingredients: IngredientInput[] | undefined;
  if (hasIngredients) {
    ingredients = parseIngredients(body.ingredients) ?? undefined;
    if (!ingredients) {
      return NextResponse.json(
        { error: "Every ingredient needs an inventory item and a quantity greater than zero." },
        { status: 400 }
      );
    }
  }

  const hotelId = tenant.hotelId;
  const recipe = await prisma.recipe.findFirst({
    where: {
      ...recipeTenantFilter(id, hotelId),
      ingredients: { every: { inventoryItem: { is: { hotelId } } } },
    },
    select: { id: true },
  });
  if (!recipe) return NextResponse.json({ error: "Recipe not found." }, { status: 404 });

  if (ingredients && !(await allInventoryItemsBelongToHotel(hotelId, ingredients))) {
    return NextResponse.json({ error: "One or more inventory items were not found in this hotel." }, { status: 404 });
  }

  const updated = await prisma.$transaction(async (tx) => {
    const change = await tx.recipe.updateMany({
      where: recipeTenantFilter(id, hotelId),
      data: { ...(portions === undefined ? {} : { portions }) },
    });
    if (change.count === 0) return null;

    if (ingredients !== undefined) {
      await tx.recipeIngredient.deleteMany({
        where: {
          recipeId: id,
          recipe: { is: { menuItem: { is: { hotelId } } } },
        },
      });
      if (ingredients.length > 0) {
        await tx.recipeIngredient.createMany({
          data: ingredients.map((ingredient) => ({
            recipeId: id,
            inventoryItemId: ingredient.inventoryItemId,
            quantity: ingredient.quantity,
          })),
        });
      }
    }

    return tx.recipe.findFirst({
      where: recipeTenantFilter(id, hotelId),
      include: {
        ingredients: {
          where: { inventoryItem: { is: { hotelId } } },
          include: { inventoryItem: true },
        },
      },
    });
  });

  if (!updated) return NextResponse.json({ error: "Recipe not found." }, { status: 404 });
  return NextResponse.json(updated);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESTAURANT_POS");
  if (blocked) return blocked;

  const deleted = await prisma.recipe.deleteMany({
    where: recipeTenantFilter(id, tenant.hotelId),
  });
  if (deleted.count === 0) return NextResponse.json({ error: "Recipe not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
