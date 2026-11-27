import Decimal from "decimal.js";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { BRAND_COLORS, PRODUCT_NAME } from "@/lib/brand";
import { BillingInterval, getPlan, PRICING_CONFIG, SubscriptionInvoiceStatus } from "@/lib/plans";

export interface SerializedSubscriptionInvoice {
  id: string;
  hotelId: string;
  subscriptionId: string;
  invoiceNumber: string;
  status: SubscriptionInvoiceStatus;
  planId: string;
  planName: string;
  billingInterval: BillingInterval;
  currency: string;
  subtotal: number;
  taxAmount: number;
  amount: number;
  amountPaid: number;
  balanceDue: number;
  periodStartsAt: string;
  periodEndsAt: string;
  issuedAt: string;
  dueAt: string | null;
  paidAt: string | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  notes: string | null;
  source: "INVOICE" | "LEGACY_PAYMENT";
  downloadPdfUrl: string | null;
}

export function roundSubscriptionMoney(value: Decimal.Value): Decimal {
  return new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
}

export function serializeSubscriptionInvoice(inv: {
  id: string;
  hotelId: string;
  subscriptionId: string;
  invoiceNumber: string;
  status: string;
  planId: string;
  planName: string;
  billingInterval: string;
  currency: string;
  subtotal: Decimal.Value;
  taxAmount: Decimal.Value;
  amount: Decimal.Value;
  amountPaid: Decimal.Value;
  periodStartsAt: Date | string;
  periodEndsAt: Date | string;
  issuedAt: Date | string;
  dueAt?: Date | string | null;
  paidAt?: Date | string | null;
  paymentMethod?: string | null;
  paymentReference?: string | null;
  notes?: string | null;
}): SerializedSubscriptionInvoice {
  const amountDec = roundSubscriptionMoney(String(inv.amount ?? 0));
  const paidDec = roundSubscriptionMoney(String(inv.amountPaid ?? 0));
  const balanceDec = inv.status === "VOID" ? new Decimal(0) : Decimal.max(0, amountDec.minus(paidDec));

  return {
    id: inv.id,
    hotelId: inv.hotelId,
    subscriptionId: inv.subscriptionId,
    invoiceNumber: inv.invoiceNumber,
    status: inv.status as SubscriptionInvoiceStatus,
    planId: inv.planId,
    planName: inv.planName,
    billingInterval: (inv.billingInterval || BillingInterval.MONTHLY) as BillingInterval,
    currency: inv.currency || "KES",
    subtotal: roundSubscriptionMoney(String(inv.subtotal ?? 0)).toNumber(),
    taxAmount: roundSubscriptionMoney(String(inv.taxAmount ?? 0)).toNumber(),
    amount: amountDec.toNumber(),
    amountPaid: paidDec.toNumber(),
    balanceDue: roundSubscriptionMoney(balanceDec).toNumber(),
    periodStartsAt: new Date(inv.periodStartsAt).toISOString(),
    periodEndsAt: new Date(inv.periodEndsAt).toISOString(),
    issuedAt: new Date(inv.issuedAt).toISOString(),
    dueAt: inv.dueAt ? new Date(inv.dueAt).toISOString() : null,
    paidAt: inv.paidAt ? new Date(inv.paidAt).toISOString() : null,
    paymentMethod: inv.paymentMethod ?? null,
    paymentReference: inv.paymentReference ?? null,
    notes: inv.notes ?? null,
    source: "INVOICE",
    downloadPdfUrl: `/api/subscription/invoices/${encodeURIComponent(inv.id)}?format=pdf`,
  };
}

