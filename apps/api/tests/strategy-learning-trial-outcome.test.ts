import { describe, expect, it } from "vitest";
import { studyPlan } from "./study-fixture.js";
import { comparePairedSessions } from "../src/backtests/paired-session-comparison.js";
import {
  boundedRuleTrialClaim,
  buildBoundedRuleTrialAttempt,
  buildUnadmittedToggleCandidateStudyDraft,
  enumerateBoundedRuleCandidates,
} from "../src/backtests/bounded-rule-candidates.js";
import { contentHash } from "../src/backtests/research-coverage.js";

function candidateAndPlan() {
  const plan = studyPlan();
  for (const input of Object.values(plan.inputs)) {
    input.baseline.parameters.retestVolumeContractionEnabled = 0;
    input.challenger.parameters.retestVolumeContractionEnabled = 1;
  }
  const candidate = enumerateBoundedRuleCandidates({
    version: "bounded-rule-search-space-v1",
    strategy: "ORB_RETEST",
    marketId: "CA_TSX",
    baselineParameters: plan.inputs.TRAIN.baseline.parameters,
    dimensions: [{ key: "retestVolumeContractionEnabled", values: [1] }],
    maxCandidates: 1,
  })[0]!;
  const draft = buildUnadmittedToggleCandidateStudyDraft(
    { ...candidate, approvalStatus: "APPROVED" },
    plan,
  );
  if (draft.state !== "READY_UNADMITTED") throw new Error("BAD_TEST_FIXTURE");
  return { candidate, plan: draft.plan };
}

describe("bounded strategy study trial outcome", () => {
  it("hashes the full candidate and search-space description into the ledger claim", () => {
    const { candidate } = candidateAndPlan();
    const claim = boundedRuleTrialClaim(candidate);
    expect(claim.candidateIdentity).toBe(contentHash(claim.candidateSpec));
    expect(claim.candidateSpec).toMatchObject({
      searchSpaceHash: candidate.searchSpaceHash,
      candidateHash: candidate.candidateHash,
      changes: candidate.changes,
      neighborDescription: candidate.neighborDescription,
    });
  });

  it("retains negative development selection as not evaluated on final TEST", () => {
    const { candidate, plan } = candidateAndPlan();
    const claim = boundedRuleTrialClaim(candidate);
    const report = {
      experimentId: plan.experimentId,
      binding: plan.binding,
      status: "NOT_SELECTED" as const,
      results: [],
      comparison: null,
      reasonCodes: ["DEVELOPMENT_SELECTION_FAILED"],
    };
    const attempt = buildBoundedRuleTrialAttempt({
      plan,
      report,
      candidateIdentity: claim.candidateIdentity,
      attemptId: claim.attemptId,
    });
    expect(attempt).toMatchObject({ status: "SUCCEEDED" });
    expect(attempt.outcome).toMatchObject({
      evaluationStatus: "NOT_EVALUATED",
      matchedEconomicEvaluation: null,
      report: { status: "NOT_SELECTED" },
    });
  });

  it("retains an insufficient paired-session evaluation with its frozen run identities", () => {
    const { candidate, plan } = candidateAndPlan();
    const claim = boundedRuleTrialClaim(candidate);
    const stageResult = {
      stage: "TEST" as const,
      binding: plan.inputs.TEST.binding,
      baselineRunId: "10000000-0000-4000-8000-000000000201",
      challengerRunId: "10000000-0000-4000-8000-000000000202",
      baselineClosedTrades: 0,
      challengerClosedTrades: 0,
      challengerAverageR: null,
      sessions: [
        {
          sessionDate: plan.comparison.expectedSessions[0]!,
          baseline: 0.1,
          challenger: -0.2,
          coverage: "VERIFIED" as const,
        },
      ],
    };
    const comparison = comparePairedSessions(stageResult.sessions, {
      ...plan.comparison,
      minimumSessions: 2,
    });
    const report = {
      experimentId: plan.experimentId,
      binding: plan.binding,
      status: "INSUFFICIENT_EVIDENCE" as const,
      results: [stageResult],
      comparison,
      reasonCodes: comparison.reasonCodes,
    };
    const attempt = buildBoundedRuleTrialAttempt({
      plan,
      report,
      candidateIdentity: claim.candidateIdentity,
      attemptId: claim.attemptId,
    });
    expect(attempt.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(attempt.outcome).toMatchObject({
      evaluationStatus: "INSUFFICIENT",
      stageExecutions: [
        {
          stage: "TEST",
          baselineRunId: stageResult.baselineRunId,
          challengerRunId: stageResult.challengerRunId,
        },
      ],
      matchedEconomicEvaluation: { status: "INSUFFICIENT" },
    });
  });
});
