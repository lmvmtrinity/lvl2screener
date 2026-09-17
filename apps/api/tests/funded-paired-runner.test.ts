import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import {
  createBacktestSchema,
  FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
  FUNDED_COMPARISON_OPPORTUNITY_ELIGIBILITY_VERSION,
  fundedExecutionModelArtifactSchema,
  fundedExecutionInferenceOutputSchema,
  type FundedComparisonPolicyEvaluation,
} from "@tsx-scanner/contracts";
import {
  championReplayAccountId,
  challengerReplayAccountId,
  runFundedPairedComparison,
  type FundedPairedComparisonDependencies,
} from "../src/paper-bot/funded-paired-runner.js";
import {
  buildFundedComparisonSpecification,
  fundedComparisonTrainingSessionDigest,
  type FundedComparisonSpecificationInput,
} from "../src/paper-bot/funded-comparison-specification.js";
import {
  FundedComparisonRepository,
  type FundedComparisonSessionFreeze,
  type FundedComparisonSpecificationReceipt,
} from "../src/paper-bot/funded-comparison-repository.js";
import {
  chunkFundedComparisonItems,
  projectFundedComparisonSessionItems,
  sessionInputDigestOf,
} from "../src/paper-bot/funded-comparison-input-freezer.js";
import type { ComparisonSideSessionResult } from "../src/paper-bot/funded-comparison-side-runner.js";
import { loadFundedComparisonSharedInput } from "../src/paper-bot/funded-comparison-shared-input.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import { fundedExecutionArtifactDigest } from "../src/statistical-models/funded-execution-digest.js";
import { fundedExecutionTrainingPartitionDigest } from "../src/statistical-models/funded-execution-digest.js";
import { contentHash } from "../src/paper-bot/funded-evidence-digest.js";
import { createFundedLedger } from "../src/paper-bot/funded-ledger.js";
import {
  buildFundedDecisionDraft,
  fundedAccountStateEvidence,
} from "../src/paper-bot/funded-decision-evidence.js";
import type { FundedDecisionRow } from "../src/paper-bot/funded-decision-evidence-repository.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const sessionDate = "2026-09-15";
const TRAINING_DATES = ["2026-09-09", "2026-09-10", "2026-09-11"];
const TRAINING_ROW_DIGESTS = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
const TRAINING_KNOWLEDGE_AT = "2026-09-11T20:00:00.000Z";
const at = `${sessionDate}T14:30:00.000Z`;

const fixtureUrl = new URL(
  "../../../services/scanner/tests/fixtures/funded_execution_result.json",
  import.meta.url,
);
const fixtureArtifact = fundedExecutionModelArtifactSchema.parse(
  JSON.parse((await readFile(fixtureUrl, "utf8")) as string).artifact,
);
// The comparison loader verifies the derived TRAIN partition digest against the
// persisted artifact, so the test uses an artifact whose digest is computed
// over the same TRAIN member rows the mock dataset returns.
const trainingPartitionDigest =
  fundedExecutionTrainingPartitionDigest(TRAINING_ROW_DIGESTS);
const artifact = {
  ...fixtureArtifact,
  trainingPartitionDigest,
  sourceDatasetDigest: fixtureArtifact.sourceDatasetDigest,
};
const assumptions = {
  positionSize: 1_000,
  slippageBps: 2,
  feePerTrade: 1,
  costs: {
    entryCommission: 1,
    exitCommission: 1,
    estimatedRegulatoryFees: 0,
    slippageBps: 2,
    currency: "CAD",
    brokerPricingVersion: "cost-policy-v1",
  },
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
  riskBudget: 250,
  maxNotional: 1_500,
  executionMode: "CAPACITY_CONSTRAINED",
  latencyMs: 0,
} as const;

function observation(
  ordinal: number,
): Parameters<
  typeof projectFundedComparisonSessionItems
>[0]["observations"][number] {
  return {
    runId: "baseline-1",
    sourceEventId: `source-event-${ordinal}`,
    sourceSignalId: null,
    setupInstanceId: `00000000-0000-4000-8000-00000000000${ordinal}`,
    instrumentId: `00000000-0000-4000-8000-00000000010${ordinal}`,
    symbol: `SYM${ordinal}`,
    profileId: "profile-1",
    profileName: "profile",
    profileConfigId: "00000000-0000-4000-8000-000000000200",
    configVersion: "config-1",
    profileParameters: { scoreCutoff: 60 },
    strategyKey: "ORB_RETEST",
    strategyVersion: "2026-09-01",
    signalTimestamp: at,
    score: 70 + ordinal,
    entryReference: 10,
    stopReference: 9,
    targetReference: 12,
    atr14: 1,
    featureSnapshot: { featureVersion: "features-v1", atr14: 1 },
    reasonCodes: ["BREAKOUT"],
    sourceEventPayload: { signalSemanticsVersion: "setup-semantics-v2" },
    eligibilityStatus: "ELIGIBLE",
    eligibilityReason: null,
  };
}

function frozenSession(): FundedComparisonSessionFreeze {
  const projection = projectFundedComparisonSessionItems({
    baselineRunId: "baseline-1",
    sessionDate,
    sessionStartAt: `${sessionDate}T13:30:00.000Z`,
    scheduledCloseAt: `${sessionDate}T20:00:00.000Z`,
    sessionTimezone: "America/Toronto",
    observations: [observation(1), observation(2)],
    quotes: [],
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
}

function replayConfiguration() {
  return {
    request: createBacktestSchema.parse({
      name: "baseline",
      marketId: "CA_TSX",
      startDate: "2026-09-10",
      endDate: sessionDate,
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
          endDate: sessionDate,
        }).parameters,
        scoreCutoff: 60,
      },
    }),
    profiles: [
      {
        strategyKey: "ORB_RETEST",
        profileId: "profile-1",
        profileName: "profile",
        profileConfigId: "00000000-0000-4000-8000-000000000200",
        configVersion: "config-1",
      },
    ],
  };
}

