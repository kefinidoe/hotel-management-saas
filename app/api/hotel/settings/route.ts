import { NextResponse } from "next/server";
import { getTenantFromRoute, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { normaliseBillingCurrency, priceForSubscription, BillingInterval } from "@/lib/plans";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUPPORTED_CURRENCIES = ["KES", "USD", "EUR", "GBP", "TZS", "UGX", "RWF", "ZAR", "AED"];

export const dynamic = "force-dynamic";

export async function GET() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.STAFF_ADMIN);
  if (forbidden) return forbidden;

  try {
    const hotel = await prisma.hotel.findUnique({
      where: { id: tenant.hotelId },
      select: {
        id: true,
        name: true,
        slug: true,
        logo: true,
        email: true,
        phone: true,
        address: true,
        currency: true,
        timezone: true,
        status: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!hotel) {
      return NextResponse.json({ error: "Hotel not found" }, { status: 404 });
    }

    return NextResponse.json({ hotel });
  } catch (error) {
    console.error("Failed to fetch hotel settings:", error);
    return NextResponse.json(
      { error: "Could not load hotel settings" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;

  const forbidden = requireRole(tenant.role, ROLE_GROUPS.STAFF_ADMIN);
  if (forbidden) return forbidden;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const updateData: {
    name?: string;
    email?: string | null;
    phone?: string | null;
    address?: string | null;
    currency?: string;
    timezone?: string;
  } = {};

  if (body.name !== undefined) {
    const cleanName = typeof body.name === "string" ? body.name.trim() : "";
    if (cleanName.length < 2 || cleanName.length > 100) {
      return NextResponse.json(
        { error: "Hotel name must be between 2 and 100 characters." },
        { status: 400 }
      );
    }
    updateData.name = cleanName;
  }

  if (body.email !== undefined) {
    if (body.email === null || body.email === "") {
      updateData.email = null;
    } else {
      const cleanEmail = typeof body.email === "string" ? body.email.trim() : "";
      if (!EMAIL_REGEX.test(cleanEmail)) {
        return NextResponse.json({ error: "Invalid email format." }, { status: 400 });
      }
      updateData.email = cleanEmail;
    }
  }

  if (body.phone !== undefined) {
    updateData.phone =
      body.phone && typeof body.phone === "string" ? body.phone.trim() : null;
  }

  if (body.address !== undefined) {
    updateData.address =
      body.address && typeof body.address === "string" ? body.address.trim() : null;
  }

  if (body.currency !== undefined) {
    const cleanCurrency = typeof body.currency === "string" ? body.currency.trim().toUpperCase() : "";
    if (!SUPPORTED_CURRENCIES.includes(cleanCurrency)) {
      return NextResponse.json(
        { error: `Supported currencies: ${SUPPORTED_CURRENCIES.join(", ")}` },
        { status: 400 }
      );
    }
    updateData.currency = cleanCurrency;
  }

  if (body.timezone !== undefined) {
    const cleanTimezone = typeof body.timezone === "string" ? body.timezone.trim() : "";
    if (cleanTimezone.length < 2 || cleanTimezone.length > 60) {
      return NextResponse.json({ error: "Invalid timezone identifier." }, { status: 400 });
    }
    updateData.timezone = cleanTimezone;
  }

  try {
    const before = await prisma.hotel.findUnique({
      where: { id: tenant.hotelId },
      select: { currency: true },
    });
    const currencyChanges =
      updateData.currency !== undefined && before?.currency !== updateData.currency;

    // A currency change re-denominates the property. The subscription is still
    // billed in KES or USD, so when the operation currency crosses that line the
    // stored amount must be re-priced in the same transaction -- otherwise the
    // hotel would keep paying the old currency's amount while every screen
    // quotes the new one.
    const subscriptionModel = (prisma as any).subscription;
    const canTouchSubscription = typeof subscriptionModel?.findUnique === "function";

    const applyChange = async (tx: any) => {
      const updated = await tx.hotel.update({
        where: { id: tenant.hotelId },
        data: updateData,
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

      let repriced: { currency: string; amount: number } | null = null;
      if (currencyChanges && canTouchSubscription) {
        const sub = await tx.subscription.findUnique({ where: { hotelId: tenant.hotelId } });
        if (sub) {
          const nextCurrency = normaliseBillingCurrency(updated.currency);
          if (nextCurrency !== normaliseBillingCurrency(sub.currency)) {
            const nextAmount = priceForSubscription({
              planId: sub.planId,
              billingInterval: sub.billingInterval ?? BillingInterval.MONTHLY,
              currency: nextCurrency,
            });
            if (nextAmount !== null && nextAmount !== sub.amount) {
              await tx.subscription.update({
                where: { hotelId: tenant.hotelId },
                data: { currency: nextCurrency, amount: nextAmount },
              });
              repriced = { currency: nextCurrency, amount: nextAmount };
            }
          }
        }
      }

      await recordAudit(
        {
          hotelId: tenant.hotelId,
          userId: tenant.userId,
          action: "HOTEL_SETTINGS_UPDATED",
          entity: "HOTEL",
          entityId: tenant.hotelId,
          metadata: {
            fields: Object.keys(updateData),
            previousCurrency: before?.currency ?? null,
            newCurrency: updated.currency,
            subscriptionRepriced: repriced,
          },
        },
        tx
      );

      return { updated, repriced };
    };

    const { updated, repriced } = canTouchSubscription
      ? await prisma.$transaction(applyChange)
      : { ...(await applyChange(prisma)), repriced: null };

    return NextResponse.json({
      hotel: updated,
      message: "Hotel settings updated successfully.",
      ...(repriced ? { subscriptionRepriced: repriced } : {}),
    });
  } catch (error) {
    console.error("Failed to update hotel settings:", error);
    return NextResponse.json(
      { error: "Could not save hotel settings. Please try again." },
      { status: 500 }
    );
  }
}
