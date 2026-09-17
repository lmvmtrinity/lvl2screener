import { z } from "zod";
import { marketIdSchema } from "./markets.js";
import { statisticalPredictionSchema } from "./statistical-models.js";
import { setupStrategyNameSchema } from "./strategies.js";
import {
  researchEvidenceBindingSchema,
  sessionComparisonResultSchema,
} from "./research-evidence.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const isoDateTimeSchema = z.string().datetime({ offset: true });
const uuidSchema = z.string().uuid();

export const challengerCurrencySchema = z.enum(["CAD", "USD"]);
export type ChallengerCurrency = z.infer<typeof challengerCurrencySchema>;

export const challengerScopeSchema = z
  .object({
    marketId: marketIdSchema,
    currency: challengerCurrencySchema,
    strategy: setupStrategyNameSchema,
    strategyVersion: z.string().min(1),
    profileConfigId: uuidSchema,
    configVersion: z.string().min(1),
    executionModelVersion: z.string().min(1),
    executionAssumptionsHash: sha256Schema,
    signalSemanticsVersion: z.string().min(1),
    replayScope: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const expected = value.marketId === "CA_TSX" ? "CAD" : "USD";
    if (value.currency !== expected)
      ctx.addIssue({
        code: "custom",
        path: ["currency"],
        message: `Market ${value.marketId} requires ${expected}`,
      });
  });
export type ChallengerScope = z.infer<typeof challengerScopeSchema>;

const challengerIdentityFields = {
  modelId: uuidSchema,
  modelVersion: z.string().min(1),
  artifactHash: sha256Schema,
  scope: challengerScopeSchema,
  researchEvidence: researchEvidenceBindingSchema,
  baselineIdentityHash: sha256Schema,
  acceptancePlanHash: sha256Schema,
  startsAt: isoDateTimeSchema,
  endsAt: isoDateTimeSchema,
  maxPredictionLagMs: z.number().int().positive().max(30_000),
} as const;

export const challengerBaselineRecordSchema = z
  .object({
    version: z.literal("challenger-baseline-v1"),
    scope: challengerScopeSchema,
    featureVersion: z.string().min(1),
    deterministicPolicyHash: sha256Schema,
    executionAssumptions: z.record(z.string(), z.unknown()),
    researchEvidence: researchEvidenceBindingSchema,
  })
  .strict();
export type ChallengerBaselineRecord = z.infer<
  typeof challengerBaselineRecordSchema
>;

export const challengerAcceptanceCriterionSchema = z.object({
  metric: z.enum([
    "NET_RETURN_AFTER_COSTS",
    "CLOSED_OUTCOME_DRAWDOWN",
    "SESSION_CONSISTENCY",
    "SYMBOL_CONSISTENCY",
    "CONDITION_CONSISTENCY",
    "BRIER_SCORE",
  ]),
  unit: z.enum(["R", "CAD", "USD", "PROPORTION"]),
  operator: z.enum(["GT", "GTE", "LT", "LTE"]),
  threshold: z.number().finite(),
});
export type ChallengerAcceptanceCriterion = z.infer<
  typeof challengerAcceptanceCriterionSchema
>;

export const challengerAcceptancePlanSchema = z
  .object({
    version: z.literal("challenger-acceptance-v1"),
    baselineIdentityHash: sha256Schema,
    scope: challengerScopeSchema,
    startsAt: isoDateTimeSchema,
    endsAt: isoDateTimeSchema,
    comparison: z.object({
      marketId: marketIdSchema,
      unit: z.enum(["R", "CAD", "USD"]),
      expectedSessions: z.array(z.string().date()).min(1),
      minimumSessions: z.number().int().positive(),
      blockLength: z.number().int().positive(),
      bootstrapSamples: z.number().int().min(1_000),
      seed: z.number().int().min(0).max(4_294_967_295),
    }),
    minimumClosedOutcomes: z.number().int().positive(),
    criteria: z.array(challengerAcceptanceCriterionSchema).length(6),
    conditionDefinitionHash: sha256Schema,
    evaluationBasis: z.enum([
      "INDEPENDENT_CLOSED_OUTCOMES",
      "SEPARATE_PORTFOLIO_EVIDENCE",
    ]),
  })
  .strict()
  .superRefine((value, ctx) => {
    const metrics = value.criteria.map((criterion) => criterion.metric);
    if (new Set(metrics).size !== 6)
      ctx.addIssue({
        code: "custom",
        path: ["criteria"],
        message: "Each acceptance metric must appear exactly once",
      });
    if (Date.parse(value.endsAt) <= Date.parse(value.startsAt))
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "Invalid acceptance window",
      });
    if (value.comparison.marketId !== value.scope.marketId)
      ctx.addIssue({
        code: "custom",
        path: ["comparison", "marketId"],
        message: "Acceptance market mismatch",
      });
    const expectedUnit = value.scope.marketId === "CA_TSX" ? "CAD" : "USD";
    for (const [index, criterion] of value.criteria.entries()) {
      const probability = [
        "SESSION_CONSISTENCY",
        "SYMBOL_CONSISTENCY",
        "CONDITION_CONSISTENCY",
        "BRIER_SCORE",
      ].includes(criterion.metric);
      if (
        probability
          ? criterion.unit !== "PROPORTION" ||
            criterion.threshold < 0 ||
            criterion.threshold > 1
          : criterion.unit !== "R" && criterion.unit !== expectedUnit
      )
        ctx.addIssue({
          code: "custom",
          path: ["criteria", index],
          message:
            "Criterion unit or threshold is incompatible with its metric and market",
        });
    }
    if (
      new Set(value.comparison.expectedSessions).size !==
        value.comparison.expectedSessions.length ||
      value.comparison.expectedSessions.some(
        (date) =>
          date < value.startsAt.slice(0, 10) ||
          date > value.endsAt.slice(0, 10),
      )
    )
      ctx.addIssue({
        code: "custom",
        path: ["comparison", "expectedSessions"],
        message: "Expected dates must be unique and inside the frozen window",
      });
    if (value.comparison.unit !== "R" && value.comparison.unit !== expectedUnit)
      ctx.addIssue({
        code: "custom",
        path: ["comparison", "unit"],
        message: "Acceptance currency mismatch",
      });
  });
