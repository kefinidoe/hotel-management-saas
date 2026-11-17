import { z } from "zod";

export const reservationExtensionSchema = z.object({
  checkOutDate: z.string().min(1).refine((value) => Number.isFinite(new Date(value).getTime()), "Choose a valid new check-out date."),
  note: z.string().nullable().optional(),
}).strict();
