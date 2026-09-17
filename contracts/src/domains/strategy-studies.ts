import { z } from "zod";
import {
  researchEvidenceBindingSchema,
  sessionComparisonConfigSchema,
  sessionComparisonResultSchema,
  sessionPairSchema,
} from "./research-evidence.js";
import { createBacktestSchema } from "./backtests.js";

export const studyVariantSchema = z.enum([
  "RETEST_CONTRACTION",
  "RETEST_REJECTION",
  "RETEST_HIGH_BREAK",
  "DAILY_EMA",
  "RSI_SEQUENCE",
]);
export type StudyVariant = z.infer<typeof studyVariantSchema>;

export const studyStageSchema = z.enum(["TRAIN", "VALIDATION", "TEST"]);
export type StudyStage = z.infer<typeof studyStageSchema>;

export const studySessionPlanSchema = z
  .object({
    version: z.literal("study-session-plan-v2"),
    sessions: z
      .object({
        TRAIN: z.array(z.string().date()).min(1),
        VALIDATION: z.array(z.string().date()).min(1),
        TEST: z.array(z.string().date()).min(1),
      })
      .strict(),
  })
  .strict()
  .superRefine((plan, context) => {
    for (const stage of ["TRAIN", "VALIDATION", "TEST"] as const) {
      const dates = plan.sessions[stage];
      if (new Set(dates).size !== dates.length)
        context.addIssue({
          code: "custom",
          path: ["sessions", stage],
          message: "Study session dates must be unique",
        });
      if (dates.some((date, index) => index > 0 && dates[index - 1]! >= date))
        context.addIssue({
          code: "custom",
          path: ["sessions", stage],
          message: "Study session dates must be chronological",
        });
    }
  });
export type StudySessionPlan = z.infer<typeof studySessionPlanSchema>;

const studyInputSchema = z
  .object({
    baseline: createBacktestSchema,
    challenger: createBacktestSchema,
    binding: researchEvidenceBindingSchema,
  })
  .strict();

export const frozenStudyPlanSchema = z
  .object({
    experimentId: z.string().uuid(),
    binding: researchEvidenceBindingSchema,
    variant: studyVariantSchema,
    baselineProfileConfigId: z.string().uuid(),
    challengerProfileConfigId: z.string().uuid(),
    inputs: z
      .object({
        TRAIN: studyInputSchema,
        VALIDATION: studyInputSchema,
        TEST: studyInputSchema,
      })
      .strict(),
    comparison: sessionComparisonConfigSchema,
    sessionPlan: studySessionPlanSchema.optional(),
    minimumClosedTradesPerDevelopmentSegment: z.number().int().positive(),
    minimumValidationAverageR: z.number().finite(),
  })
  .strict()
  .superRefine((plan, context) => {
    const stages = ["TRAIN", "VALIDATION", "TEST"] as const;
    for (const stage of stages) {
      const input = plan.inputs[stage];
      if (input.baseline.marketId !== plan.comparison.marketId)
        context.addIssue({
          code: "custom",
          path: ["inputs", stage, "baseline", "marketId"],
          message: "Study input market must match the comparison market",
        });
      if (input.challenger.marketId !== plan.comparison.marketId)
        context.addIssue({
          code: "custom",
          path: ["inputs", stage, "challenger", "marketId"],
          message: "Study input market must match the comparison market",
        });
      if (
        input.baseline.startDate !== input.challenger.startDate ||
        input.baseline.endDate !== input.challenger.endDate
      )
        context.addIssue({
          code: "custom",
          path: ["inputs", stage],
          message: "Baseline and challenger must share the stage window",
        });
      if (input.baseline.startDate > input.baseline.endDate)
        context.addIssue({
          code: "custom",
          path: ["inputs", stage, "baseline"],
          message: "Study stage window is reversed",
        });
      if (!sameBinding(input.binding, plan.binding))
        context.addIssue({
          code: "custom",
          path: ["inputs", stage, "binding"],
          message: "Study stage binding must match the frozen plan binding",
        });
    }
    const train = plan.inputs.TRAIN.baseline;
    const validation = plan.inputs.VALIDATION.baseline;
    const test = plan.inputs.TEST.baseline;
    if (train.endDate >= validation.startDate)
      context.addIssue({
        code: "custom",
        path: ["inputs", "VALIDATION"],
        message: "TRAIN and VALIDATION windows must be disjoint and ordered",
      });
    if (validation.endDate >= test.startDate)
      context.addIssue({
        code: "custom",
        path: ["inputs", "TEST"],
        message: "VALIDATION and TEST windows must be disjoint and ordered",
      });
    for (const date of plan.comparison.expectedSessions) {
      if (date < test.startDate || date > test.endDate)
        context.addIssue({
          code: "custom",
          path: ["comparison", "expectedSessions"],
          message: "Comparison sessions must belong to the frozen TEST window",
        });
    }
    if (
      plan.sessionPlan &&
      JSON.stringify(plan.sessionPlan.sessions.TEST) !==
        JSON.stringify(plan.comparison.expectedSessions)
    )
      context.addIssue({
        code: "custom",
        path: ["comparison", "expectedSessions"],
        message: "TEST sessions must match the frozen session plan",
      });
    if (plan.sessionPlan) {
      for (const stage of stages) {
        const input = plan.inputs[stage].baseline;
        for (const date of plan.sessionPlan.sessions[stage]) {
          if (date < input.startDate || date > input.endDate)
            context.addIssue({
              code: "custom",
              path: ["sessionPlan", "sessions", stage],
              message: "Frozen session date is outside its stage window",
            });
        }
      }
    }
  });

