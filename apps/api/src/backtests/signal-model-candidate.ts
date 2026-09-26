import {
  AUTHORITATIVE_EXECUTION_MODEL_VERSION,
  type BacktestRun,
  type BacktestTrade,
  type MarketId,
  type StatisticalModelArtifact,
  type StatisticalPredictionInput,
} from "@tsx-scanner/contracts";
import {
  evaluateMatchedStrategyEconomics,
  type MatchedStrategyEvaluation,
  type MatchedStrategyOpportunity,
} from "./strategy-learning-evaluation.js";
import type { StatisticalModelEngine } from "../statistical-models/statistical-model-service.js";
import { contentHash } from "./research-coverage.js";

export type SignalModelOutcome =
  | { status: "CLOSED"; trade: BacktestTrade }
  | { status: "NO_FILL"; reason: string }
  | { status: "INVALID"; reason: string };

export type SignalModelOpportunity = {
  opportunityId: string;
  stage: "TRAIN" | "VALIDATION" | "TEST";
  sessionDate: string;
  symbol: string;
  baselineSelected: boolean;
  /** Retained replay/evidence identity for every outcome, including no-fills and invalid rows. */
  evidenceSource: { sourceRunId: string; evidenceId: string };
  predictionInput: StatisticalPredictionInput;
  outcome: SignalModelOutcome;
};

export type FinalTestClaimRequest = {
  claimId: string;
  sourceRunId: string;
  marketId: MarketId;
  membershipHash: string;
};

export interface FinalTestClaimVerifier {
  /** Must validate the existing study selection and atomically consume its one-use TEST claim. */
  consumeFinalTestClaim(
    request: FinalTestClaimRequest,
  ): Promise<FinalTestClaimRequest | null>;
}

export type SignalModelCandidateInput = {
  source: BacktestRun;
  strategy: BacktestTrade["strategy"];
  coverageStatus: "VERIFIED" | "MISSING";
  lineageStatus: "VERIFIED" | "UNVERIFIED";
  expectedSessions: Record<SignalModelOpportunity["stage"], readonly string[]>;
  expectedOpportunityIds: Record<
    SignalModelOpportunity["stage"],
    readonly string[]
  >;
  /** TRAIN and VALIDATION only; TEST rows stay behind the durable claim. */
  opportunities: readonly SignalModelOpportunity[];
  loadTestOpportunities: () => Promise<{
    opportunities: readonly SignalModelOpportunity[];
    persistedTrades: readonly BacktestTrade[];
  }>;
  minimumTrainingSamples: number;
  thresholdCandidates: readonly number[];
  expectedTestMembershipHash: string;
  finalTestClaimId: string | null;
};

export function signalModelTestMembershipHash(input: {
  sourceRunId: string;
  marketId: MarketId;
  sessionDates: readonly string[];
  opportunityIds: readonly string[];
}): string {
  return contentHash({
    sourceRunId: input.sourceRunId,
    marketId: input.marketId,
    sessionDates: [...input.sessionDates],
    opportunityIds: [...input.opportunityIds],
  });
}

export type InactiveSignalModelCandidate = {
  status: "TESTED_INACTIVE";
  sourceRunId: string;
  marketId: MarketId;
  strategy: BacktestTrade["strategy"];
  artifact: StatisticalModelArtifact;
  threshold: number;
  thresholdSelection: "VALIDATION_NET_PNL_PER_SELECTED_OPPORTUNITY";
  finalTestClaimId: string;
  evaluation: MatchedStrategyEvaluation;
  /** Research candidates never enter the activation registry. */
  active: false;
  eligibleForActivation: false;
  activationReason: "PROSPECTIVE_GATE_REQUIRED";
};

export class SignalModelCandidateService {
  constructor(
    private readonly engine: StatisticalModelEngine,
    private readonly finalTestGate: FinalTestClaimVerifier,
  ) {}

