import { describe, expect, it, vi } from "vitest";
import {
  FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
  createBacktestSchema,
  fundedComparisonFailureReceiptSchema,
  fundedComparisonPolicyEvaluationSchema,
  fundedComparisonRunBindingSchema,
  fundedComparisonSessionMetricSchema,
  type FundedComparisonFailureReceipt,
  type FundedComparisonJobPayload,
  type FundedComparisonPolicyEvaluation,
  type FundedComparisonResult,
  type FundedComparisonRunBinding,
  type FundedComparisonSessionMetric,
  type FundedComparisonSide,
  type FundedComparisonSourceOpportunity,
  type FundedComparisonSpecification,
} from "@tsx-scanner/contracts";
import {
  FundedComparisonIncompleteError,
  FundedComparisonService,
  type FundedComparisonEvidenceSource,
  type FundedComparisonPairedRunner,
  type FundedComparisonSideSessionEvidence,
} from "../src/paper-bot/funded-comparison-service.js";
import { FundedComparisonChampionError } from "../src/paper-bot/funded-comparison-champion.js";
import {
  FundedComparisonRepository,
  FundedComparisonRepositoryError,
  type FundedComparisonSpecificationReceipt,
} from "../src/paper-bot/funded-comparison-repository.js";
import { buildFundedComparisonSpecification } from "../src/paper-bot/funded-comparison-specification.js";
import {
  chunkFundedComparisonItems,
  projectFundedComparisonSessionItems,
  sessionInputDigestOf,
} from "../src/paper-bot/funded-comparison-input-freezer.js";
import {
  fundedComparisonEvaluationDigest,
  fundedComparisonMetricDigest,
} from "../src/paper-bot/funded-comparison-digest.js";
import { contentHash } from "../src/paper-bot/funded-evidence-digest.js";
import {
  assembleComparisonResult,
  assembleSideMetrics,
} from "../src/paper-bot/funded-comparison-metrics.js";
import { CancelledError } from "../src/worker/research-worker.js";
import {
  LeaseLostError,
  type ClaimedResearchJob,
  type ResearchJobRepository,
} from "../src/research-jobs/research-job-repository.js";
import {
  FundedComparisonJobHandler,
  buildFundedComparisonJobPayload,
} from "../src/worker/handlers/funded-comparison-job-handler.js";
import { ResearchWorker } from "../src/worker/research-worker.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);
const marketId = "CA_TSX" as const;
const sessionDates = ["2026-09-14", "2026-09-15"] as const;
const trainingDates = ["2026-09-09", "2026-09-10"];
const specId = "00000000-0000-4000-8000-000000000132";

function observation(sessionDate: string, setupInstanceId: string) {
  return {
    runId: "baseline-run-1",
    sourceEventId: `source-event-${setupInstanceId}`,
    sourceSignalId: null,
    setupInstanceId,
    instrumentId: "instrument-1",
    symbol: "FP03",
    profileId: "profile-1",
    profileName: "fp03",
    profileConfigId: "profile-config-1",
    configVersion: "config-1",
    profileParameters: { scoreCutoff: 60 },
    strategyKey: "ORB_RETEST",
    strategyVersion: "2026-09-01",
    signalTimestamp: `${sessionDate}T14:30:00.000Z`,
    score: 70,
    entryReference: 10,
    stopReference: 9.8,
    targetReference: 10.5,
    atr14: 0.2,
    featureSnapshot: { featureVersion: "features-v1", atr14: 0.2 },
    reasonCodes: ["BREAKOUT"],
    sourceEventPayload: { signalSemanticsVersion: "setup-semantics-v2" },
    eligibilityStatus: "ELIGIBLE" as const,
    eligibilityReason: null,
  };
}

