import type { MarketId } from "@tsx-scanner/contracts";
import { calendarSessionBoundaryFor } from "../universe/market-calendar.js";

/** Research jobs stay queued until this long after the close, so the post-close
 * collection and paper settlement do not compete with replays for the database. */
export const RESEARCH_CLOSE_GRACE_MS = 10 * 60_000;

function localDate(now: Date, marketId: MarketId): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: marketId === "CA_TSX" ? "America/Toronto" : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((value) => value.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/** True while any enabled market is inside its regular session (holidays and
 * early closes follow the market calendar) or its post-close grace period. */
export function regularSessionOpen(
  markets: readonly MarketId[],
  now: Date,
  closeGraceMs = RESEARCH_CLOSE_GRACE_MS,
): boolean {
  const at = now.getTime();
  return markets.some((marketId) => {
    const session = calendarSessionBoundaryFor(
      marketId,
      localDate(now, marketId),
    );
    return (
      session !== null &&
      at >= Date.parse(session.open) &&
      at < Date.parse(session.close) + closeGraceMs
    );
  });
}
