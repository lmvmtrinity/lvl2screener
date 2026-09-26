import {
  boundedRuleTrialOutcomeSchema,
  strategyStudyReportSchema,
  approvedBoundedRuleCandidateSchema,
  boundedRuleCandidateSchema,
  boundedRuleSearchSpaceSchema,
  boundedSearchParameterBounds,
  frozenStudyPlanSchema,
  strategyParametersSchema,
  type BoundedRuleCandidate,
  type BoundedRuleTrialOutcome,
  type BoundedRuleSearchSpace,
  type FrozenStudyPlan,
  type StrategyStudyReport,
  type StrategyLearningTrialAttempt,
  type StrategyLearningTrialClaimRequest,
} from "@tsx-scanner/contracts";
import { randomUUID } from "node:crypto";
import { contentHash, canonicalJson } from "./research-coverage.js";

const TOGGLE_VARIANTS = {
  retestVolumeContractionEnabled: "RETEST_CONTRACTION",
  retestRejectionEnabled: "RETEST_REJECTION",
  retestHighBreakEnabled: "RETEST_HIGH_BREAK",
  dailyEmaFilterEnabled: "DAILY_EMA",
} as const;

/** Enumerates the finite Cartesian space in declared dimension/value order. */
export function enumerateBoundedRuleCandidates(
  rawSpace: BoundedRuleSearchSpace,
): BoundedRuleCandidate[] {
  const space = boundedRuleSearchSpaceSchema.parse(rawSpace);
  const searchSpaceHash = contentHash(space);
  const combinations: Array<Record<string, number>> = [{}];
  for (const dimension of space.dimensions) {
    const prior = [...combinations];
    combinations.length = 0;
    for (const partial of prior) {
      for (const value of [
        space.baselineParameters[dimension.key],
        ...dimension.values,
      ]) {
        if (value === undefined)
          throw new Error("SEARCH_BASELINE_PARAMETER_MISSING");
        if (value === space.baselineParameters[dimension.key]) {
          combinations.push(partial);
        } else {
          combinations.push({ ...partial, [dimension.key]: value });
        }
      }
    }
  }
  const candidates = combinations
    .filter((changes) => Object.keys(changes).length > 0)
    .map((changes) => {
      const parameters = { ...space.baselineParameters, ...changes };
      const changeList = Object.entries(changes)
        .map(([key, to]) => ({
          key: key as BoundedRuleCandidate["changes"][number]["key"],
          from: space.baselineParameters[
            key as keyof typeof space.baselineParameters
          ]!,
          to,
        }))
        .sort((left, right) => left.key.localeCompare(right.key));
      const identity = {
        searchSpaceHash,
        strategy: space.strategy,
        marketId: space.marketId,
        parameters,
      };
      return boundedRuleCandidateSchema.parse({
        version: "bounded-rule-candidate-v1",
        ...identity,
        candidateHash: contentHash(identity),
        changes: changeList,
        neighborDescription: changeList
          .map(({ key, from, to }) => `${key} ${from} -> ${to}`)
          .join(", "),
      });
    });
  if (candidates.length > space.maxCandidates)
    throw new Error("SEARCH_CANDIDATE_BUDGET_EXCEEDED");
  const hashes = candidates.map((candidate) => candidate.candidateHash);
  if (new Set(hashes).size !== hashes.length)
    throw new Error("DUPLICATE_SEARCH_CANDIDATE");
  return candidates;
}

/**
 * Builds an unadmitted plan draft for a separately approved one-parameter
 * candidate. It does not verify database profile config IDs; study admission
 * must run before submission and again in the worker to bind those IDs and
 * every stage to their persisted configs.
 */
export type UnadmittedBoundedRuleStudyDraft =
  | {
      state: "READY_UNADMITTED";
      candidateHash: string;
      plan: FrozenStudyPlan;
    }
  | {
      state: "UNSUPPORTED";
      reasonCode:
        | "NUMERIC_VARIANT_NOT_SUPPORTED_BY_STUDY_PROFILE_SCOPE"
        | "MULTI_DIMENSION_VARIANT_NOT_SUPPORTED_BY_STUDY_PROFILE_SCOPE";
      candidateHash: string;
    };

