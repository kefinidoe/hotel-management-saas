import { strToU8, zipSync } from "fflate";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import Decimal from "decimal.js";
import { prisma } from "@/lib/prisma";
import { BRAND_COLORS, PRODUCT_NAME } from "@/lib/brand";
import { getOrBootstrapSubscription, getSubscriptionLifecycleSummary } from "@/lib/entitlements";
import { getBillingHistoryForHotel, roundSubscriptionMoney } from "@/lib/subscription-invoices";

export interface TenantExportPayload {
  exportedAt: string;
  hotel: {
    id: string;
    name: string;
    slug: string;
    currency: string;
    timezone: string;
    status: string;
  };
  subscription: {
    id: string;
    planId: string;
    planName: string;
    storedStatus: string;
    effectiveStatus: string;
    billingInterval: string;
    amount: number;
    currency: string;
    trialStartsAt: string;
    trialEndsAt: string | null;
    currentPeriodStartsAt: string;
    currentPeriodEndsAt: string | null;
    lifecycleSummary: string;
  };
  billingHistory: Awaited<ReturnType<typeof getBillingHistoryForHotel>>;
  rooms: Array<{
    id: string;
    number: string;
    floor: string | null;
    roomType: string;
    baseRate: string;
    status: string;
    isActive: boolean;
  }>;
  guests: Array<{
    id: string;
    fullName: string;
    phone: string | null;
    email: string | null;
    idNumber: string | null;
    nationality: string | null;
    isArchived: boolean;
    createdAt: string;
  }>;
  reservations: Array<{
    id: string;
    code: string;
    guestName: string;
    status: string;
    source: string;
    checkInDate: string;
    checkOutDate: string;
    adults: number;
    children: number;
    rooms: string[];
    discount: string;
    createdAt: string;
  }>;
  payments: Array<{
    id: string;
    folioId: string;
    amount: string;
    method: string;
    reference: string | null;
    status: string;
    reversalOfId: string | null;
    createdAt: string;
  }>;
  expenses: Array<{
    id: string;
    category: string;
    description: string;
    amount: string;
    paymentMethod: string;
    status: string;
    createdAt: string;
  }>;
}

