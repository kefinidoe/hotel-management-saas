import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tenant: { hotelId: "hotel-a", userId: "user-a", role: "HOTEL_ADMIN" },
  roleGroups: {
    MANAGEMENT: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER"],
    FRONT_DESK: ["HOTEL_OWNER", "HOTEL_ADMIN", "MANAGER", "RECEPTIONIST", "CASHIER"],
  },
  getTenantFromRoute: vi.fn(),
  requireRole: vi.fn(),
  requireModule: vi.fn(),
  expenseFindFirst: vi.fn(),
  expenseUpdateMany: vi.fn(),
  recipeFindMany: vi.fn(),
  recipeFindFirst: vi.fn(),
  recipeCreate: vi.fn(),
  recipeUpdateMany: vi.fn(),
  recipeDeleteMany: vi.fn(),
  recipeIngredientDeleteMany: vi.fn(),
  recipeIngredientCreateMany: vi.fn(),
  menuItemFindFirst: vi.fn(),
  menuItemUpdateMany: vi.fn(),
  inventoryItemFindMany: vi.fn(),
  inventoryItemFindFirst: vi.fn(),
  guestFindMany: vi.fn(),
  reservationFindMany: vi.fn(),
  roomFindMany: vi.fn(),
  stockMovementFindMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("next/server", () => {
  class MockNextResponse extends Response {
    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(JSON.stringify(body), {
        ...init,
        headers: { "content-type": "application/json", ...init?.headers },
      });
    }
  }
  return { NextResponse: MockNextResponse };
});
vi.mock("@/lib/authz", () => ({
  getTenantFromRoute: mocks.getTenantFromRoute,
  requireRole: mocks.requireRole,
  requireModule: mocks.requireModule,
  ROLE_GROUPS: mocks.roleGroups,
}));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    expense: { findFirst: mocks.expenseFindFirst, updateMany: mocks.expenseUpdateMany },
    recipe: {
      findMany: mocks.recipeFindMany,
      findFirst: mocks.recipeFindFirst,
      create: mocks.recipeCreate,
      updateMany: mocks.recipeUpdateMany,
      deleteMany: mocks.recipeDeleteMany,
    },
    recipeIngredient: {
      deleteMany: mocks.recipeIngredientDeleteMany,
      createMany: mocks.recipeIngredientCreateMany,
    },
    menuItem: { findFirst: mocks.menuItemFindFirst, updateMany: mocks.menuItemUpdateMany },
    inventoryItem: { findMany: mocks.inventoryItemFindMany, findFirst: mocks.inventoryItemFindFirst },
    guest: { findMany: mocks.guestFindMany },
    reservation: { findMany: mocks.reservationFindMany },
    room: { findMany: mocks.roomFindMany },
    stockMovement: { findMany: mocks.stockMovementFindMany },
    $transaction: mocks.transaction,
  },
}));
vi.mock("@/lib/inventory", () => ({
  computeAvailablePortions: () => ({ portions: 2, limitingItem: null }),
}));

import { NextResponse } from "next/server";
import { PATCH as reviewExpense } from "@/app/api/expenses/[id]/route";
import { GET as listRecipes, POST as createRecipe } from "@/app/api/recipes/route";
import { DELETE as deleteRecipe, PATCH as updateRecipe } from "@/app/api/recipes/[id]/route";
import { GET as search } from "@/app/api/search/route";
import { GET as listStockMovements } from "@/app/api/stock-movements/route";
import { PUT as updateMenuItem } from "@/app/api/menu/items/[id]/route";

