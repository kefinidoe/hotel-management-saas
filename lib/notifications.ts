import { prisma } from "@/lib/prisma";
import type { NotificationType } from "@prisma/client";

/**
 * Hotel-scoped in-app notifications.
 *
 * The `Notification` model has been in the schema since the first migration but
 * nothing ever wrote to it, so the bell in the topbar was decoration. These
 * helpers give it something real to show: stock that has fallen to its reorder
 * level, maintenance tickets raised by staff, and billing changes an operator
 * needs to know about.
 *
 * Two rules, both learned from `recordAudit`:
 *
 *  - a notification must never be the reason a legitimate operation fails, so
 *    every write here is best-effort and caught;
 *  - but it must not be silent either, so a failure is logged with its type.
 *
 * Notifications are addressed either to the whole hotel (userId null) or to one
 * user. The read API resolves the broadcast-plus-mine union; nothing here has to
 * know who is going to read it.
 */

export interface HotelNotification {
  hotelId: string;
  type: NotificationType;
  title: string;
  message: string;
  userId?: string | null;
}

export async function notify(notification: HotelNotification): Promise<boolean> {
  try {
    await prisma.notification.create({
      data: {
        hotelId: notification.hotelId,
        userId: notification.userId ?? null,
        type: notification.type,
        title: notification.title,
        message: notification.message,
      },
    });
    return true;
  } catch (error) {
    console.error(`Failed to write notification (${notification.type}):`, error);
    return false;
  }
}

/**
 * Raise (or keep) one unread stock alert per item that is at or below its
 * reorder level.
 *
 * Called after anything that changes stock - a purchase, a wastage record, a
 * manual adjustment or a restaurant sale - because a low-stock alert is only
 * useful if it appears while the operator can still order more. Existing unread
 * alerts for the same item are left alone so a busy service does not fill the
 * bell with duplicates; once someone marks it read, the next drop re-raises it.
 */
export async function syncLowStockAlerts(hotelId: string): Promise<number> {
  try {
    const low = await prisma.inventoryItem.findMany({
      where: {
        hotelId,
        isActive: true,
        reorderLevel: { gt: 0 },
      },
      select: { id: true, name: true, unit: true, currentStock: true, reorderLevel: true },
    });

    const below = low.filter(
      (item) => Number(item.currentStock) <= Number(item.reorderLevel)
    );
    if (below.length === 0) return 0;

    const existing = await prisma.notification.findMany({
      where: {
        hotelId,
        type: "STOCK_ALERT",
        isRead: false,
        title: { in: below.map((item) => `Low stock: ${item.name}`) },
      },
      select: { title: true },
    });
    const alreadyAlerted = new Set(existing.map((n) => n.title));

    const created = below
      .filter((item) => !alreadyAlerted.has(`Low stock: ${item.name}`))
      .map((item) => ({
        hotelId,
        type: "STOCK_ALERT" as const,
        title: `Low stock: ${item.name}`,
        message:
          Number(item.currentStock) <= 0
            ? `${item.name} is out of stock (reorder level ${Number(item.reorderLevel)} ${item.unit}).`
            : `${item.name} is down to ${Number(item.currentStock)} ${item.unit}, at or below the reorder level of ${Number(item.reorderLevel)} ${item.unit}.`,
      }));

    if (created.length === 0) return 0;
    await prisma.notification.createMany({ data: created });
    return created.length;
  } catch (error) {
    console.error("Failed to sync low-stock notifications:", error);
    return 0;
  }
}
