import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getTenantFromRoute, requireRole, ROLE_GROUPS, requireModule } from "@/lib/authz";
import { computeAvailablePortions } from "@/lib/inventory";

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

export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;

  const blocked = await requireModule(tenant.hotelId, "RESTAURANT_POS");
  if (blocked) return blocked;

  const hotelId = tenant.hotelId;
  const recipes = await prisma.recipe.findMany({
    // Hide malformed legacy recipes if any linked ingredient is outside this hotel.
    where: {
      menuItem: { is: { hotelId } },
      ingredients: { every: { inventoryItem: { is: { hotelId } } } },
    },
    include: {
      menuItem: { include: { category: true } },
      ingredients: {
        where: { inventoryItem: { is: { hotelId } } },
        include: { inventoryItem: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const result = recipes.map((recipe) => {
    const ingredients = recipe.ingredients.map((ingredient) => ({
      inventoryItemId: ingredient.inventoryItemId,
      name: ingredient.inventoryItem.name,
      unit: ingredient.inventoryItem.unit,
      quantityPerBatch: Number(ingredient.quantity),
      currentStock: Number(ingredient.inventoryItem.currentStock),
      unitCost: Number(ingredient.inventoryItem.costPerUnit),
    }));

    const { portions, limitingItem } = computeAvailablePortions(ingredients, recipe.portions);
    const costPerBatch = ingredients.reduce(
      (sum, ingredient) => sum + ingredient.quantityPerBatch * ingredient.unitCost,
      0
    );
    const costPerPortion = costPerBatch / recipe.portions;
    const sellingPrice = Number(recipe.menuItem.price);
    const profit = sellingPrice - costPerPortion;

    return {
      id: recipe.id,
      menuItemId: recipe.menuItemId,
      name: recipe.menuItem.name,
      category: recipe.menuItem.category.name,
      sellingPrice,
      portionsPerBatch: recipe.portions,
      costPerPortion: Math.round(costPerPortion),
      profit: Math.round(profit),
      profitMargin: sellingPrice > 0 ? Math.round((profit / sellingPrice) * 100) : 0,
      availablePortions: portions,
      limitingItem,
      ingredients: ingredients.map((ingredient) => ({
        inventoryItemId: ingredient.inventoryItemId,
        name: ingredient.name,
        unit: ingredient.unit,
        quantityPerBatch: ingredient.quantityPerBatch,
      })),
    };
  });

  return NextResponse.json(result);
}

export async function POST(req: Request) {
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

  const menuItemId = typeof body?.menuItemId === "string" ? body.menuItemId.trim() : "";
  const ingredients = parseIngredients(body?.ingredients);
  if (!menuItemId || !ingredients || ingredients.length === 0) {
    return NextResponse.json(
      { error: "A menu item, portion count, and at least one valid ingredient are required." },
      { status: 400 }
    );
  }

  const portionCount = Number(body?.portions);
  if (!Number.isInteger(portionCount) || portionCount < 1) {
    return NextResponse.json(
      { error: "The portion count must be a whole number of at least 1." },
      { status: 400 }
    );
  }

  const menuItem = await prisma.menuItem.findFirst({
    where: { id: menuItemId, hotelId: tenant.hotelId },
    select: { id: true },
  });
  if (!menuItem) return NextResponse.json({ error: "Menu item not found." }, { status: 404 });

  if (!(await allInventoryItemsBelongToHotel(tenant.hotelId, ingredients))) {
    return NextResponse.json({ error: "One or more inventory items were not found in this hotel." }, { status: 404 });
  }

  try {
    const recipe = await prisma.recipe.create({
      data: {
        menuItemId: menuItem.id,
        hotelId: tenant.hotelId,
        portions: portionCount,
        ingredients: {
          create: ingredients.map((ingredient) => ({
            hotelId: tenant.hotelId,
            inventoryItemId: ingredient.inventoryItemId,
            quantity: ingredient.quantity,
          })),
        },
      },
      include: { ingredients: true },
    });
    return NextResponse.json(recipe, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "That menu item already has a recipe, or an ingredient is invalid." },
      { status: 400 }
    );
  }
}
