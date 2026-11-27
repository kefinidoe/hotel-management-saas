// Shared inventory logic used by both API routes and dashboard pages.
// Every InventoryItem is tracked internally in ONE base unit (g, ml, or pcs)
// so the recipe engine never has to guess at a conversion. These helpers
// only handle turning that base-unit number into something readable.


import Decimal from "decimal.js";

export type BaseUnit = "g" | "ml" | "pcs";

export type QuantityValue = number | string | { toString(): string };

function toDecimal(value: QuantityValue): Decimal {
  if (value instanceof Decimal) return value;
  const raw = typeof value === "number" ? value : String(value).trim();
  return new Decimal(raw);
}

/** Human-friendly display of a base-unit quantity, e.g. 2000 "g" -> "2.00 kg". */
export function formatQty(quantity: QuantityValue, unit: string): string {
  const n = toDecimal(quantity);
  if (unit === "g") {
    return n.gte(1000) ? `${n.div(1000).toFixed(2)} kg` : `${n.toFixed(0)} g`;
  }
  if (unit === "ml") {
    return n.gte(1000) ? `${n.div(1000).toFixed(2)} L` : `${n.toFixed(0)} ml`;
  }
  return `${n.isInteger() ? n.toFixed(0) : n.toFixed(2)} pcs`;
}

export type StockStatus = "OUT_OF_STOCK" | "CRITICAL" | "LOW_STOCK" | "IN_STOCK";

/** Critical = below half the reorder level; Low = at/below reorder level. */
export function getStockStatus(currentStock: QuantityValue, reorderLevel: QuantityValue): StockStatus {
  const stock = toDecimal(currentStock);
  const reorder = toDecimal(reorderLevel);
  if (stock.lte(0)) return "OUT_OF_STOCK";
  if (reorder.gt(0) && stock.lte(reorder.div(2))) return "CRITICAL";
  if (reorder.gt(0) && stock.lte(reorder)) return "LOW_STOCK";
  return "IN_STOCK";
}

export const STOCK_STATUS_LABEL: Record<StockStatus, string> = {
  OUT_OF_STOCK: "Out of Stock",
  CRITICAL: "Critical",
  LOW_STOCK: "Low Stock",
  IN_STOCK: "In Stock",
};

export const STOCK_STATUS_BADGE_CLASS: Record<StockStatus, string> = {
  OUT_OF_STOCK: "badge bg-text-primary/10 text-text-secondary",
  CRITICAL: "badge bg-danger/10 text-danger",
  LOW_STOCK: "badge bg-warning/10 text-warning",
  IN_STOCK: "badge bg-success/10 text-success",
};

export type IngredientLine = {
  inventoryItemId: string;
  name: string;
  unit: string;
  quantityPerBatch: number; // quantity required for `portions` portions
  currentStock: number;
};

/**
 * Recipe Availability Engine: given a recipe's ingredient list and the
 * portions that quantity list makes, work out how many whole portions can
 * currently be prepared, and which ingredient is the bottleneck.
 */
export function computeAvailablePortions(
  ingredients: ReadonlyArray<{
    inventoryItemId: string;
    name: string;
    unit: string;
    quantityPerBatch: QuantityValue;
    currentStock: QuantityValue;
  }>,
  portionsPerBatch: QuantityValue
): { portions: number; limitingItem: string | null } {
  if (ingredients.length === 0) return { portions: 0, limitingItem: null };

  let batchPortions: Decimal;
  try {
    batchPortions = toDecimal(portionsPerBatch);
  } catch {
    return { portions: 0, limitingItem: null };
  }
  if (!batchPortions.isFinite() || batchPortions.lte(0)) {
    return { portions: 0, limitingItem: null };
  }

  let minPortions = Infinity;
  let limitingItem: string | null = null;

  for (const ing of ingredients) {
    let qtyPerBatch: Decimal;
    let stock: Decimal;
    try {
      qtyPerBatch = toDecimal(ing.quantityPerBatch);
      stock = toDecimal(ing.currentStock);
    } catch {
      continue;
    }
    if (!qtyPerBatch.isFinite() || qtyPerBatch.lte(0) || !stock.isFinite()) continue;

    const possible = stock.mul(batchPortions).div(qtyPerBatch).floor().toNumber();
    if (possible < minPortions) {
      minPortions = possible;
      limitingItem = ing.name;
    }
  }

  if (!isFinite(minPortions)) return { portions: 0, limitingItem: null };
  return { portions: Math.max(0, minPortions), limitingItem };
}