function specificationInput(): FundedComparisonSpecificationInput {
  const session = frozenSession();
  return {
    marketId: "CA_TSX",
    baseline: {
      backtestRunId: "baseline-1",
      configVersion: "config-1",
      strategyKeys: ["ORB_RETEST"],
      startDate: "2026-09-10",
      endDate: sessionDate,
      executionModelVersion: "execution-v1",
      replayInputDigest: digestA,
      baselineResultDigest: digestB,
      completedAt: `${sessionDate}T20:30:00.000Z`,
    },
    sessionDates: [sessionDate],
    sessions: [
      {
        sessionDate,
        itemCount: frozenSession().itemCount,
        chunkCount: frozenSession().chunkCount,
        sessionInputDigest: frozenSession().sessionInputDigest,
      },
    ],
    replay: replayConfiguration(),
    opportunities: session.opportunities,
    champion: {
      kind: "DETERMINISTIC_FUNDED_POLICY",
      fundedPolicyVersion: "funded-cash-v1",
      portfolioPolicyVersion: "funded-portfolio-v2",
      policyDigest: contentHash(fundedPolicy(1, 0)),
      sourceLiveRunId: "live-run-1",
      sourceAccountId: "live-account-1",
      executionModelVersion: "execution-v1",
      costPolicyVersion: "cost-policy-v1",
      participationVersion: "participation-v1",
      runtimeVersion: "runtime-v1",
      accountAssumptionDigest: digestB,
      assumptionsDigest: contentHash(assumptions),
    },
    challenger: {
      kind: "FUNDED_EXECUTION_POLICY_V1",
      policyVersion: FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
      policyDigest: digestB,
      model: {
        modelId: "00000000-0000-4000-8000-000000000300",
        modelVersion: "funded-execution-v1",
        artifactDigest: fundedExecutionArtifactDigest(artifact),
        datasetDigest: artifact.sourceDatasetDigest,
        cohortDigest: digestB,
        featureVersion: "funded-execution-features-v1",
        predictionPolicyVersion: "funded-execution-prediction-v1",
        trainingPartitionDigest: artifact.trainingPartitionDigest,
        trainingEvidenceCutoffAt: TRAINING_KNOWLEDGE_AT,
        trainingSessionDigest:
          fundedComparisonTrainingSessionDigest(TRAINING_DATES),
      },
    },
    capital: {
      initialCash: 25_000,
      dailyLossLimit: 2_500,
      riskConfigurationDigest: digestA,
    },
    training: {
      trainingSessionDates: TRAINING_DATES,
      trainingKnowledgeCutoffAt: TRAINING_KNOWLEDGE_AT,
      trainingPartitionDigest: artifact.trainingPartitionDigest,
      trainingSessionDigest:
        fundedComparisonTrainingSessionDigest(TRAINING_DATES),
    },
    lastInputEffectiveAt: `${sessionDate}T20:00:00.000Z`,
    evidenceCutoffAt: `${sessionDate}T20:00:00.000Z`,
    specificationFrozenAt: `${sessionDate}T20:30:00.000Z`,
  };
}

function receipt(): FundedComparisonSpecificationReceipt {
  const session = frozenSession();
  const specification =
    buildFundedComparisonSpecification(specificationInput());
  void specification.metricsPolicyVersion;
  void FUNDED_COMPARISON_OPPORTUNITY_ELIGIBILITY_VERSION;
  return {
    specification,
    specId: "spec-1",
    sessions: [
      {
        sessionDate,
        ordinal: 1,
        itemCount: session.itemCount,
        chunkCount: session.chunks.length,
        sessionInputDigest: session.sessionInputDigest,
        chunks: session.chunks,
        opportunities: session.opportunities,
      },
    ],
    opportunities: session.opportunities,
  };
}

const SECOND_SESSION_DATE = "2026-09-16";

function sessionProjection(
  date: string,
  timestamps: readonly string[],
): {
  chunks: ReturnType<typeof chunkFundedComparisonItems>;
  itemCount: number;
  sessionInputDigest: string;
  opportunities: ReturnType<
    typeof projectFundedComparisonSessionItems
  >["opportunities"];
} {
  const projection = projectFundedComparisonSessionItems({
    baselineRunId: "baseline-1",
    sessionDate: date,
    sessionStartAt: `${date}T13:30:00.000Z`,
    scheduledCloseAt: `${date}T20:00:00.000Z`,
    sessionTimezone: "America/Toronto",
    observations: timestamps.map((timestamp, index) => ({
      ...observation(index + 1),
      sourceEventId: `source-event-${date}-${index + 1}`,
      setupInstanceId: `00000000-0000-4000-8000-10000000000${index + 1}`,
      instrumentId: `00000000-0000-4000-8000-20000000000${index + 1}`,
      signalTimestamp: timestamp,
    })),
    quotes: [],
    invalidations: [],
    contextsFor: () => [
      {
        signalKey: "MARKET_RELATIVE_STRENGTH",
        status: "STRONG",
        timestamp: `${date}T14:25:00.000Z`,
        benchmarkTimestamp: null,
      },
    ],
  });
  const chunks = chunkFundedComparisonItems(date, projection.items);
  return {
    chunks,
    itemCount: projection.items.length,
    sessionInputDigest: sessionInputDigestOf(date, chunks),
    opportunities: projection.opportunities,
  };
}

/**
 * Two chronological sessions, with a second session that contains two
 * simultaneous batches: (14:30) and (14:45, two candidates).
 */
function twoSessionReceipt(): FundedComparisonSpecificationReceipt {
  const first = sessionProjection(sessionDate, [at, at, at]);
  const second = sessionProjection(SECOND_SESSION_DATE, [
    `${SECOND_SESSION_DATE}T14:30:00.000Z`,
    `${SECOND_SESSION_DATE}T14:45:00.000Z`,
    `${SECOND_SESSION_DATE}T14:45:00.000Z`,
  ]);
  const sessionDates = [sessionDate, SECOND_SESSION_DATE];
  const specification = buildFundedComparisonSpecification({
    ...specificationInput(),
    sessionDates,
    sessions: [
      {
        sessionDate,
        itemCount: first.itemCount,
        chunkCount: first.chunks.length,
        sessionInputDigest: first.sessionInputDigest,
      },
      {
        sessionDate: SECOND_SESSION_DATE,
        itemCount: second.itemCount,
        chunkCount: second.chunks.length,
        sessionInputDigest: second.sessionInputDigest,
      },
    ],
    opportunities: [...first.opportunities, ...second.opportunities],
    lastInputEffectiveAt: `${SECOND_SESSION_DATE}T20:00:00.000Z`,
    evidenceCutoffAt: `${SECOND_SESSION_DATE}T20:00:00.000Z`,
    specificationFrozenAt: `${SECOND_SESSION_DATE}T20:30:00.000Z`,
  });
  return {
    specification,
    specId: "spec-1",
    sessions: [
      {
        sessionDate,
        ordinal: 1,
        itemCount: first.itemCount,
        chunkCount: first.chunks.length,
        sessionInputDigest: first.sessionInputDigest,
        chunks: first.chunks,
        opportunities: first.opportunities,
      },
      {
        sessionDate: SECOND_SESSION_DATE,
        ordinal: 2,
        itemCount: second.itemCount,
        chunkCount: second.chunks.length,
        sessionInputDigest: second.sessionInputDigest,
        chunks: second.chunks,
        opportunities: second.opportunities,
      },
    ],
    opportunities: [...first.opportunities, ...second.opportunities],
  };
}