const jsonRequest = (url: string, method: string, body?: unknown) =>
  new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const routeParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function responseJson(response: Response) {
  return response.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tenant = { hotelId: "hotel-a", userId: "user-a", role: "HOTEL_ADMIN" };
  mocks.getTenantFromRoute.mockImplementation(async () => mocks.tenant);
  mocks.requireRole.mockImplementation((role: string, allowed: string[]) =>
    allowed.includes(role) ? null : new Response("Forbidden", { status: 403 })
  );
  mocks.requireModule.mockResolvedValue(null);
  mocks.expenseFindFirst.mockResolvedValue(null);
  mocks.expenseUpdateMany.mockResolvedValue({ count: 0 });
  mocks.recipeFindMany.mockResolvedValue([]);
  mocks.recipeFindFirst.mockResolvedValue(null);
  mocks.recipeCreate.mockResolvedValue({ id: "recipe-a", portions: 3, ingredients: [] });
  mocks.recipeUpdateMany.mockResolvedValue({ count: 0 });
  mocks.recipeDeleteMany.mockResolvedValue({ count: 0 });
  mocks.recipeIngredientDeleteMany.mockResolvedValue({ count: 0 });
  mocks.recipeIngredientCreateMany.mockResolvedValue({ count: 0 });
  mocks.menuItemFindFirst.mockResolvedValue(null);
  mocks.menuItemUpdateMany.mockResolvedValue({ count: 0 });
  mocks.inventoryItemFindMany.mockResolvedValue([]);
  mocks.inventoryItemFindFirst.mockResolvedValue(null);
  mocks.guestFindMany.mockResolvedValue([]);
  mocks.reservationFindMany.mockResolvedValue([]);
  mocks.roomFindMany.mockResolvedValue([]);
  mocks.stockMovementFindMany.mockResolvedValue([]);
  mocks.transaction.mockImplementation(async (callback: (tx: any) => unknown) =>
    callback({
      recipe: { updateMany: mocks.recipeUpdateMany, findFirst: mocks.recipeFindFirst },
      recipeIngredient: {
        deleteMany: mocks.recipeIngredientDeleteMany,
        createMany: mocks.recipeIngredientCreateMany,
      },
    })
  );
});

const affectedRouteCalls: Array<{ name: string; invoke: () => Promise<Response> }> = [
  { name: "expense approval", invoke: () => reviewExpense(jsonRequest("https://hotel.test/api/expenses/e1", "PATCH", { status: "APPROVED" }), routeParams("e1")) },
  { name: "recipe listing", invoke: () => listRecipes() },
  { name: "recipe creation", invoke: () => createRecipe(jsonRequest("https://hotel.test/api/recipes", "POST", {})) },
  { name: "recipe update", invoke: () => updateRecipe(jsonRequest("https://hotel.test/api/recipes/r1", "PATCH", { portions: 2 }), routeParams("r1")) },
  { name: "recipe deletion", invoke: () => deleteRecipe(new Request("https://hotel.test/api/recipes/r1", { method: "DELETE" }), routeParams("r1")) },
  { name: "search", invoke: () => search(new Request("https://hotel.test/api/search?q=guest")) },
  { name: "stock movements", invoke: () => listStockMovements(new Request("https://hotel.test/api/stock-movements")) },
  { name: "menu item update", invoke: () => updateMenuItem(jsonRequest("https://hotel.test/api/menu/items/item-a", "PUT", { name: "Updated" }), routeParams("item-a")) },
];