function buildFixture() {
  const sessions = sessionDates.map((sessionDate) => {
    const projection = projectFundedComparisonSessionItems({
      baselineRunId: "baseline-run-1",
      sessionDate,
      sessionStartAt: `${sessionDate}T13:30:00.000Z`,
      scheduledCloseAt: `${sessionDate}T20:00:00.000Z`,
      sessionTimezone: "America/Toronto",
      observations: [observation(sessionDate, `setup-${sessionDate}`)],
      quotes: [
        {
          instrumentId: "instrument-1",
          timestamp: `${sessionDate}T14:30:30.000Z`,
          bid: 10,
          ask: 10.02,
          bidSize: 500,
          askSize: 500,
          sizeUnit: "SHARES",
          sizeMultiplier: null,
          isDelayed: false,
          isHalted: false,
          source: "QUESTRADE",
        },
      ],
      invalidations: [],
      contextsFor: () => [
        {
          signalKey: "MARKET_RELATIVE_STRENGTH",
          status: "STRONG",
          timestamp: `${sessionDate}T14:25:00.000Z`,
          benchmarkTimestamp: null,
        },
      ],
    });
    const chunks = chunkFundedComparisonItems(sessionDate, projection.items);
    return {
      sessionDate,
      sessionStartAt: `${sessionDate}T13:30:00.000Z`,
      scheduledCloseAt: `${sessionDate}T20:00:00.000Z`,
      sessionTimezone: "America/Toronto",
      itemCount: projection.items.length,
      chunkCount: chunks.length,
      sessionInputDigest: sessionInputDigestOf(sessionDate, chunks),
      chunks,
      opportunities: projection.opportunities,
    };
  });
  const opportunities = sessions.flatMap((session) => session.opportunities);
  const specification = buildFundedComparisonSpecification({
    marketId,
    baseline: {
      backtestRunId: "baseline-run-1",
      configVersion: "config-1",
      strategyKeys: ["ORB_RETEST"],
      startDate: "2026-09-10",
      endDate: "2026-09-15",
      executionModelVersion: "execution-v1",
      replayInputDigest: digestA,
      baselineResultDigest: digestB,
      completedAt: "2026-09-15T20:30:00.000Z",
    },
    sessionDates: [...sessionDates],
    sessions: sessions.map((session) => ({
      sessionDate: session.sessionDate,
      itemCount: session.itemCount,
      chunkCount: session.chunkCount,
      sessionInputDigest: session.sessionInputDigest,
    })),
    replay: {
      request: createBacktestSchema.parse({
        name: "baseline",
        marketId,
        startDate: "2026-09-10",
        endDate: "2026-09-15",
        strategies: ["ORB_RETEST"],
        symbols: [],
        startingCapital: 25_000,
        positionSize: 1_000,
        slippageBps: 5,
        feePerTrade: 1,
        parameters: {
          ...createBacktestSchema.parse({
            name: "x",
            startDate: "2026-09-10",
            endDate: "2026-09-15",
          }).parameters,
          scoreCutoff: 60,
        },
      }),
      profiles: [
        {
          strategyKey: "ORB_RETEST",
          profileId: "profile-1",
          profileName: "fp03",
          profileConfigId: "profile-config-1",
          configVersion: "config-1",
        },
      ],
    },
    opportunities,
    champion: {
      kind: "DETERMINISTIC_FUNDED_POLICY",
      fundedPolicyVersion: "funded-cash-v1",
      portfolioPolicyVersion: "funded-portfolio-v2",
      policyDigest: digestA,
      sourceLiveRunId: "live-run-1",
      sourceAccountId: "live-account-1",
      executionModelVersion: "execution-v1",
      costPolicyVersion: "test-cost-policy-v1",
      participationVersion: "participation-v1",
      runtimeVersion: "runtime-v1",
      accountAssumptionDigest: digestB,
      assumptionsDigest: digestC,
    },
    challenger: {
      kind: "FUNDED_EXECUTION_POLICY_V1",
      policyVersion: FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
      policyDigest: digestB,
      model: {
        modelId: "challenger-1",
        modelVersion: "funded-execution-v1",
        artifactDigest: digestA,
        datasetDigest: digestC,
        cohortDigest: digestB,
        featureVersion: "funded-execution-features-v1",
        predictionPolicyVersion: "funded-execution-prediction-v1",
        trainingPartitionDigest: digestA,
        trainingEvidenceCutoffAt: "2026-09-10T20:00:00.000Z",
        trainingSessionDigest: contentHash(trainingDates),
      },
    },
    capital: {
      initialCash: 25_000,
      dailyLossLimit: 2_500,
      riskConfigurationDigest: digestA,
    },
    training: {
      trainingSessionDates: trainingDates,
      trainingKnowledgeCutoffAt: "2026-09-10T20:00:00.000Z",
      trainingPartitionDigest: digestA,
      trainingSessionDigest: contentHash(trainingDates),
    },
    lastInputEffectiveAt: "2026-09-15T20:00:00.000Z",
    evidenceCutoffAt: "2026-09-15T21:00:00.000Z",
    specificationFrozenAt: "2026-09-15T22:00:00.000Z",
  });
  const receipt: FundedComparisonSpecificationReceipt = {
    specification,
    specId,
    sessions: sessions.map((session, index) => ({
      ...session,
      ordinal: index + 1,
    })),
    opportunities,
  };
  return { specification, receipt, sessions, opportunities };
}

