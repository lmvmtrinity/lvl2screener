import { describe, expect, it } from "vitest";
import {
  createBacktestSchema,
  type FundedComparisonSourceOpportunity,
  type FundedComparisonSpecification,
} from "@tsx-scanner/contracts";
import {
  FundedComparisonSpecificationError,
  assertFundedComparisonChronology,
  assertSourceOpportunityOwnership,
  buildFundedComparisonSpecification,
  fundedComparisonTrainingSessionDigest,
  type FundedComparisonFrozenSessionIdentity,
  type FundedComparisonSpecificationInput,
} from "../src/paper-bot/funded-comparison-specification.js";
import { fundedComparisonSpecDigest } from "../src/paper-bot/funded-comparison-digest.js";
import { contentHash } from "../src/paper-bot/funded-evidence-digest.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);

const TRAINING_DATES = ["2026-09-09", "2026-09-10", "2026-09-11"];

function sessionsFor(
  dates: readonly string[],
): FundedComparisonFrozenSessionIdentity[] {
  return dates.map((sessionDate, index) => ({
    sessionDate,
    itemCount: 3 + index,
    chunkCount: 1,
    sessionInputDigest: contentHash({ sessionDate, index }),
  }));
}

function replayConfiguration(marketId: "CA_TSX" | "US_EQUITIES" = "CA_TSX") {
  return {
    request: createBacktestSchema.parse({
      name: "baseline",
      marketId,
      startDate: "2026-09-01",
      endDate: "2026-09-15",
      strategies: ["ORB_RETEST"],
      symbols: [],
      startingCapital: 25_000,
      positionSize: 2_500,
      slippageBps: 5,
      feePerTrade: 1,
      parameters: {
        ...createBacktestSchema.parse({
          name: "x",
          startDate: "2026-09-01",
          endDate: "2026-09-02",
        }).parameters,
        scoreCutoff: 70,
      },
    }),
    profiles: [
      {
        strategyKey: "ORB_RETEST",
        profileId: "profile-1",
        profileName: "Opening range",
        profileConfigId: "profile-config-1",
        configVersion: "config-1",
      },
    ],
  };
}

function opportunity(
  sourceOrdinal: number,
  overrides: Partial<FundedComparisonSourceOpportunity> = {},
): FundedComparisonSourceOpportunity {
  const sourceOpportunityId = `source-${sourceOrdinal}`;
  return {
    sourceOpportunityId,
    sessionDate: "2026-09-14",
    sourceOrdinal,
    sourceEventId: `source-event-${sourceOrdinal}`,
    setupInstanceId: `setup-${sourceOrdinal}`,
    instrumentId: `instrument-${sourceOrdinal}`,
    profileConfigId: "profile-config-1",
    signalTimestamp: `2026-09-14T13:${(30 + sourceOrdinal).toString().padStart(2, "0")}:00.000Z`,
    sourceContentDigest: digestA,
    ...overrides,
  };
}

