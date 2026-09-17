import { describe, expect, it } from "vitest";
import {
  createBacktestSchema,
  requiredStudyExecutions,
  type FrozenStudyPlan,
  type ResearchCoverageReport,
  type StudyAuthorizationRecord,
} from "@tsx-scanner/contracts";
import { StudyDispatchService } from "../src/backtests/study-dispatch-service.js";
import {
  authorizationPlanHash,
  authorizationPolicyHash,
  type StudyAuthorizationRepository,
} from "../src/backtests/study-authorization-repository.js";
import type { ResearchEvidenceStore } from "../src/backtests/research-evidence-repository.js";

const binding = {
  manifestHash: "a".repeat(64),
  coverageReportHash: "b".repeat(64),
  inputHash: "c".repeat(64),
  engineRevision: "d".repeat(40),
  runtimeFingerprint: "e".repeat(64),
  verifiedAt: "2026-09-10T12:00:00.000Z",
};
const backtest = (name: string, date: string) =>
  createBacktestSchema.parse({
    name,
    marketId: "CA_TSX",
    startDate: date,
    endDate: date,
    strategies: ["ORB_RETEST"],
  });
const plan: FrozenStudyPlan = {
  experimentId: "10000000-0000-4000-8000-000000000140",
  binding,
  variant: "RETEST_CONTRACTION",
  baselineProfileConfigId: "10000000-0000-4000-8000-000000000141",
  challengerProfileConfigId: "10000000-0000-4000-8000-000000000142",
  inputs: {
    TRAIN: {
      baseline: backtest("train b", "2026-09-01"),
      challenger: backtest("train c", "2026-09-01"),
      binding,
    },
    VALIDATION: {
      baseline: backtest("validation b", "2026-09-02"),
      challenger: backtest("validation c", "2026-09-02"),
      binding,
    },
    TEST: {
      baseline: backtest("test b", "2026-09-03"),
      challenger: backtest("test c", "2026-09-03"),
      binding,
    },
  },
  comparison: {
    marketId: "CA_TSX",
    unit: "R",
    expectedSessions: ["2026-09-03"],
    minimumSessions: 1,
    blockLength: 1,
    bootstrapSamples: 1_000,
    seed: 7,
  },
  sessionPlan: {
    version: "study-session-plan-v2",
    sessions: {
      TRAIN: ["2026-09-01"],
      VALIDATION: ["2026-09-02"],
      TEST: ["2026-09-03"],
    },
  },
  minimumClosedTradesPerDevelopmentSegment: 1,
  minimumValidationAverageR: 0,
};

function authorization(): StudyAuthorizationRecord {
  return {
    id: "10000000-0000-4000-8000-000000000143",
    marketId: "CA_TSX",
    frozenPlanHash: authorizationPlanHash(plan),
    prerequisitePolicyHash: authorizationPolicyHash(plan),
    sourceWindowStart: "2026-09-01",
    sourceWindowEnd: "2026-09-03",
    engineRevision: binding.engineRevision,
    runtimeFingerprint: binding.runtimeFingerprint,
    expiresAt: "2099-09-10T00:00:00.000Z",
    maxStudies: 1,
    maxSessionExecutions: 6,
    mode: "EXECUTE_WHEN_READY",
    grantedAt: "2026-09-10T00:00:00.000Z",
    revokedAt: null,
    dispatchedJobId: null,
  };
}

class FakeAuthorizationRepository implements StudyAuthorizationRepository {
  record = authorization();
  async create() {
    return this.record;
  }
  async get() {
    return this.record;
  }
  async getPlan() {
    return plan;
  }
  async list() {
    return [this.record];
  }
  async revoke() {
    return this.record;
  }
  async reserveAndEnqueue() {
    return {
      state: "DISPATCHED" as const,
      jobId: "10000000-0000-4000-8000-000000000144",
    };
  }
}

const verified = {
  status: "VERIFIED",
  marketId: "CA_TSX",
  inputHash: binding.inputHash,
} as ResearchCoverageReport;

it("counts every frozen stage session exactly twice", () => {
  expect(
    requiredStudyExecutions({
      version: "study-session-plan-v2",
      sessions: {
        TRAIN: Array.from(
          { length: 10 },
          (_, i) => `2026-08-${String(i + 10).padStart(2, "0")}`,
        ),
        VALIDATION: Array.from(
          { length: 10 },
          (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`,
        ),
        TEST: ["2026-09-11"],
      },
    }),
  ).toBe(42);
});

describe("StudyDispatchService", () => {
  it("dispatches exactly once only after verified prerequisites", async () => {
    const repository = new FakeAuthorizationRepository();
    const evidence = {
      getReport: async () => verified,
    } as unknown as ResearchEvidenceStore;
    const service = new StudyDispatchService(repository, evidence);
    expect(await service.dispatchReady("CA_TSX")).toBe(1);
  });

  it("leaves incomplete prerequisites waiting", async () => {
    const repository = new FakeAuthorizationRepository();
    const evidence = {
      getReport: async () => null,
    } as unknown as ResearchEvidenceStore;
    const service = new StudyDispatchService(repository, evidence);
    expect(await service.tryDispatch(repository.record)).toEqual({
      state: "WAITING",
    });
  });
});