const fixture = buildFixture();

function bindingOf(
  side: FundedComparisonSide,
  sessionDate: string,
): FundedComparisonRunBinding {
  return fundedComparisonRunBindingSchema.parse({
    specId,
    side,
    sessionDate,
    runId: `run-${side}-${sessionDate}`,
    accountId: `account-${side}`,
    marketId,
    currency: "CAD",
    policyDigest:
      side === "CHAMPION"
        ? fixture.specification.champion.policyDigest
        : fixture.specification.challenger.policyDigest,
    executionModelVersion: fixture.specification.champion.executionModelVersion,
    accountAssumptionDigest:
      fixture.specification.champion.accountAssumptionDigest,
    boundAt: `${sessionDate}T13:30:00.000Z`,
  });
}

function evaluationOf(
  side: FundedComparisonSide,
  sessionDate: string,
  opportunity: FundedComparisonSourceOpportunity,
): FundedComparisonPolicyEvaluation {
  const withoutDigest = {
    specId,
    side,
    sessionDate,
    sourceOpportunityId: opportunity.sourceOpportunityId,
    sourceOrdinal: opportunity.sourceOrdinal,
    signalTimestamp: opportunity.signalTimestamp,
    batchKey: opportunity.signalTimestamp,
    championRank: opportunity.sourceOrdinal,
    appliedRank: opportunity.sourceOrdinal,
    destinationRunId: `run-${side}-${sessionDate}`,
    destinationObservationId: `observation-${side}-${opportunity.sourceOpportunityId}`,
    disposition: "CHAMPION_ORDER" as const,
    fallbackReason: null,
    prediction: null,
  };
  return fundedComparisonPolicyEvaluationSchema.parse({
    ...withoutDigest,
    evaluationDigest: fundedComparisonEvaluationDigest(withoutDigest),
  });
}

const allBindings = sessionDates.flatMap((sessionDate) => [
  bindingOf("CHAMPION", sessionDate),
  bindingOf("CHALLENGER", sessionDate),
]);

const allEvaluations = sessionDates.flatMap((sessionDate) =>
  (["CHAMPION", "CHALLENGER"] as const).flatMap((side) =>
    fixture.opportunities
      .filter((opportunity) => opportunity.sessionDate === sessionDate)
      .map((opportunity) => evaluationOf(side, sessionDate, opportunity)),
  ),
);

function sideEvidence(
  sessionDate: string,
): FundedComparisonSideSessionEvidence {
  return {
    valuation: {
      equityPoints: [
        { at: `${sessionDate}T13:30:00.000Z`, equity: 25_000 },
        { at: `${sessionDate}T20:00:00.000Z`, equity: 25_100 },
      ],
      maxDrawdown: 0,
      maxDrawdownPctOfInitialCash: 0,
      staleMarkPoints: 0,
      integrityFindings: [],
      status: "PROVEN",
      reason: null,
    },
    carryInEquity: 25_000,
    dailyLossLimit: 2_500,
    dailyPnl: 100,
    entriesAllowed: true,
    openRisk: 0,
    grossNotional: 0,
    openPositions: 0,
    zeroTradeSessions: true,
    decisions: [],
    orders: [],
  };
}

function metricOf(
  side: FundedComparisonSide,
  sessionDate: string,
): FundedComparisonSessionMetric {
  const withoutDigest = {
    specId,
    side,
    sessionDate,
    marketId,
    currency: "CAD" as const,
    valuation: "UNION_GRID_MTM" as const,
    valuationReason: null,
    netReturn: 100,
    maxDrawdown: 0,
    tradeCount: 0,
    unrealizedPositionCount: 0,
    unresolvedOrderCount: 0,
    unresolvedReservationCount: 0,
    staleMarkCount: 0,
    valuationPointCount: 2,
  };
  return fundedComparisonSessionMetricSchema.parse({
    ...withoutDigest,
    metricDigest: fundedComparisonMetricDigest(withoutDigest),
  });
}