export function boundedRuleCandidateLedgerSpec(
  candidate: BoundedRuleCandidate,
) {
  return {
    version: candidate.version,
    candidateHash: candidate.candidateHash,
    searchSpaceHash: candidate.searchSpaceHash,
    strategy: candidate.strategy,
    marketId: candidate.marketId,
    parameters: candidate.parameters,
    changes: candidate.changes,
    neighborDescription: candidate.neighborDescription,
  };
}

export function boundedRuleTrialClaim(
  candidate: BoundedRuleCandidate,
): StrategyLearningTrialClaimRequest {
  const candidateSpec = boundedRuleCandidateLedgerSpec(candidate);
  return {
    attemptId: randomUUID(),
    candidateIdentity: contentHash(candidateSpec),
    candidateSpec,
  };
}

export function buildUnadmittedToggleCandidateStudyDraft(
  rawCandidate: unknown,
  rawPlan: FrozenStudyPlan,
): UnadmittedBoundedRuleStudyDraft {
  const candidate = approvedBoundedRuleCandidateSchema.parse(rawCandidate);
  const plan = frozenStudyPlanSchema.parse(rawPlan);
  const baseline = plan.inputs.TRAIN.baseline;
  if (
    candidate.marketId !== plan.comparison.marketId ||
    candidate.marketId !== baseline.marketId
  )
    throw new Error("STUDY_CANDIDATE_MARKET_MISMATCH");
  if (
    candidate.strategy !== baseline.strategies[0] ||
    baseline.strategies.length !== 1
  )
    throw new Error("STUDY_CANDIDATE_STRATEGY_MISMATCH");
  if (
    candidate.candidateHash !==
    contentHash({
      searchSpaceHash: candidate.searchSpaceHash,
      strategy: candidate.strategy,
      marketId: candidate.marketId,
      parameters: candidate.parameters,
    })
  )
    throw new Error("STUDY_CANDIDATE_IDENTITY_MISMATCH");
  const [change] = candidate.changes;
  if (candidate.changes.length !== 1)
    return {
      state: "UNSUPPORTED",
      reasonCode:
        "MULTI_DIMENSION_VARIANT_NOT_SUPPORTED_BY_STUDY_PROFILE_SCOPE",
      candidateHash: candidate.candidateHash,
    };
  if (!change)
    return {
      state: "UNSUPPORTED",
      reasonCode: "NUMERIC_VARIANT_NOT_SUPPORTED_BY_STUDY_PROFILE_SCOPE",
      candidateHash: candidate.candidateHash,
    };
  const toggleVariant =
    TOGGLE_VARIANTS[change.key as keyof typeof TOGGLE_VARIANTS];
  const parameterBound = boundedSearchParameterBounds[change.key];
  const variant = toggleVariant ?? "NUMERIC_PARAMETER";
  if (
    change.from !==
      baseline.parameters[change.key as keyof typeof baseline.parameters] ||
    change.to !==
      candidate.parameters[change.key as keyof typeof candidate.parameters] ||
    (toggleVariant !== undefined && (change.from !== 0 || change.to !== 1)) ||
    (toggleVariant === undefined &&
      (parameterBound.kind !== "numeric" ||
        change.to < parameterBound.minimum ||
        change.to > parameterBound.maximum))
  )
    throw new Error("STUDY_CANDIDATE_BASELINE_MISMATCH");
  if (
    canonicalJson(candidate.parameters) !==
    canonicalJson(
      strategyParametersSchema.parse({
        ...baseline.parameters,
        [change.key]: change.to,
      }),
    )
  )
    throw new Error("STUDY_CANDIDATE_PARAMETER_MISMATCH");
  const baselineParameters = canonicalJson(
    strategyParametersSchema.parse(baseline.parameters),
  );
  const challengerParameters = canonicalJson(candidate.parameters);
  for (const input of Object.values(plan.inputs)) {
    if (
      canonicalJson(
        strategyParametersSchema.parse(input.baseline.parameters),
      ) !== baselineParameters
    )
      throw new Error("STUDY_BASELINE_PARAMETERS_MISMATCH");
    if (
      canonicalJson(
        strategyParametersSchema.parse(input.challenger.parameters),
      ) !== challengerParameters
    )
      throw new Error("STUDY_CANDIDATE_PROFILE_STAGE_MISMATCH");
  }
  return {
    state: "READY_UNADMITTED",
    candidateHash: candidate.candidateHash,
    plan: frozenStudyPlanSchema.parse({
      ...plan,
      variant,
      boundedRuleCandidate: candidate,
    }),
  };
}

