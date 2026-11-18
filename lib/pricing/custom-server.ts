import type { Prisma } from "@prisma/client";
import { priceCustomStay } from "@/lib/pricing/custom-rate-rules";

/** Reads every configurable price from the authenticated hotel within the caller's transaction. */
export async function priceCustomReservation(tx: Prisma.TransactionClient, input: {
  hotelId: string; currency: string; roomTypeId: string; mealId: string; occupancyId: string;
  adults: number; children: number; checkIn: Date; checkOut: Date; discount: number;
}) {
  const [roomType, meal, occupancy] = await Promise.all([
    tx.roomType.findUnique({ where: { id_hotelId: { id: input.roomTypeId, hotelId: input.hotelId } }, select: { id: true, name: true, baseRate: true, maxAdults: true, maxChildren: true } }),
    tx.mealPlanRate.findFirst({ where: { id: input.mealId, hotelId: input.hotelId, isActive: true } }),
    tx.occupancyRateRule.findFirst({ where: { id: input.occupancyId, hotelId: input.hotelId, isActive: true } }),
  ]);
  if (!roomType || !meal || !occupancy) throw new CustomPricingError("The selected room, meal plan or occupancy rule is unavailable in this hotel.");
  try {
    return priceCustomStay({ currency: input.currency, roomType: { ...roomType, baseRate: String(roomType.baseRate) }, meal, occupancy, adults: input.adults, children: input.children, checkIn: input.checkIn, checkOut: input.checkOut, discount: input.discount });
  } catch (error) {
    throw new CustomPricingError(error instanceof Error ? error.message : "Could not price the reservation.");
  }
}
export class CustomPricingError extends Error {}