function pairedOutcome(sessionDate: string) {
  return {
    sessionDate,
    champion: { side: "CHAMPION", sessionDate },
    challenger: { side: "CHALLENGER", sessionDate },
    championEvaluations: [],
    challengerEvaluations: [],
    predictionFallback: false,
    ordering: null,
  } as never;
}

function completedResult(): FundedComparisonResult {
  const sessions = sessionDates.map((sessionDate) => ({
    sessionDate,
    ...sideEvidence(sessionDate),
  }));
  const champion = assembleSideMetrics({
    side: "CHAMPION",
    specification: fixture.specification,
    sessions,
    decisions: [],
    orders: [],
    evaluations: [],
  });
  const challenger = assembleSideMetrics({
    side: "CHALLENGER",
    specification: fixture.specification,
    sessions,
    decisions: [],
    orders: [],
    evaluations: [],
  });
  return assembleComparisonResult({
    specification: fixture.specification,
    sessionPairs: sessionDates.map((sessionDate) => ({
      sessionDate,
      champion: sideEvidence(sessionDate).valuation,
      challenger: sideEvidence(sessionDate).valuation,
    })),
    champion,
    challenger,
    championEvaluationDigest: digestA,
    challengerEvaluationDigest: digestB,
  });
}

interface HarnessOptions {
  readonly result?: FundedComparisonResult;
  readonly metrics?: readonly FundedComparisonSessionMetric[];
  readonly bindings?: readonly FundedComparisonRunBinding[];
  readonly evaluations?: readonly FundedComparisonPolicyEvaluation[];
  readonly failures?: readonly FundedComparisonFailureReceipt[];
  readonly runner?: FundedComparisonPairedRunner;
  readonly evidence?: FundedComparisonEvidenceSource;
  readonly verifyImmutableIdentities?: (
    specification: FundedComparisonSpecification,
  ) => Promise<void>;
}

function defaultRunner(): FundedComparisonPairedRunner {
  return async (input) => ({
    specificationId: input.specificationId,
    sessions: sessionDates.map((sessionDate) => pairedOutcome(sessionDate)),
    skippedSessions: [],
  });
}

