/** Format a stored decimal without converting it to a binary floating-point value. */
export function formatPlatformPrice(amount: string, currency?: string | null, hotelCurrency?: string | null): string {
  const code = (currency?.trim() || hotelCurrency?.trim() || "KES").toUpperCase();
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(amount);
  if (!match) return `${code} —`;
  const integer = match[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (match[3] || "").replace(/0+$/, "");
  return `${code} ${match[1]}${integer}${fraction ? `.${fraction}` : ""}`;
}