export function assertBoundedRuleCandidateStudyPlan(
  rawPlan: FrozenStudyPlan,
): void {
  const plan = frozenStudyPlanSchema.parse(rawPlan);
  const candidate = plan.boundedRuleCandidate;
  if (!candidate) return;
  const draft = buildUnadmittedToggleCandidateStudyDraft(candidate, plan);
  if (draft.state === "UNSUPPORTED") throw new Error(draft.reasonCode);
  if (canonicalJson(draft.plan) !== canonicalJson(plan))
    throw new Error("STUDY_CANDIDATE_PLAN_MISMATCH");
}

export function buildBoundedRuleTrialAttempt(input: {
  plan: FrozenStudyPlan;
  report: StrategyStudyReport;
  candidateIdentity: string;
  attemptId: string;
  status?: StrategyLearningTrialAttempt["status"];
}): StrategyLearningTrialAttempt {
  const plan = frozenStudyPlanSchema.parse(input.plan);
  const candidate = approvedBoundedRuleCandidateSchema.parse(
    plan.boundedRuleCandidate,
  );
  const report = strategyStudyReportSchema.parse(input.report);
  const candidateIdentity = contentHash(
    boundedRuleCandidateLedgerSpec(candidate),
  );
  if (
    report.experimentId !== plan.experimentId ||
    canonicalJson(report.binding) !== canonicalJson(plan.binding) ||
    input.candidateIdentity !== candidateIdentity
  )
    throw new Error("STRATEGY_STUDY_TRIAL_OUTCOME_IDENTITY_MISMATCH");
  const evaluationStatus: BoundedRuleTrialOutcome["evaluationStatus"] =
    report.status === "NOT_SELECTED"
      ? "NOT_EVALUATED"
      : report.status === "INTERRUPTED"
        ? "INTERRUPTED"
        : (report.comparison?.status ??
          (report.status === "INSUFFICIENT_EVIDENCE"
            ? "INSUFFICIENT"
            : "UNVERIFIED"));
  const outcome = boundedRuleTrialOutcomeSchema.parse({
    version: "bounded-rule-trial-outcome-v1",
    candidateIdentity,
    candidateHash: candidate.candidateHash,
    searchSpaceHash: candidate.searchSpaceHash,
    studyId: plan.experimentId,
    studySpecHash: contentHash(plan),
    evaluationStatus,
    stageExecutions: report.results.map((result) => ({
      stage: result.stage,
      baselineRunId: result.baselineRunId,
      challengerRunId: result.challengerRunId,
      resultHash: contentHash(result),
    })),
    matchedEconomicEvaluation: report.comparison,
    report,
  });
  return {
    attemptId: input.attemptId,
    candidateIdentity,
    status:
      input.status ??
      (report.status === "INSUFFICIENT_EVIDENCE"
        ? "INSUFFICIENT_EVIDENCE"
        : report.status === "INTERRUPTED"
          ? "INTERRUPTED"
          : "SUCCEEDED"),
    outcome: outcome as unknown as Record<string, unknown>,
  };
}