  async evaluate(
    input: SignalModelCandidateInput,
  ): Promise<InactiveSignalModelCandidate> {
    validateInput(input, false);
    const training = input.opportunities.filter(
      (row) => row.stage === "TRAIN" && row.outcome.status === "CLOSED",
    );
    const trained = await this.engine.trainStatistical({
      marketId: input.source.marketId,
      strategy: input.strategy,
      trades: training.map(
        (row) => (row.outcome as { trade: BacktestTrade }).trade,
      ),
      trainPct: 80,
      minimumSamples: input.minimumTrainingSamples,
      l2Penalty: 0.1,
    });
    if (trained.status !== "COMPLETED" || !trained.artifact)
      throw new Error("TRAINING_INSUFFICIENT_DATA");

    const artifact = trained.artifact;
    const validation = input.opportunities.filter(
      (row) => row.stage === "VALIDATION",
    );
    const validationPredictions = await predict(
      this.engine,
      artifact,
      validation,
    );
    const threshold = selectValidationThreshold(
      validation,
      validationPredictions,
      input.thresholdCandidates,
    );

    if (!input.finalTestClaimId) throw new Error("FINAL_TEST_CLAIM_REQUIRED");
    const membershipHash = signalModelTestMembershipHash({
      sourceRunId: input.source.id,
      marketId: input.source.marketId,
      sessionDates: input.expectedSessions.TEST,
      opportunityIds: input.expectedOpportunityIds.TEST,
    });
    if (input.expectedTestMembershipHash !== membershipHash)
      throw new Error("FINAL_TEST_MEMBERSHIP_HASH_MISMATCH");
    const claim = await this.finalTestGate.consumeFinalTestClaim({
      claimId: input.finalTestClaimId,
      sourceRunId: input.source.id,
      marketId: input.source.marketId,
      membershipHash,
    });
    if (
      !claim ||
      claim.claimId !== input.finalTestClaimId ||
      claim.sourceRunId !== input.source.id ||
      claim.marketId !== input.source.marketId ||
      claim.membershipHash !== membershipHash
    )
      throw new Error("FINAL_TEST_CLAIM_INVALID");

    const loadedTest = await input.loadTestOpportunities();
    const test = [...loadedTest.opportunities];
    if (test.some((row) => row.stage !== "TEST"))
      throw new Error("TEST_LOADER_RETURNED_NON_TEST_ROW");
    validateInput({
      ...input,
      source: {
        ...input.source,
        trades: [...input.source.trades, ...loadedTest.persistedTrades],
      },
      opportunities: [...input.opportunities, ...test],
    });
    const testPredictions = await predict(this.engine, artifact, test);
    const evaluationInput: Parameters<
      typeof evaluateMatchedStrategyEconomics
    >[0] = {
      marketId: input.source.marketId,
      unit: input.source.marketId === "CA_TSX" ? "CAD" : "USD",
      sourceRunId: input.source.id,
      coverageStatus: input.coverageStatus,
      lineageStatus: input.lineageStatus,
      expectedSessions: input.expectedSessions.TEST,
      expectedOpportunityIds: input.expectedOpportunityIds.TEST,
      minimumSessions: 2,
      bootstrapSamples: 1_000,
      blockLength: 1,
      seed: 17,
      extraCostScenarios: [],
      opportunities: test.map((row, index) => ({
        opportunityId: row.opportunityId,
        sessionDate: row.sessionDate,
        symbol: row.symbol,
        regime: null,
        baselineSelected: row.baselineSelected,
        candidateSelected:
          row.baselineSelected && testPredictions[index]! >= threshold,
        outcome: row.outcome,
      })) as MatchedStrategyOpportunity[],
    };
    return {
      status: "TESTED_INACTIVE",
      sourceRunId: input.source.id,
      marketId: input.source.marketId,
      strategy: input.strategy,
      artifact,
      threshold,
      thresholdSelection: "VALIDATION_NET_PNL_PER_SELECTED_OPPORTUNITY",
      finalTestClaimId: claim.claimId,
      evaluation: evaluateMatchedStrategyEconomics(evaluationInput),
      active: false,
      eligibleForActivation: false,
      activationReason: "PROSPECTIVE_GATE_REQUIRED",
    };
  }
}

