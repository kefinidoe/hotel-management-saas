import { prisma } from "@/lib/prisma";

export type ActiveHotelStaff = {
  id: string;
  userId: string;
  department: string | null;
  user: { id: string; name: string };
};

/**
 * Resolve a user only through their active membership in the selected hotel.
 * Global User existence is not sufficient authorization for hotel assignments.
 */
export async function findActiveHotelStaff(
  hotelId: string,
  userId: string,
  client: any = prisma
): Promise<ActiveHotelStaff | null> {
  return client.hotelMembership.findFirst({
    where: {
      hotelId,
      userId,
      status: "ACTIVE",
      user: { isActive: true },
    },
    select: {
      id: true,
      userId: true,
      department: true,
      user: { select: { id: true, name: true } },
    },
  }) as Promise<ActiveHotelStaff | null>;
}