export async function generateNextInvoiceNumber(
  tx: Prisma.TransactionClient,
  now = new Date()
): Promise<string> {
  const year = now.getUTCFullYear();
  const prefix = `SUB-INV-${year}-`;
  if (typeof (tx as any).$queryRaw === "function") {
    await (tx as any).$queryRaw`SELECT pg_advisory_xact_lock(hashtext('subscription-invoice-seq'))`;
  }
  const latest =
    typeof (tx as any).subscriptionInvoice?.findFirst === "function"
      ? await (tx as any).subscriptionInvoice.findFirst({
          where: { invoiceNumber: { startsWith: prefix } },
          orderBy: { invoiceNumber: "desc" },
          select: { invoiceNumber: true },
        })
      : null;

  let nextSeq = 1;
  if (latest?.invoiceNumber) {
    const suffix = latest.invoiceNumber.slice(prefix.length);
    const parsed = Number.parseInt(suffix, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      nextSeq = parsed + 1;
    }
  }
  return `${prefix}${String(nextSeq).padStart(4, "0")}`;
}

export async function issueSubscriptionInvoice(params: {
  hotelId: string;
  adminUserId: string;
  adminRole: string;
  amount?: number;
  taxAmount?: number;
  dueDays?: number;
  periodDays?: number;
  notes?: string;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const subscription = await tx.subscription.findUnique({ where: { hotelId: params.hotelId } });
    if (!subscription) {
      throw new Error("Subscription not found.");
    }

    const plan = getPlan(subscription.planId);
    const invoiceNumber = await generateNextInvoiceNumber(tx, now);
    const subtotalDec = roundSubscriptionMoney(
      params.amount !== undefined ? params.amount : String(subscription.amount ?? 0)
    );
    const taxDec = roundSubscriptionMoney(params.taxAmount ?? 0);
    const totalDec = roundSubscriptionMoney(subtotalDec.plus(taxDec));

    const periodDays =
      params.periodDays ?? (subscription.billingInterval === BillingInterval.YEARLY ? 365 : 30);
    const periodStartsAt =
      subscription.currentPeriodEndsAt && subscription.currentPeriodEndsAt > now
        ? new Date(subscription.currentPeriodEndsAt)
        : now;
    const periodEndsAt = new Date(periodStartsAt.getTime() + periodDays * 86_400_000);
    const dueDays = params.dueDays ?? 7;
    const dueAt = new Date(now.getTime() + dueDays * 86_400_000);

    const invoice = await tx.subscriptionInvoice.create({
      data: {
        hotelId: params.hotelId,
        subscriptionId: subscription.id,
        invoiceNumber,
        status: "ISSUED",
        planId: subscription.planId,
        planName: plan.name,
        billingInterval: subscription.billingInterval,
        currency: subscription.currency || "KES",
        subtotal: new Prisma.Decimal(subtotalDec.toFixed(2)),
        taxAmount: new Prisma.Decimal(taxDec.toFixed(2)),
        amount: new Prisma.Decimal(totalDec.toFixed(2)),
        amountPaid: new Prisma.Decimal("0.00"),
        periodStartsAt,
        periodEndsAt,
        issuedAt: now,
        dueAt,
        paymentMethod: "MANUAL_COOP_MPESA",
        recordedByUserId: params.adminUserId,
        notes: params.notes?.trim() || "Manual invoice issued for Paybill 400200 / Co-op Bank settlement.",
        metadata: {
          issuedByRole: params.adminRole,
          isScheduleApproved: PRICING_CONFIG.isScheduleApproved,
        },
      },
    });

    await tx.auditLog.create({
      data: {
        hotelId: params.hotelId,
        userId: params.adminUserId,
        action: "PLATFORM_SUBSCRIPTION_INVOICE_ISSUED",
        entity: "SubscriptionInvoice",
        entityId: invoice.id,
        metadata: {
          invoiceNumber,
          amount: totalDec.toNumber(),
          currency: invoice.currency,
          dueAt: dueAt.toISOString(),
          periodStartsAt: periodStartsAt.toISOString(),
          periodEndsAt: periodEndsAt.toISOString(),
          reason: params.notes?.trim() || "Subscription invoice issued",
        },
      },
    });

    return serializeSubscriptionInvoice(invoice);
  });
}