function buildHarness(options: HarnessOptions = {}) {
  const metrics: FundedComparisonSessionMetric[] = [...(options.metrics ?? [])];
  const failures: FundedComparisonFailureReceipt[] = [
    ...(options.failures ?? []),
  ];
  let result = options.result;
  const finalizeCalls: FundedComparisonResult[] = [];
  const appendMetricCalls: {
    side: FundedComparisonSide;
    sessionDate: string;
  }[] = [];
  const evidenceCalls: string[] = [];

  const repository = {
    loadSpecification: vi.fn(async (requestedSpecId: string) =>
      requestedSpecId === specId ? fixture.receipt : undefined,
    ),
    loadResult: vi.fn(async () => result),
    listFailures: vi.fn(async () => failures),
    appendFailure: vi.fn(async (raw: FundedComparisonFailureReceipt) => {
      const parsed = fundedComparisonFailureReceiptSchema.parse(raw);
      const existing = failures.find(
        (failure) =>
          failure.attemptId === parsed.attemptId &&
          failure.reason === parsed.reason &&
          failure.side === parsed.side &&
          failure.sessionDate === parsed.sessionDate,
      );
      if (existing) {
        if (existing.failureDigest !== parsed.failureDigest)
          throw new FundedComparisonRepositoryError(
            "CONFLICTING_RETRY",
            "conflicting failure receipt",
          );
        return existing;
      }
      const stored = { ...parsed, recordedAt: "2026-09-17T12:00:00.000Z" };
      failures.push(stored);
      return stored;
    }),
    findBinding: vi.fn(
      async (
        requestedSpecId: string,
        side: FundedComparisonSide,
        sessionDate: string,
      ) => {
        if (requestedSpecId !== specId) return undefined;
        const bindings = options.bindings ?? allBindings;
        return bindings.find(
          (binding) =>
            binding.side === side && binding.sessionDate === sessionDate,
        );
      },
    ),
    listBindings: vi.fn(async () => options.bindings ?? allBindings),
    listPolicyEvaluations: vi.fn(
      async (
        requestedSpecId: string,
        side: FundedComparisonSide,
        sessionDate?: string,
      ) =>
        (options.evaluations ?? allEvaluations).filter(
          (evaluation) =>
            evaluation.specId === requestedSpecId &&
            evaluation.side === side &&
            (sessionDate === undefined ||
              evaluation.sessionDate === sessionDate),
        ),
    ),
    listSessionMetrics: vi.fn(
      async (requestedSpecId: string, side?: FundedComparisonSide) =>
        metrics.filter(
          (metric) =>
            metric.specId === requestedSpecId &&
            (side === undefined || metric.side === side),
        ),
    ),
    findSessionMetric: vi.fn(
      async (
        requestedSpecId: string,
        side: FundedComparisonSide,
        sessionDate: string,
      ) =>
        metrics.find(
          (metric) =>
            metric.specId === requestedSpecId &&
            metric.side === side &&
            metric.sessionDate === sessionDate,
        ),
    ),
    appendSessionMetric: vi.fn(
      async (
        requestedSpecId: string,
        side: FundedComparisonSide,
        metric: FundedComparisonSessionMetric,
      ) => {
        if (requestedSpecId !== specId || metric.specId !== specId)
          throw new Error("unexpected specification identity");
        appendMetricCalls.push({ side, sessionDate: metric.sessionDate });
        const existing = metrics.find(
          (candidate) =>
            candidate.side === metric.side &&
            candidate.sessionDate === metric.sessionDate,
        );
        if (existing) {
          if (existing.metricDigest !== metric.metricDigest)
            throw new FundedComparisonRepositoryError(
              "CONFLICTING_RETRY",
              "conflicting session metric",
            );
          return;
        }
        metrics.push(metric);
      },
    ),
    loadSessionChunks: vi.fn(
      async (requestedSpecId: string, sessionDate: string) =>
        requestedSpecId === specId
          ? (fixture.receipt.sessions.find(
              (session) => session.sessionDate === sessionDate,
            )?.chunks ?? [])
          : [],
    ),
    finalizeResult: vi.fn(
      async (_requestedSpecId: string, finalized: FundedComparisonResult) => {
        finalizeCalls.push(finalized);
        result = finalized;
        return finalized;
      },
    ),
  };

  const evidence =
    options.evidence ??
    ({
      loadSessionEvidence: vi.fn(async (input) => {
        evidenceCalls.push(input.sessionDate);
        return {
          champion: sideEvidence(input.sessionDate),
          challenger: sideEvidence(input.sessionDate),
        };
      }),
    } satisfies FundedComparisonEvidenceSource);

  const service = new FundedComparisonService({
    repository: repository as unknown as FundedComparisonRepository,
    pairedRunner: options.runner ?? defaultRunner(),
    evidenceSource: evidence,
    verifyImmutableIdentities:
      options.verifyImmutableIdentities ?? (async () => {}),
  });

  return {
    service,
    repository,
    metrics,
    failures,
    finalizeCalls,
    appendMetricCalls,
    evidenceCalls,
    getResult: () => result,
  };
}

