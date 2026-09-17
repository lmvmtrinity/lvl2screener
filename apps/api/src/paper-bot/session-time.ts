/** Converts a session-local HH:mm boundary to its UTC instant. */
export function zonedSessionBoundary(
  sessionDate: string,
  localTime: string,
  timezone: string,
): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
    throw new Error(`Invalid session date: ${sessionDate}`);
  }
  const match = /^(\d{2}):(\d{2})$/.exec(localTime);
  if (!match) throw new Error(`Invalid session boundary: ${localTime}`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new Error(`Invalid session boundary: ${localTime}`);
  }

  // Sampling the zone at UTC noon avoids a date rollover for the North
  // American trading zones used by the scanner and selects the correct DST
  // offset for this concrete session date.
  const noonUtc = new Date(`${sessionDate}T12:00:00.000Z`);
  const localHour = Number(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      hour: "2-digit",
      hour12: false,
    }).format(noonUtc),
  );
  const offsetHours = localHour - 12;
  return new Date(
    Date.UTC(
      Number(sessionDate.slice(0, 4)),
      Number(sessionDate.slice(5, 7)) - 1,
      Number(sessionDate.slice(8, 10)),
      hours - offsetHours,
      minutes,
    ),
  ).toISOString();
}