export async function getBillingHistoryForHotel(
  hotelId: string,
  subscription?: {
    id: string;
    planId: string;
    planName?: string;
    billingInterval?: string;
    currency?: string;
    metadata?: unknown;
  } | null
): Promise<SerializedSubscriptionInvoice[]> {
  const invoiceModel = (prisma as any).subscriptionInvoice;
  const rows: any[] =
    typeof invoiceModel?.findMany === "function"
      ? await invoiceModel.findMany({
          where: { hotelId },
          orderBy: [{ issuedAt: "desc" }, { createdAt: "desc" }],
          take: 100,
        })
      : [];

  const serialized = rows.map(serializeSubscriptionInvoice);
  const seenRefs = new Set(
    serialized
      .map((item) => item.paymentReference?.trim().toUpperCase())
      .filter((ref): ref is string => Boolean(ref))
  );

  const meta =
    subscription?.metadata && typeof subscription.metadata === "object" && !Array.isArray(subscription.metadata)
      ? (subscription.metadata as Record<string, unknown>)
      : null;
  const legacyPayments = Array.isArray(meta?.payments) ? meta.payments : [];

  for (let i = legacyPayments.length - 1; i >= 0; i--) {
    const entry = legacyPayments[i] as Record<string, unknown>;
    if (!entry || typeof entry !== "object") continue;
    const rawRef = typeof entry.referenceCode === "string" ? entry.referenceCode.trim().toUpperCase() : "";
    if (rawRef && seenRefs.has(rawRef)) continue;
    if (rawRef) seenRefs.add(rawRef);

    const amount = roundSubscriptionMoney(Number(entry.amountPaid ?? 0) || 0).toNumber();
    const recordedAt = typeof entry.recordedAt === "string" ? entry.recordedAt : new Date().toISOString();
    const periodStartsAt = typeof entry.periodStartsAt === "string" ? entry.periodStartsAt : recordedAt;
    const periodEndsAt = typeof entry.periodEndsAt === "string" ? entry.periodEndsAt : recordedAt;
    const planId = subscription?.planId || "BAND_1_10";

    serialized.push({
      id: `legacy-${rawRef || i}`,
      hotelId,
      subscriptionId: subscription?.id || "",
      invoiceNumber: rawRef ? `REC-${rawRef}` : `REC-LEGACY-${i + 1}`,
      status: "PAID",
      planId,
      planName: subscription?.planName || getPlan(planId).name,
      billingInterval: (subscription?.billingInterval || BillingInterval.MONTHLY) as BillingInterval,
      currency: typeof entry.currency === "string" ? entry.currency : subscription?.currency || "KES",
      subtotal: amount,
      taxAmount: 0,
      amount,
      amountPaid: amount,
      balanceDue: 0,
      periodStartsAt,
      periodEndsAt,
      issuedAt: recordedAt,
      dueAt: recordedAt,
      paidAt: recordedAt,
      paymentMethod: typeof entry.method === "string" ? entry.method : "MANUAL_COOP_MPESA",
      paymentReference: rawRef || null,
      notes: typeof entry.reason === "string" ? entry.reason : null,
      source: "LEGACY_PAYMENT",
      downloadPdfUrl: null,
    });
  }

  serialized.sort((a, b) => new Date(b.issuedAt).getTime() - new Date(a.issuedAt).getTime());
  return serialized;
}

function safePdfText(value: string): string {
  return value
    .replaceAll("—", "-")
    .replaceAll("–", "-")
    .replaceAll("’", "'")
    .replaceAll("“", '"')
    .replaceAll("”", '"')
    .replace(/[^\x20-\x7E]/g, "?");
}

function formatMoney(amount: number, currency: string): string {
  const code = (currency || "KES").toUpperCase();
  const formatted = new Decimal(String(amount || 0))
    .toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
    .toFixed(2);
  return `${code} ${formatted}`;
}

