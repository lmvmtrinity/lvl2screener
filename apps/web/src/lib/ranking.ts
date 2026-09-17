import {
  compareOpportunities,
  contextScoreForSymbol,
  type ContextEvaluation,
  type DataReadiness,
  type StrategyEvaluation,
  type UniverseAutomation,
} from "@tsx-scanner/contracts";
import { ACTIVE_SETUP_STATES, contextStatusFor } from "./format.js";
import type { BoardFilters, BoardRow } from "../types.js";

export interface CandidateLookup {
  bySymbol: Map<string, StrategyEvaluation[]>;
  contextsBySymbol: Map<string, ContextEvaluation[]>;
}

function groupBySymbol<T extends { symbol: string }>(
  values: T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const value of values) {
    const list = map.get(value.symbol);
    if (list) list.push(value);
    else map.set(value.symbol, [value]);
  }
  return map;
}

/** W9: groups candidates and contexts by symbol once per snapshot (per `candidates`/`contexts`
 * array identity), instead of the board recomputing `candidates.filter(v => v.symbol === symbol)`
 * and `contexts.filter(v => v.symbol === symbol)` from scratch for every symbol on every render —
 * an O(symbols * candidates) scan whose cost grows quadratically with universe size. */
export function buildCandidateLookup(
  candidates: StrategyEvaluation[],
  contexts: ContextEvaluation[],
): CandidateLookup {
  return {
    bySymbol: groupBySymbol(candidates),
    contextsBySymbol: groupBySymbol(contexts),
  };
}

/** W9: extracted from App.tsx's inline `ranked` useMemo body so the ranking/filtering logic is
 * unit-testable independent of React, and so the candidate/context lookups and the per-symbol
 * context score are computed once instead of being recomputed per symbol (and, for context score,
 * twice per symbol — once for the setup sort, once for the row). */
export function buildRankedRows(
  candidates: StrategyEvaluation[],
  contexts: ContextEvaluation[],
  universe: UniverseAutomation | undefined,
  activeProfile: string,
  filters: BoardFilters,
  marketId?: "CA_TSX" | "US_EQUITIES",
): BoardRow[] {
  const scopedUniverse =
    universe &&
    (!marketId ||
      !universe.policy?.marketId ||
      universe.policy.marketId === marketId)
      ? universe
      : undefined;
  const scopedCandidates = marketId
    ? candidates.filter((value) => (value.marketId ?? "CA_TSX") === marketId)
    : candidates;
  const scopedContexts = marketId
    ? contexts.filter((value) => (value.marketId ?? "CA_TSX") === marketId)
    : contexts;
  const scopedMembers = (scopedUniverse?.members ?? []).filter(
    (value) => !marketId || (value.marketId ?? "CA_TSX") === marketId,
  );
  const scopedCoverage = (scopedUniverse?.coverage ?? []).filter(
    (value) =>
      !marketId ||
      !("marketId" in value) ||
      (value as { marketId?: string }).marketId === marketId,
  );
  const lookup = buildCandidateLookup(scopedCandidates, scopedContexts);
  const membersBySymbol = groupBySymbol(scopedMembers);
  const coverageBySymbol = groupBySymbol(scopedCoverage);
  const rawSymbols = [
    ...(scopedUniverse?.configuredSymbols ??
      scopedMembers.map((value) => value.symbol)),
    ...scopedCandidates.map((value) => value.symbol),
  ];
  const isSymbolForMarket = (symbol: string): boolean => {
    if (!marketId) return true;
    const member = membersBySymbol.get(symbol)?.[0];
    if (member && (member.marketId ?? "CA_TSX") !== marketId) return false;
    const candidate = lookup.bySymbol.get(symbol)?.[0];
    if (candidate && (candidate.marketId ?? "CA_TSX") !== marketId)
      return false;
    if (marketId === "US_EQUITIES" && symbol.endsWith(".TO")) return false;
    if (marketId === "CA_TSX" && !symbol.endsWith(".TO")) return false;
    return true;
  };
  const symbols = new Set(rawSymbols.filter(isSymbolForMarket));
  const rows: BoardRow[] = [];
  const maximumSpread =
    filters.maximumSpread.trim() === "" ? null : Number(filters.maximumSpread);

  for (const symbol of symbols) {
    const allSetups = (lookup.bySymbol.get(symbol) ?? []).filter(
      (value) => activeProfile === "ALL" || value.profileId === activeProfile,
    );
    const eligibleSetups = allSetups.filter(
      (value) =>
        (filters.setup === "ALL" || value.strategy === filters.setup) &&
        (filters.state === "ALL" || value.state === filters.state),
    );
    if (
      (filters.setup !== "ALL" || filters.state !== "ALL") &&
      !eligibleSetups.length
    )
      continue;

    // Computed once per symbol (not once per candidate being compared) and reused for both the
    // in-symbol setup sort below and this row's `contextScore` field.
    const contextScore = contextScoreForSymbol(scopedContexts, symbol);
    const setup =
      [...eligibleSetups].sort((left, right) =>
        compareOpportunities(
          { setup: left, contextScore },
          { setup: right, contextScore },
        ),
      )[0] ?? null;
    const member = membersBySymbol.get(symbol)?.[0];
    const coverage = coverageBySymbol.get(symbol)?.[0];
    const symbolContexts = lookup.contextsBySymbol.get(symbol) ?? [];
    const contextStatus = contextStatusFor(symbolContexts);
    const readiness =
      coverage?.dataReadiness ??
      ((setup?.featureSnapshot.dataStatus === "REALTIME"
        ? "READY"
        : (setup?.featureSnapshot.dataStatus ?? "WARMING")) as DataReadiness);
    if (filters.sector !== "ALL" && member?.sector !== filters.sector) continue;
    if (
      filters.context !== "ALL" &&
      !symbolContexts.some((value) => value.status === filters.context)
    )
      continue;
    if (filters.readiness !== "ALL" && readiness !== filters.readiness)
      continue;
    if (
      maximumSpread !== null &&
      Number.isFinite(maximumSpread) &&
      setup &&
      setup.featureSnapshot.spreadPct > maximumSpread
    )
      continue;
    const latestAt =
      [
        setup?.timestamp,
        coverage?.latestAnalysisAt,
        ...symbolContexts.map((value) => value.timestamp),
      ]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;
    rows.push({
      symbol,
      setup,
      contextScore,
      contextStatus,
      otherActiveSetups: Math.max(
        0,
        allSetups.filter((value) => ACTIVE_SETUP_STATES.has(value.state))
          .length - (setup && ACTIVE_SETUP_STATES.has(setup.state) ? 1 : 0),
      ),
      sector: member?.sector ?? null,
      readiness,
      status: coverage?.status ?? setup?.state ?? "WARMING",
      reason:
        coverage?.reasons[0] ??
        member?.reasons.join(" · ") ??
        "Waiting for the first setup evaluation",
      latestAt,
    });
  }

  return rows.sort((left, right) =>
    left.setup && right.setup
      ? compareOpportunities(
          { setup: left.setup, contextScore: left.contextScore },
          { setup: right.setup, contextScore: right.contextScore },
        )
      : left.setup
        ? -1
        : right.setup
          ? 1
          : left.symbol.localeCompare(right.symbol),
  );
}
