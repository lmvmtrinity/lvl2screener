import type {
  CandidateCoverage,
  ContextEvaluation,
  FeatureSnapshot,
  StrategyEvaluation,
  UniverseAutomation,
} from "@tsx-scanner/contracts";

/** W9: extracted from `QuestradeDataService`'s private `candidateCoverage` method as a pure
 * function of a symbol plus the relevant slices of service state (the universe automation
 * snapshot, that symbol's feature snapshot, and its setups/contexts). Projects the operator-facing
 * "why isn't this candidate ready" coverage record shown in `/api/universe` and candidate detail. */
export function projectCandidateCoverage(
  symbol: string,
  automation: UniverseAutomation,
  feature: FeatureSnapshot | undefined,
  setups: StrategyEvaluation[],
  contexts: ContextEvaluation[],
): CandidateCoverage {
  const upper = symbol.toUpperCase();
  const member = automation.members.find(
    (value) => value.symbol.toUpperCase() === upper,
  );
  const warmupPending = feature?.warmingUp ?? [];
  const unavailable = member
    ? !member.eligible
    : automation.latestRun?.status === "COMPLETED";
  const dataReadiness: CandidateCoverage["dataReadiness"] = unavailable
    ? "UNAVAILABLE"
    : feature?.dataStatus === "HALTED"
      ? "HALTED"
      : feature?.dataStatus === "DELAYED"
        ? "DELAYED"
        : feature && warmupPending.length === 0
          ? "READY"
          : "WARMING";
  const status: CandidateCoverage["status"] =
    dataReadiness === "UNAVAILABLE" ||
    dataReadiness === "HALTED" ||
    dataReadiness === "DELAYED"
      ? "UNAVAILABLE"
      : dataReadiness === "WARMING"
        ? "WARMING"
        : setups.some((value) => value.state === "READY")
          ? "READY"
          : setups.some((value) => value.state === "FORMING")
            ? "FORMING"
            : setups.length > 0 &&
                setups.every(
                  (value) =>
                    value.state === "INVALIDATED" || value.state === "EXPIRED",
                )
              ? "INVALIDATED"
              : "ANALYZABLE";
  const timestamps = [
    feature?.timestamp,
    ...setups.map((value) => value.timestamp),
    ...contexts.map((value) => value.timestamp),
  ]
    .filter((value): value is string => Boolean(value))
    .sort();
  const reasons = unavailable
    ? member?.reasons.length
      ? member.reasons
      : ["Candidate was not resolved in the latest intake refresh"]
    : warmupPending.length > 0
      ? warmupPending.map((value) => `Waiting for ${value}`)
      : dataReadiness !== "READY"
        ? [`Market data is ${dataReadiness.toLowerCase()}`]
        : [];
  return {
    symbol,
    status,
    dataReadiness,
    warmupPending: [...warmupPending],
    setupCount: setups.length,
    contextCount: contexts.length,
    latestAnalysisAt: timestamps.at(-1) ?? null,
    reasons,
  };
}