export async function buildSubscriptionInvoicePdf(params: {
  invoice: SerializedSubscriptionInvoice;
  hotel: { id: string; name: string; slug: string; email?: string | null; address?: string | null };
}): Promise<Uint8Array> {
  const { invoice, hotel } = params;
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
  const lightBg = rgb(0.96, 0.97, 0.98);
  const green = rgb(0.11, 0.49, 0.27);
  const amber = rgb(0.68, 0.42, 0.05);

  const page = doc.addPage([595.28, 841.89]);
  page.drawRectangle({ x: 0, y: 760, width: 595.28, height: 81.89, color: primary });
  page.drawText(`${PRODUCT_NAME.toUpperCase()} SUBSCRIPTION ${invoice.status === "PAID" ? "RECEIPT" : "INVOICE"}`, {
    x: 42,
    y: 805,
    size: 16,
    font: bold,
    color: rgb(1, 1, 1),
  });
  page.drawText(`Invoice #: ${safePdfText(invoice.invoiceNumber)}`, {
    x: 42,
    y: 782,
    size: 10,
    font: regular,
    color: rgb(0.92, 0.95, 0.98),
  });
  page.drawText(`Status: ${safePdfText(invoice.status)}`, {
    x: 440,
    y: 782,
    size: 11,
    font: bold,
    color: rgb(1, 1, 1),
  });

  // Billed To & Metadata
  page.drawText("BILLED PROPERTY", { x: 42, y: 726, size: 9, font: bold, color: muted });
  page.drawText(safePdfText(hotel.name), { x: 42, y: 708, size: 13, font: bold, color: dark });
  page.drawText(`Hotel ID: ${safePdfText(hotel.id)}`, { x: 42, y: 692, size: 9, font: regular, color: muted });
  if (hotel.email) {
    page.drawText(`Email: ${safePdfText(hotel.email)}`, { x: 42, y: 678, size: 9, font: regular, color: muted });
  }
  if (hotel.address) {
    page.drawText(`Address: ${safePdfText(hotel.address)}`, { x: 42, y: 664, size: 9, font: regular, color: muted });
  }

  page.drawText("INVOICE DATES", { x: 350, y: 726, size: 9, font: bold, color: muted });
  page.drawText(`Issued: ${invoice.issuedAt.slice(0, 10)}`, { x: 350, y: 708, size: 9, font: regular, color: dark });
  page.drawText(`Due Date: ${invoice.dueAt ? invoice.dueAt.slice(0, 10) : "On receipt"}`, {
    x: 350,
    y: 694,
    size: 9,
    font: regular,
    color: dark,
  });
  page.drawText(
    `Service Period: ${invoice.periodStartsAt.slice(0, 10)} to ${invoice.periodEndsAt.slice(0, 10)}`,
    { x: 350, y: 680, size: 9, font: regular, color: dark }
  );
  if (invoice.paidAt) {
    page.drawText(`Paid At: ${invoice.paidAt.slice(0, 10)}`, { x: 350, y: 666, size: 9, font: bold, color: green });
  }

  // Line Item Table Header
  page.drawRectangle({ x: 42, y: 616, width: 511, height: 22, color: primary });
  page.drawText("DESCRIPTION", { x: 52, y: 623, size: 8, font: bold, color: rgb(1, 1, 1) });
  page.drawText("INTERVAL", { x: 300, y: 623, size: 8, font: bold, color: rgb(1, 1, 1) });
  page.drawText("AMOUNT", { x: 455, y: 623, size: 8, font: bold, color: rgb(1, 1, 1) });

  // Line Item Row
  page.drawRectangle({ x: 42, y: 582, width: 511, height: 34, color: lightBg });
  page.drawText(safePdfText(`${invoice.planName} (${invoice.planId})`), {
    x: 52,
    y: 600,
    size: 10,
    font: bold,
    color: dark,
  });
  page.drawText(
    safePdfText(`Period ${invoice.periodStartsAt.slice(0, 10)} - ${invoice.periodEndsAt.slice(0, 10)}`),
    { x: 52, y: 588, size: 8, font: regular, color: muted }
  );
  page.drawText(safePdfText(invoice.billingInterval), { x: 300, y: 596, size: 9, font: regular, color: dark });
  page.drawText(safePdfText(formatMoney(invoice.subtotal, invoice.currency)), {
    x: 455,
    y: 596,
    size: 9,
    font: bold,
    color: dark,
  });

  // Totals
  page.drawText("Subtotal:", { x: 365, y: 552, size: 9, font: regular, color: muted });
  page.drawText(safePdfText(formatMoney(invoice.subtotal, invoice.currency)), {
    x: 455,
    y: 552,
    size: 9,
    font: regular,
    color: dark,
  });

  page.drawText("Tax:", { x: 365, y: 536, size: 9, font: regular, color: muted });
  page.drawText(safePdfText(formatMoney(invoice.taxAmount, invoice.currency)), {
    x: 455,
    y: 536,
    size: 9,
    font: regular,
    color: dark,
  });

  page.drawText("Total Amount:", { x: 365, y: 516, size: 10, font: bold, color: dark });
  page.drawText(safePdfText(formatMoney(invoice.amount, invoice.currency)), {
    x: 455,
    y: 516,
    size: 10,
    font: bold,
    color: primary,
  });

  page.drawText("Amount Paid:", { x: 365, y: 498, size: 9, font: regular, color: muted });
  page.drawText(safePdfText(formatMoney(invoice.amountPaid, invoice.currency)), {
    x: 455,
    y: 498,
    size: 9,
    font: bold,
    color: green,
  });

  page.drawText("Balance Due:", { x: 365, y: 480, size: 10, font: bold, color: dark });
  page.drawText(safePdfText(formatMoney(invoice.balanceDue, invoice.currency)), {
    x: 455,
    y: 480,
    size: 10,
    font: bold,
    color: invoice.balanceDue > 0 ? amber : green,
  });

  // Manual Settlement & Payment Reference Box
  page.drawRectangle({
    x: 42,
    y: 350,
    width: 511,
    height: 106,
    color: lightBg,
    borderColor: rgb(0.84, 0.86, 0.88),
    borderWidth: 0.75,
  });
  page.drawText("MANUAL PAYMENT & VERIFICATION DETAILS", {
    x: 54,
    y: 438,
    size: 9,
    font: bold,
    color: primary,
  });
  page.drawText("M-Pesa Paybill: 400200 | Co-op Bank Account: 01102662965002", {
    x: 54,
    y: 418,
    size: 9,
    font: bold,
    color: dark,
  });
  page.drawText(`Account Reference: ${safePdfText(hotel.id)} (${safePdfText(hotel.name)})`, {
    x: 54,
    y: 402,
    size: 8.5,
    font: regular,
    color: dark,
  });
  page.drawText(
    `Recorded Payment Reference: ${safePdfText(invoice.paymentReference || "Pending manual verification")}`,
    { x: 54, y: 386, size: 8.5, font: bold, color: invoice.paymentReference ? green : muted }
  );
  if (invoice.notes) {
    page.drawText(`Notes: ${safePdfText(invoice.notes).slice(0, 88)}`, {
      x: 54,
      y: 368,
      size: 8,
      font: regular,
      color: muted,
    });
  }

  if (!PRICING_CONFIG.isScheduleApproved) {
    page.drawText(
      "Notice: Commercial pricing schedule status is currently unapproved/indicative unless confirmed on an issued invoice.",
      { x: 42, y: 326, size: 8, font: regular, color: amber }
    );
  }

  doc.setTitle(`${PRODUCT_NAME} Subscription Invoice ${invoice.invoiceNumber}`);
  doc.setAuthor(PRODUCT_NAME);
  return doc.save();
}