describe("funded comparison service", () => {
  it("returns the existing result on an exact completed retry without executing work", async () => {
    const completed = completedResult();
    const runner = vi.fn(defaultRunner());
    const harness = buildHarness({ result: completed, runner });
    const outcome = await harness.service.run(specId, {
      attemptId: "attempt-1",
      maxSessions: 2,
    });
    expect(outcome.reused).toBe(true);
    expect(outcome.result).toEqual(completed);
    expect(runner).not.toHaveBeenCalled();
    expect(harness.appendMetricCalls).toHaveLength(0);
    expect(harness.finalizeCalls).toHaveLength(0);
  });

  it("fails CONFLICTING_RETRY with a terminal receipt when the frozen digest does not match", async () => {
    const harness = buildHarness();
    harness.repository.loadSpecification.mockResolvedValueOnce({
      ...fixture.receipt,
      specification: {
        ...fixture.specification,
        comparisonSpecDigest: "f".repeat(64),
      },
    });
    await expect(
      harness.service.run(specId, { attemptId: "attempt-1", maxSessions: 2 }),
    ).rejects.toMatchObject({
      name: "FundedComparisonServiceError",
      reason: "CONFLICTING_RETRY",
    });
    expect(harness.finalizeCalls).toHaveLength(0);
    expect(harness.getResult()).toBeUndefined();
    expect(harness.failures).toHaveLength(1);
    expect(harness.failures[0]).toMatchObject({
      reason: "CONFLICTING_RETRY",
      classification: "TERMINAL",
    });
  });

  it("writes a terminal receipt and no result when immutable identities changed", async () => {
    const harness = buildHarness({
      verifyImmutableIdentities: async () => {
        throw new FundedComparisonChampionError(
          "CHAMPION_POLICY_IDENTITY_MISMATCH",
          "champion policy digest changed",
        );
      },
    });
    await expect(
      harness.service.run(specId, { attemptId: "attempt-1", maxSessions: 2 }),
    ).rejects.toMatchObject({ reason: "CHAMPION_POLICY_IDENTITY_MISMATCH" });
    expect(harness.finalizeCalls).toHaveLength(0);
    expect(harness.getResult()).toBeUndefined();
    expect(harness.failures[0]?.reason).toBe(
      "CHAMPION_POLICY_IDENTITY_MISMATCH",
    );
  });

  it("runs both sides for every incomplete session and finalizes exactly once", async () => {
    const harness = buildHarness();
    const outcome = await harness.service.run(specId, {
      attemptId: "attempt-1",
      maxSessions: 2,
    });
    expect(outcome.reused).toBe(false);
    expect(harness.finalizeCalls).toHaveLength(1);
    expect(harness.appendMetricCalls).toHaveLength(4);
    expect(outcome.result.sessionCount).toBe(2);
    expect(outcome.result.historicalVolumeStatus).toBe("INSUFFICIENT_SESSIONS");
  });

  it("does not rerun completed sessions or sides and appends no duplicate metric", async () => {
    const harness = buildHarness({
      metrics: [
        metricOf("CHAMPION", "2026-09-14"),
        metricOf("CHALLENGER", "2026-09-14"),
      ],
      runner: async (input) => ({
        specificationId: input.specificationId,
        sessions: [pairedOutcome("2026-09-15")],
        skippedSessions: ["2026-09-14"],
      }),
    });
    await harness.service.run(specId, {
      attemptId: "attempt-1",
      maxSessions: 2,
    });
    expect(harness.appendMetricCalls).toEqual([
      { side: "CHAMPION", sessionDate: "2026-09-15" },
      { side: "CHALLENGER", sessionDate: "2026-09-15" },
    ]);
    expect(harness.finalizeCalls).toHaveLength(1);
  });

  it("performs no execution or inference when every session and side is proven", async () => {
    const runner = vi.fn(defaultRunner());
    const harness = buildHarness({
      metrics: sessionDates.flatMap((sessionDate) => [
        metricOf("CHAMPION", sessionDate),
        metricOf("CHALLENGER", sessionDate),
      ]),
      runner,
    });
    await harness.service.run(specId, {
      attemptId: "attempt-1",
      maxSessions: 2,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(harness.appendMetricCalls).toHaveLength(0);
    expect(harness.finalizeCalls).toHaveLength(1);
  });

  it("leaves no result when only one side is complete", async () => {
    const harness = buildHarness({
      metrics: sessionDates.map((sessionDate) =>
        metricOf("CHAMPION", sessionDate),
      ),
      bindings: allBindings.filter((binding) => binding.side === "CHAMPION"),
      runner: async (input) => ({
        specificationId: input.specificationId,
        sessions: [],
        skippedSessions: [],
      }),
    });
    await expect(
      harness.service.run(specId, { attemptId: "attempt-1", maxSessions: 2 }),
    ).rejects.toBeInstanceOf(FundedComparisonIncompleteError);
    expect(harness.finalizeCalls).toHaveLength(0);
    expect(harness.getResult()).toBeUndefined();
  });

  it("writes one idempotent interruption receipt on cancellation", async () => {
    const harness = buildHarness();
    let hookCalls = 0;
    const betweenSessions = async () => {
      hookCalls += 1;
      if (hookCalls % 2 === 0) throw new CancelledError("cancel requested");
    };
    const first = harness.service.run(specId, {
      attemptId: "attempt-1",
      maxSessions: 2,
      betweenSessions,
    });
    await expect(first).rejects.toBeInstanceOf(CancelledError);
    const second = harness.service.run(specId, {
      attemptId: "attempt-1",
      maxSessions: 2,
      betweenSessions,
    });
    await expect(second).rejects.toBeInstanceOf(CancelledError);
    const interruptions = harness.failures.filter(
      (failure) => failure.reason === "CANCELLED",
    );
    expect(interruptions).toHaveLength(1);
    expect(interruptions[0]).toMatchObject({
      attemptId: "attempt-1",
      classification: "INTERRUPTION",
    });
    expect(harness.getResult()).toBeUndefined();
  });

  it("writes one idempotent LEASE_LOST receipt when the lease is lost", async () => {
    const harness = buildHarness({
      runner: async () => {
        throw new LeaseLostError("job-1");
      },
    });
    const first = harness.service.run(specId, {
      attemptId: "attempt-1",
      maxSessions: 2,
    });
    await expect(first).rejects.toBeInstanceOf(LeaseLostError);
    const second = harness.service.run(specId, {
      attemptId: "attempt-1",
      maxSessions: 2,
    });
    await expect(second).rejects.toBeInstanceOf(LeaseLostError);
    const interruptions = harness.failures.filter(
      (failure) => failure.reason === "LEASE_LOST",
    );
    expect(interruptions).toHaveLength(1);
    expect(interruptions[0]?.classification).toBe("INTERRUPTION");
    expect(harness.finalizeCalls).toHaveLength(0);
  });

  it("resumes only missing work on an exact-spec retry", async () => {
    const first = buildHarness();
    let hookCalls = 0;
    const betweenSessions = async () => {
      hookCalls += 1;
      if (hookCalls === 2) throw new CancelledError("cancel requested");
    };
    await expect(
      first.service.run(specId, {
        attemptId: "attempt-1",
        maxSessions: 2,
        betweenSessions,
      }),
    ).rejects.toBeInstanceOf(CancelledError);
    expect(first.appendMetricCalls).toEqual([
      { side: "CHAMPION", sessionDate: "2026-09-14" },
      { side: "CHALLENGER", sessionDate: "2026-09-14" },
    ]);
    const runner = vi.fn(async (input: { specificationId: string }) => ({
      specificationId: input.specificationId,
      sessions: [pairedOutcome("2026-09-15")],
      skippedSessions: ["2026-09-14"],
    }));
    const retry = buildHarness({
      metrics: [...first.metrics],
      failures: [...first.failures],
      runner: runner as unknown as FundedComparisonPairedRunner,
    });
    const outcome = await retry.service.run(specId, {
      attemptId: "attempt-2",
      maxSessions: 2,
    });
    expect(runner).toHaveBeenCalledWith(
      { specificationId: specId, maxSessions: 2 },
      expect.any(Function),
    );
    expect(retry.appendMetricCalls).toEqual([
      { side: "CHAMPION", sessionDate: "2026-09-15" },
      { side: "CHALLENGER", sessionDate: "2026-09-15" },
    ]);
    expect(outcome.result.sessionCount).toBe(2);
    expect(retry.finalizeCalls).toHaveLength(1);
  });

  it("fails closed when a side valuation is unavailable and records its terminal reason", async () => {
    const harness = buildHarness({
      evidence: {
        loadSessionEvidence: async (input) => ({
          champion: sideEvidence(input.sessionDate),
          challenger: {
            ...sideEvidence(input.sessionDate),
            valuation: {
              equityPoints: [],
              maxDrawdown: null,
              maxDrawdownPctOfInitialCash: null,
              staleMarkPoints: 1,
              integrityFindings: ["stale"],
              status: "UNAVAILABLE",
              reason: "STALE_MARK",
            },
          },
        }),
      },
    });
    await expect(
      harness.service.run(specId, { attemptId: "attempt-1", maxSessions: 2 }),
    ).rejects.toMatchObject({ reason: "STALE_MARK" });
    expect(harness.finalizeCalls).toHaveLength(0);
    expect(harness.getResult()).toBeUndefined();
    expect(
      harness.metrics.some(
        (metric) =>
          metric.side === "CHALLENGER" && metric.valuation === "UNAVAILABLE",
      ),
    ).toBe(true);
    expect(harness.failures[0]?.reason).toBe("STALE_MARK");
  });

  it("does not attempt finalization when policy evaluations are incomplete", async () => {
    const harness = buildHarness({
      evaluations: allEvaluations.filter(
        (evaluation) =>
          !(
            evaluation.side === "CHALLENGER" &&
            evaluation.sessionDate === "2026-09-15"
          ),
      ),
    });
    await expect(
      harness.service.run(specId, { attemptId: "attempt-1", maxSessions: 2 }),
    ).rejects.toMatchObject({
      name: "FundedComparisonServiceError",
      reason: "INCOMPLETE_SESSION",
    });
    expect(harness.finalizeCalls).toHaveLength(0);
    expect(harness.getResult()).toBeUndefined();
  });

  it("does not attempt finalization when a session was not executed within the bound", async () => {
    const harness = buildHarness({
      bindings: allBindings.filter(
        (binding) => binding.sessionDate === "2026-09-14",
      ),
      runner: async (input) => ({
        specificationId: input.specificationId,
        sessions: [pairedOutcome("2026-09-14")],
        skippedSessions: [],
      }),
    });
    await expect(
      harness.service.run(specId, { attemptId: "attempt-1", maxSessions: 1 }),
    ).rejects.toBeInstanceOf(FundedComparisonIncompleteError);
    expect(harness.finalizeCalls).toHaveLength(0);
    expect(harness.getResult()).toBeUndefined();
  });

  it("rejects a conflicting job payload with CONFLICTING_RETRY and no receipt", async () => {
    const harness = buildHarness();
    const handler = new FundedComparisonJobHandler(harness.service);
    const conflicting: FundedComparisonJobPayload = {
      specificationId: specId,
      comparisonSpecDigest: "f".repeat(64),
      marketId,
      currency: "CAD",
      maxSessions: 2,
    };
    await expect(
      handler.execute(claimedComparisonJob(conflicting), jobContext()),
    ).rejects.toMatchObject({
      name: "CategorizedError",
      category: "VALIDATION",
      message: expect.stringContaining("CONFLICTING_RETRY"),
    });
    expect(harness.finalizeCalls).toHaveLength(0);
    expect(harness.failures).toHaveLength(0);
  });

  it("returns the existing result artifact id on an exact completed-job retry", async () => {
    const harness = buildHarness({ result: completedResult() });
    const handler = new FundedComparisonJobHandler(harness.service);
    const payload = buildFundedComparisonJobPayload(
      specId,
      fixture.specification,
      2,
    );
    const outcome = await handler.execute(
      claimedComparisonJob(payload),
      jobContext(),
    );
    expect(outcome).toEqual({ resultRefId: specId });
  });

  it("registers the FUNDED_COMPARISON handler without changing the worker contract", async () => {
    const harness = buildHarness({ result: completedResult() });
    const job = claimedComparisonJob(
      buildFundedComparisonJobPayload(specId, fixture.specification, 2),
    );
    const calls: string[] = [];
    const workerRepository = {
      claimNext: vi.fn(async () => job),
      heartbeat: vi.fn(async () => ({ cancellationRequested: false })),
      complete: vi.fn(
        async (id: string, owner: string, resultRefId: string) => {
          calls.push(`complete:${id}:${owner}:${resultRefId}`);
        },
      ),
      fail: vi.fn(async () => {
        calls.push("fail");
      }),
      markCancelled: vi.fn(async () => {
        calls.push("cancel");
      }),
      reapExpiredLeases: vi.fn(async () => ({ requeued: 0, interrupted: 0 })),
    };
    const worker = new ResearchWorker(
      workerRepository as unknown as ResearchJobRepository,
      { FUNDED_COMPARISON: new FundedComparisonJobHandler(harness.service) },
      { ownerId: "worker-a" },
    );
    await worker.runOnce();
    expect(workerRepository.claimNext).toHaveBeenCalledWith(
      ["FUNDED_COMPARISON"],
      "worker-a",
      expect.any(Number),
    );
    expect(calls).toEqual([`complete:${job.id}:worker-a:${specId}`]);
  });
});

function claimedComparisonJob(
  payload: FundedComparisonJobPayload,
): ClaimedResearchJob {
  return {
    id: "job-1",
    jobType: "FUNDED_COMPARISON",
    status: "RUNNING",
    resultRefId: null,
    progress: {},
    error: null,
    errorCategory: null,
    attemptCount: 1,
    maxAttempts: 3,
    cancellationRequested: false,
    createdAt: "2026-09-17T00:00:00.000Z",
    startedAt: "2026-09-17T00:00:00.000Z",
    completedAt: null,
    requestPayload: payload,
    leaseOwner: "worker-a",
  };
}

function jobContext() {
  return {
    jobId: "job-1",
    heartbeat: async () => ({ cancellationRequested: false }),
  };
}
