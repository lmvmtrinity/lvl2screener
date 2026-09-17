export function planFundedHistoricalRange(
  dates: readonly string[],
  maxSessions = 20,
): string[] {
  if (dates.length === 0)
    throw new Error("Funded historical range has no captured sessions");
  if (dates.length > maxSessions)
    throw new Error(
      `Funded historical range exceeds ${maxSessions} captured sessions`,
    );
  if (new Set(dates).size !== dates.length)
    throw new Error("Funded historical range has duplicate sessions");
  for (const date of dates)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      throw new Error(`Invalid funded historical session date: ${date}`);
  return [...dates].sort();
}
