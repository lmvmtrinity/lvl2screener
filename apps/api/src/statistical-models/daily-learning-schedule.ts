/** Next occurrence of an Eastern (America/New_York) wall-clock boundary at minute
 * precision, including daylight-saving changes. */
export function nextEasternBoundary(now: Date, hourMinute: string): Date {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  // Search minute boundaries in UTC. This avoids assuming Eastern has a fixed
  // offset or that every local day is exactly 24 hours.
  const firstMinute = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  for (let minute = 0; minute < 26 * 60; minute += 1) {
    const candidate = new Date(firstMinute + minute * 60_000);
    if (formatter.format(candidate) === hourMinute) return candidate;
  }
  throw new Error(`Unable to determine next Eastern check for ${hourMinute}`);
}

/** Next 17:00 America/New_York boundary, including daylight-saving changes. */
export function nextLearningCheck(now: Date): Date {
  return nextEasternBoundary(now, "17:00");
}