function sameBinding(
  left: z.infer<typeof researchEvidenceBindingSchema>,
  right: z.infer<typeof researchEvidenceBindingSchema>,
): boolean {
  return (
    left.manifestHash === right.manifestHash &&
    left.coverageReportHash === right.coverageReportHash &&
    left.inputHash === right.inputHash &&
    left.engineRevision === right.engineRevision &&
    left.runtimeFingerprint === right.runtimeFingerprint &&
    left.verifiedAt === right.verifiedAt
  );
}
export type FrozenStudyPlan = z.infer<typeof frozenStudyPlanSchema>;

/** New mutation/execution paths require an explicit frozen calendar. Legacy
 * plans remain readable through frozenStudyPlanSchema for historical reports. */
export const executableFrozenStudyPlanSchema = frozenStudyPlanSchema.and(
  z.object({ sessionPlan: studySessionPlanSchema }),
);
export type ExecutableFrozenStudyPlan = z.infer<
  typeof executableFrozenStudyPlanSchema
>;

export function requiredStudyExecutions(
  plan: StudySessionPlan | Pick<FrozenStudyPlan, "sessionPlan">,
): number {
  const calendar = "version" in plan ? plan : plan.sessionPlan;
  if (!calendar) throw new Error("STUDY_SESSION_PLAN_REQUIRED");
  return (
    2 *
    (calendar.sessions.TRAIN.length +
      calendar.sessions.VALIDATION.length +
      calendar.sessions.TEST.length)
  );
}

export const studyAuthorityRefSchema = z.discriminatedUnion("kind", [
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
]);
export type StudyAuthorityRef = z.infer<typeof studyAuthorityRefSchema>;
export const executableStrategyStudyJobPayloadSchema = z
  .object({
    plan: executableFrozenStudyPlanSchema,
    authority: studyAuthorityRefSchema,
  })
  .strict();

export const studyStageResultSchema = z
  .object({
    stage: studyStageSchema,
    binding: researchEvidenceBindingSchema,
    baselineRunId: z.string().uuid(),
    challengerRunId: z.string().uuid(),
    baselineClosedTrades: z.number().int().nonnegative(),
    challengerClosedTrades: z.number().int().nonnegative(),
    challengerAverageR: z.number().finite().nullable(),
    sessions: z.array(sessionPairSchema),
  })
  .strict();
