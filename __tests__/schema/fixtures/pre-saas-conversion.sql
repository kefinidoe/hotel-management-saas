-- Synthetic-only fixture for local migration rehearsal. Run after the original
-- single-hotel migrations and before 20261008123000_multi_tenant_saas_init.
-- No customer or production data belongs in this file.
INSERT INTO "User" ("id", "name", "email", "passwordHash", "role", "department", "updatedAt")
VALUES ('legacy-admin', 'Legacy Admin', 'legacy@example.test', 'hash', 'ADMIN', 'Legacy Operations', CURRENT_TIMESTAMP);

INSERT INTO "RoomType" ("id", "name", "baseRate", "capacity", "mealPlan", "updatedAt")
VALUES ('legacy-room-type', 'Legacy Half Board', 120.00, 2, 'HALF_BOARD', CURRENT_TIMESTAMP);
INSERT INTO "Room" ("id", "number", "roomTypeId", "status", "updatedAt")
VALUES ('legacy-room', '101', 'legacy-room-type', 'AVAILABLE', CURRENT_TIMESTAMP);
INSERT INTO "Guest" ("id", "fullName", "updatedAt")
VALUES ('legacy-guest', 'Legacy Guest', CURRENT_TIMESTAMP);
INSERT INTO "Reservation" ("id", "code", "guestId", "checkInDate", "checkOutDate", "createdById", "updatedAt")
VALUES ('legacy-reservation', 'LEGACY-001', 'legacy-guest', '2026-10-27', '2026-10-29', 'legacy-admin', CURRENT_TIMESTAMP);
INSERT INTO "ReservationRoom" ("id", "reservationId", "roomId", "rate")
VALUES ('legacy-reservation-room', 'legacy-reservation', 'legacy-room', 120.00);

INSERT INTO "Folio" ("id", "guestId", "reservationId", "updatedAt")
VALUES ('legacy-folio', 'legacy-guest', 'legacy-reservation', CURRENT_TIMESTAMP);
INSERT INTO "PaymentMethod" ("id", "name") VALUES ('legacy-cash', 'Cash');
INSERT INTO "Payment" ("id", "folioId", "paymentMethodId", "cashierId", "amount", "status")
VALUES ('legacy-payment', 'legacy-folio', 'legacy-cash', 'legacy-admin', 25.00, 'COMPLETED');

INSERT INTO "MenuCategory" ("id", "name") VALUES
  ('legacy-dessert-a', 'Desserts'), ('legacy-dessert-b', 'Desserts');
INSERT INTO "MenuItem" ("id", "categoryId", "name", "price")
VALUES ('legacy-dessert-item', 'legacy-dessert-b', 'Cake', 8.00);
INSERT INTO "InventoryItem" ("id", "sku", "name", "category", "unit", "updatedAt")
VALUES ('legacy-inventory', 'LEGACY-INV-1', 'Cake Mix', 'Dry Goods', 'g', CURRENT_TIMESTAMP);
INSERT INTO "Recipe" ("id", "menuItemId", "portions", "updatedAt")
VALUES ('legacy-recipe', 'legacy-dessert-item', 1, CURRENT_TIMESTAMP);
INSERT INTO "RecipeIngredient" ("id", "recipeId", "inventoryItemId", "quantity")
VALUES ('legacy-recipe-ingredient', 'legacy-recipe', 'legacy-inventory', 500.00);

INSERT INTO "Order" ("id", "paymentMethodId", "folioId", "total")
VALUES ('legacy-order', 'legacy-cash', 'legacy-folio', 8.00);
INSERT INTO "OrderItem" ("id", "orderId", "menuItemId", "name", "unitPrice", "quantity", "total")
VALUES ('legacy-order-item', 'legacy-order', 'legacy-dessert-item', 'Cake', 8.00, 1, 8.00);

INSERT INTO "Notification" ("id", "title", "body")
VALUES ('legacy-notification', 'Legacy title', 'Legacy notification body');
INSERT INTO "AuditLog" ("id", "userId", "action", "entityType", "entityId", "before", "after", "reason")
VALUES ('legacy-audit', 'legacy-admin', 'UPDATED', 'Reservation', 'legacy-reservation', '{"status":"PENDING"}', '{"status":"CONFIRMED"}', 'migration fixture');
