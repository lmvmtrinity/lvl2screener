export type DiagnosticHistoryRevision = {
  revision: number;
  factAt: string;
  state: Record<string, unknown>;
};

export type PreAllocationResolution = {
  state: Record<string, unknown> | null;
  completeness: "EXACT" | "PARTIAL";
  reason: "MISSING_ORDER_HISTORY" | "UNVERIFIED_EVENT_SEQUENCE" | null;
};

/** Resolve the order state immediately before a quote allocation. A durable
 * applied revision is required to disambiguate same-time facts; timestamps
 * alone are deliberately insufficient. */
export function resolvePreAllocationState(input: {
  history: readonly DiagnosticHistoryRevision[];
  quoteAt: string;
  appliedRevision: number | null;
}): PreAllocationResolution {
  const quoteTime = Date.parse(input.quoteAt);
  if (!Number.isFinite(quoteTime))
    return {
      state: null,
      completeness: "PARTIAL",
      reason: "MISSING_ORDER_HISTORY",
    };
  const ordered = [...input.history]
    .filter((row) => Number.isFinite(Date.parse(row.factAt)))
    .sort(
      (left, right) =>
        Date.parse(left.factAt) - Date.parse(right.factAt) ||
        left.revision - right.revision,
    );
  if (ordered.length === 0)
    return {
      state: null,
      completeness: "PARTIAL",
      reason: "MISSING_ORDER_HISTORY",
    };
  if (input.appliedRevision !== null) {
    const prior = ordered
      .filter(
        (row) =>
          Date.parse(row.factAt) <= quoteTime &&
          row.revision < input.appliedRevision!,
      )
      .at(-1);
    return prior && prior.revision === input.appliedRevision - 1
      ? { state: prior.state, completeness: "EXACT", reason: null }
      : {
          state: null,
          completeness: "PARTIAL",
          reason: "MISSING_ORDER_HISTORY",
        };
  }
  const eligible = ordered.filter((row) => Date.parse(row.factAt) <= quoteTime);
  if (eligible.length === 0)
    return {
      state: null,
      completeness: "PARTIAL",
      reason: "MISSING_ORDER_HISTORY",
    };
  const latest = eligible.at(-1)!;
  const sameTime = eligible.filter(
    (row) => Date.parse(row.factAt) === Date.parse(latest.factAt),
  );
  if (Date.parse(latest.factAt) === quoteTime || sameTime.length > 1)
    return {
      state: null,
      completeness: "PARTIAL",
      reason: "UNVERIFIED_EVENT_SEQUENCE",
    };
  return { state: latest.state, completeness: "EXACT", reason: null };
}