async function predict(
  engine: StatisticalModelEngine,
  artifact: StatisticalModelArtifact,
  rows: readonly SignalModelOpportunity[],
): Promise<number[]> {
  const result = await engine.predictStatistical({
    artifact,
    inputs: rows.map((row) => row.predictionInput),
  });
  if (result.predictions.length !== rows.length)
    throw new Error("PREDICTION_MEMBERSHIP_MISMATCH");
  return result.predictions.map((value, index) => {
    if (
      value.marketId !== rows[index]!.predictionInput.marketId ||
      value.strategy !== rows[index]!.predictionInput.strategy ||
      value.symbol !== rows[index]!.symbol ||
      value.instrumentId !== rows[index]!.predictionInput.instrumentId ||
      value.timestamp !== rows[index]!.predictionInput.timestamp ||
      value.profileId !== rows[index]!.predictionInput.profileId ||
      value.profileName !== rows[index]!.predictionInput.profileName ||
      value.deterministicScore !==
        rows[index]!.predictionInput.deterministicScore
    )
      throw new Error("PREDICTION_IDENTITY_MISMATCH");
    return value.rankingScore;
  });
}

function selectValidationThreshold(
  rows: readonly SignalModelOpportunity[],
  scores: readonly number[],
  thresholds: readonly number[],
): number {
  if (
    rows.some((row) => row.baselineSelected && row.outcome.status === "INVALID")
  )
    throw new Error("VALIDATION_SELECTED_OUTCOME_INVALID");
  let selected: { threshold: number; objective: number } | undefined;
  for (const threshold of [...new Set(thresholds)].sort((a, b) => a - b)) {
    const included = rows.flatMap((row, index) =>
      row.baselineSelected && scores[index]! >= threshold ? [row] : [],
    );
    if (!included.length) continue;
    const objective =
      included.reduce(
        (sum, row) =>
          sum +
          (row.outcome.status === "CLOSED" ? row.outcome.trade.netPnl : 0),
        0,
      ) / included.length;
    if (
      !selected ||
      objective > selected.objective ||
      (objective === selected.objective && threshold > selected.threshold)
    )
      selected = { threshold, objective };
  }
  if (!selected) throw new Error("VALIDATION_HAS_NO_USABLE_OUTCOMES");
  return selected.threshold;
}