describe("legacy API routes now use the active tenant context", () => {
  it.each(affectedRouteCalls)("returns 401 before querying for unauthenticated $name requests", async ({ invoke }) => {
    mocks.getTenantFromRoute.mockResolvedValueOnce(
      NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 })
    );

    const response = await invoke();

    expect(response.status).toBe(401);
    expect(mocks.requireRole).not.toHaveBeenCalled();
    for (const query of [
      mocks.expenseFindFirst, mocks.expenseUpdateMany, mocks.recipeFindMany, mocks.recipeFindFirst,
      mocks.recipeCreate, mocks.recipeUpdateMany, mocks.recipeDeleteMany, mocks.menuItemFindFirst, mocks.menuItemUpdateMany,
      mocks.inventoryItemFindMany, mocks.inventoryItemFindFirst, mocks.guestFindMany,
      mocks.reservationFindMany, mocks.roomFindMany, mocks.stockMovementFindMany,
    ]) expect(query).not.toHaveBeenCalled();
  });

  it.each(affectedRouteCalls)("returns 403 before querying for unauthorized $name requests", async ({ invoke }) => {
    mocks.tenant = { hotelId: "hotel-a", userId: "user-a", role: "HOUSEKEEPER" };

    const response = await invoke();

    expect(response.status).toBe(403);
    for (const query of [
      mocks.expenseFindFirst, mocks.expenseUpdateMany, mocks.recipeFindMany, mocks.recipeFindFirst,
      mocks.recipeCreate, mocks.recipeUpdateMany, mocks.recipeDeleteMany, mocks.menuItemFindFirst, mocks.menuItemUpdateMany,
      mocks.inventoryItemFindMany, mocks.inventoryItemFindFirst, mocks.guestFindMany,
      mocks.reservationFindMany, mocks.roomFindMany, mocks.stockMovementFindMany,
    ]) expect(query).not.toHaveBeenCalled();
  });

  it("blocks an operational handler with 503 when subscription entitlement cannot be verified", async () => {
    mocks.requireModule.mockResolvedValueOnce(
      NextResponse.json({ error: "SUBSCRIPTION_STATUS_UNAVAILABLE" }, { status: 503 })
    );

    const response = await reviewExpense(
      jsonRequest("https://hotel.test/api/expenses/expense-a", "PATCH", { status: "APPROVED" }),
      routeParams("expense-a")
    );

    expect(response.status).toBe(503);
    expect(mocks.requireModule).toHaveBeenCalledWith("hotel-a", "EXPENSES");
    expect(mocks.expenseUpdateMany).not.toHaveBeenCalled();
  });

  it("blocks menu mutation when Restaurant POS entitlement cannot be verified", async () => {
    mocks.requireModule.mockResolvedValueOnce(
      NextResponse.json({ error: "SUBSCRIPTION_STATUS_UNAVAILABLE" }, { status: 503 })
    );

    const response = await updateMenuItem(
      jsonRequest("https://hotel.test/api/menu/items/item-a", "PUT", { name: "Updated" }),
      routeParams("item-a")
    );

    expect(response.status).toBe(503);
    expect(mocks.requireModule).toHaveBeenCalledWith("hotel-a", "RESTAURANT_POS");
    expect(mocks.menuItemUpdateMany).not.toHaveBeenCalled();
  });

  it("updates menu items only within the active hotel", async () => {
    mocks.menuItemUpdateMany.mockResolvedValueOnce({ count: 1 });

    const response = await updateMenuItem(
      jsonRequest("https://hotel.test/api/menu/items/item-a", "PUT", { name: "Updated" }),
      routeParams("item-a")
    );

    expect(response.status).toBe(200);
    expect(mocks.menuItemUpdateMany).toHaveBeenCalledWith({
      where: { id: "item-a", hotelId: "hotel-a" },
      data: { name: "Updated", price: undefined },
    });
  });

  it("approves an expense in the active hotel and scopes the update and response lookup", async () => {
    mocks.expenseUpdateMany.mockResolvedValueOnce({ count: 1 });
    mocks.expenseFindFirst.mockResolvedValueOnce({ id: "expense-a", hotelId: "hotel-a", status: "APPROVED" });

    const response = await reviewExpense(
      jsonRequest("https://hotel.test/api/expenses/expense-a", "PATCH", { status: "APPROVED" }),
      routeParams("expense-a")
    );

    expect(response.status).toBe(200);
    expect(mocks.expenseUpdateMany).toHaveBeenCalledWith({
      where: { id: "expense-a", hotelId: "hotel-a", status: "PENDING_APPROVAL" },
      data: { status: "APPROVED" },
    });
    expect(mocks.expenseFindFirst).toHaveBeenCalledWith({ where: { id: "expense-a", hotelId: "hotel-a" } });
  });

  it("returns 404 and does not update an expense owned by Hotel B", async () => {
    mocks.expenseUpdateMany.mockResolvedValueOnce({ count: 0 });
    mocks.expenseFindFirst.mockResolvedValueOnce(null);

    const response = await reviewExpense(
      jsonRequest("https://hotel.test/api/expenses/expense-b", "PATCH", { status: "REJECTED" }),
      routeParams("expense-b")
    );

    expect(response.status).toBe(404);
    expect(await responseJson(response)).toEqual({ error: "Expense not found." });
    expect(mocks.expenseUpdateMany.mock.calls[0][0].where).toEqual({
      id: "expense-b", hotelId: "hotel-a", status: "PENDING_APPROVAL",
    });
  });

  it("lists only same-hotel recipes and excludes recipes with foreign inventory links", async () => {
    const recipeA = {
      id: "recipe-a", hotelId: "hotel-a", menuItemId: "menu-a", portions: 2,
      createdAt: new Date(), menuItem: { name: "A dish", price: 20, category: { name: "A menu" } },
      ingredients: [{ inventoryItemId: "item-a", quantity: 1, inventoryItem: { hotelId: "hotel-a", name: "A stock", unit: "pcs", currentStock: 5, costPerUnit: 2 } }],
    };
    const recipeB = {
      ...recipeA, id: "recipe-b", hotelId: "hotel-b", menuItemId: "menu-b",
      menuItem: { name: "B secret dish", price: 99, category: { name: "B menu" } },
      ingredients: [{ inventoryItemId: "item-b", quantity: 1, inventoryItem: { hotelId: "hotel-b", name: "B secret stock", unit: "pcs", currentStock: 9, costPerUnit: 9 } }],
    };
    const malformedA = { ...recipeA, id: "recipe-malformed", ingredients: [
      ...recipeA.ingredients,
      { inventoryItemId: "item-b", quantity: 2, inventoryItem: { hotelId: "hotel-b", name: "B secret stock", unit: "pcs", currentStock: 9, costPerUnit: 9 } },
    ] };
    mocks.recipeFindMany.mockImplementation(async (args) => {
      const tenantId = args.where.menuItem.is.hotelId;
      const ingredientTenantId = args.where.ingredients.every.inventoryItem.is.hotelId;
      return [recipeA, recipeB, malformedA].filter((recipe) =>
        recipe.hotelId === tenantId && recipe.ingredients.every((item: any) => item.inventoryItem.hotelId === ingredientTenantId)
      );
    });

    const response = await listRecipes();
    const result = await responseJson(response);

    expect(response.status).toBe(200);
    expect(mocks.recipeFindMany.mock.calls[0][0].where.menuItem.is.hotelId).toBe("hotel-a");
    expect(mocks.recipeFindMany.mock.calls[0][0].where.ingredients.every.inventoryItem.is.hotelId).toBe("hotel-a");
    expect(result.map((recipe: any) => recipe.id)).toEqual(["recipe-a"]);
    expect(JSON.stringify(result)).not.toContain("B secret");
  });

  it("creates recipes only from a same-hotel menu item and inventory items", async () => {
    mocks.menuItemFindFirst.mockImplementation(async (args) =>
      args.where.hotelId === "hotel-a" && args.where.id === "menu-a" ? { id: "menu-a" } : null
    );
    mocks.inventoryItemFindMany.mockImplementation(async (args) =>
      args.where.hotelId === "hotel-a" ? args.where.id.in.filter((id: string) => id === "item-a").map((id: string) => ({ id })) : []
    );
    const body = { menuItemId: "menu-a", portions: 2, ingredients: [{ inventoryItemId: "item-a", quantity: 1 }] };

    const response = await createRecipe(jsonRequest("https://hotel.test/api/recipes", "POST", body));

    expect(response.status).toBe(201);
    expect(mocks.menuItemFindFirst).toHaveBeenCalledWith({
      where: { id: "menu-a", hotelId: "hotel-a" }, select: { id: true },
    });
    expect(mocks.inventoryItemFindMany.mock.calls[0][0].where).toEqual({
      hotelId: "hotel-a", id: { in: ["item-a"] },
    });
    expect(mocks.recipeCreate).toHaveBeenCalledOnce();
    expect(mocks.recipeCreate.mock.calls[0][0].data).toMatchObject({
      hotelId: "hotel-a",
      ingredients: { create: [{ hotelId: "hotel-a", inventoryItemId: "item-a", quantity: 1 }] },
    });
  });

  it("rejects a Hotel B menu item or inventory ingredient when creating a recipe", async () => {
    mocks.menuItemFindFirst.mockResolvedValueOnce(null);
    const foreignMenuResponse = await createRecipe(jsonRequest("https://hotel.test/api/recipes", "POST", {
      menuItemId: "menu-b", portions: 1, ingredients: [{ inventoryItemId: "item-a", quantity: 1 }],
    }));
    expect(foreignMenuResponse.status).toBe(404);
    expect(mocks.recipeCreate).not.toHaveBeenCalled();

    mocks.menuItemFindFirst.mockResolvedValueOnce({ id: "menu-a" });
    mocks.inventoryItemFindMany.mockResolvedValueOnce([]);
    const foreignInventoryResponse = await createRecipe(jsonRequest("https://hotel.test/api/recipes", "POST", {
      menuItemId: "menu-a", portions: 1, ingredients: [{ inventoryItemId: "item-b", quantity: 1 }],
    }));
    expect(foreignInventoryResponse.status).toBe(404);
    expect(mocks.recipeCreate).not.toHaveBeenCalled();
  });

  it("returns 404 for a foreign recipe and does not patch or delete it", async () => {
    mocks.recipeFindFirst.mockResolvedValueOnce(null);
    const patchResponse = await updateRecipe(
      jsonRequest("https://hotel.test/api/recipes/recipe-b", "PATCH", { portions: 4 }),
      routeParams("recipe-b")
    );
    expect(patchResponse.status).toBe(404);
    expect(mocks.recipeFindFirst.mock.calls[0][0].where).toMatchObject({
      id: "recipe-b", menuItem: { is: { hotelId: "hotel-a" } },
    });
    expect(mocks.transaction).not.toHaveBeenCalled();

    mocks.recipeDeleteMany.mockResolvedValueOnce({ count: 0 });
    const deleteResponse = await deleteRecipe(new Request("https://hotel.test/api/recipes/recipe-b", { method: "DELETE" }), routeParams("recipe-b"));
    expect(deleteResponse.status).toBe(404);
    expect(mocks.recipeDeleteMany.mock.calls[0][0].where).toEqual({
      id: "recipe-b", menuItem: { is: { hotelId: "hotel-a" } },
    });
  });

  it("rejects foreign inventory links when editing and allows a scoped same-hotel edit", async () => {
    mocks.recipeFindFirst.mockResolvedValue({ id: "recipe-a" });
    mocks.inventoryItemFindMany.mockResolvedValueOnce([]);
    const foreignIngredientResponse = await updateRecipe(
      jsonRequest("https://hotel.test/api/recipes/recipe-a", "PATCH", {
        ingredients: [{ inventoryItemId: "item-b", quantity: 1 }],
      }),
      routeParams("recipe-a")
    );
    expect(foreignIngredientResponse.status).toBe(404);
    expect(mocks.transaction).not.toHaveBeenCalled();

    mocks.inventoryItemFindMany.mockResolvedValueOnce([{ id: "item-a" }]);
    mocks.recipeUpdateMany.mockResolvedValueOnce({ count: 1 });
    mocks.recipeFindFirst.mockResolvedValueOnce({ id: "recipe-a", portions: 3, ingredients: [] });
    const sameHotelResponse = await updateRecipe(
      jsonRequest("https://hotel.test/api/recipes/recipe-a", "PATCH", {
        portions: 3, ingredients: [{ inventoryItemId: "item-a", quantity: 2 }],
      }),
      routeParams("recipe-a")
    );
    expect(sameHotelResponse.status).toBe(200);
    expect(mocks.recipeUpdateMany.mock.calls[0][0].where).toEqual({
      id: "recipe-a", menuItem: { is: { hotelId: "hotel-a" } },
    });
    expect(mocks.recipeIngredientDeleteMany.mock.calls[0][0].where.recipe.is.menuItem.is.hotelId).toBe("hotel-a");
    expect(mocks.recipeIngredientCreateMany).toHaveBeenCalledOnce();
    expect(mocks.recipeIngredientCreateMany.mock.calls[0][0].data).toEqual([
      { recipeId: "recipe-a", hotelId: "hotel-a", inventoryItemId: "item-a", quantity: 2 },
    ]);
  });

  it("returns only Hotel A search results and scopes all three resource queries", async () => {
    const guestRows = [
      { id: "guest-a", hotelId: "hotel-a", fullName: "A guest", phone: null, email: null },
      { id: "guest-b", hotelId: "hotel-b", fullName: "B secret guest", phone: null, email: null },
    ];
    const reservationRows = [
      { id: "stay-a", hotelId: "hotel-a", code: "A-100", status: "CONFIRMED", checkInDate: new Date(), guest: { fullName: "A guest" } },
      { id: "stay-b", hotelId: "hotel-b", code: "B-100", status: "CONFIRMED", checkInDate: new Date(), guest: { fullName: "B secret guest" } },
    ];
    const roomRows = [
      { id: "room-a", hotelId: "hotel-a", number: "A-1", status: "AVAILABLE" },
      { id: "room-b", hotelId: "hotel-b", number: "B-1", status: "AVAILABLE" },
    ];
    mocks.guestFindMany.mockImplementation(async (args) => guestRows.filter((row) => row.hotelId === args.where.hotelId));
    mocks.reservationFindMany.mockImplementation(async (args) => reservationRows.filter((row) => row.hotelId === args.where.hotelId));
    mocks.roomFindMany.mockImplementation(async (args) => roomRows.filter((row) => row.hotelId === args.where.hotelId));

    const response = await search(new Request("https://hotel.test/api/search?q=guest"));
    const result = await responseJson(response);

    expect(response.status).toBe(200);
    expect(result.guests.map((row: any) => row.id)).toEqual(["guest-a"]);
    expect(result.reservations.map((row: any) => row.id)).toEqual(["stay-a"]);
    expect(result.rooms.map((row: any) => row.id)).toEqual(["room-a"]);
    for (const query of [mocks.guestFindMany, mocks.reservationFindMany, mocks.roomFindMany]) {
      expect(query.mock.calls[0][0].where.hotelId).toBe("hotel-a");
    }
    expect(JSON.stringify(result)).not.toContain("B secret");
  });

  it("scopes movement results and masks staff without an active Hotel A membership", async () => {
    const rows = [
      { id: "movement-a", hotelId: "hotel-a", inventoryItemId: "item-a", quantity: 1, beforeQty: 1, afterQty: 2, reference: null, createdAt: new Date(), inventoryItem: { hotelId: "hotel-a", name: "A stock", unit: "pcs" }, user: { name: "B secret staff", memberships: [{ id: "membership-b" }] } },
      { id: "movement-b", hotelId: "hotel-b", inventoryItemId: "item-b", quantity: 1, beforeQty: 1, afterQty: 2, reference: null, createdAt: new Date(), inventoryItem: { hotelId: "hotel-b", name: "B secret stock", unit: "pcs" }, user: { name: "B secret staff", memberships: [{ id: "membership-b" }] } },
    ];
    mocks.stockMovementFindMany.mockImplementation(async (args) => rows
      .filter((row) => row.hotelId === args.where.hotelId)
      .map((row) => ({
        ...row,
        user: row.user && {
          ...row.user,
          memberships: row.user.memberships.filter((membership: any) =>
            membership.id === "membership-a" && args.include.user.select.memberships.where.hotelId === "hotel-a"
          ),
        },
      }))
    );

    const response = await listStockMovements(new Request("https://hotel.test/api/stock-movements"));
    const result = await responseJson(response);

    expect(response.status).toBe(200);
    expect(result.map((movement: any) => movement.id)).toEqual(["movement-a"]);
    expect(result[0].userName).toBe("Former staff");
    expect(JSON.stringify(result)).not.toContain("B secret");
    expect(mocks.stockMovementFindMany.mock.calls[0][0].where.hotelId).toBe("hotel-a");
    expect(mocks.stockMovementFindMany.mock.calls[0][0].include.user.select.memberships.where).toEqual({
      hotelId: "hotel-a", status: "ACTIVE",
    });
  });

  it("returns 404 for a foreign inventory filter without listing movements", async () => {
    mocks.inventoryItemFindFirst.mockResolvedValueOnce(null);

    const response = await listStockMovements(
      new Request("https://hotel.test/api/stock-movements?itemId=item-b")
    );

    expect(response.status).toBe(404);
    expect(await responseJson(response)).toEqual({ error: "Inventory item not found." });
    expect(mocks.inventoryItemFindFirst).toHaveBeenCalledWith({
      where: { id: "item-b", hotelId: "hotel-a" }, select: { id: true },
    });
    expect(mocks.stockMovementFindMany).not.toHaveBeenCalled();
  });
});