export type ChallengerAcceptancePlan = z.infer<
  typeof challengerAcceptancePlanSchema
>;

export const challengerConditionDefinitionSchema = z
  .object({
    version: z.literal("challenger-conditions-v1"),
    marketId: marketIdSchema,
    featureVersion: z.string().min(1),
    dimensions: z
      .array(
        z.object({
          field: z.enum(["atrPct", "rvolAtTime", "spreadPct"]),
          breakpoints: z.array(z.number().finite()),
          missing: z.literal("UNKNOWN"),
        }),
      )
      .length(3),
  })
  .strict()
  .superRefine((value, ctx) => {
    const fields = value.dimensions.map((dimension) => dimension.field);
    if (new Set(fields).size !== fields.length)
      ctx.addIssue({
        code: "custom",
        path: ["dimensions"],
        message: "Condition fields must be unique",
      });
    for (const [index, dimension] of value.dimensions.entries()) {
      if (
        dimension.breakpoints.some(
          (point, i) => i > 0 && dimension.breakpoints[i - 1]! >= point,
        )
      )
        ctx.addIssue({
          code: "custom",
          path: ["dimensions", index, "breakpoints"],
          message: "Breakpoints must be strictly increasing",
        });
    }
  });
export type ChallengerConditionDefinition = z.infer<
  typeof challengerConditionDefinitionSchema
>;

export const registerChallengerSchema = z
  .object(challengerIdentityFields)
  .extend({
    version: z.literal("register-challenger-v2").optional(),
    baseline: challengerBaselineRecordSchema.optional(),
    acceptancePlan: challengerAcceptancePlanSchema.optional(),
    conditionDefinition: challengerConditionDefinitionSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.endsAt) <= Date.parse(value.startsAt))
      ctx.addIssue({
        code: "custom",
        path: ["endsAt"],
        message: "endsAt must be later than startsAt",
      });
    if (value.version === "register-challenger-v2") {
      if (
        !value.baseline ||
        !value.acceptancePlan ||
        !value.conditionDefinition
      )
        ctx.addIssue({
          code: "custom",
          path: ["version"],
          message: "Complete acceptance records are required",
        });
      if (value.baseline && value.acceptancePlan) {
        if (
          value.acceptancePlan.scope.profileConfigId !==
          value.scope.profileConfigId
        )
          ctx.addIssue({
            code: "custom",
            path: ["acceptancePlan", "scope"],
            message: "Acceptance scope mismatch",
          });
      }
      if (
        value.conditionDefinition &&
        value.conditionDefinition.marketId !== value.scope.marketId
      )
        ctx.addIssue({
          code: "custom",
          path: ["conditionDefinition", "marketId"],
          message: "Condition market mismatch",
        });
    }
  });
export type RegisterChallenger = z.infer<typeof registerChallengerSchema>;

export const challengerExperimentStateSchema = z.enum([
  "REGISTERED",
  "ACTIVE",
  "PAUSED",
  "ENDED",
  "REVOKED",
]);
export type ChallengerExperimentState = z.infer<
  typeof challengerExperimentStateSchema
>;

export const challengerExperimentSchema = z
  .object({
    id: uuidSchema,
    ...challengerIdentityFields,
    registeredAt: isoDateTimeSchema,
    state: challengerExperimentStateSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.startsAt) < Date.parse(value.registeredAt))
      ctx.addIssue({
        code: "custom",
        path: ["startsAt"],
        message: "startsAt cannot precede registeredAt",
      });
  });
export type ChallengerExperiment = z.infer<typeof challengerExperimentSchema>;

export const experimentActionSchema = z.enum([
  "START",
  "PAUSE",
  "RESUME",
  "END",
  "REVOKE",
]);
export type ExperimentAction = z.infer<typeof experimentActionSchema>;

