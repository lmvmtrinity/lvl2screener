import {
  signalModelResearchJobPayloadSchema,
  statisticalPredictionInputSchema,
  type StatisticalModelArtifact,
  type SignalModelResearchTrainingRequest,
  type BacktestTrade,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import type { ScannerFeatureClient } from "../../market-data/scanner-client.js";
import { contentHash } from "../../backtests/research-coverage.js";
import { PostgresBacktestStore } from "../../backtests/backtest-repository.js";
import { evaluateMatchedStrategyEconomics } from "../../backtests/strategy-learning-evaluation.js";
import {
  PostgresCanonicalSignalOpportunityCaptureRepository,
  type CanonicalSignalOpportunityCapture,
} from "../../backtests/signal-model-source-preflight.js";
import { PostgresSignalModelResearchControlStore } from "../../backtests/signal-model-research-control.js";
import { persistCapturedResearchCandidate } from "../../backtests/signal-model-candidate-persistence.js";
import {
  CategorizedError,
  CancelledError,
  type ClaimedResearchJob,
  type JobContext,
  type ResearchJobHandler,
} from "../research-worker.js";

export class SignalModelResearchJobHandler implements ResearchJobHandler {
  constructor(
    private readonly pool: Pool,
    private readonly scanner: ScannerFeatureClient,
  ) {}

  async execute(
    job: ClaimedResearchJob,
    context: JobContext,
  ): Promise<{ resultRefId: string }> {
    const parsed = signalModelResearchJobPayloadSchema.safeParse(
      job.requestPayload,
    );
    if (!parsed.success)
      throw new CategorizedError(
        "VALIDATION",
        `Signal-model job payload invalid: ${parsed.error.message}`,
      );
    const { authorizationId, plan, planHash } = parsed.data;
    const control = new PostgresSignalModelResearchControlStore(this.pool);
    const fence = {
      jobId: job.id,
      leaseOwner: job.leaseOwner,
      attemptCount: job.attemptCount,
    };
    let pending: {
      stage: "TRAIN" | "VALIDATION" | "TEST";
      claimId: string;
    } | null = null;
    const candidateIdentity = contentHash({
      planHash,
      model: plan.model,
      runtime: "signal-model-research-v1",
    });
    try {
      if (contentHash(plan) !== planHash)
        throw new Error("SIGNAL_MODEL_PLAN_HASH_MISMATCH");
      await control.assertJobAuthority({
        authorizationId,
        planHash,
        plan,
        jobId: job.id,
      });
      const priorReport = await this.pool.query<{
        selected_candidate_identity: string | null;
        evaluation: {
          artifact?: StatisticalModelArtifact;
          trainingMetrics?: unknown;
          trainingWarnings?: string[];
        } | null;
      }>(
        "SELECT selected_candidate_identity,evaluation FROM signal_model_research_report WHERE authorization_id=$1",
        [authorizationId],
      );
      if (priorReport.rows.length) {
        const prior = priorReport.rows[0]!;
        if (prior.evaluation?.artifact && prior.selected_candidate_identity)
          await persistCapturedResearchCandidate({
            pool: this.pool,
            authorizationId,
            plan,
            planHash,
            modelVersion: prior.selected_candidate_identity,
            artifact: prior.evaluation.artifact,
            trainMetrics: null,
            testMetrics: null,
            warnings: prior.evaluation.trainingWarnings ?? [],
          });
        return { resultRefId: authorizationId };
      }
      await checkpoint(context, "Loading frozen canonical capture source");
      const scope = {
        runId: plan.source.runId,
        marketId: plan.source.marketId,
        strategy: plan.source.strategy,
        strategyVersion: plan.source.strategyVersion,
        configVersion: plan.source.configVersion,
        profileId: plan.source.profileId,
        profileName: plan.source.profileName,
        executionModelVersion: plan.source.executionModelVersion,
        executionAssumptionsHash: plan.source.executionAssumptionsHash,
      };
      const reader = new PostgresCanonicalSignalOpportunityCaptureRepository(
        this.pool,
        control,
      );
      const source = await reader.loadForSource({
        scope,
        expectedSessions: plan.sessions,
      });
      if (source.status !== "AVAILABLE")
        throw new Error(
          `SIGNAL_MODEL_SOURCE_UNAVAILABLE:${source.reasonCodes.join(",")}`,
        );
      if (
        source.sourceDigest !== plan.source.sourceDigest ||
        source.sourceBindingHash !== plan.source.sourceBindingHash ||
        source.orderedMembershipHash !== plan.source.orderedMembershipHash ||
        source.orderedMembershipCount !== plan.source.orderedMembershipCount ||
        source.testOutcomesReleased
      )
        throw new Error("SIGNAL_MODEL_SOURCE_IDENTITY_MISMATCH");
      const rows = source.orderedCaptures;
      const trainStage = rows.filter((row) => row.stage === "TRAIN");
      const validationStage = rows.filter((row) => row.stage === "VALIDATION");
      const train = trainStage.filter((row) => row.baselineSelected);
      const validation = validationStage.filter((row) => row.baselineSelected);
      assertRows(trainStage, plan.membership.TRAIN.opportunityIds, "TRAIN");
      assertRows(
        validationStage,
        plan.membership.VALIDATION.opportunityIds,
        "VALIDATION",
      );
      const trainClaim = await control.claimStage(
        authorizationId,
        "TRAIN",
        fence,
        stableUuid(authorizationId, "TRAIN-CLAIM"),
        plan.membership.TRAIN.membershipHash,
      );
      pending = { stage: "TRAIN", claimId: trainClaim.claim_id };
      const trainingRows = train.flatMap((row) =>
        row.outcome?.status === "CLOSED" && row.labelAvailableAt
          ? [
              {
                sourceKey: row.opportunityId,
                strategy: plan.source.strategy,
                entryTime: row.outcome.entryTime,
                score: row.predictionInput.deterministicScore,
                atrPct: row.predictionInput.atrPct,
                rvolAtTime: row.predictionInput.rvolAtTime,
                rMultiple: row.outcome.rMultiple,
              },
            ]
          : [],
      );
      const trainingRequest: SignalModelResearchTrainingRequest = {
        sourceKind: "CAPTURED_BACKTEST_RESEARCH",
        marketId: plan.source.marketId,
        strategy: plan.source
          .strategy as SignalModelResearchTrainingRequest["strategy"],
        trainingRows,
        minimumSamples: plan.model.minimumTrainingSamples,
        l2Penalty: plan.model.l2Penalty,
      };
      const trained =
        await this.scanner.trainSignalModelResearch(trainingRequest);
      if (trained.status !== "COMPLETED" || !trained.artifact) {
        await control.appendAttempt({
          authorizationId,
          fence,
          claimId: trainClaim.claim_id,
          attemptId: stableUuid(authorizationId, "TRAIN-ATTEMPT"),
          stage: "TRAIN",
          candidateIdentity,
          status: "INSUFFICIENT_EVIDENCE",
          outcome: {
            warnings: trained.warnings,
            trainingRows: trainingRows.length,
          },
        });
        pending = null;
        await control.recordReport({
          authorizationId,
          fence,
          report: {
            experimentId: plan.experimentId,
            sourceDigest: plan.source.sourceDigest,
            planHash,
            status: "INSUFFICIENT",
            selectedCandidateIdentity: null,
            selectedThreshold: null,
            evaluation: null,
            reasonCodes: trained.warnings,
          },
        });
        return { resultRefId: authorizationId };
      }
      const artifact = trained.artifact;
      const modelIdentity = candidateIdentity;
      await control.appendAttempt({
        authorizationId,
        fence,
        claimId: trainClaim.claim_id,
        attemptId: stableUuid(authorizationId, "TRAIN-ATTEMPT"),
        stage: "TRAIN",
        candidateIdentity: modelIdentity,
        status: "SUCCEEDED",
        outcome: {
          trainingRows: trainingRows.length,
          warnings: trained.warnings,
          artifactHash: contentHash(artifact),
        },
      });
      pending = null;

      await checkpoint(
        context,
        "Selecting threshold on chronological validation only",
      );
      const validationClaim = await control.claimStage(
        authorizationId,
        "VALIDATION",
        fence,
        stableUuid(authorizationId, "VALIDATION-CLAIM"),
        plan.membership.VALIDATION.membershipHash,
      );
      pending = { stage: "VALIDATION", claimId: validationClaim.claim_id };
      const validationScores = await this.predict(
        artifact,
        validation,
        plan.source.strategy,
      );
      const threshold = selectThreshold(
        validation,
        validationScores,
        plan.model.thresholdCandidates,
      );
      const validationResult = summarize(
        validation,
        validationScores,
        threshold,
        plan.comparison.extraCostScenarios,
      );
      await control.appendAttempt({
        authorizationId,
        fence,
        claimId: validationClaim.claim_id,
        attemptId: stableUuid(authorizationId, "VALIDATION-ATTEMPT"),
        stage: "VALIDATION",
        candidateIdentity: modelIdentity,
        status: "SUCCEEDED",
        outcome: {
          selectedCandidateIdentity: modelIdentity,
          selectedThreshold: threshold,
          validation: validationResult,
        },
      });
      pending = null;

      await checkpoint(
        context,
        "Consuming one-use final-test claim before releasing labels",
      );
      const testClaim = await control.claimStage(
        authorizationId,
        "TEST",
        fence,
        stableUuid(authorizationId, "TEST-CLAIM"),
        source.testMembershipHash,
      );
      pending = { stage: "TEST", claimId: testClaim.claim_id };
      const released = await reader.loadTestAfterClaim({
        scope,
        expectedSessions: plan.sessions,
        claimId: testClaim.claim_id,
        expectedTestMembershipHash: source.testMembershipHash,
      });
      if (
        released.status !== "AVAILABLE" ||
        !released.testOutcomesReleased ||
        released.sourceDigest !== source.sourceDigest ||
        released.sourceBindingHash !== source.sourceBindingHash ||
        released.orderedMembershipHash !== source.orderedMembershipHash
      )
        throw new Error(
          `SIGNAL_MODEL_TEST_SOURCE_UNAVAILABLE:${released.status === "AVAILABLE" ? "SOURCE_CHANGED" : released.reasonCodes.join(",")}`,
        );
      const test = released.orderedCaptures.filter(
        (row) => row.stage === "TEST",
      );
      assertRows(test, plan.membership.TEST.opportunityIds, "TEST");
      const testScores = await this.predict(
        artifact,
        test,
        plan.source.strategy,
      );
      const persistedTrades = await loadPersistedClosedTrades(
        this.pool,
        plan.source.runId,
        test,
      );
      const unjoinedClosed = test.some(
        (row) =>
          row.outcome?.status === "CLOSED" &&
          !persistedTrades.has(row.opportunityId),
      );
      const reasons: string[] = [];
      let evaluation: ReturnType<
        typeof evaluateMatchedStrategyEconomics
      > | null = null;
      if (unjoinedClosed) {
        reasons.push("PERSISTED_TRADE_OPPORTUNITY_JOIN_UNPROVEN");
      } else {
        evaluation = evaluateMatchedStrategyEconomics({
          marketId: plan.source.marketId,
          unit: plan.comparison.unit,
          sourceRunId: plan.source.runId,
          coverageStatus: "VERIFIED",
          lineageStatus: "VERIFIED",
          expectedSessions: plan.sessions.TEST,
          expectedOpportunityIds: plan.membership.TEST.opportunityIds,
          minimumSessions: plan.comparison.minimumIndependentSessions,
          bootstrapSamples: plan.comparison.bootstrapSamples,
          blockLength: plan.comparison.blockLength,
          seed: plan.comparison.seed,
          extraCostScenarios: plan.comparison.extraCostScenarios,
          opportunities: test.map((row, index) => ({
            opportunityId: row.opportunityId,
            sessionDate: row.sessionDate,
            symbol: row.symbol,
            regime: null,
            baselineSelected: row.baselineSelected,
            candidateSelected:
              row.baselineSelected && testScores[index]! >= threshold,
            outcome:
              row.outcome?.status === "CLOSED"
                ? {
                    status: "CLOSED" as const,
                    trade: persistedTrades.get(row.opportunityId)!,
                  }
                : row.outcome?.status === "NO_FILL"
                  ? { status: "NO_FILL" as const, reason: row.outcome.reason }
                  : {
                      status: "INVALID" as const,
                      reason:
                        row.outcome?.status === "INVALID"
                          ? row.outcome.reason
                          : "LABEL_UNAVAILABLE",
                    },
          })),
        });
        reasons.push(...evaluation.reasonCodes);
        const matchedEffect =
          evaluation.candidate.meanNetPnlPerSelectedOpportunity === null ||
          evaluation.baseline.meanNetPnlPerSelectedOpportunity === null
            ? null
            : evaluation.candidate.meanNetPnlPerSelectedOpportunity -
              evaluation.baseline.meanNetPnlPerSelectedOpportunity;
        if (
          matchedEffect === null ||
          matchedEffect <
            plan.comparison.minimumUsefulNetPnlPerSelectedOpportunity
        )
          reasons.push("MINIMUM_USEFUL_EFFECT_NOT_MET");
        if (
          evaluation.uncertainty.interval === null ||
          evaluation.uncertainty.interval.lower <
            plan.comparison.minimumUsefulNetPnlPerSelectedOpportunity
        )
          reasons.push("MINIMUM_EFFECT_INTERVAL_NOT_MET");
        if (
          evaluation.candidate.missedWinnerRate === null ||
          evaluation.candidate.missedWinnerRate >
            plan.comparison.maximumMissedWinnerRate
        )
          reasons.push("MISSED_WINNER_RATE_NOT_MET");
        if (
          evaluation.candidate.concentration.largestSymbolShare === null ||
          evaluation.candidate.concentration.largestSymbolShare >
            plan.comparison.maximumLargestSymbolShare
        )
          reasons.push("SYMBOL_CONCENTRATION_LIMIT_NOT_MET");
        if (
          evaluation.candidate.concentration.largestSessionShare === null ||
          evaluation.candidate.concentration.largestSessionShare >
            plan.comparison.maximumLargestSessionShare
        )
          reasons.push("SESSION_CONCENTRATION_LIMIT_NOT_MET");
      }
      // The matched evaluator reports independent-opportunity economics and
      // session uncertainty, but cannot infer portfolio drawdown or turnover
      // from capture rows. Such a report is explicitly insufficient.
      reasons.push("DRAWDOWN_GATE_UNAVAILABLE_FROM_INDEPENDENT_OPPORTUNITIES");
      reasons.push("TURNOVER_GATE_UNAVAILABLE_FROM_INDEPENDENT_OPPORTUNITIES");
      const reportEvaluation = evaluation
        ? {
            ...evaluation,
            riskAssessment: {
              maximumDrawdownIncrease: "UNAVAILABLE",
              maximumTurnoverIncrease: "UNAVAILABLE",
            },
            inactive: true,
            eligibleForActivation: false,
            activationReason: "PROSPECTIVE_GATE_REQUIRED",
            artifact,
            trainingMetrics: trained.train,
            trainingWarnings: trained.warnings,
          }
        : {
            status: "UNAVAILABLE",
            reasonCodes: reasons,
            inactive: true,
            eligibleForActivation: false,
            artifactHash: contentHash(artifact),
            artifact,
            trainingMetrics: trained.train,
            trainingWarnings: trained.warnings,
          };
      const insufficient =
        reasons.length > 0 ||
        evaluation === null ||
        evaluation.uncertainty.status !== "AVAILABLE";
      await control.appendAttempt({
        authorizationId,
        fence,
        claimId: testClaim.claim_id,
        attemptId: stableUuid(authorizationId, "TEST-ATTEMPT"),
        stage: "TEST",
        candidateIdentity: modelIdentity,
        status: insufficient ? "INSUFFICIENT_EVIDENCE" : "SUCCEEDED",
        outcome: {
          selectedCandidateIdentity: modelIdentity,
          selectedThreshold: threshold,
          evaluationHash: contentHash(reportEvaluation),
          reasonCodes: reasons,
        },
      });
      pending = null;
      await control.recordReport({
        authorizationId,
        fence,
        report: {
          experimentId: plan.experimentId,
          sourceDigest: plan.source.sourceDigest,
          planHash,
          status: insufficient ? "INSUFFICIENT" : "COMPLETED",
          selectedCandidateIdentity: modelIdentity,
          selectedThreshold: threshold,
          evaluation: reportEvaluation,
          reasonCodes: reasons,
        },
      });
      await persistCapturedResearchCandidate({
        pool: this.pool,
        authorizationId,
        plan,
        planHash,
        modelVersion: modelIdentity,
        artifact,
        trainMetrics: trained.train,
        testMetrics: trained.test,
        warnings: trained.warnings,
      });
      return { resultRefId: authorizationId };
    } catch (error) {
      const cancelled = error instanceof CancelledError;
      const message = error instanceof Error ? error.message : String(error);
      if (pending) {
        const terminalStatus = cancelled ? "CANCELED" : "INTERRUPTED";
        try {
          await control.appendAttempt({
            authorizationId,
            fence,
            claimId: pending.claimId,
            attemptId: stableUuid(authorizationId, `${pending.stage}-ATTEMPT`),
            stage: pending.stage,
            candidateIdentity,
            status: terminalStatus,
            outcome: { reasonCode: message.slice(0, 200) },
          });
          if (pending.stage === "TEST")
            await control.recordReport({
              authorizationId,
              fence,
              report: {
                experimentId: plan.experimentId,
                sourceDigest: plan.source.sourceDigest,
                planHash,
                status: "INTERRUPTED",
                selectedCandidateIdentity: null,
                selectedThreshold: null,
                evaluation: null,
                reasonCodes: [message.slice(0, 200)],
              },
            });
        } catch {
          /* Lease loss/revocation leaves the charged claim visible and fail-closed. */
        }
      }
      if (cancelled) throw error;
      throw new CategorizedError("VALIDATION", message, { cause: error });
    }
  }

  private async predict(
    artifact: StatisticalModelArtifact,
    rows: readonly CanonicalSignalOpportunityCapture[],
    strategy: string,
  ): Promise<number[]> {
    const inputs = rows.map((row) =>
      statisticalPredictionInputSchema.parse({
        marketId: row.marketId,
        instrumentId: row.instrumentId,
        symbol: row.symbol,
        timestamp: row.predictionInput.timestamp,
        profileId: row.profileId,
        profileName: row.profileName,
        strategy,
        deterministicScore: row.predictionInput.deterministicScore,
        atrPct: row.predictionInput.atrPct,
        rvolAtTime: row.predictionInput.rvolAtTime,
      }),
    );
    const result = await this.scanner.predictStatistical({ artifact, inputs });
    if (result.predictions.length !== rows.length)
      throw new Error("SIGNAL_MODEL_PREDICTION_MEMBERSHIP_MISMATCH");
    return result.predictions.map((prediction, index) => {
      const input = inputs[index]!;
      if (
        prediction.marketId !== input.marketId ||
        prediction.instrumentId !== input.instrumentId ||
        prediction.symbol !== input.symbol ||
        prediction.timestamp !== input.timestamp ||
        prediction.profileId !== input.profileId ||
        prediction.strategy !== input.strategy ||
        prediction.deterministicScore !== input.deterministicScore
      )
        throw new Error("SIGNAL_MODEL_PREDICTION_IDENTITY_MISMATCH");
      return prediction.rankingScore;
    });
  }
}

function assertRows(
  rows: readonly CanonicalSignalOpportunityCapture[],
  expected: readonly string[],
  stage: string,
): void {
  if (
    JSON.stringify(rows.map((row) => row.opportunityId)) !==
    JSON.stringify(expected)
  )
    throw new Error(`SIGNAL_MODEL_${stage}_MEMBERSHIP_MISMATCH`);
}

function selectThreshold(
  rows: readonly CanonicalSignalOpportunityCapture[],
  scores: readonly number[],
  thresholds: readonly number[],
): number {
  if (
    rows.length !== scores.length ||
    rows.some((row) => row.outcome === null || row.outcome.status === "INVALID")
  )
    throw new Error("SIGNAL_MODEL_VALIDATION_LABEL_UNAVAILABLE");
  let selected: { threshold: number; objective: number } | undefined;
  for (const threshold of [...new Set(thresholds)].sort((a, b) => a - b)) {
    const picked = rows.flatMap((row, index) =>
      scores[index]! >= threshold ? [row] : [],
    );
    if (!picked.length) continue;
    const objective =
      picked.reduce(
        (sum, row) =>
          sum +
          (row.outcome?.status === "CLOSED" ? (row.outcome.netPnl ?? 0) : 0),
        0,
      ) / picked.length;
    if (
      !selected ||
      objective > selected.objective ||
      (objective === selected.objective && threshold > selected.threshold)
    )
      selected = { threshold, objective };
  }
  if (!selected)
    throw new Error("SIGNAL_MODEL_VALIDATION_HAS_NO_SELECTED_ROWS");
  return selected.threshold;
}

function summarize(
  rows: readonly CanonicalSignalOpportunityCapture[],
  scores: readonly number[],
  threshold: number,
  costScenarios: readonly {
    extraSlippageBps: number;
    extraFeePerTrade: number;
  }[],
) {
  if (rows.length !== scores.length || rows.some((row) => row.outcome === null))
    throw new Error("SIGNAL_MODEL_EVALUATION_LABEL_UNAVAILABLE");
  const winnerIds = rows
    .filter(
      (row) =>
        row.baselineSelected &&
        row.outcome?.status === "CLOSED" &&
        (row.outcome.netPnl ?? 0) > 0,
    )
    .map((row) => row.opportunityId);
  const selectedRows = rows.flatMap((row, index) =>
    row.baselineSelected && scores[index]! >= threshold ? [row] : [],
  );
  const selectedWinners = new Set(
    selectedRows
      .filter((row) => winnerIds.includes(row.opportunityId))
      .map((row) => row.opportunityId),
  );
  const closed = selectedRows.filter((row) => row.outcome?.status === "CLOSED");
  const net = (cost: { extraSlippageBps: number; extraFeePerTrade: number }) =>
    selectedRows.reduce(
      (sum, row) =>
        sum +
        (row.outcome?.status === "CLOSED"
          ? (row.outcome.netPnl ?? 0) -
            (row.outcome.entryPrice *
              row.outcome.shares *
              cost.extraSlippageBps) /
              10_000 -
            cost.extraFeePerTrade
          : 0),
      0,
    );
  const candidateNetPnl = net({ extraSlippageBps: 0, extraFeePerTrade: 0 });
  const baselineRows = rows.filter((row) => row.baselineSelected);
  const baselineNetPnl = baselineRows.reduce(
    (sum, row) =>
      sum + (row.outcome?.status === "CLOSED" ? (row.outcome.netPnl ?? 0) : 0),
    0,
  );
  const missedWinnerRate = winnerIds.length
    ? (winnerIds.length - selectedWinners.size) / winnerIds.length
    : null;
  return {
    denominators: {
      matchedOpportunities: rows.length,
      closedOutcomes: rows.filter((row) => row.outcome?.status === "CLOSED")
        .length,
      noFillOutcomes: rows.filter((row) => row.outcome?.status === "NO_FILL")
        .length,
      invalidOutcomes: rows.filter((row) => row.outcome?.status === "INVALID")
        .length,
      rejectedByCandidate: rows.length - selectedRows.length,
      rejectedWinners: winnerIds.length - selectedWinners.size,
      missedWinnerDenominator: winnerIds.length,
    },
    baseline: {
      selectedOpportunities: baselineRows.length,
      netPnl: baselineNetPnl,
      meanNetPnlPerSelectedOpportunity: baselineRows.length
        ? baselineNetPnl / baselineRows.length
        : null,
    },
    candidate: {
      selectedOpportunities: selectedRows.length,
      closedOutcomes: closed.length,
      netPnl: candidateNetPnl,
      meanNetPnlPerSelectedOpportunity: selectedRows.length
        ? candidateNetPnl / selectedRows.length
        : null,
      missedWinnerRate,
      costSensitivity: costScenarios.map((cost) => ({
        ...cost,
        netPnl: net(cost),
      })),
    },
    uncertainty: {
      status: "UNAVAILABLE",
      estimate: null,
      interval: null,
      independentSessions: new Set(rows.map((row) => row.sessionDate)).size,
      reason: "BLOCK_BOOTSTRAP_NOT_IMPLEMENTED",
    },
    reasonCodes: selectedRows.length ? [] : ["NO_CANDIDATE_SELECTED_ROWS"],
  };
}

async function checkpoint(context: JobContext, message: string): Promise<void> {
  const result = await context.heartbeat({ message });
  if (result.cancellationRequested)
    throw new CancelledError("Signal-model research job cancelled");
}

function stableUuid(namespace: string, name: string): string {
  const hex = contentHash({ namespace, name }).slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function loadPersistedClosedTrades(
  pool: Pool,
  sourceRunId: string,
  rows: readonly CanonicalSignalOpportunityCapture[],
): Promise<Map<string, BacktestTrade>> {
  const result = new Map<string, BacktestTrade>();
  const closedRows = rows.filter((row) => row.outcome?.status === "CLOSED");
  if (!closedRows.length) return result;
  const run = await new PostgresBacktestStore(pool).get(sourceRunId);
  if (
    !run ||
    run.id !== sourceRunId ||
    run.status !== "COMPLETED" ||
    run.dataSource !== "CAPTURED_QUOTES"
  )
    return result;
  for (const capture of closedRows) {
    // Captures with no stable setup ID fall back to event ID and cannot prove a
    // BacktestTrade relationship. Never synthesize a trade from capture fields.
    const setupId = capture.opportunityId;
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        setupId,
      )
    )
      continue;
    const event = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM backtest_state_event
       WHERE run_id=$1 AND setup_instance_id=$2 AND instrument_id=$3
         AND strategy_name=$4 AND timestamp=$5 AND score=$6 AND symbol=$7`,
      [
        sourceRunId,
        setupId,
        capture.instrumentId,
        capture.strategy,
        capture.predictionInput.timestamp,
        capture.predictionInput.deterministicScore,
        capture.symbol,
      ],
    );
    if (event.rows[0]?.count !== "1") continue;
    const matches = run.trades.filter(
      (trade) =>
        trade.setupInstanceId === setupId &&
        trade.runId === sourceRunId &&
        trade.strategy === capture.strategy &&
        trade.instrumentId === capture.instrumentId &&
        trade.symbol === capture.symbol &&
        trade.signalTimestamp === capture.predictionInput.timestamp &&
        trade.score === capture.predictionInput.deterministicScore,
    );
    if (matches.length !== 1) continue;
    const trade = matches[0]!;
    const outcome = capture.outcome!;
    if (
      outcome.status !== "CLOSED" ||
      Date.parse(trade.entryTime) !== Date.parse(outcome.entryTime) ||
      Date.parse(trade.exitTime) !== Date.parse(outcome.exitTime) ||
      trade.entryPrice !== outcome.entryPrice ||
      trade.exitPrice !== outcome.exitPrice ||
      trade.shares !== outcome.shares ||
      trade.netPnl !== outcome.netPnl ||
      trade.rMultiple !== outcome.rMultiple
    )
      continue;
    result.set(capture.opportunityId, trade);
  }
  return result;
}