export type StudyStageResult = z.infer<typeof studyStageResultSchema>;

export const studySelectionSchema = z
  .object({
    selected: z.boolean(),
    baselineProfileConfigId: z.string().uuid(),
    challengerProfileConfigId: z.string().uuid(),
    developmentResultHashes: z.tuple([
      z.string().regex(/^[a-f0-9]{64}$/),
      z.string().regex(/^[a-f0-9]{64}$/),
    ]),
  })
  .strict();
export type StudySelection = z.infer<typeof studySelectionSchema>;

export const strategyStudyReportSchema = z
  .object({
    experimentId: z.string().uuid(),
    calculationVersion: z.literal("study-report-v2").optional(),
    binding: researchEvidenceBindingSchema,
    status: z.enum([
      "COMPLETE",
      "INSUFFICIENT_EVIDENCE",
      "NOT_SELECTED",
      "INTERRUPTED",
    ]),
    results: z.array(studyStageResultSchema),
    comparison: sessionComparisonResultSchema.nullable(),
    reasonCodes: z.array(z.string().min(1)),
  })
  .strict();
export type StrategyStudyReport = z.infer<typeof strategyStudyReportSchema>;

export const strategyStudyRecordSchema = z
  .object({
    id: z.string().uuid(),
    marketId: z.enum(["CA_TSX", "US_EQUITIES"]),
    plan: frozenStudyPlanSchema,
    receiptKeys: z.array(z.string().min(1)),
    report: strategyStudyReportSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type StrategyStudyRecord = z.infer<typeof strategyStudyRecordSchema>;

export const strategyStudyJobPayloadSchema = z
  .object({
    plan: frozenStudyPlanSchema,
    authority: z
      .object({
        kind: z.enum(["EXECUTE_WHEN_READY", "DIRECT_SUBMISSION"]),
        authorizationId: z.string().uuid().optional(),
        grantId: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type StrategyStudyJobPayload = z.infer<
  typeof strategyStudyJobPayloadSchema
>;

export const studyAuthorizationModeSchema = z.enum([
  "PREPARE_ONLY",
  "EXECUTE_WHEN_READY",
]);
export type StudyAuthorizationMode = z.infer<
  typeof studyAuthorizationModeSchema
>;

export const studyExecutionAuthorizationSchema = z
  .object({
    id: z.string().uuid(),
    marketId: z.enum(["CA_TSX", "US_EQUITIES"]),
    frozenPlanHash: z.string().regex(/^[a-f0-9]{64}$/),
    prerequisitePolicyHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceWindowStart: z.string().date(),
    sourceWindowEnd: z.string().date(),
    engineRevision: z.string().min(1),
    runtimeFingerprint: z.string().min(1),
    expiresAt: z.string().datetime({ offset: true }),
    maxStudies: z.literal(1),
    maxSessionExecutions: z.number().int().positive(),
    mode: studyAuthorizationModeSchema.default("PREPARE_ONLY"),
  })
  .strict();
export type StudyExecutionAuthorization = z.infer<
  typeof studyExecutionAuthorizationSchema
>;

export const studyAuthorizationRecordSchema = studyExecutionAuthorizationSchema
  .extend({
    grantedAt: z.string().datetime({ offset: true }),
    revokedAt: z.string().datetime({ offset: true }).nullable(),
    dispatchedJobId: z.string().uuid().nullable(),
  })
  .strict();
export type StudyAuthorizationRecord = z.infer<
  typeof studyAuthorizationRecordSchema
>;

export const studyAuthorizationRequestSchema = z
  .object({
    authorization: studyExecutionAuthorizationSchema,
    plan: frozenStudyPlanSchema,
  })
  .strict();
export type StudyAuthorizationRequest = z.infer<
  typeof studyAuthorizationRequestSchema
>;
