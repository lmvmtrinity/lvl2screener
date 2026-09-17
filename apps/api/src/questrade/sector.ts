/** Stable key shared by provider fundamentals and sector-benchmark config. */
export function normalizeSectorKey(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value
    .trim()
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "_")
    .toUpperCase();
  return normalized || null;
}