function quietSecondSessionReceipt(): FundedComparisonSpecificationReceipt {
  const first = sessionProjection(sessionDate, [at]);
  const second = sessionProjection(SECOND_SESSION_DATE, []);
  const sessionDates = [sessionDate, SECOND_SESSION_DATE];
  const specification = buildFundedComparisonSpecification({
    ...specificationInput(),
    sessionDates,
    sessions: [first, second].map((session, index) => ({
      sessionDate: sessionDates[index]!,
      itemCount: session.itemCount,
      chunkCount: session.chunks.length,
      sessionInputDigest: session.sessionInputDigest,
    })),
    opportunities: [...first.opportunities],
    lastInputEffectiveAt: `${SECOND_SESSION_DATE}T20:00:00.000Z`,
    evidenceCutoffAt: `${SECOND_SESSION_DATE}T20:00:00.000Z`,
    specificationFrozenAt: `${SECOND_SESSION_DATE}T20:30:00.000Z`,
  });
  return {
    specification,
    specId: "spec-1",
    sessions: [first, second].map((session, index) => ({
      sessionDate: sessionDates[index]!,
      ordinal: index + 1,
      itemCount: session.itemCount,
      chunkCount: session.chunks.length,
      sessionInputDigest: session.sessionInputDigest,
      chunks: session.chunks,
      opportunities: session.opportunities,
    })),
    opportunities: [...first.opportunities],
  };
}

function decisionRow(observationId: string): FundedDecisionRow {
  const ledger = createFundedLedger("CAD", 25_000, sessionDate, at, 2_500);
  const content = buildFundedDecisionDraft({
    observation: {
      id: observationId,
      strategyKey: "ORB_RETEST",
      strategyVersion: "2026-09-01",
      score: 70,
      reasonCodes: ["BREAKOUT"],
      fundedContexts: [
        {
          signalKey: "MARKET_RELATIVE_STRENGTH",
          status: "STRONG",
          timestamp: at,
        },
      ],
    },
    order: {
      signal: {
        entryReference: 10,
        stopReference: 9,
        targetReference: 12,
        atr14: 1,
        signalTimestamp: at,
      },
      assumptions,
      submittedAt: at,
    },
    requestedCapital: { maximumDebit: 1_000, maximumRisk: 250 },
    quote: {
      timestamp: at,
      bid: 10,
      ask: 10.02,
      bidSize: 500,
      askSize: 500,
      sizeUnit: "SHARES",
      sizeMultiplier: 1,
      dataStatus: "REALTIME",
      actionable: true,
    },
    context: {
      marketId: "CA_TSX",
      accountId: "00000000-0000-4000-8000-000000000002",
      runId: "00000000-0000-4000-8000-000000000001",
      sourceKind: "HISTORICAL_REPLAY",
      fundedPolicyVersion: "funded-cash-v1",
      executionModelVersion: "execution-v1",
      featureVersion: "features-v1",
      runtimeVersion: "runtime-v1",
      costPolicyVersion: "cost-policy-v1",
      participationVersion: "participation-v1",
      policy: fundedPolicy(1, 0),
      accountState: fundedAccountStateEvidence(ledger, at, {
        cooldownActive: false,
        consecutiveStops: 0,
      }),
      model: null,
    },
    action: "SUBMIT",
    policyReason: null,
  });
  return {
    run_id: "00000000-0000-4000-8000-000000000001",
    observation_id: observationId,
    sequence: 1,
    market_id: "CA_TSX",
    currency: "CAD",
    account_id: "00000000-0000-4000-8000-000000000002",
    funded_policy_version: "funded-cash-v1",
    execution_model_version: "execution-v1",
    feature_version: "features-v1",
    evidence_schema_version: 2,
    action: "SUBMIT",
    source_kind: "HISTORICAL_REPLAY",
    content_digest: contentHash(content),
    cohort_digest: digestB,
    decision_content: content,
    captured_at: at,
  } as unknown as FundedDecisionRow;
}

function sideResult(
  side: "CHAMPION" | "CHALLENGER",
  runId: string,
  observations: ReadonlyMap<string, string>,
): ComparisonSideSessionResult {
  return {
    side,
    runId,
    sessionDate,
    observations,
    decisions: new Map(
      [...observations.entries()].map(
        ([sourceOpportunityId, observationId]) => [
          sourceOpportunityId,
          decisionRow(observationId),
        ],
      ),
    ),
    appliedRanks: new Map(),
    unresolvedPositions: 0,
    unresolvedReservations: 0,
  };
}

