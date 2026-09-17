import type { QuoteFact } from "./types.js";

/** Adapter/storage sizes are already shares; their metadata describes the raw
 * provider units. Translate that provenance at the execution boundary, without
 * multiplying the normalized sizes again or accepting raw lots as QuoteFacts. */
export function normalizedQuoteSize(
  sizeUnit: string | null | undefined,
  sizeMultiplier: number | string | null | undefined,
): Pick<QuoteFact, "sizeUnit" | "sizeMultiplier"> {
  const multiplier = Number(sizeMultiplier ?? 1);
  if (
    ((sizeUnit ?? "SHARES") === "SHARES" && multiplier === 1) ||
    (sizeUnit === "BOARD_LOTS" &&
      sizeMultiplier != null &&
      Number.isInteger(multiplier) &&
      multiplier > 0)
  ) {
    return { sizeUnit: "SHARES", sizeMultiplier: 1 };
  }
  return { sizeUnit: "UNKNOWN", sizeMultiplier: multiplier };
}