function input(
  overrides: Partial<FundedComparisonSpecificationInput> = {},
): FundedComparisonSpecificationInput {
  const sessionDates = overrides.sessionDates ?? ["2026-09-15", "2026-09-16"];
  return {
    marketId: "CA_TSX",
    baseline: {
      backtestRunId: "baseline-1",
      configVersion: "config-1",
      strategyKeys: ["ORB_RETEST"],
      startDate: "2026-09-01",
      endDate: "2026-09-15",
      executionModelVersion: "execution-v1",
      replayInputDigest: digestA,
      baselineResultDigest: digestB,
      completedAt: "2026-09-15T20:00:00.000Z",
    },
    sessionDates,
    sessions: overrides.sessions ?? sessionsFor([...sessionDates]),
    replay: overrides.replay ?? replayConfiguration(),
    opportunities: [
      opportunity(1, { sessionDate: "2026-09-15" }),
      opportunity(2, { sessionDate: "2026-09-16" }),
    ],
    champion: {
      kind: "DETERMINISTIC_FUNDED_POLICY",
      fundedPolicyVersion: "funded-cash-v1",
      portfolioPolicyVersion: "funded-portfolio-v2",
      policyDigest: digestA,
      sourceLiveRunId: "live-run-1",
      sourceAccountId: "live-account-1",
      executionModelVersion: "execution-v1",
      costPolicyVersion: "cost-v1",
      participationVersion: "participation-v1",
      runtimeVersion: "runtime-v1",
      accountAssumptionDigest: digestB,
      assumptionsDigest: digestC,
    },
    challenger: {
      kind: "FUNDED_EXECUTION_POLICY_V1",
      policyVersion: "funded-comparison-execution-quality-ordering-v1",
      policyDigest: digestB,
      model: {
        modelId: "challenger-1",
        modelVersion: "funded-execution-v1",
        artifactDigest: digestA,
        datasetDigest: digestB,
        cohortDigest: digestC,
        featureVersion: "funded-execution-features-v1",
        predictionPolicyVersion: "funded-execution-prediction-v1",
        trainingPartitionDigest: digestA,
        trainingEvidenceCutoffAt: "2026-09-11T20:00:00.000Z",
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
      trainingKnowledgeCutoffAt: "2026-09-11T20:00:00.000Z",
      trainingPartitionDigest: digestA,
      trainingSessionDigest:
        fundedComparisonTrainingSessionDigest(TRAINING_DATES),
    },
    lastInputEffectiveAt: "2026-09-16T20:00:00.000Z",
    evidenceCutoffAt: "2026-09-16T20:00:00.000Z",
    specificationFrozenAt: "2026-09-16T20:30:00.000Z",
    ...overrides,
  };
}

function trainingWindow(
  overrides: Partial<FundedComparisonSpecificationInput["training"]> = {},
): FundedComparisonSpecificationInput["training"] {
  const trainingSessionDates = overrides.trainingSessionDates ?? TRAINING_DATES;
  return {
    trainingSessionDates,
    trainingKnowledgeCutoffAt:
      overrides.trainingKnowledgeCutoffAt ?? "2026-09-11T20:00:00.000Z",
    trainingPartitionDigest: overrides.trainingPartitionDigest ?? digestA,
    trainingSessionDigest:
      overrides.trainingSessionDigest ??
      fundedComparisonTrainingSessionDigest(trainingSessionDates),
  };
}

function build(
  overrides: Partial<FundedComparisonSpecificationInput> = {},
): FundedComparisonSpecification {
  return buildFundedComparisonSpecification(input(overrides));
}

describe("funded comparison specification builder", () => {
  it("builds a stable, self-verifying digest", () => {
    const specification = build();
    expect(specification.comparisonSpecDigest).toMatch(/^[a-f0-9]{64}$/);
    const { comparisonSpecDigest, ...withoutDigest } = specification;
    expect(fundedComparisonSpecDigest(withoutDigest)).toBe(
      comparisonSpecDigest,
    );
    expect(build().comparisonSpecDigest).toBe(comparisonSpecDigest);
  });

  it("changes the digest when any frozen identity changes", () => {
    const baseline = build().comparisonSpecDigest;
    const variants: Partial<FundedComparisonSpecificationInput>[] = [
      {
        champion: {
          ...input().champion,
          policyDigest: digestB,
        },
      },
      {
        challenger: {
          ...input().challenger,
          policyDigest: digestA,
        },
      },
      {
        challenger: {
          ...input().challenger,
          model: { ...input().challenger.model, artifactDigest: digestB },
        },
      },
      {
        challenger: {
          ...input().challenger,
          model: { ...input().challenger.model, datasetDigest: digestA },
        },
      },
      { capital: { ...input().capital, initialCash: 30_000 } },
      { evidenceCutoffAt: "2026-09-16T20:15:00.000Z" },
      { specificationFrozenAt: "2026-09-16T21:00:00.000Z" },
      { sessionDates: ["2026-09-16"] },
      { opportunities: [opportunity(1)] },
      {
        opportunities: [
          opportunity(1, { sessionDate: "2026-09-15" }),
          opportunity(3, { sessionDate: "2026-09-16" }),
        ],
      },
    ];
    for (const variant of variants)
      expect(build(variant).comparisonSpecDigest).not.toBe(baseline);
  });

  it("rejects unsorted, duplicate or empty membership", () => {
    expect(() =>
      build({ sessionDates: ["2026-09-16", "2026-09-15"] }),
    ).toThrow();
    expect(() =>
      build({ sessionDates: ["2026-09-15", "2026-09-15"] }),
    ).toThrow();
    expect(() => build({ sessionDates: [] })).toThrow();
    expect(() => build({ opportunities: [] })).toThrow();
  });

  it("rejects missing baseline result lineage", () => {
    expect(() =>
      build({
        baseline: { ...input().baseline, baselineResultDigest: "" },
      }),
    ).toThrow();
  });

  it("rejects non-chronological comparison windows", () => {
    expect(() =>
      build({
        training: trainingWindow({
          trainingSessionDates: ["2026-09-15"],
          trainingKnowledgeCutoffAt: "2026-09-14T20:00:00.000Z",
        }),
      }),
    ).toThrow();
    expect(() =>
      build({
        sessionDates: ["2026-09-11", "2026-09-12"],
        opportunities: [
          opportunity(1, { sessionDate: "2026-09-11" }),
          opportunity(2, { sessionDate: "2026-09-12" }),
        ],
      }),
    ).toThrow(/first comparison session/i);
    expect(() =>
      assertFundedComparisonChronology(
        input({
          training: trainingWindow({
            trainingSessionDates: ["2026-09-15"],
            trainingKnowledgeCutoffAt: "2026-09-11T20:00:00.000Z",
          }),
        }),
      ),
    ).toThrow(/overlap/i);
  });

  it("rejects a source item effective after the frozen cutoff", () => {
    expect(() =>
      build({ lastInputEffectiveAt: "2026-09-16T21:00:00.000Z" }),
    ).toThrow(FundedComparisonSpecificationError);
  });

  it("refuses to substitute a destination identity for a source opportunity", () => {
    const specification = build();
    const substituted: FundedComparisonSourceOpportunity[] = [
      opportunity(1, {
        sessionDate: "2026-09-15",
        sourceOpportunityId: "destination-observation-uuid",
      }),
      opportunity(2, { sessionDate: "2026-09-16" }),
    ];
    expect(() =>
      assertSourceOpportunityOwnership(specification, substituted),
    ).toThrow(/frozen membership/i);
    expect(() =>
      assertSourceOpportunityOwnership(specification, [
        opportunity(1, { sessionDate: "2026-09-15" }),
        opportunity(2, { sessionDate: "2026-09-17" }),
      ]),
    ).toThrow(/outside the frozen sessions/i);
  });

  it("accepts the exact frozen membership", () => {
    const specification = build();
    const frozen = [
      opportunity(1, { sessionDate: "2026-09-15" }),
      opportunity(2, { sessionDate: "2026-09-16" }),
    ];
    expect(() =>
      assertSourceOpportunityOwnership(specification, frozen),
    ).not.toThrow();
  });

  it("changes the digest when a frozen session input identity changes", () => {
    const baseline = build().comparisonSpecDigest;
    const altered = sessionsFor(["2026-09-15", "2026-09-16"]);
    altered[1] = { ...altered[1]!, sessionInputDigest: digestC };
    expect(build({ sessions: altered }).comparisonSpecDigest).not.toBe(
      baseline,
    );
    const chunkCountChanged = sessionsFor(["2026-09-15", "2026-09-16"]);
    chunkCountChanged[0] = { ...chunkCountChanged[0]!, chunkCount: 2 };
    expect(
      build({ sessions: chunkCountChanged }).comparisonSpecDigest,
    ).not.toBe(baseline);
    expect(build().sharedInput.orderedSessions).toEqual([
      {
        sessionDate: "2026-09-15",
        itemCount: 3,
        chunkCount: 1,
        sessionInputDigest: contentHash({
          sessionDate: "2026-09-15",
          index: 0,
        }),
      },
      {
        sessionDate: "2026-09-16",
        itemCount: 4,
        chunkCount: 1,
        sessionInputDigest: contentHash({
          sessionDate: "2026-09-16",
          index: 1,
        }),
      },
    ]);
  });

  it("rejects a frozen replay request from another market", () => {
    expect(() => build({ replay: replayConfiguration("US_EQUITIES") })).toThrow(
      /another market/i,
    );
  });

  it("rejects a training window whose digest disagrees with its dates", () => {
    expect(() =>
      build({
        training: trainingWindow({
          trainingSessionDigest: digestC,
        }),
      }),
    ).toThrow(/TRAIN session digest/i);
    expect(() =>
      build({
        training: trainingWindow({
          trainingSessionDates: ["2026-09-11", "2026-09-10"],
        }),
      }),
    ).toThrow(/empty, duplicated or unsorted/i);
  });

  it("rejects derived TRAIN lineage that does not match the frozen challenger model", () => {
    expect(() =>
      build({
        training: trainingWindow({ trainingPartitionDigest: digestB }),
      }),
    ).toThrow(/challenger model/i);
    expect(() =>
      build({
        training: trainingWindow({
          trainingKnowledgeCutoffAt: "2026-09-11T19:59:59.000Z",
        }),
      }),
    ).toThrow(/challenger model/i);
    expect(() =>
      build({
        training: trainingWindow({
          trainingSessionDates: ["2026-09-08", ...TRAINING_DATES],
        }),
      }),
    ).toThrow(/challenger model/i);
  });
});
