import { z } from "zod";
import { marketIdSchema } from "./markets.js";
import {
  researchEvidenceBindingSchema,
  sessionComparisonResultSchema,
} from "./research-evidence.js";
import { strategyStudyReportSchema } from "./strategy-studies.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);

/** Frozen ledger metadata attached to an existing immutable strategy study. */
export const strategyLearningExperimentIdentitySchema = z
  .object({
    studyId: z.string().uuid(),
    studySpecHash: hashSchema,
    marketId: marketIdSchema,
    sourceDigest: hashSchema,
    binding: researchEvidenceBindingSchema,
    authority: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("EXECUTE_WHEN_READY"),
          authorizationId: z.string().uuid(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("DIRECT_SUBMISSION"),
          grantId: z.string().uuid(),
        })
        .strict(),
    ]),
    trialBudget: z.number().int().positive().max(10_000),
  })
  .strict()
  .superRefine((identity, context) => {
    if (identity.sourceDigest !== identity.binding.inputHash)
      context.addIssue({
        code: "custom",
        path: ["sourceDigest"],
        message: "Source digest must match the frozen evidence binding",
      });
  });
export type StrategyLearningExperimentIdentity = z.infer<
  typeof strategyLearningExperimentIdentitySchema
>;

export const strategyLearningTrialAttemptSchema = z
  .object({
    attemptId: z.string().uuid(),
    candidateIdentity: hashSchema,
    status: z.enum([
      "SUCCEEDED",
      "INSUFFICIENT_EVIDENCE",
      "FAILED",
      "CANCELED",
      "INTERRUPTED",
    ]),
    outcome: z.record(z.string(), z.unknown()),
  })
  .strict();
export type StrategyLearningTrialAttempt = z.infer<
  typeof strategyLearningTrialAttemptSchema
>;

/** Immutable result envelope for one approved rule candidate on one frozen study. */
export const boundedRuleTrialOutcomeSchema = z
  .object({
    version: z.literal("bounded-rule-trial-outcome-v1"),
    candidateIdentity: hashSchema,
    candidateHash: hashSchema,
    searchSpaceHash: hashSchema,
    studyId: z.string().uuid(),
    studySpecHash: hashSchema,
    evaluationStatus: z.enum([
      "AVAILABLE",
      "INSUFFICIENT",
      "UNVERIFIED",
      "NOT_EVALUATED",
      "INTERRUPTED",
    ]),
    stageExecutions: z.array(
      z
        .object({
          stage: z.enum(["TRAIN", "VALIDATION", "TEST"]),
          baselineRunId: z.string().uuid(),
          challengerRunId: z.string().uuid(),
          resultHash: hashSchema,
        })
        .strict(),
    ),
    matchedEconomicEvaluation: sessionComparisonResultSchema.nullable(),
    report: strategyStudyReportSchema,
  })
  .strict()
  .superRefine((outcome, context) => {
    if (outcome.report.experimentId !== outcome.studyId)
      context.addIssue({
        code: "custom",
        path: ["studyId"],
        message: "Trial outcome study identity must match its frozen report",
      });
    if (
      outcome.report.comparison &&
      outcome.matchedEconomicEvaluation &&
      JSON.stringify(outcome.report.comparison) !==
        JSON.stringify(outcome.matchedEconomicEvaluation)
    )
      context.addIssue({
        code: "custom",
        path: ["matchedEconomicEvaluation"],
        message: "Economic evaluation must be the frozen TEST comparison",
      });
  });
export type BoundedRuleTrialOutcome = z.infer<
  typeof boundedRuleTrialOutcomeSchema
>;

export const strategyLearningTrialClaimRequestSchema = z
  .object({
    attemptId: z.string().uuid(),
    candidateIdentity: hashSchema,
    candidateSpec: z.record(z.string(), z.unknown()),
  })
  .strict();
export type StrategyLearningTrialClaimRequest = z.infer<
  typeof strategyLearningTrialClaimRequestSchema
>;

export const strategyLearningTrialClaimSchema = z
  .object({
    studyId: z.string().uuid(),
    studySpecHash: hashSchema,
    attemptId: z.string().uuid(),
    candidateIdentity: hashSchema,
    candidateSpec: z.record(z.string(), z.unknown()),
    attemptNumber: z.number().int().positive(),
    jobId: z.string().uuid(),
    status: z.enum(["CLAIMED", "COMPLETED"]),
    terminalAttempt: strategyLearningTrialAttemptSchema.optional(),
    claimedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((claim, context) => {
    if ((claim.status === "COMPLETED") !== Boolean(claim.terminalAttempt))
      context.addIssue({
        code: "custom",
        path: ["terminalAttempt"],
        message: "Completed claims require their persisted terminal attempt",
      });
  });
export type StrategyLearningTrialClaim = z.infer<
  typeof strategyLearningTrialClaimSchema
>;

export const strategyLearningFinalTestLinkSchema = z
  .object({
    studyId: z.string().uuid(),
    studySpecHash: hashSchema,
    testClaimId: z.string().uuid(),
    linkedAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type StrategyLearningFinalTestLink = z.infer<
  typeof strategyLearningFinalTestLinkSchema
>;