export const challengerAttemptSchema = z
  .object({
    experimentId: uuidSchema,
    observationId: uuidSchema,
    modelVersion: z.string().min(1),
    inputHash: sha256Schema,
    observedAt: isoDateTimeSchema,
    recordedAt: isoDateTimeSchema,
    deadlineAt: isoDateTimeSchema,
    input: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.deadlineAt) <= Date.parse(value.observedAt))
      ctx.addIssue({
        code: "custom",
        path: ["deadlineAt"],
        message: "deadlineAt must be later than observedAt",
      });
  });
export type ChallengerAttempt = z.infer<typeof challengerAttemptSchema>;

export const challengerOutcomeStatusSchema = z.enum([
  "PREDICTED",
  "MISSED_DEADLINE",
  "ENGINE_FAILED",
  "INPUT_INVALID",
  "EXPERIMENT_REVOKED",
]);
export type ChallengerOutcomeStatus = z.infer<
  typeof challengerOutcomeStatusSchema
>;

const failureOutcomeSchema = z.object({
  status: z.enum([
    "MISSED_DEADLINE",
    "ENGINE_FAILED",
    "INPUT_INVALID",
    "EXPERIMENT_REVOKED",
  ]),
  completedAt: isoDateTimeSchema,
  reason: z.string().min(1).max(160),
});

export const challengerOutcomeSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("PREDICTED"),
    completedAt: isoDateTimeSchema,
    prediction: statisticalPredictionSchema,
  }),
  failureOutcomeSchema,
]);
export type ChallengerOutcome = z.infer<typeof challengerOutcomeSchema>;

export const challengerPopulationSchema = z
  .object({
    expectedEligibleObservations: z.number().int().nonnegative(),
    predicted: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    missedDeadline: z.number().int().nonnegative(),
    engineFailed: z.number().int().nonnegative(),
    inputInvalid: z.number().int().nonnegative(),
    revoked: z.number().int().nonnegative(),
    unknownCapture: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const accounted =
      value.predicted +
      value.pending +
      value.missedDeadline +
      value.engineFailed +
      value.inputInvalid +
      value.revoked +
      value.unknownCapture;
    if (accounted !== value.expectedEligibleObservations)
      ctx.addIssue({
        code: "custom",
        path: ["expectedEligibleObservations"],
        message: "population denominator does not equal its classified rows",
      });
  });
export type ChallengerPopulation = z.infer<typeof challengerPopulationSchema>;

export const challengerComparisonUnavailableReasonSchema = z.enum([
  "PAIRED_INPUTS_MISSING",
  "INSUFFICIENT_SESSIONS",
  "COVERAGE_UNVERIFIED",
  "EXPERIMENT_REVOKED",
]);
export type ChallengerComparisonUnavailableReason = z.infer<
  typeof challengerComparisonUnavailableReasonSchema
>;

export const challengerObservationReportSchema = z
  .object({
    experimentId: uuidSchema,
    asOf: isoDateTimeSchema,
    population: challengerPopulationSchema,
    verifiedSessions: z.number().int().nonnegative().nullable(),
    incompleteSessions: z.number().int().nonnegative().nullable(),
    unknownSessions: z.number().int().nonnegative().nullable(),
    coveredNoOpportunitySessions: z.number().int().nonnegative().nullable(),
    excludedPausedSessions: z.number().int().nonnegative().nullable(),
    sessionCountsAvailable: z.boolean().optional(),
    sessionCountsUnavailableReason: z.string().nullable().optional(),
    frozenAcceptance: z
      .object({
        baseline: challengerBaselineRecordSchema,
        acceptancePlan: challengerAcceptancePlanSchema,
        conditionDefinition: challengerConditionDefinitionSchema,
      })
      .nullable()
      .optional(),
    closedQuoteOutcomes: z.number().int().nonnegative(),
    prospectiveBrierScore: z.number().nonnegative().nullable(),
    comparison: sessionComparisonResultSchema.nullable(),
    comparisonUnavailableReason:
      challengerComparisonUnavailableReasonSchema.nullable(),
    promotionAuthorized: z.literal(false),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.comparison === null) !==
      (value.comparisonUnavailableReason !== null)
    )
      ctx.addIssue({
        code: "custom",
        path: ["comparisonUnavailableReason"],
        message: "comparison and its unavailable reason must be paired",
      });
  });
export type ChallengerObservationReport = z.infer<
  typeof challengerObservationReportSchema
>;

export const challengerExperimentDetailSchema = z
  .object({
    experiment: challengerExperimentSchema,
    report: challengerObservationReportSchema,
  })
  .strict();
export type ChallengerExperimentDetail = z.infer<
  typeof challengerExperimentDetailSchema
>;

export const challengerExperimentListSchema = z
  .object({ experiments: z.array(challengerExperimentSchema) })
  .strict();
export type ChallengerExperimentList = z.infer<
  typeof challengerExperimentListSchema
>;
