import { z } from 'zod';

export const reservationSchema = z.object({
  roomId: z.string().cuid(),
  guestId: z.string().cuid(),
  checkInDate: z.string().datetime(),
  checkOutDate: z.string().datetime(),
  adults: z.number().int().min(1).default(1),
  children: z.number().int().min(0).default(0),
  totalAmount: z.number().positive(),
  hotelId: z.string().cuid(),
});

export function validateReservationPayload(data: unknown) {
  return reservationSchema.safeParse(data);
}
