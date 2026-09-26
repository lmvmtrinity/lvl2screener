import {
  challengerScopeSchema,
  type ChallengerScope,
  type MarketId,
} from "@tsx-scanner/contracts";

export function buildCapturedResearchProspectiveScope(input: {
  marketId: MarketId;
  strategy: string;
  strategyVersion: string;
  profileId: string;
  configVersion: string;
  executionModelVersion: string;
  executionAssumptionsHash: string;
  signalSemanticsVersions: readonly (string | null)[];
}): ChallengerScope {
  const semantics = input.signalSemanticsVersions;
  if (
    semantics.length === 0 ||
    semantics.some((value) => !value || value === "UNKNOWN")
  )
    throw new Error("SIGNAL_MODEL_CANDIDATE_SEMANTICS_UNPROVEN");
  if (new Set(semantics).size !== 1)
    throw new Error("SIGNAL_MODEL_CANDIDATE_SEMANTICS_MISMATCH");
  return challengerScopeSchema.parse({
    marketId: input.marketId,
    currency: input.marketId === "CA_TSX" ? "CAD" : "USD",
    strategy: input.strategy,
    strategyVersion: input.strategyVersion,
    profileConfigId: input.profileId,
    configVersion: input.configVersion,
    executionModelVersion: input.executionModelVersion,
    executionAssumptionsHash: input.executionAssumptionsHash,
    signalSemanticsVersion: semantics[0],
    replayScope: "FORWARD_LIVE",
  });
}
