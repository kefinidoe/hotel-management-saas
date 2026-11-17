import type { Prisma } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import type { CartLine } from "@/lib/restaurant";

type TxClient = Prisma.TransactionClient;

/**
 * Deducts recipe ingredients for every cart line whose menu item has a
 * recipe attached. Items with no recipe are skipped -- treated as always
 * available (e.g. a bottled drink you haven't linked to inventory yet).
 *
 * Must be called INSIDE the same transaction as the folio/payment writes:
 * if stock is insufficient, this throws and the whole order rolls back
 * together -- never a paid order with no stock deducted, or a deduction
 * with no matching sale.
 */
export async function deductRecipeStock(
  tx: TxClient,
  lines: CartLine[],
  reference: string,
  userId: string,
  hotelId: string
): Promise<void> {
  if (!hotelId || typeof hotelId !== "string" || !hotelId.trim()) {
    throw new Error("Active hotel tenant is required to deduct recipe stock.");
  }
  const cleanHotelId = hotelId.trim();

  const needed = new Map<string, Decimal>(); // inventoryItemId -> base-unit quantity needed

  const menuItemIds = [...new Set(lines.map((l) => l.menuItemId).filter((id): id is string => !!id))];
  const recipes =
    menuItemIds.length > 0
      ? await tx.recipe.findMany({
          where: {
            menuItemId: { in: menuItemIds },
            menuItem: { hotelId: cleanHotelId },
          },
          include: {
            menuItem: { select: { id: true, hotelId: true } },
            ingredients: {
              include: {
                inventoryItem: { select: { id: true, hotelId: true, name: true } },
              },
            },
          },
        })
      : [];
  const recipeByMenuItemId = new Map(recipes.map((r) => [r.menuItemId, r]));

  for (const line of lines) {
    if (!line.menuItemId) continue;
    const recipe = recipeByMenuItemId.get(line.menuItemId);
    if (!recipe) continue; // no recipe defined for this item -- nothing to deduct

    if (recipe.menuItem?.hotelId && recipe.menuItem.hotelId !== cleanHotelId) {
      throw new Error("Cannot deduct recipe stock for a menu item from another hotel.");
    }

    for (const ing of recipe.ingredients) {
      if (ing.inventoryItem?.hotelId && ing.inventoryItem.hotelId !== cleanHotelId) {
        throw new Error(
          `Recipe for "${line.name}" references an inventory item from another hotel.`
        );
      }
      if (!Number.isInteger(recipe.portions) || recipe.portions <= 0 || !Number.isInteger(line.quantity) || line.quantity <= 0 || new Decimal(ing.quantity).lte(0)) {
        throw new Error("Invalid recipe quantity or portions.");
      }
      const total = new Decimal(ing.quantity).mul(line.quantity).div(recipe.portions);
      needed.set(ing.inventoryItemId, (needed.get(ing.inventoryItemId) ?? new Decimal(0)).add(total));
    }
  }

  if (needed.size === 0) return;

  const items = await tx.inventoryItem.findMany({
    where: {
      id: { in: [...needed.keys()] },
      hotelId: cleanHotelId,
    },
  });
  const itemById = new Map(items.map((i) => [i.id, i]));

  // Check everything first, before writing anything.
  for (const [itemId, qty] of needed) {
    if (!qty.mul(100).isInteger()) throw new Error("Recipe consumption exceeds inventory precision; adjust the recipe or quantity.");
    const item = itemById.get(itemId);
    if (!item) {
      throw new Error("An ingredient used by this order is unavailable or belongs to another hotel.");
    }
    if (item.hotelId !== cleanHotelId) {
      throw new Error("Cross-tenant inventory deduction rejected.");
    }
    if (new Decimal(item.currentStock).lt(qty)) {
      throw new Error(
        `Not enough "${item.name}" in stock to complete this order (need ${qty.toFixed(1)} ${item.unit}, have ${Number(item.currentStock).toFixed(1)} ${item.unit}).`
      );
    }
  }

  // Deterministic lock order reduces deadlocks when orders share ingredients.
  for (const [itemId, qty] of [...needed.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const item = itemById.get(itemId)!;
    const updated = await tx.inventoryItem.updateMany({
      where: { id: itemId, hotelId: cleanHotelId, currentStock: { gte: qty } },
      data: { currentStock: { decrement: qty }, stockVersion: { increment: 1 } },
    });
    if (updated.count !== 1) throw new Error(`Not enough "${item.name}" in stock to complete this order.`);
    const locked = await tx.inventoryItem.findUniqueOrThrow({
      where: { id_hotelId: { id: itemId, hotelId: cleanHotelId } },
    });
    const after = locked.currentStock;
    await tx.stockMovement.create({
      data: {
        hotelId: cleanHotelId, inventoryItemId: itemId, type: "MEAL_SALE",
        quantity: qty.negated(), beforeQty: after.add(qty), afterQty: after,
        reference, userId,
      },
    });
  }
}
