import { requirePageRole } from "@/lib/page-auth";
import { ROLE_GROUPS } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import HotelSettingsClient from "@/components/settings/HotelSettingsClient";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const context = await requirePageRole(ROLE_GROUPS.STAFF_ADMIN, "RESERVATIONS");

  const hotel = await prisma.hotel.findUnique({
    where: { id: context.hotelId },
    select: {
      id: true,
      name: true,
      slug: true,
      email: true,
      phone: true,
      address: true,
      currency: true,
      timezone: true,
      status: true,
      updatedAt: true,
    },
  });

  if (!hotel) {
    redirect("/dashboard");
  }

  return (
    <HotelSettingsClient
      initialHotel={{
        ...hotel,
        updatedAt: hotel.updatedAt.toISOString(),
      }}
      userRole={context.role}
    />
  );
}