export async function buildTenantExportPayload(hotelId: string): Promise<TenantExportPayload> {
  const hotel = await prisma.hotel.findUnique({
    where: { id: hotelId },
    select: {
      id: true,
      name: true,
      slug: true,
      currency: true,
      timezone: true,
      status: true,
      subscription: true,
    },
  });

  if (!hotel) {
    throw new Error("Hotel not found for export.");
  }

  const subCtx = await getOrBootstrapSubscription(hotelId);
  const lifecycle = getSubscriptionLifecycleSummary(subCtx);
  const billingHistory = await getBillingHistoryForHotel(hotelId, {
    id: subCtx.id,
    planId: subCtx.planId,
    planName: subCtx.plan.name,
    billingInterval: subCtx.billingInterval,
    currency: subCtx.currency,
    metadata: hotel.subscription?.metadata ?? null,
  });

  const [rooms, guests, reservations, payments, expenses] = await Promise.all([
    prisma.room.findMany({
      where: { hotelId },
      include: { roomType: { select: { name: true, baseRate: true } } },
      orderBy: { number: "asc" },
    }),
    prisma.guest.findMany({
      where: { hotelId },
      orderBy: { createdAt: "desc" },
    }),
    prisma.reservation.findMany({
      where: { hotelId },
      include: {
        guest: { select: { fullName: true } },
        rooms: { include: { room: { select: { number: true } } } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.payment.findMany({
      where: { hotelId },
      include: { paymentMethod: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
    prisma.expense.findMany({
      where: { hotelId },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    hotel: {
      id: hotel.id,
      name: hotel.name,
      slug: hotel.slug,
      currency: hotel.currency,
      timezone: hotel.timezone,
      status: hotel.status,
    },
    subscription: {
      id: subCtx.id,
      planId: subCtx.planId,
      planName: subCtx.plan.name,
      storedStatus: subCtx.storedStatus,
      effectiveStatus: subCtx.effectiveStatus,
      billingInterval: subCtx.billingInterval,
      amount: subCtx.amount,
      currency: subCtx.currency,
      trialStartsAt: subCtx.trialStartsAt.toISOString(),
      trialEndsAt: subCtx.trialEndsAt ? subCtx.trialEndsAt.toISOString() : null,
      currentPeriodStartsAt: subCtx.currentPeriodStartsAt.toISOString(),
      currentPeriodEndsAt: subCtx.currentPeriodEndsAt ? subCtx.currentPeriodEndsAt.toISOString() : null,
      lifecycleSummary: lifecycle.summaryMessage,
    },
    billingHistory,
    rooms: rooms.map((r) => ({
      id: r.id,
      number: r.number,
      floor: r.floor ?? null,
      roomType: r.roomType?.name || "Standard",
      baseRate: roundSubscriptionMoney(String(r.roomType?.baseRate ?? 0)).toFixed(2),
      status: r.status,
      isActive: r.isActive,
    })),
    guests: guests.map((g) => ({
      id: g.id,
      fullName: g.fullName,
      phone: g.phone ?? null,
      email: g.email ?? null,
      idNumber: g.idNumber ?? null,
      nationality: g.nationality ?? null,
      isArchived: g.isArchived,
      createdAt: g.createdAt.toISOString(),
    })),
    reservations: reservations.map((res) => ({
      id: res.id,
      code: res.code,
      guestName: res.guest?.fullName || "Guest",
      status: res.status,
      source: res.source,
      checkInDate: res.checkInDate.toISOString(),
      checkOutDate: res.checkOutDate.toISOString(),
      adults: res.adults,
      children: res.children,
      rooms: res.rooms.map((rr) => rr.room.number),
      discount: roundSubscriptionMoney(String(res.discount ?? 0)).toFixed(2),
      createdAt: res.createdAt.toISOString(),
    })),
    payments: payments.map((p) => ({
      id: p.id,
      folioId: p.folioId,
      amount: roundSubscriptionMoney(String(p.amount)).toFixed(2),
      method: p.paymentMethod?.name || "Other",
      reference: p.reference ?? null,
      status: p.status,
      reversalOfId: p.reversalOfId ?? null,
      createdAt: p.createdAt.toISOString(),
    })),
    expenses: expenses.map((ex) => ({
      id: ex.id,
      category: ex.category,
      description: ex.description,
      amount: roundSubscriptionMoney(String(ex.amount)).toFixed(2),
      paymentMethod: ex.paymentMethod,
      status: ex.status,
      createdAt: ex.createdAt.toISOString(),
    })),
  };
}

function xmlEscape(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function colLetter(index: number) {
  let name = "";
  let current = index + 1;
  while (current > 0) {
    const rem = (current - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    current = Math.floor((current - 1) / 26);
  }
  return name;
}

export function buildTenantExportWorkbook(payload: TenantExportPayload): Uint8Array {
  type SheetDef = { name: string; rows: Array<Array<string | number>> };

  const sheets: SheetDef[] = [
    {
      name: "Summary",
      rows: [
        ["Field", "Value"],
        ["Exported At", payload.exportedAt],
        ["Hotel ID", payload.hotel.id],
        ["Hotel Name", payload.hotel.name],
        ["Hotel Status", payload.hotel.status],
        ["Currency", payload.hotel.currency],
        ["Subscription Plan", `${payload.subscription.planName} (${payload.subscription.planId})`],
        ["Subscription Status", payload.subscription.effectiveStatus],
        ["Billing Interval", payload.subscription.billingInterval],
        ["Rooms Count", payload.rooms.length],
        ["Guests Count", payload.guests.length],
        ["Reservations Count", payload.reservations.length],
        ["Payments Count", payload.payments.length],
        ["Expenses Count", payload.expenses.length],
      ],
    },
    {
      name: "Billing History",
      rows: [
        ["Invoice #", "Status", "Plan", "Currency", "Amount", "Paid", "Balance", "Issued At", "Reference"],
        ...payload.billingHistory.map((inv) => [
          inv.invoiceNumber,
          inv.status,
          inv.planName,
          inv.currency,
          inv.amount,
          inv.amountPaid,
          inv.balanceDue,
          inv.issuedAt.slice(0, 10),
          inv.paymentReference || "",
        ]),
      ],
    },
    {
      name: "Rooms",
      rows: [
        ["Room #", "Floor", "Type", "Base Rate", "Status", "Active"],
        ...payload.rooms.map((r) => [r.number, r.floor || "", r.roomType, Number(r.baseRate), r.status, r.isActive ? "Yes" : "No"]),
      ],
    },
    {
      name: "Guests",
      rows: [
        ["Full Name", "Phone", "Email", "ID Number", "Nationality", "Archived"],
        ...payload.guests.map((g) => [g.fullName, g.phone || "", g.email || "", g.idNumber || "", g.nationality || "", g.isArchived ? "Yes" : "No"]),
      ],
    },
    {
      name: "Reservations",
      rows: [
        ["Code", "Guest", "Status", "Source", "Check-In", "Check-Out", "Rooms", "Discount"],
        ...payload.reservations.map((r) => [
          r.code,
          r.guestName,
          r.status,
          r.source,
          r.checkInDate.slice(0, 10),
          r.checkOutDate.slice(0, 10),
          r.rooms.join(", "),
          Number(r.discount),
        ]),
      ],
    },
    {
      name: "Payments & Expenses",
      rows: [
        ["Record Type", "ID", "Category / Method", "Amount", "Status", "Reference / Description", "Created At"],
        ...payload.payments.map((p) => [
          "PAYMENT",
          p.id,
          p.method,
          Number(p.amount),
          p.status,
          p.reference || "",
          p.createdAt.slice(0, 10),
        ]),
        ...payload.expenses.map((e) => [
          "EXPENSE",
          e.id,
          e.category,
          Number(e.amount),
          e.status,
          e.description,
          e.createdAt.slice(0, 10),
        ]),
      ],
    },
  ];

  const files: Record<string, Uint8Array> = {
    "[Content_Types].xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheets
    .map(
      (_, i) =>
        `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
    .join("")}
</Types>`
    ),
    "_rels/.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`
    ),
    "xl/workbook.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheets
    .map((s, i) => `<sheet name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")}</sheets>
</workbook>`
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheets
    .map(
      (_, i) =>
        `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
    )
    .join("")}
</Relationships>`
    ),
  };

  sheets.forEach((sheet, idx) => {
    const rowXml = sheet.rows
      .map(
        (row, rIdx) =>
          `<row r="${rIdx + 1}">${row
            .map((cell, cIdx) => {
              const ref = `${colLetter(cIdx)}${rIdx + 1}`;
              if (typeof cell === "number" && Number.isFinite(cell)) {
                return `<c r="${ref}"><v>${cell}</v></c>`;
              }
              return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(cell ?? ""))}</t></is></c>`;
            })
            .join("")}</row>`
      )
      .join("");
    files[`xl/worksheets/sheet${idx + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowXml}</sheetData></worksheet>`
    );
  });

  return zipSync(files, { level: 6 });
}

export async function buildTenantExportPdf(payload: TenantExportPayload): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const primaryHex = BRAND_COLORS.primary.slice(1);
  const primary = rgb(
    parseInt(primaryHex.slice(0, 2), 16) / 255,
    parseInt(primaryHex.slice(2, 4), 16) / 255,
    parseInt(primaryHex.slice(4, 6), 16) / 255
  );
  const dark = rgb(0.14, 0.16, 0.18);
  const muted = rgb(0.42, 0.45, 0.48);

  const page = doc.addPage([595.28, 841.89]);
  page.drawRectangle({ x: 0, y: 765, width: 595.28, height: 76.89, color: primary });
  page.drawText(`${PRODUCT_NAME.toUpperCase()} TENANT DATA EXPORT SUMMARY`, {
    x: 40,
    y: 800,
    size: 15,
    font: bold,
    color: rgb(1, 1, 1),
  });
  page.drawText(`Exported ${payload.exportedAt}`, {
    x: 40,
    y: 780,
    size: 9,
    font: regular,
    color: rgb(0.92, 0.95, 0.98),
  });

  const safe = (v: string) => v.replace(/[^\x20-\x7E]/g, "?");
  const totalPaid = payload.payments.reduce((acc, p) => acc.plus(p.amount), new Decimal(0));
  const totalExpenses = payload.expenses.reduce((acc, e) => acc.plus(e.amount), new Decimal(0));

  const lines = [
    `Property: ${safe(payload.hotel.name)} (${safe(payload.hotel.id)})`,
    `Slug / Currency: /${safe(payload.hotel.slug)} (${safe(payload.hotel.currency)})`,
    `Subscription Plan: ${safe(payload.subscription.planName)} (${safe(payload.subscription.effectiveStatus)})`,
    `Rooms Recorded: ${payload.rooms.length} (Active: ${payload.rooms.filter((r) => r.isActive).length})`,
    `Guests Recorded: ${payload.guests.length}`,
    `Reservations Recorded: ${payload.reservations.length}`,
    `Payments Recorded: ${payload.payments.length} (Total: ${payload.hotel.currency} ${totalPaid.toFixed(2)})`,
    `Expenses Recorded: ${payload.expenses.length} (Total: ${payload.hotel.currency} ${totalExpenses.toFixed(2)})`,
    `Subscription Invoices & Receipts: ${payload.billingHistory.length}`,
  ];

  let y = 720;
  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: 10.5, font: regular, color: dark });
    y -= 22;
  }

  page.drawText("For complete row-level backup records, use the JSON or Excel (.xlsx) export options.", {
    x: 40,
    y: y - 18,
    size: 9,
    font: bold,
    color: muted,
  });

  doc.setTitle(`${PRODUCT_NAME} Workspace Export - ${safe(payload.hotel.name)}`);
  return doc.save();
}
