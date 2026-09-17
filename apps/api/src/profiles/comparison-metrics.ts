export type RealizedOutcome = {
  outcomeId: string;
  realizedAt: string | null;
  pnl: number;
};

export type RealizedDrawdown = {
  amount: number | null;
  basis: "REALIZED_CLOSED_OUTCOMES";
  status: "AVAILABLE" | "NO_CLOSED_OUTCOMES" | "UNAVAILABLE";
};

export function realizedOutcomeDrawdown(
  outcomes: readonly RealizedOutcome[],
): RealizedDrawdown {
  const basis = "REALIZED_CLOSED_OUTCOMES" as const;
  if (!outcomes.length)
    return { amount: null, basis, status: "NO_CLOSED_OUTCOMES" };

  const identities = new Map<string, { at: number; pnl: number }>();
  const byTime = new Map<number, number>();
  for (const outcome of outcomes) {
    const at =
      outcome.realizedAt === null ? NaN : Date.parse(outcome.realizedAt);
    if (!Number.isFinite(at) || !Number.isFinite(outcome.pnl))
      return { amount: null, basis, status: "UNAVAILABLE" };

    const previous = identities.get(outcome.outcomeId);
    if (previous) {
      if (previous.at !== at || previous.pnl !== outcome.pnl)
        throw new Error("Conflicting realized outcome identity");
      continue;
    }
    identities.set(outcome.outcomeId, { at, pnl: outcome.pnl });
    byTime.set(at, (byTime.get(at) ?? 0) + outcome.pnl);
  }

  let equity = 0;
  let peak = 0;
  let amount = 0;
  for (const [, pnl] of [...byTime].sort(([left], [right]) => left - right)) {
    equity += pnl;
    peak = Math.max(peak, equity);
    amount = Math.max(amount, peak - equity);
  }
  return { amount, basis, status: "AVAILABLE" };
}
