import Decimal from "decimal.js";

const MAX_MONEY_DECIMAL = new Decimal("99999999.99");

export function roundMoneyDecimal(
  value: Decimal.Value,
  roundingMode: Decimal.Rounding = Decimal.ROUND_HALF_CEIL
): Decimal {
  const rounded = new Decimal(value).toDecimalPlaces(2, roundingMode);
  return rounded.isZero() ? new Decimal(0) : rounded;
}

export function roundMoney(value: number | string | Decimal): number {
  if (typeof value === "number" && !Number.isFinite(value)) {
    return value;
  }
  const rounded = roundMoneyDecimal(value).toNumber();
  return rounded === 0 ? 0 : rounded;
}

export function hasMaxDecimalPlaces(value: unknown, places = 2): boolean {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    return new Decimal(value).decimalPlaces() <= places;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return false;
    try {
      const parsed = new Decimal(trimmed);
      return parsed.isFinite() && parsed.decimalPlaces() <= places;
    } catch {
      return false;
    }
  }
  if (value instanceof Decimal) {
    return value.isFinite() && value.decimalPlaces() <= places;
  }
  return false;
}

export function parseMoneyDecimal(
  raw: unknown,
  label: string,
  { allowZero = false }: { allowZero?: boolean } = {}
): Decimal {
  if (
    (typeof raw !== "number" && typeof raw !== "string" && !(raw instanceof Decimal)) ||
    (typeof raw === "string" && raw.trim() === "") ||
    (typeof raw === "number" && !Number.isFinite(raw))
  ) {
    throw new Error(`${label} must be a valid amount.`);
  }

  let parsed: Decimal;
  try {
    parsed =
      raw instanceof Decimal
        ? raw
        : new Decimal(typeof raw === "string" ? raw.trim() : raw);
  } catch {
    throw new Error(`${label} must be a valid amount.`);
  }

  if (!parsed.isFinite() || parsed.lt(0) || (!allowZero && parsed.isZero())) {
    throw new Error(`${label} must be ${allowZero ? "zero or a positive amount" : "greater than zero"}.`);
  }
  if (parsed.gt(MAX_MONEY_DECIMAL)) {
    throw new Error(`${label} is too large.`);
  }
  if (parsed.decimalPlaces() > 2) {
    throw new Error(`${label} cannot have more than two decimal places.`);
  }
  return parsed.isZero() ? new Decimal(0) : parsed;
}

export function parseMoney(
  raw: unknown,
  label: string,
  { allowZero = false }: { allowZero?: boolean } = {}
): number {
  return parseMoneyDecimal(raw, label, { allowZero }).toNumber();
}

export function folioTotalsExact(itemTotals: readonly (string | number)[], completedPayments: readonly (string | number)[]) {
  const required = itemTotals.reduce<Decimal>((sum, amount) => sum.plus(amount), new Decimal(0));
  const paid = completedPayments.reduce<Decimal>((sum, amount) => sum.plus(amount), new Decimal(0));
  return { required, paid, balance: required.minus(paid) };
}

export function folioTotals(itemTotals: readonly (string | number)[], completedPayments: readonly (string | number)[]) {
  // Convert only the final display/API values for compatibility with clients.
  const { required, paid, balance } = folioTotalsExact(itemTotals, completedPayments);
  return { required: required.toNumber(), paid: paid.toNumber(), balance: balance.toNumber() };
}

export function stayNights(checkIn: Date, checkOut: Date): number {
  const milliseconds = checkOut.getTime() - checkIn.getTime();
  const nights = milliseconds / 86_400_000;
  if (!Number.isFinite(milliseconds) || !Number.isInteger(nights) || nights < 1) {
    throw new Error("Check-in and check-out must define one or more whole nights.");
  }
  return nights;
}

export function accommodationRequiredExact(
  nightlyRates: readonly (number | string | Decimal)[],
  nights: number,
  discount: number | string | Decimal = 0
): Decimal {
  if (!Number.isInteger(nights) || nights < 1 || nightlyRates.length === 0) {
    throw new Error("The reservation accommodation charges are invalid.");
  }

  let roomCharges = new Decimal(0);
  for (const rawRate of nightlyRates) {
    if (typeof rawRate === "number" && !Number.isFinite(rawRate)) {
      throw new Error("The reservation accommodation charges are invalid.");
    }
    let rate: Decimal;
    try {
      rate =
        rawRate instanceof Decimal
          ? rawRate
          : new Decimal(typeof rawRate === "string" ? rawRate.trim() : rawRate);
    } catch {
      throw new Error("The reservation accommodation charges are invalid.");
    }
    if (!rate.isFinite() || rate.isNegative()) {
      throw new Error("The reservation accommodation charges are invalid.");
    }
    roomCharges = roomCharges.plus(roundMoneyDecimal(rate.mul(nights)));
  }
  roomCharges = roundMoneyDecimal(roomCharges);

  if (typeof discount === "number" && !Number.isFinite(discount)) {
    throw new Error("The reservation discount is invalid.");
  }
  let parsedDiscount: Decimal;
  try {
    parsedDiscount =
      discount instanceof Decimal
        ? discount
        : new Decimal(typeof discount === "string" ? discount.trim() : discount);
  } catch {
    throw new Error("The reservation discount is invalid.");
  }
  if (!parsedDiscount.isFinite() || parsedDiscount.isNegative()) {
    throw new Error("The reservation discount is invalid.");
  }

  const safeDiscount = roundMoneyDecimal(parsedDiscount);
  if (safeDiscount.gt(roomCharges)) {
    throw new Error("The reservation discount cannot exceed the accommodation charge.");
  }
  return roundMoneyDecimal(roomCharges.minus(safeDiscount));
}

export function accommodationRequired(
  nightlyRates: readonly (number | string | Decimal)[],
  nights: number,
  discount: number | string | Decimal = 0
): number {
  return accommodationRequiredExact(nightlyRates, nights, discount).toNumber();
}
