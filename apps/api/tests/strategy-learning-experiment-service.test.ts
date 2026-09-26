import { describe, expect, it } from "vitest";
import { StrategyLearningExperimentService } from "../src/backtests/strategy-learning-experiment-service.js";
import type {
  StrategyLearningExperimentIdentity,
  StrategyLearningTrialAttempt,
  StrategyLearningTrialClaim,
  StrategyLearningTrialClaimRequest,
} from "@tsx-scanner/contracts";
import type { StudyExecutionFence } from "../src/backtests/strategy-study-service.js";

const identity = {
  studyId: "10000000-0000-4000-8000-000000000100",
  studySpecHash: "a".repeat(64),
  marketId: "CA_TSX" as const,
  sourceDigest: "b".repeat(64),
  binding: {
    manifestHash: "c".repeat(64),
    coverageReportHash: "d".repeat(64),
    inputHash: "b".repeat(64),
    engineRevision: "e".repeat(40),
    runtimeFingerprint: "f".repeat(64),
    verifiedAt: "2026-09-10T12:00:00.000Z",
  },
  authority: {
    kind: "EXECUTE_WHEN_READY" as const,
    authorizationId: "60000000-0000-4000-8000-000000000600",
  },
  trialBudget: 1,
};
const attempt = {
  attemptId: "20000000-0000-4000-8000-000000000200",
  candidateIdentity: "9".repeat(64),
  status: "FAILED" as const,
  outcome: { reason: "NO_CANDIDATES" },
};

function memoryStore() {
  const attempts = new Map<string, StrategyLearningTrialAttempt>();
  const claims = new Map<string, StrategyLearningTrialClaim>();
  const fence: StudyExecutionFence = {
    jobId: "70000000-0000-4000-8000-000000000700",
    leaseOwner: "test-worker",
    attemptCount: 1,
  };
  let frozen: StrategyLearningExperimentIdentity | null = null;
  return {
    attempts,
    claims,
    fence,
    store: {
      freeze: async (value: StrategyLearningExperimentIdentity) => {
        if (frozen && JSON.stringify(frozen) !== JSON.stringify(value))
          throw new Error("STRATEGY_STUDY_LEDGER_IDENTITY_CONFLICT");
        frozen = value;
        return value;
      },
      get: async () => frozen,
      claim: async (
        studyId: string,
        value: StrategyLearningTrialClaimRequest,
        _fence: StudyExecutionFence,
      ) => {
        const prior = claims.get(value.attemptId);
        if (prior) {
          if (
            prior.candidateIdentity !== value.candidateIdentity ||
            JSON.stringify(prior.candidateSpec) !==
              JSON.stringify(value.candidateSpec)
          )
            throw new Error("STRATEGY_STUDY_TRIAL_CLAIM_CONFLICT");
          return prior;
        }
        if (claims.size >= identity.trialBudget)
          throw new Error("STRATEGY_STUDY_TRIAL_BUDGET_EXHAUSTED");
        const claim = {
          studyId,
          studySpecHash: identity.studySpecHash,
          ...value,
          attemptNumber: claims.size + 1,
          jobId: fence.jobId,
          status: "CLAIMED" as const,
          claimedAt: "2026-09-10T12:00:00.000Z",
        };
        claims.set(value.attemptId, claim);
        return claim;
      },
      append: async (
        _id: string,
        value: StrategyLearningTrialAttempt,
        _fence: StudyExecutionFence,
      ) => {
        if (!claims.has(value.attemptId))
          throw new Error("STRATEGY_STUDY_TRIAL_CLAIM_REQUIRED");
        const prior = attempts.get(value.attemptId);
        if (prior) {
          if (JSON.stringify(prior) !== JSON.stringify(value))
            throw new Error("TRIAL_ATTEMPT_CONFLICT");
          return prior;
        }
        if (attempts.size >= identity.trialBudget)
          throw new Error("STRATEGY_STUDY_TRIAL_BUDGET_EXHAUSTED");
        attempts.set(value.attemptId, value);
        return value;
      },
      linkFinalTest: async (studyId: string, testClaimId: string) => ({
        studyId,
        studySpecHash: identity.studySpecHash,
        testClaimId,
        linkedAt: "2026-09-10T12:00:00.000Z",
      }),
    },
  };
}

describe("strategy learning experiment ledger", () => {
  it("retries an identical attempt and retains failed attempts against the budget", async () => {
    const { store, attempts, claims, fence } = memoryStore();
    const service = new StrategyLearningExperimentService(store);
    await service.freeze(identity);
    const candidateSpec = { parameters: { threshold: 7 } };
    const claimRequest = {
      attemptId: attempt.attemptId,
      candidateIdentity: "9".repeat(64),
      candidateSpec,
    };
    await service.claimTrial(
      identity.studyId,
      identity.studySpecHash,
      claimRequest,
      fence,
    );
    await service.claimTrial(
      identity.studyId,
      identity.studySpecHash,
      claimRequest,
      fence,
    );
    await expect(
      service.recordTrial(
        identity.studyId,
        identity.studySpecHash,
        attempt,
        fence,
      ),
    ).resolves.toMatchObject({ status: "FAILED" });
    await expect(
      service.recordTrial(
        identity.studyId,
        identity.studySpecHash,
        attempt,
        fence,
      ),
    ).resolves.toMatchObject({ status: "FAILED" });
    expect(attempts.size).toBe(1);
    expect(claims.size).toBe(1);
    await expect(
      service.claimTrial(
        identity.studyId,
        identity.studySpecHash,
        {
          attemptId: "30000000-0000-4000-8000-000000000300",
          candidateIdentity: "8".repeat(64),
          candidateSpec: { parameters: { threshold: 8 } },
        },
        fence,
      ),
    ).rejects.toThrow("STRATEGY_STUDY_TRIAL_BUDGET_EXHAUSTED");
  });

  it("rejects conflicting frozen identity and market/source mismatch", async () => {
    const { store, fence } = memoryStore();
    const service = new StrategyLearningExperimentService(store);
    await service.freeze(identity);
    await expect(
      service.freeze({ ...identity, trialBudget: 2 }),
    ).rejects.toThrow("STRATEGY_STUDY_LEDGER_IDENTITY_CONFLICT");
    await expect(
      service.recordTrial(identity.studyId, "8".repeat(64), attempt, fence),
    ).rejects.toThrow("STRATEGY_STUDY_SPEC_HASH_MISMATCH");
  });

  it("links final testing only through a one-use existing study claim", async () => {
    const { store } = memoryStore();
    let links = 0;
    store.linkFinalTest = async (studyId, testClaimId) => {
      if (links++) throw new Error("STRATEGY_STUDY_FINAL_TEST_ALREADY_LINKED");
      return {
        studyId,
        studySpecHash: identity.studySpecHash,
        testClaimId,
        linkedAt: "2026-09-10T12:00:00.000Z",
      };
    };
    const service = new StrategyLearningExperimentService(store);
    await service.freeze(identity);
    await expect(
      service.linkFinalTest(
        identity.studyId,
        identity.studySpecHash,
        "40000000-0000-4000-8000-000000000400",
      ),
    ).resolves.toMatchObject({ studyId: identity.studyId });
    await expect(
      service.linkFinalTest(
        identity.studyId,
        identity.studySpecHash,
        "50000000-0000-4000-8000-000000000500",
      ),
    ).rejects.toThrow("STRATEGY_STUDY_FINAL_TEST_ALREADY_LINKED");
  });
});
