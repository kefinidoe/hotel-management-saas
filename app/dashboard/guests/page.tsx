import { prisma } from "@/lib/prisma";
import GuestsClient from "@/components/guests/GuestsClient";
import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";

export const dynamic = 'force-dynamic';

export default async function GuestsPage() {
  const tenant = await requirePageRole(ROLE_GROUPS.GUEST_STAYS);

  const guests = await prisma.guest.findMany({
    where: { hotelId: tenant.hotelId, isArchived: false },
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      reservations: {
        where: { hotelId: tenant.hotelId },
        orderBy: { checkInDate: "desc" },
        take: 1,
        include: {
          rooms: {
            where: { room: { is: { hotelId: tenant.hotelId } } },
            include: { room: true },
          },
        },
      },
    },
  });

  const initialGuests = guests.map((g) => ({
    id: g.id,
    fullName: g.fullName,
    phone: g.phone,
    email: g.email,
    isArchived: g.isArchived,
    currentRoom: g.reservations[0]?.rooms[0]?.room.number ?? null,
    lastStatus: g.reservations[0]?.status ?? null,
    checkInDate: g.reservations[0]?.checkInDate.toISOString() ?? null,
    checkOutDate: g.reservations[0]?.checkOutDate.toISOString() ?? null,
  }));

  return <GuestsClient initialGuests={initialGuests} />;
}