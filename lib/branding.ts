/** Only external HTTPS image URLs may be rendered. Never fetch them server-side. */
export function isSafeLogoUrl(value: string): boolean {
  if (!value || value.length > 2048 || value.trim() !== value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch { return false; }
}