function validateInput(
  input: SignalModelCandidateInput,
  requireTest = true,
): void {
  const { source } = input;
  if (
    source.status !== "COMPLETED" ||
    source.dataSource !== "CAPTURED_QUOTES" ||
    source.executionModelVersion !== AUTHORITATIVE_EXECUTION_MODEL_VERSION ||
    source.dataQuality?.spread !== "CAPTURED"
  )
    throw new Error("BACKTEST_NOT_AUTHORITATIVE_CAPTURED_QUOTES");
  if (!source.strategies.includes(input.strategy))
    throw new Error("STRATEGY_NOT_IN_BACKTEST");
  if (input.coverageStatus !== "VERIFIED" || input.lineageStatus !== "VERIFIED")
    throw new Error("SOURCE_COVERAGE_OR_LINEAGE_UNVERIFIED");
  if (
    !Number.isInteger(input.minimumTrainingSamples) ||
    input.minimumTrainingSamples < 20
  )
    throw new Error("MINIMUM_TRAINING_SAMPLES_TOO_LOW");
  if (
    !input.thresholdCandidates.length ||
    input.thresholdCandidates.some(
      (value) => !Number.isFinite(value) || value < 0 || value > 100,
    )
  )
    throw new Error("INVALID_THRESHOLD_CANDIDATES");

  const sourceTrades = new Map(source.trades.map((row) => [row.id, row]));
  if (
    sourceTrades.size !== source.trades.length ||
    source.trades.some((row) => row.runId !== source.id)
  )
    throw new Error("BACKTEST_TRADE_MEMBERSHIP_INVALID");
  const byStage = new Map<string, SignalModelOpportunity[]>();
  const allOpportunityIds = new Set<string>();
  for (const row of input.opportunities) {
    if (!row.opportunityId || allOpportunityIds.has(row.opportunityId))
      throw new Error("DUPLICATE_OR_EMPTY_OPPORTUNITY_ID");
    allOpportunityIds.add(row.opportunityId);
    if (
      !row.evidenceSource.evidenceId ||
      row.evidenceSource.sourceRunId !== source.id
    )
      throw new Error("OUTCOME_SOURCE_IDENTITY_REQUIRED");
    if (
      row.predictionInput.marketId !== source.marketId ||
      row.predictionInput.strategy !== input.strategy
    )
      throw new Error("MARKET_MISMATCH");
    if (!row.baselineSelected)
      throw new Error("OPPORTUNITY_NOT_SELECTED_BY_BASELINE");
    if (row.predictionInput.symbol !== row.symbol)
      throw new Error("OPPORTUNITY_SYMBOL_MISMATCH");
    if (
      marketSessionDate(row.predictionInput.timestamp, source.marketId) !==
      row.sessionDate
    )
      throw new Error("OPPORTUNITY_SESSION_MISMATCH");
    if (row.outcome.status === "CLOSED") {
      const persisted = sourceTrades.get(row.outcome.trade.id);
      if (
        !persisted ||
        row.outcome.trade.runId !== source.id ||
        persisted.runId !== source.id ||
        persisted.symbol !== row.symbol ||
        persisted.strategy !== input.strategy ||
        contentHash(persisted) !== contentHash(row.outcome.trade)
      )
        throw new Error("CLOSED_OUTCOME_SOURCE_MISMATCH");
    }
    const rows = byStage.get(row.stage) ?? [];
    rows.push(row);
    byStage.set(row.stage, rows);
  }
  const dates: string[] = [];
  const stages: SignalModelOpportunity["stage"][] = requireTest
    ? ["TRAIN", "VALIDATION", "TEST"]
    : ["TRAIN", "VALIDATION"];
  for (const stage of stages) {
    const rows = byStage.get(stage) ?? [];
    const expectedIds = input.expectedOpportunityIds[stage];
    const expectedSessions = input.expectedSessions[stage];
    const ids = rows.map((row) => row.opportunityId);
    if (
      new Set(ids).size !== ids.length ||
      new Set(expectedIds).size !== expectedIds.length ||
      ids.length !== expectedIds.length ||
      expectedIds.some((id) => !ids.includes(id))
    )
      throw new Error(`${stage}_OPPORTUNITY_MEMBERSHIP_MISMATCH`);
    if (
      !expectedSessions.length ||
      rows.some((row) => !expectedSessions.includes(row.sessionDate)) ||
      expectedSessions.some((date) => dates.includes(date)) ||
      expectedSessions.some(
        (date, index) =>
          !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
          (index > 0 && expectedSessions[index - 1]! >= date),
      ) ||
      new Set(expectedSessions).size !== expectedSessions.length
    )
      throw new Error(`${stage}_SESSION_MEMBERSHIP_MISMATCH`);
    dates.push(...expectedSessions);
    if (
      rows.some(
        (row) =>
          row.outcome.status === "CLOSED" &&
          row.outcome.trade.netPnl === undefined,
      )
    )
      throw new Error("INVALID_SUPERVISED_LABEL");
  }
  if (
    input.expectedSessions.TRAIN.at(-1)! >=
      input.expectedSessions.VALIDATION[0]! ||
    input.expectedSessions.VALIDATION.at(-1)! >= input.expectedSessions.TEST[0]!
  )
    throw new Error("CHRONOLOGICAL_SPLIT_INVALID");
  const training = byStage.get("TRAIN") ?? [];
  if (
    training.some(
      (row) =>
        row.outcome.status === "CLOSED" &&
        marketSessionDate(row.outcome.trade.exitTime, source.marketId) >=
          input.expectedSessions.VALIDATION[0]!,
    )
  )
    throw new Error("TRAIN_LABEL_UNAVAILABLE_BEFORE_VALIDATION");
  const validation = byStage.get("VALIDATION") ?? [];
  if (
    validation.some(
      (row) =>
        row.outcome.status === "CLOSED" &&
        marketSessionDate(row.outcome.trade.exitTime, source.marketId) >=
          input.expectedSessions.TEST[0]!,
    )
  )
    throw new Error("VALIDATION_LABEL_UNAVAILABLE_BEFORE_TEST");
}

function marketSessionDate(timestamp: string, marketId: MarketId): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "INVALID";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: marketId === "CA_TSX" ? "America/Toronto" : "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${value.year}-${value.month}-${value.day}`;
}
