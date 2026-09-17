import {
  createBacktestSchema,
  type FrozenStudyPlan,
} from "@tsx-scanner/contracts";
export function studyPlan(): FrozenStudyPlan {
  const binding = {
    manifestHash: "a".repeat(64),
    coverageReportHash: "b".repeat(64),
    inputHash: "c".repeat(64),
    engineRevision: "d".repeat(40),
    runtimeFingerprint: "e".repeat(64),
    verifiedAt: "2026-09-10T12:00:00.000Z",
  };
  const request = (date: string) =>
    createBacktestSchema.parse({
      name: "regression",
      marketId: "CA_TSX",
      startDate: date,
      endDate: date,
      strategies: ["ORB_RETEST"],
    });
  const stage = (date: string) => ({
    baseline: request(date),
    challenger: request(date),
    binding,
  });
  return {
    experimentId: "10000000-0000-4000-8000-000000000140",
    binding,
    variant: "RETEST_CONTRACTION",
    baselineProfileConfigId: "10000000-0000-4000-8000-000000000141",
    challengerProfileConfigId: "10000000-0000-4000-8000-000000000142",
    inputs: {
      TRAIN: stage("2026-09-01"),
      VALIDATION: stage("2026-09-02"),
      TEST: stage("2026-09-03"),
    },
    sessionPlan: {
      version: "study-session-plan-v2",
      sessions: {
        TRAIN: ["2026-09-01"],
        VALIDATION: ["2026-09-02"],
        TEST: ["2026-09-03"],
      },
    },
    comparison: {
      marketId: "CA_TSX",
      unit: "R",
      expectedSessions: ["2026-09-03"],
      minimumSessions: 1,
      blockLength: 1,
      bootstrapSamples: 1000,
      seed: 7,
    },
    minimumClosedTradesPerDevelopmentSegment: 1,
    minimumValidationAverageR: 0,
  };
}
