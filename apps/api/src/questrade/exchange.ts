import type { NormalizedExchange } from "@tsx-scanner/contracts";

/** Shared normalization for live intake and retained membership reads. */
export function normalizeExchange(value: string): NormalizedExchange {
  const normalized = value.trim().toUpperCase();
  if (normalized === "TSX") return "TSX";
  if (normalized === "NASDAQ") return "NASDAQ";
  if (normalized === "NYSE") return "NYSE";
  if (["NYSE AMERICAN", "NYSE_AMERICAN", "AMEX"].includes(normalized))
    return "NYSE_AMERICAN";
  if (["NYSE ARCA", "NYSE_ARCA", "ARCA"].includes(normalized))
    return "NYSE_ARCA";
  if (["CBOE BZX", "CBOE_BZX", "BZX"].includes(normalized)) return "CBOE_BZX";
  return "UNKNOWN";
}
