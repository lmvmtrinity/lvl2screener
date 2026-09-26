import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SignalModelResearchJobHandler } from "../src/worker/handlers/signal-model-research-job-handler.js";
import { contentHash } from "../src/backtests/research-coverage.js";
import { PostgresCanonicalSignalOpportunityCaptureRepository } from "../src/backtests/signal-model-source-preflight.js";
import { PostgresSignalModelResearchControlStore } from "../src/backtests/signal-model-research-control.js";
import type { ScannerFeatureClient } from "../src/market-data/scanner-client.js";
import type { Pool } from "pg";
import { signalModelResearchPlanSchema } from "@tsx-scanner/contracts";

describe("signal-model research job handler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps exact unselected membership, records an insufficient inactive report, and never activates", async () => {
    const opportunityIds = {
      TRAIN: ["train-selected", "train-unselected"],
      VALIDATION: ["validation-one", "validation-two"],
      TEST: ["test-selected", "test-unselected"],
    } as const;
    const sessions = {
      TRAIN: ["2026-01-01", "2026-01-02"],
      VALIDATION: ["2026-01-04", "2026-01-05"],
      TEST: ["2026-01-07", "2026-01-08"],
    } as const;
    const runId = randomUUID();
    const sourceDigest = contentHash("source");
    const sourceBindingHash = contentHash("binding");
    const membershipHash = (stage: keyof typeof opportunityIds) =>
      contentHash({ stage, ids: opportunityIds[stage] });
    const source = {
      runId,
      marketId: "CA_TSX" as const,
      strategy: "ORB_RETEST",
      strategyVersion: "1.0.0",
      configVersion: "capture-v1",
      profileId: "00000000-0000-4000-8000-000000000082",
      profileName: "ORB",
      executionModelVersion: "paper-execution-v7",
      executionAssumptionsHash: contentHash({ positionSize: 1000 }),
      sourceDigest,
      sourceBindingHash,
      orderedMembershipHash: contentHash("ordered"),
      orderedMembershipCount: 6,
    };
    const plan = signalModelResearchPlanSchema.parse({
      version: "signal-model-experiment-v1",
      experimentId: randomUUID(),
      source,
      sessions,
      membership: {
        TRAIN: {
          opportunityIds: opportunityIds.TRAIN,
          membershipHash: membershipHash("TRAIN"),
        },
        VALIDATION: {
          opportunityIds: opportunityIds.VALIDATION,
          membershipHash: membershipHash("VALIDATION"),
        },
        TEST: {
          opportunityIds: opportunityIds.TEST,
          membershipHash: membershipHash("TEST"),
        },
      },
      overlapPurge: {
        labelHorizonSessions: 1,
        trainValidationPurgeSessions: ["2026-01-03"],
        validationTestPurgeSessions: ["2026-01-06"],
      },
      model: {
        minimumTrainingSamples: 20,
        thresholdCandidates: [0, 50, 90],
        l2Penalty: 0.1,
      },
      comparison: {
        minimumUsefulNetPnlPerSelectedOpportunity: 0.25,
        unit: "CAD",
        alpha: 0.05,
        targetPower: 0.8,
        minimumIndependentSessions: 2,
        minimumValidationSessions: 2,
        minimumClosedOutcomes: 20,
        maximumMissedWinnerRate: 0.25,
        maximumDrawdownIncrease: 100,
        maximumTurnoverIncrease: 0.1,
        maximumLargestSymbolShare: 1,
        maximumLargestSessionShare: 1,
        bootstrapSamples: 1000,
        blockLength: 2,
        seed: 17,
        extraCostScenarios: [],
      },
      trialBudget: 1,
    });
    const hash = contentHash(plan);
    const authorizationId = randomUUID();
    const makeRow = (
      id: string,
      stage: "TRAIN" | "VALIDATION" | "TEST",
      index: number,
      baselineSelected: boolean,
    ) => {
      const date = sessions[stage][index]!;
      return {
        opportunityId: id,
        stage,
        sessionDate: date,
        marketId: "CA_TSX",
        instrumentId: randomUUID(),
        symbol: `SYM${index}`,
        strategy: "ORB_RETEST",
        profileId: source.profileId,
        profileName: source.profileName,
        baselineSelected,
        predictionInput: {
          timestamp: `${date}T14:00:00.000Z`,
          deterministicScore: 75,
          atrPct: 2,
          rvolAtTime: 1.5,
        },
        labelAvailableAt: `${date}T15:00:00.000Z`,
        outcome:
          stage === "TEST"
            ? { status: "NO_FILL", reason: "NO_FILL" }
            : {
                status: "CLOSED",
                entryTime: `${date}T14:01:00.000Z`,
                exitTime: `${date}T15:00:00.000Z`,
                entryPrice: 10,
                exitPrice: 11,
                shares: 1,
                netPnl: 1,
                rMultiple: 1,
              },
      };
    };
    const captures = [
      makeRow(opportunityIds.TRAIN[0], "TRAIN", 0, true),
      makeRow(opportunityIds.TRAIN[1], "TRAIN", 1, false),
      makeRow(opportunityIds.VALIDATION[0], "VALIDATION", 0, true),
      makeRow(opportunityIds.VALIDATION[1], "VALIDATION", 1, true),
      makeRow(opportunityIds.TEST[0], "TEST", 0, true),
      makeRow(opportunityIds.TEST[1], "TEST", 1, false),
    ];
    const ordinarySource = {
      status: "AVAILABLE",
      sourceDigest,
      sourceBindingHash,
      orderedMembershipHash: source.orderedMembershipHash,
      orderedMembershipCount: 6,
      testMembershipHash: membershipHash("TEST"),
      testOutcomesReleased: false,
      orderedCaptures: captures.map((row) =>
        row.stage === "TEST"
          ? { ...row, outcome: null, labelAvailableAt: null }
          : row,
      ),
    };
    const releasedSource = {
      ...ordinarySource,
      testOutcomesReleased: true,
      orderedCaptures: captures,
    } as never;
    vi.spyOn(
      PostgresSignalModelResearchControlStore.prototype,
      "assertJobAuthority",
    ).mockResolvedValue();
    vi.spyOn(
      PostgresSignalModelResearchControlStore.prototype,
      "claimStage",
    ).mockImplementation(
      async (_id, stage) =>
        ({
          claim_id: `${stage.toLowerCase()}-claim`,
          membership_hash: membershipHash(stage),
        }) as never,
    );
    vi.spyOn(
      PostgresSignalModelResearchControlStore.prototype,
      "appendAttempt",
    ).mockResolvedValue({} as never);
    vi.spyOn(
      PostgresCanonicalSignalOpportunityCaptureRepository.prototype,
      "loadForSource",
    ).mockResolvedValue(ordinarySource as never);
    vi.spyOn(
      PostgresCanonicalSignalOpportunityCaptureRepository.prototype,
      "loadTestAfterClaim",
    ).mockResolvedValue(releasedSource);
    vi.spyOn(
      PostgresSignalModelResearchControlStore.prototype,
      "consumeFinalTestClaim",
    ).mockResolvedValue({} as never);

    const trainingRows: unknown[] = [];
    const artifact = {
      artifactVersion: "1.0.0" as const,
      modelType: "LOGISTIC_SETUP_QUALITY" as const,
      featureNames: ["score", "atrPct", "rvolAtTime", "strategy"] as [
        string,
        string,
        string,
        string,
      ],
      intercept: 0,
      coefficients: [0, 0, 0, 0] as [number, number, number, number],
      means: [0, 0, 0, 0] as [number, number, number, number],
      scales: [1, 1, 1, 1] as [number, number, number, number],
      medians: [0, 0, 0, 0] as [number, number, number, number],
      atrMedian: 0,
      rvolMedian: 0,
    };
    const metrics = {
      samples: 20,
      positives: 10,
      negatives: 10,
      baseRate: 0.5,
      brierScore: 0.25,
      baselineBrierScore: 0.25,
      logLoss: 0.69,
      rocAuc: 0.5,
    };
    const scanner = {
      trainSignalModelResearch: vi.fn(
        async (request: { trainingRows: unknown[] }) => {
          trainingRows.push(...request.trainingRows);
          return {
            status: "COMPLETED",
            artifact,
            train: metrics,
            test: null,
            calibration: [],
            eligibleForActivation: false,
            warnings: [],
            trainingStart: null,
            trainingEnd: null,
            testStart: null,
            testEnd: null,
          };
        },
      ),
      predictStatistical: vi.fn(
        async (request: { inputs: Array<Record<string, unknown>> }) => ({
          predictions: request.inputs.map((input) => ({
            ...input,
            setupProbability: 0.5,
            falseBreakoutProbability: 0.5,
            rankingScore: 50,
            regime: { atr: "UNKNOWN", rvol: "UNKNOWN", combined: "UNKNOWN" },
            contributions: {},
            warnings: [],
          })),
        }),
      ),
    } as unknown as ScannerFeatureClient;
    let persistedReport: Record<string, unknown> | undefined;
    const handoff = vi
      .spyOn(
        await import("../src/backtests/signal-model-candidate-persistence.js"),
        "persistCapturedResearchCandidate",
      )
      .mockResolvedValue("70000000-0000-4000-8000-000000000001");
    vi.spyOn(
      PostgresSignalModelResearchControlStore.prototype,
      "recordReport",
    ).mockImplementation(async ({ report }) => {
      persistedReport = report as unknown as Record<string, unknown>;
      return {} as never;
    });
    const pool = {
      query: vi.fn(async () => ({ rows: [] })),
    } as unknown as Pool;
    const handler = new SignalModelResearchJobHandler(pool, scanner);
    await handler.execute(
      {
        id: randomUUID(),
        leaseOwner: "test-worker",
        attemptCount: 1,
        requestPayload: {
          version: "signal-model-research-v1",
          authorizationId,
          planHash: hash,
          plan,
        },
      } as never,
      {
        jobId: randomUUID(),
        heartbeat: async () => ({ cancellationRequested: false }),
      },
    );

    expect(trainingRows).toHaveLength(1);
    expect((trainingRows[0] as { sourceKey: string }).sourceKey).toBe(
      opportunityIds.TRAIN[0],
    );
    expect(scanner.predictStatistical).toHaveBeenCalledTimes(2);
    expect(
      PostgresCanonicalSignalOpportunityCaptureRepository.prototype
        .loadTestAfterClaim,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedTestMembershipHash: membershipHash("TEST"),
      }),
    );
    expect(persistedReport?.status).toBe("INSUFFICIENT");
    expect(handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationId,
        planHash: hash,
        artifact: expect.any(Object),
      }),
    );
    const evaluation = persistedReport?.evaluation as {
      inactive?: boolean;
      eligibleForActivation?: boolean;
      riskAssessment?: {
        maximumDrawdownIncrease?: string;
        maximumTurnoverIncrease?: string;
      };
    };
    expect(evaluation).toMatchObject({
      inactive: true,
      eligibleForActivation: false,
      riskAssessment: {
        maximumDrawdownIncrease: "UNAVAILABLE",
        maximumTurnoverIncrease: "UNAVAILABLE",
      },
    });
  });
});