interface HarnessOptions {
  liveAccount?: boolean;
  foreignAccount?: boolean;
  unboundAccount?: boolean;
  hiddenForeignBinding?: boolean;
  wrongSideBinding?: boolean;
  lifecycle?: string[];
  heartbeats?: string[];
  runStatuses?: Record<string, string>;
  existingBindings?: Record<string, unknown>;
  existingEvaluations?: Record<string, FundedComparisonPolicyEvaluation[]>;
  applySide?: FundedPairedComparisonDependencies["applySide"];
  projectSide?: FundedPairedComparisonDependencies["projectSide"];
  predictionEngine?: FundedPairedComparisonDependencies["predictionEngine"];
  built?: FundedComparisonSpecificationReceipt;
  failPredictions?: boolean;
  crashAfterProvisionBeforeBind?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const built = options.built ?? receipt();
  const specification = built.specification;
  const bindings: unknown[] = [];
  const evaluations: FundedComparisonPolicyEvaluation[] = [];
  const storedEvaluations = new Map<string, FundedComparisonPolicyEvaluation[]>(
    Object.entries(options.existingEvaluations ?? {}),
  );
  const bindingStore = new Map<string, unknown>(
    Object.entries(options.existingBindings ?? {}),
  );
  let predictionCalls = 0;
  let failPredictions = options.failPredictions ?? false;
  let crashAfterProvisionBeforeBind =
    options.crashAfterProvisionBeforeBind ?? false;
  const provisioningIntents = new Map<string, Record<string, unknown>>();
  const provisionedRuns: {
    runId: string;
    accountId: string;
    sessionDate: string;
  }[] = [];
  const applied: { side: string; digest: string; sessionDate: string }[] = [];
  const projected: string[] = [];
  const sessionsRun: string[] = [];
  const binds: string[] = [];
  const repository = {
    loadSpecification: async () => built,
    loadSessionChunks: async (_specId: string, date: string) =>
      built.sessions.find((session) => session.sessionDate === date)?.chunks ??
      [],
    findBinding: async (_specId: string, side: string, date: string) =>
      bindingStore.get(`${side}:${date}`),
    listPolicyEvaluations: async (
      _specId: string,
      side: string,
      date: string,
    ) => storedEvaluations.get(`${side}:${date}`) ?? [],
    listSessionMetrics: async () => [],
    bindSessionSide: async (
      specId: string,
      side: string,
      date: string,
      binding: object,
    ) => {
      binds.push(`${side}:${date}`);
      options.lifecycle?.push(`bind:${side}`);
      if (crashAfterProvisionBeforeBind) {
        crashAfterProvisionBeforeBind = false;
        throw new Error("injected crash after provisioning commit");
      }
      const value = { specId, side, sessionDate: date, ...binding };
      bindings.push(value);
      bindingStore.set(`${side}:${date}`, value);
      return value;
    },
    saveProvisioningIntent: async (intent: object) => {
      const value = intent as Record<string, unknown>;
      provisioningIntents.set(
        `${String(value.side)}:${String(value.sessionDate)}`,
        value,
      );
      return { ...value, createdAt: at };
    },
    appendPolicyEvaluations: async (
      _specId: string,
      side: string,
      date: string,
      rows: readonly FundedComparisonPolicyEvaluation[],
    ) => {
      options.lifecycle?.push(`persist:${side}`);
      evaluations.push(...rows);
      storedEvaluations.set(`${side}:${date}`, [...rows]);
    },
  } as unknown as FundedComparisonRepository;
  const pool = {
    query: async (text: string, values?: unknown[]) => {
      if (text.includes("b.account_id=ANY")) {
        const championAccountId = championReplayAccountId(
          specification.comparisonSpecDigest,
        );
        if (options.liveAccount)
          return {
            rows: [
              {
                run_id: "live-run-1",
                account_id: championAccountId,
                source: "LIVE",
                run_session_date: sessionDate,
                binding_spec_id: null,
                binding_side: null,
                binding_session_date: null,
                binding_run_id: null,
                binding_account_id: null,
              },
            ],
          };
        if (options.foreignAccount)
          return {
            rows: [
              {
                run_id: "foreign-run-1",
                account_id: championAccountId,
                source: "BACKTEST",
                run_session_date: sessionDate,
                binding_spec_id: "other-spec",
                binding_side: "CHAMPION",
                binding_session_date: sessionDate,
                binding_run_id: "foreign-run-1",
                binding_account_id: championAccountId,
              },
            ],
          };
        if (options.unboundAccount)
          return {
            rows: [
              {
                run_id: "unbound-run-1",
                account_id: championAccountId,
                source: "BACKTEST",
                run_session_date: sessionDate,
                binding_spec_id: null,
                binding_side: null,
                binding_session_date: null,
                binding_run_id: null,
                binding_account_id: null,
              },
            ],
          };
        if (options.hiddenForeignBinding) {
          const current = {
            run_id: "multiply-bound-run-1",
            account_id: championAccountId,
            source: "BACKTEST",
            run_session_date: sessionDate,
            binding_spec_id: "spec-1",
            binding_side: "CHAMPION",
            binding_session_date: sessionDate,
            binding_run_id: "multiply-bound-run-1",
            binding_account_id: championAccountId,
          };
          return {
            rows: text.includes("LIMIT 1")
              ? [current]
              : [current, { ...current, binding_spec_id: "other-spec" }],
          };
        }
        if (options.wrongSideBinding)
          return {
            rows: [
              {
                run_id: "wrong-side-run-1",
                account_id: championAccountId,
                source: "BACKTEST",
                run_session_date: sessionDate,
                binding_spec_id: "spec-1",
                binding_side: "CHALLENGER",
                binding_session_date: sessionDate,
                binding_run_id: "wrong-side-run-1",
                binding_account_id: championAccountId,
              },
            ],
          };
        if (bindingStore.size > 0)
          return {
            rows: [...bindingStore.values()]
              .map(
                (binding) =>
                  binding as {
                    runId: string;
                    accountId: string;
                    side: "CHAMPION" | "CHALLENGER";
                    sessionDate: string;
                  },
              )
              .filter(
                (value) =>
                  value.accountId === championAccountId ||
                  value.accountId ===
                    challengerReplayAccountId(
                      specification.comparisonSpecDigest,
                    ),
              )
              .map((value) => ({
                run_id: value.runId,
                account_id: value.accountId,
                source: "BACKTEST",
                run_session_date: value.sessionDate,
                binding_spec_id: "spec-1",
                binding_side: value.side,
                binding_session_date: value.sessionDate,
                binding_run_id: value.runId,
                binding_account_id: value.accountId,
              })),
          };
        if (provisionedRuns.length > 0)
          return {
            rows: provisionedRuns.map((run) => {
              const side =
                run.accountId === championAccountId ? "CHAMPION" : "CHALLENGER";
              const intent = provisioningIntents.get(
                `${side}:${run.sessionDate}`,
              );
              return {
                run_id: run.runId,
                account_id: run.accountId,
                source: "BACKTEST",
                run_session_date: run.sessionDate,
                binding_spec_id: null,
                binding_side: null,
                binding_session_date: null,
                binding_run_id: null,
                binding_account_id: null,
                intent_spec_id: intent?.specId ?? null,
                intent_side: intent?.side ?? null,
                intent_session_date: intent?.sessionDate ?? null,
                intent_account_id: intent?.accountId ?? null,
                intent_market_id: intent?.marketId ?? null,
                intent_currency: intent?.currency ?? null,
                intent_policy_digest: intent?.policyDigest ?? null,
                intent_execution_model_version:
                  intent?.executionModelVersion ?? null,
                intent_account_assumption_digest:
                  intent?.accountAssumptionDigest ?? null,
                run_market_id: "CA_TSX",
                run_execution_model_version: "execution-v1",
                run_assumptions: assumptions,
                run_policy: fundedPolicy(1, 0),
                run_currency: "CAD",
              };
            }),
          };
        return { rows: [] };
      }
      if (text.includes("SELECT b.policy,r.assumptions")) {
        return {
          rows: [
            {
              policy: fundedPolicy(1, 0),
              assumptions,
              execution_model_version: "execution-v1",
              account_id: "live-account-1",
              market_id: "CA_TSX",
              currency: "CAD",
            },
          ],
        };
      }
      if (text.includes("FROM funded_execution_challenger")) {
        return {
          rows: [
            {
              status: "INACTIVE",
              artifact,
              cohort_digest: digestB,
              dataset_digest: artifact.sourceDatasetDigest,
              dataset_id: "00000000-0000-4000-8000-000000000400",
              feature_version: "funded-execution-features-v1",
              model_version: "funded-execution-v1",
              artifact_digest: fundedExecutionArtifactDigest(artifact),
            },
          ],
        };
      }
      if (text.includes("FROM funded_execution_dataset_member")) {
        return {
          rows: TRAINING_DATES.map((sessionDateValue, index) => ({
            session_date: sessionDateValue,
            label_available_at: TRAINING_KNOWLEDGE_AT,
            row_digest: TRAINING_ROW_DIGESTS[index]!,
          })),
        };
      }
      if (text.includes("SELECT status FROM paper_bot_run")) {
        const runId = String(values?.[0] ?? "");
        return {
          rows: [{ status: options.runStatuses?.[runId] ?? "RUNNING" }],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    },
  } as unknown as Pool;
  const seenDigests: string[] = [];
  const deps: FundedPairedComparisonDependencies = {
    pool,
    repository,
    betweenSessions: async () => {
      options.heartbeats?.push("heartbeat");
    },
    reporting: {
      report: async () => ({ positions: {}, reservations: {} }),
    } as never,
    predictionEngine: options.predictionEngine ?? {
      predictFundedExecution: async (payload) => {
        predictionCalls += 1;
        if (failPredictions) throw new Error("inference unavailable");
        const parsed = payload as {
          model: unknown;
          inputs: {
            runId: string;
            observationId: string;
            decisionSequence: number;
            decisionInputDigest: string;
          }[];
        };
        return fundedExecutionInferenceOutputSchema.parse({
          requestVersion: "funded-execution-inference-v1",
          marketId: "CA_TSX",
          currency: "CAD",
          model: parsed.model,
          predictions: parsed.inputs.map((input) => ({
            runId: input.runId,
            observationId: input.observationId,
            decisionSequence: input.decisionSequence,
            decisionInputDigest: input.decisionInputDigest,
            output: {
              fillProbability: {
                value: 0.5,
                unit: "PROBABILITY",
                lowerBound: 0,
                upperBound: 1,
              },
              expectedFillFraction: {
                value: 0.9,
                unit: "FRACTION",
                lowerBound: 0,
                upperBound: 1,
              },
              expectedSlippagePerShare: {
                value: 0.01,
                unit: "CURRENCY_PER_SHARE",
                lowerBound: 0,
                upperBound: null,
              },
              expectedTotalExecutionCost: {
                value: 1,
                unit: "CURRENCY",
                lowerBound: 0,
                upperBound: null,
              },
            },
            warnings: [],
          })),
          warnings: [],
        });
      },
    },
    evidenceSourceFor: () =>
      ({
        quote: async () => null,
        contexts: async () => [],
        model: async () => null,
      }) as never,
    provisionRun: async (_pool, provisionInput) => {
      options.lifecycle?.push(`provision:${provisionInput.accountId}`);
      const provisioned = {
        runId: `run-${provisionInput.accountId.slice(0, 8)}`,
        accountId: provisionInput.accountId,
        reused: false,
      };
      if (!provisionedRuns.some((run) => run.runId === provisioned.runId))
        provisionedRuns.push({
          runId: provisioned.runId,
          accountId: provisionInput.accountId,
          sessionDate: provisionInput.sessionDate,
        });
      return provisioned;
    },
    prepareSide: async (input) => {
      options.lifecycle?.push(`prepare:${input.side}`);
      return new Map(
        input.shared.opportunities.map((opportunity) => [
          opportunity.sourceOpportunityId,
          `observation-${opportunity.sourceOrdinal}`,
        ]),
      );
    },
    applySide:
      options.applySide ??
      (async (input) => {
        options.lifecycle?.push(`apply:${input.side}`);
        applied.push({
          side: input.side,
          digest: input.shared.sessionInputDigest,
          sessionDate: input.shared.sessionDate,
        });
        seenDigests.push(input.shared.sessionInputDigest);
        sessionsRun.push(input.shared.sessionDate);
        return sideResult(
          input.side,
          input.runId,
          new Map(
            input.shared.opportunities.map((opportunity) => [
              opportunity.sourceOpportunityId,
              `observation-${opportunity.sourceOrdinal}`,
            ]),
          ),
        );
      }),
    projectSide:
      options.projectSide ??
      (async (input) => {
        projected.push(input.side);
        return sideResult(
          input.side,
          input.runId,
          new Map(
            input.shared.opportunities.map((opportunity) => [
              opportunity.sourceOpportunityId,
              `observation-${opportunity.sourceOrdinal}`,
            ]),
          ),
        );
      }),
  };
  return {
    deps,
    built,
    specification,
    bindings,
    binds,
    evaluations,
    storedEvaluations,
    get predictionCalls() {
      return predictionCalls;
    },
    setPredictionFailure(value: boolean) {
      failPredictions = value;
    },
    applied,
    projected,
    sessionsRun,
    seenDigests,
  };
}

describe("funded paired comparison runner", () => {
  it("runs champion before challenger over identical frozen input", async () => {
    const lifecycle: string[] = [];
    const harnessValue = harness({ lifecycle });
    const result = await runFundedPairedComparison(
      { specificationId: "spec-1", maxSessions: 1 },
      harnessValue.deps,
    );
    expect(result.sessions).toHaveLength(1);
    expect(lifecycle.filter((entry) => entry.startsWith("apply:"))).toEqual([
      "apply:CHAMPION",
      "apply:CHALLENGER",
    ]);
    expect(lifecycle).toEqual([
      "provision:" +
        championReplayAccountId(
          harnessValue.built.specification.comparisonSpecDigest,
        ),
      "bind:CHAMPION",
      "apply:CHAMPION",
      "persist:CHAMPION",
      "provision:" +
        challengerReplayAccountId(
          harnessValue.built.specification.comparisonSpecDigest,
        ),
      "bind:CHALLENGER",
      "prepare:CHALLENGER",
      "persist:CHALLENGER",
      "apply:CHALLENGER",
    ]);
    // A binding is committed before its side's facts exist.
    expect(
      lifecycle.indexOf("bind:CHAMPION") < lifecycle.indexOf("apply:CHAMPION"),
    ).toBe(true);
    expect(
      lifecycle.indexOf("bind:CHALLENGER") <
        lifecycle.indexOf("apply:CHALLENGER"),
    ).toBe(true);
    expect(
      lifecycle.indexOf("persist:CHALLENGER") <
        lifecycle.indexOf("apply:CHALLENGER"),
    ).toBe(true);
    expect(new Set(harnessValue.seenDigests).size).toBe(1);
    expect(harnessValue.bindings).toHaveLength(2);
    expect(harnessValue.evaluations).toHaveLength(4);
    const champion = harnessValue.evaluations.filter(
      (row) => row.side === "CHAMPION",
    );
    expect(champion.every((row) => row.prediction === null)).toBe(true);
    expect(champion.every((row) => row.appliedRank === row.championRank)).toBe(
      true,
    );
    const challenger = harnessValue.evaluations.filter(
      (row) => row.side === "CHALLENGER",
    );
    expect(challenger.every((row) => row.disposition === "PREDICTED")).toBe(
      true,
    );
    expect(challenger[0]!.disposition).toBe("PREDICTED");
    // Equal diagnostics tie-break on deterministic score descending: source-2
    // (score 72) is applied first while its champion rank stays 2.
    expect(challenger[0]!.appliedRank).toBe(2);
    expect(challenger[0]!.championRank).toBe(1);
    const secondOpportunityId = harnessValue.built.opportunities.find(
      (opportunity) => opportunity.sourceOrdinal === 2,
    )!.sourceOpportunityId;
    expect(
      challenger.find((row) => row.sourceOpportunityId === secondOpportunityId)!
        .appliedRank,
    ).toBe(1);
    expect(challenger[0]!.prediction?.modelId).toBe(
      harnessValue.built.specification.challenger.model.modelId,
    );
    expect(challenger[0]!.prediction?.featureVersion).toBe(
      "funded-execution-features-v1",
    );
  });

  it("fails closed when a retained chunk no longer matches its digest", async () => {
    const harnessValue = harness();
    const source = {
      loadSpecification: async () => harnessValue.built,
      loadSessionChunks: async () => [
        {
          ...harnessValue.built.sessions[0]!.chunks[0]!,
          items: harnessValue.built.sessions[0]!.chunks[0]!.items.map(
            (entry, index) =>
              index === 0 ? { ...entry, itemDigest: "0".repeat(64) } : entry,
          ),
        },
      ],
    };
    await expect(
      loadFundedComparisonSharedInput(source, "spec-1", sessionDate),
    ).rejects.toThrow(/item digest/i);
    await expect(
      loadFundedComparisonSharedInput(
        {
          ...source,
          loadSessionChunks: async () => [],
        },
        "spec-1",
        sessionDate,
      ),
    ).rejects.toThrow(/no retained chunks/i);
  });

  it("rejects a live funded account as a replay target", async () => {
    const harnessValue = harness({ liveAccount: true });
    await expect(
      runFundedPairedComparison(
        { specificationId: "spec-1", maxSessions: 1 },
        harnessValue.deps,
      ),
    ).rejects.toThrow(/live funded account/i);
  });

  it("skips a session whose both sides are already proven", async () => {
    const harnessValue = harness();
    const spec = harnessValue.built.specification;
    (
      harnessValue.deps.repository as unknown as {
        findBinding: (
          _specId: string,
          side: "CHAMPION" | "CHALLENGER",
        ) => Promise<object>;
        listSessionMetrics: () => Promise<object[]>;
      }
    ).findBinding = async (_specId, side) => {
      const accountId =
        side === "CHAMPION"
          ? championReplayAccountId(spec.comparisonSpecDigest)
          : challengerReplayAccountId(spec.comparisonSpecDigest);
      return {
        specId: "spec-1",
        side,
        sessionDate,
        runId: `run-${accountId.slice(0, 8)}`,
        accountId,
        marketId: "CA_TSX",
        currency: "CAD",
        policyDigest:
          side === "CHAMPION"
            ? spec.champion.policyDigest
            : spec.challenger.policyDigest,
        executionModelVersion: "execution-v1",
        accountAssumptionDigest: spec.champion.accountAssumptionDigest,
        boundAt: at,
      };
    };
    (
      harnessValue.deps.repository as unknown as {
        listSessionMetrics: () => Promise<object[]>;
      }
    ).listSessionMetrics = async () => [
      {
        specId: "spec-1",
        side: "CHAMPION",
        sessionDate,
        marketId: "CA_TSX",
        currency: "CAD",
        valuation: "UNION_GRID_MTM",
        valuationReason: null,
        netReturn: 1,
        maxDrawdown: 1,
        tradeCount: 1,
        unrealizedPositionCount: 0,
        unresolvedOrderCount: 0,
        unresolvedReservationCount: 0,
        staleMarkCount: 0,
        valuationPointCount: 1,
        metricDigest: digestA,
      },
      {
        specId: "spec-1",
        side: "CHALLENGER",
        sessionDate,
        marketId: "CA_TSX",
        currency: "CAD",
        valuation: "UNION_GRID_MTM",
        valuationReason: null,
        netReturn: 1,
        maxDrawdown: 1,
        tradeCount: 1,
        unrealizedPositionCount: 0,
        unresolvedOrderCount: 0,
        unresolvedReservationCount: 0,
        staleMarkCount: 0,
        valuationPointCount: 1,
        metricDigest: digestA,
      },
    ];
    (
      harnessValue.deps.repository as unknown as {
        listPolicyEvaluations: (
          _specId: string,
          side: "CHAMPION" | "CHALLENGER",
          date: string,
        ) => Promise<FundedComparisonPolicyEvaluation[]>;
      }
    ).listPolicyEvaluations = async (_specId, side, date) =>
      harnessValue.built.opportunities
        .filter((opportunity) => opportunity.sessionDate === date)
        .map(
          (opportunity) =>
            ({
              side,
              sessionDate: date,
              sourceOpportunityId: opportunity.sourceOpportunityId,
              sourceOrdinal: opportunity.sourceOrdinal,
            }) as FundedComparisonPolicyEvaluation,
        );
    const result = await runFundedPairedComparison(
      { specificationId: "spec-1", maxSessions: 1 },
      harnessValue.deps,
    );
    expect(result.skippedSessions).toEqual([sessionDate]);
    expect(result.sessions).toHaveLength(0);
  });

  it("does not skip proven bindings whose evaluation membership is incomplete", async () => {
    const built = receipt();
    const spec = built.specification;
    const championAccount = championReplayAccountId(spec.comparisonSpecDigest);
    const challengerAccount = challengerReplayAccountId(
      spec.comparisonSpecDigest,
    );
    const binding = (side: "CHAMPION" | "CHALLENGER", accountId: string) => ({
      specId: "spec-1",
      side,
      sessionDate,
      runId: `run-${accountId.slice(0, 8)}`,
      accountId,
      marketId: "CA_TSX",
      currency: "CAD",
      policyDigest:
        side === "CHAMPION"
          ? spec.champion.policyDigest
          : spec.challenger.policyDigest,
      executionModelVersion: "execution-v1",
      accountAssumptionDigest: spec.champion.accountAssumptionDigest,
      boundAt: at,
    });
    const harnessValue = harness({
      built,
      existingBindings: {
        [`CHAMPION:${sessionDate}`]: binding("CHAMPION", championAccount),
        [`CHALLENGER:${sessionDate}`]: binding("CHALLENGER", challengerAccount),
      },
    });
    (
      harnessValue.deps.repository as unknown as {
        listSessionMetrics: () => Promise<object[]>;
      }
    ).listSessionMetrics = async () =>
      (["CHAMPION", "CHALLENGER"] as const).map((side) => ({
        specId: "spec-1",
        side,
        sessionDate,
        marketId: "CA_TSX",
        currency: "CAD",
        valuation: "UNION_GRID_MTM",
        valuationReason: null,
        netReturn: 1,
        maxDrawdown: 1,
        tradeCount: 1,
        unrealizedPositionCount: 0,
        unresolvedOrderCount: 0,
        unresolvedReservationCount: 0,
        staleMarkCount: 0,
        valuationPointCount: 1,
        metricDigest: digestA,
      }));
    const result = await runFundedPairedComparison(
      { specificationId: "spec-1", maxSessions: 1 },
      harnessValue.deps,
    );
    expect(result.skippedSessions).toEqual([]);
    expect(result.sessions).toHaveLength(1);
  });

  it("heartbeats before each session and before each side", async () => {
    const heartbeats: string[] = [];
    const harnessValue = harness({ heartbeats });
    await runFundedPairedComparison(
      { specificationId: "spec-1", maxSessions: 1 },
      harnessValue.deps,
    );
    // session, champion side, challenger side.
    expect(heartbeats).toHaveLength(3);
  });

  it("resumes the exact bound run after a crash at provisioning", async () => {
    const championAccount = championReplayAccountId(
      receipt().specification.comparisonSpecDigest,
    );
    const championRunId = `run-${championAccount.slice(0, 8)}`;
    const lifecycle: string[] = [];
    const harnessValue = harness({
      lifecycle,
      existingBindings: {
        [`CHAMPION:${sessionDate}`]: {
          specId: "spec-1",
          side: "CHAMPION",
          sessionDate,
          runId: championRunId,
          accountId: championAccount,
          marketId: "CA_TSX",
          currency: "CAD",
          policyDigest: harnessValuePolicyDigest(),
          executionModelVersion: "execution-v1",
          accountAssumptionDigest: digestB,
          boundAt: at,
        },
      },
      runStatuses: { [championRunId]: "RUNNING" },
    });
    const result = await runFundedPairedComparison(
      { specificationId: "spec-1", maxSessions: 1 },
      harnessValue.deps,
    );
    expect(result.sessions).toHaveLength(1);
    // The bound champion run is resumed, never re-provisioned.
    expect(
      lifecycle.some((entry) => entry === `provision:${championAccount}`),
    ).toBe(false);
    expect(harnessValue.applied.map((entry) => entry.side)).toEqual([
      "CHAMPION",
      "CHALLENGER",
    ]);
    expect(
      harnessValue.evaluations
        .filter((row) => row.side === "CHAMPION")
        .every((row) => row.destinationRunId === championRunId),
    ).toBe(true);
  });

  it("recovers an exact intent-owned run after a crash between provisioning and binding", async () => {
    const lifecycle: string[] = [];
    const harnessValue = harness({
      lifecycle,
      crashAfterProvisionBeforeBind: true,
    });
    await expect(
      runFundedPairedComparison(
        { specificationId: "spec-1", maxSessions: 1 },
        harnessValue.deps,
      ),
    ).rejects.toThrow(/after provisioning commit/i);
    const result = await runFundedPairedComparison(
      { specificationId: "spec-1", maxSessions: 1 },
      harnessValue.deps,
    );
    expect(result.sessions).toHaveLength(1);
    expect(harnessValue.binds).toContain(`CHAMPION:${sessionDate}`);
    expect(
      lifecycle.filter((entry) =>
        entry.startsWith(
          `provision:${championReplayAccountId(
            harnessValue.specification.comparisonSpecDigest,
          )}`,
        ),
      ),
    ).toHaveLength(2);
  });

  it("refuses to adopt a binding whose account is not the side-derived account", async () => {
    const championAccount = championReplayAccountId(
      receipt().specification.comparisonSpecDigest,
    );
    const championRunId = `run-${championAccount.slice(0, 8)}`;
    const harnessValue = harness({
      existingBindings: {
        [`CHAMPION:${sessionDate}`]: {
          specId: "spec-1",
          side: "CHAMPION",
          sessionDate,
          runId: championRunId,
          accountId: "00000000-0000-4000-8000-000000000099",
          marketId: "CA_TSX",
          currency: "CAD",
          policyDigest: harnessValuePolicyDigest(),
          executionModelVersion: "execution-v1",
          accountAssumptionDigest: digestB,
          boundAt: at,
        },
      },
      runStatuses: { [championRunId]: "RUNNING" },
    });
    await expect(
      runFundedPairedComparison(
        { specificationId: "spec-1", maxSessions: 1 },
        harnessValue.deps,
      ),
    ).rejects.toThrow(/binding changed while resuming/i);
  });

  it("adopts a completed champion run without rerunning its side", async () => {
    const championAccount = championReplayAccountId(
      receipt().specification.comparisonSpecDigest,
    );
    const championRunId = `run-${championAccount.slice(0, 8)}`;
    const harnessValue = harness({
      existingBindings: {
        [`CHAMPION:${sessionDate}`]: {
          specId: "spec-1",
          side: "CHAMPION",
          sessionDate,
          runId: championRunId,
          accountId: championAccount,
          marketId: "CA_TSX",
          currency: "CAD",
          policyDigest: harnessValuePolicyDigest(),
          executionModelVersion: "execution-v1",
          accountAssumptionDigest: digestB,
          boundAt: at,
        },
      },
      runStatuses: { [championRunId]: "COMPLETED" },
    });
    const result = await runFundedPairedComparison(
      { specificationId: "spec-1", maxSessions: 1 },
      harnessValue.deps,
    );
    expect(result.sessions).toHaveLength(1);
    expect(harnessValue.projected).toEqual(["CHAMPION"]);
    expect(harnessValue.applied.map((entry) => entry.side)).toEqual([
      "CHALLENGER",
    ]);
    // Both sides' evaluations are still appended from the adopted run.
    expect(harnessValue.evaluations).toHaveLength(4);
  });

  it("adopts both completed sides before finalization", async () => {
    const specDigest = receipt().specification.comparisonSpecDigest;
    const championAccount = championReplayAccountId(specDigest);
    const challengerAccount = challengerReplayAccountId(specDigest);
    const championRunId = `run-${championAccount.slice(0, 8)}`;
    const challengerRunId = `run-${challengerAccount.slice(0, 8)}`;
    const harnessValue = harness({
      existingBindings: {
        [`CHAMPION:${sessionDate}`]: {
          specId: "spec-1",
          side: "CHAMPION",
          sessionDate,
          runId: championRunId,
          accountId: championAccount,
          marketId: "CA_TSX",
          currency: "CAD",
          policyDigest: harnessValuePolicyDigest(),
          executionModelVersion: "execution-v1",
          accountAssumptionDigest: digestB,
          boundAt: at,
        },
        [`CHALLENGER:${sessionDate}`]: {
          specId: "spec-1",
          side: "CHALLENGER",
          sessionDate,
          runId: challengerRunId,
          accountId: challengerAccount,
          marketId: "CA_TSX",
          currency: "CAD",
          policyDigest: harnessValueChallengerDigest(),
          executionModelVersion: "execution-v1",
          accountAssumptionDigest: digestB,
          boundAt: at,
        },
      },
      runStatuses: {
        [championRunId]: "COMPLETED",
        [challengerRunId]: "COMPLETED",
      },
    });
    const result = await runFundedPairedComparison(
      { specificationId: "spec-1", maxSessions: 1 },
      harnessValue.deps,
    );
    expect(result.sessions).toHaveLength(1);
    expect(harnessValue.applied).toHaveLength(0);
    expect(harnessValue.projected).toEqual(["CHAMPION", "CHALLENGER"]);
    expect(harnessValue.evaluations).toHaveLength(4);
  });

  it("reuses fallback evaluations on healthy retries before and after challenger completion", async () => {
    let failBeforeEffects = true;
    const runStatuses: Record<string, string> = {};
    const challengerOrderings: {
      sourceOpportunityId: string;
      appliedRank: number;
    }[][] = [];
    const harnessValue = harness({
      failPredictions: true,
      runStatuses,
      applySide: async (input) => {
        if (input.side === "CHALLENGER")
          challengerOrderings.push([...input.ordering]);
        if (input.side === "CHALLENGER" && failBeforeEffects) {
          failBeforeEffects = false;
          throw new Error("injected crash before challenger facts");
        }
        return sideResult(
          input.side,
          input.runId,
          new Map(
            input.shared.opportunities.map((opportunity) => [
              opportunity.sourceOpportunityId,
              input.preparedObservations?.get(
                opportunity.sourceOpportunityId,
              ) ?? `observation-${opportunity.sourceOrdinal}`,
            ]),
          ),
        );
      },
    });
    await expect(
      runFundedPairedComparison(
        { specificationId: "spec-1", maxSessions: 1 },
        harnessValue.deps,
      ),
    ).rejects.toThrow(/injected crash/i);
    const storedFallback = [
      ...(harnessValue.storedEvaluations.get(`CHALLENGER:${sessionDate}`) ??
        []),
    ];
    expect(storedFallback).toHaveLength(2);
    expect(
      storedFallback.every(
        (evaluation) =>
          evaluation.disposition === "FALLBACK_CHAMPION_ORDER" &&
          evaluation.fallbackReason !== null &&
          evaluation.appliedRank === evaluation.championRank,
      ),
    ).toBe(true);
    const callsAfterFallback = harnessValue.predictionCalls;

    harnessValue.setPredictionFailure(false);
    const resumed = await runFundedPairedComparison(
      { specificationId: "spec-1", maxSessions: 1 },
      harnessValue.deps,
    );
    expect(resumed.sessions[0]!.predictionFallback).toBe(true);
    expect(harnessValue.predictionCalls).toBe(callsAfterFallback);
    const storedOrdering = storedFallback.map((evaluation) => ({
      sourceOpportunityId: evaluation.sourceOpportunityId,
      appliedRank: evaluation.appliedRank,
    }));
    expect(challengerOrderings).toEqual([storedOrdering, storedOrdering]);
    expect(
      resumed.sessions[0]!.challengerEvaluations.map((evaluation) => ({
        reason: evaluation.fallbackReason,
        rank: evaluation.appliedRank,
        digest: evaluation.evaluationDigest,
      })),
    ).toEqual(
      storedFallback.map((evaluation) => ({
        reason: evaluation.fallbackReason,
        rank: evaluation.appliedRank,
        digest: evaluation.evaluationDigest,
      })),
    );

    const challengerBinding = harnessValue.bindings.find(
      (binding) => (binding as { side: string }).side === "CHALLENGER",
    ) as { runId: string };
    runStatuses[challengerBinding.runId] = "COMPLETED";
    const completedRetry = await runFundedPairedComparison(
      { specificationId: "spec-1", maxSessions: 1 },
      harnessValue.deps,
    );
    expect(completedRetry.sessions[0]!.predictionFallback).toBe(true);
    expect(harnessValue.predictionCalls).toBe(callsAfterFallback);
  });

  it("rejects an account owned by another comparison specification", async () => {
    const harnessValue = harness({ foreignAccount: true });
    await expect(
      runFundedPairedComparison(
        { specificationId: "spec-1", maxSessions: 1 },
        harnessValue.deps,
      ),
    ).rejects.toThrow(/another comparison specification/i);
  });

  it("rejects an unbound run on a deterministic comparison account", async () => {
    const harnessValue = harness({ unboundAccount: true });
    await expect(
      runFundedPairedComparison(
        { specificationId: "spec-1", maxSessions: 1 },
        harnessValue.deps,
      ),
    ).rejects.toThrow(/no exact comparison-owned provisioning proof/i);
  });

  it("rejects a replay run when enumeration reveals a second foreign binding", async () => {
    const harnessValue = harness({ hiddenForeignBinding: true });
    await expect(
      runFundedPairedComparison(
        { specificationId: "spec-1", maxSessions: 1 },
        harnessValue.deps,
      ),
    ).rejects.toThrow(/exactly one comparison binding/i);
  });

  it("rejects a champion account whose run is bound to the challenger side", async () => {
    const harnessValue = harness({ wrongSideBinding: true });
    await expect(
      runFundedPairedComparison(
        { specificationId: "spec-1", maxSessions: 1 },
        harnessValue.deps,
      ),
    ).rejects.toThrow(/account, side, run, or session/i);
  });

  it("advances across two sessions and keeps batches local to their timestamp", async () => {
    const built = twoSessionReceipt();
    const harnessValue = harness({ built });
    const result = await runFundedPairedComparison(
      { specificationId: "spec-1", maxSessions: 5 },
      harnessValue.deps,
    );
    expect(result.sessions.map((session) => session.sessionDate)).toEqual([
      sessionDate,
      SECOND_SESSION_DATE,
    ]);
    // Both sides consume the identical frozen session input digest per session.
    for (const session of built.sessions) {
      const entries = harnessValue.applied.filter(
        (entry) => entry.sessionDate === session.sessionDate,
      );
      expect(entries).toHaveLength(2);
      expect(new Set(entries.map((entry) => entry.digest))).toEqual(
        new Set([session.sessionInputDigest]),
      );
    }
    // Evaluations use batch-local ranks consistently on both sides.
    const secondSessionRows = harnessValue.evaluations.filter(
      (row) => row.sessionDate === SECOND_SESSION_DATE,
    );
    for (const side of ["CHAMPION", "CHALLENGER"] as const) {
      const byBatch = new Map<string, FundedComparisonPolicyEvaluation[]>();
      for (const row of secondSessionRows.filter(
        (value) => value.side === side,
      )) {
        const rows = byBatch.get(row.batchKey) ?? [];
        rows.push(row);
        byBatch.set(row.batchKey, rows);
      }
      expect(byBatch.size).toBe(2);
      for (const rows of byBatch.values()) {
        const ranks = rows.map((row) => row.appliedRank).sort();
        expect(ranks).toEqual(rows.map((_, index) => index + 1));
      }
    }
    const champions = secondSessionRows.filter(
      (row) => row.side === "CHAMPION",
    );
    expect(champions.every((row) => row.appliedRank === row.championRank)).toBe(
      true,
    );
  });

  it("runs a populated session followed by an exact quiet session through both sides", async () => {
    const built = quietSecondSessionReceipt();
    const harnessValue = harness({ built });
    const result = await runFundedPairedComparison(
      { specificationId: "spec-1", maxSessions: 5 },
      harnessValue.deps,
    );
    expect(result.sessions.map((session) => session.sessionDate)).toEqual([
      sessionDate,
      SECOND_SESSION_DATE,
    ]);
    expect(
      harnessValue.applied.filter(
        (entry) => entry.sessionDate === SECOND_SESSION_DATE,
      ),
    ).toHaveLength(2);
    expect(
      harnessValue.evaluations.filter(
        (evaluation) => evaluation.sessionDate === SECOND_SESSION_DATE,
      ),
    ).toHaveLength(0);
    expect(harnessValue.predictionCalls).toBe(1);
  });
});

function harnessValuePolicyDigest(): string {
  return contentHash(fundedPolicy(1, 0));
}

function harnessValueChallengerDigest(): string {
  return receipt().specification.challenger.policyDigest;
}
