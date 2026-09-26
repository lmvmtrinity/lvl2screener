import { z } from "zod";
import { marketIdSchema } from "./markets.js";

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sessionDatesSchema = z
  .array(z.string().date())
  .min(1)
  .max(500)
  .superRefine((dates, context) => {
    if (new Set(dates).size !== dates.length)
      context.addIssue({
        code: "custom",
        message: "Session dates must be unique",
      });
    if (dates.some((date, index) => index > 0 && dates[index - 1]! >= date))
      context.addIssue({
        code: "custom",
        message: "Session dates must be ordered",
      });
  });

export const signalModelStageSchema = z.enum(["TRAIN", "VALIDATION", "TEST"]);
export type SignalModelStage = z.infer<typeof signalModelStageSchema>;

const stageMembershipSchema = z
  .object({
    opportunityIds: z.array(z.string().min(1).max(200)).min(1).max(100_000),
    membershipHash: hashSchema,
  })
  .strict()
  .superRefine((membership, context) => {
    if (
      new Set(membership.opportunityIds).size !==
      membership.opportunityIds.length
    )
      context.addIssue({
        code: "custom",
        path: ["opportunityIds"],
        message: "Opportunity membership must be unique",
      });
  });

export const signalModelResearchPlanSchema = z
  .object({
    version: z.literal("signal-model-experiment-v1"),
    experimentId: z.string().uuid(),
    source: z
      .object({
        runId: z.string().uuid(),
        marketId: marketIdSchema,
        strategy: z.string().min(1).max(120),
        strategyVersion: z.string().min(1).max(120),
        configVersion: z.string().min(1).max(120),
        profileId: z.string().uuid(),
        profileName: z.string().min(1).max(160),
        executionModelVersion: z.string().min(1).max(120),
        executionAssumptionsHash: hashSchema,
        sourceDigest: hashSchema,
        sourceBindingHash: hashSchema,
        orderedMembershipHash: hashSchema,
        orderedMembershipCount: z.number().int().positive().max(1_000_000),
      })
      .strict(),
    sessions: z
      .object({
        TRAIN: sessionDatesSchema,
        VALIDATION: sessionDatesSchema,
        TEST: sessionDatesSchema,
      })
      .strict(),
    membership: z
      .object({
        TRAIN: stageMembershipSchema,
        VALIDATION: stageMembershipSchema,
        TEST: stageMembershipSchema,
      })
      .strict(),
    overlapPurge: z
      .object({
        labelHorizonSessions: z.number().int().min(0).max(60),
        trainValidationPurgeSessions: z.array(z.string().date()).max(60),
        validationTestPurgeSessions: z.array(z.string().date()).max(60),
      })
      .strict(),
    model: z
      .object({
        minimumTrainingSamples: z.number().int().min(20).max(100_000),
        thresholdCandidates: z
          .array(z.number().finite().min(0).max(100))
          .min(1)
          .max(100),
        l2Penalty: z.number().finite().min(0).max(100),
      })
      .strict(),
    comparison: z
      .object({
        minimumUsefulNetPnlPerSelectedOpportunity: z
          .number()
          .finite()
          .positive(),
        unit: z.enum(["CAD", "USD"]),
        alpha: z.number().finite().min(0.01).max(0.1),
        targetPower: z.number().finite().min(0.8).max(0.99),
        minimumIndependentSessions: z.number().int().min(2).max(500),
        minimumValidationSessions: z.number().int().min(2).max(500),
        minimumClosedOutcomes: z.number().int().min(20).max(100_000),
        maximumMissedWinnerRate: z.number().finite().min(0).max(1),
        maximumDrawdownIncrease: z.number().finite().nonnegative(),
        maximumTurnoverIncrease: z.number().finite().min(0).max(10),
        maximumLargestSymbolShare: z.number().finite().min(0).max(1),
        maximumLargestSessionShare: z.number().finite().min(0).max(1),
        bootstrapSamples: z.number().int().min(1_000).max(100_000),
        blockLength: z.number().int().min(1).max(60),
        seed: z.number().int().min(0).max(2_147_483_647),
        extraCostScenarios: z
          .array(
            z
              .object({
                extraSlippageBps: z.number().finite().min(0).max(10_000),
                extraFeePerTrade: z.number().finite().min(0).max(1_000_000),
              })
              .strict(),
          )
          .max(20),
      })
      .strict(),
    trialBudget: z.number().int().min(1).max(10_000),
  })
  .strict()
  .superRefine((plan, context) => {
    const stageNames = ["TRAIN", "VALIDATION", "TEST"] as const;
    const allDates = stageNames.flatMap((stage) => plan.sessions[stage]);
    const membershipIds = stageNames.flatMap(
      (stage) => plan.membership[stage].opportunityIds,
    );
    if (new Set(allDates).size !== allDates.length)
      context.addIssue({
        code: "custom",
        path: ["sessions"],
        message: "Stage sessions must not overlap",
      });
    if (new Set(membershipIds).size !== membershipIds.length)
      context.addIssue({
        code: "custom",
        path: ["membership"],
        message: "Opportunity IDs must be unique across stages",
      });
    if (
      plan.sessions.TRAIN.at(-1)! >= plan.sessions.VALIDATION[0]! ||
      plan.sessions.VALIDATION.at(-1)! >= plan.sessions.TEST[0]!
    )
      context.addIssue({
        code: "custom",
        path: ["sessions"],
        message: "Training, validation and test must be chronological",
      });
    const purges = [
      [
        plan.overlapPurge.trainValidationPurgeSessions,
        plan.sessions.TRAIN.at(-1)!,
        plan.sessions.VALIDATION[0]!,
        "trainValidationPurgeSessions",
      ],
      [
        plan.overlapPurge.validationTestPurgeSessions,
        plan.sessions.VALIDATION.at(-1)!,
        plan.sessions.TEST[0]!,
        "validationTestPurgeSessions",
      ],
    ] as const;
    for (const [dates, before, after, name] of purges) {
      if (
        dates.length < plan.overlapPurge.labelHorizonSessions ||
        dates.some(
          (date, index) =>
            date <= before ||
            date >= after ||
            (index > 0 && dates[index - 1]! >= date),
        )
      )
        context.addIssue({
          code: "custom",
          path: ["overlapPurge", name],
          message: "Purge window does not cover the frozen label horizon",
        });
    }
    if (
      (plan.comparison.unit === "CAD") !==
      (plan.source.marketId === "CA_TSX")
    )
      context.addIssue({
        code: "custom",
        path: ["comparison", "unit"],
        message: "Comparison currency must match market",
      });
  });
export type SignalModelResearchPlan = z.infer<
  typeof signalModelResearchPlanSchema
>;

export const signalModelResearchAuthorizationSchema = z
  .object({
    id: z.string().uuid(),
    marketId: marketIdSchema,
    frozenPlanHash: hashSchema,
    sourceDigest: hashSchema,
    sourceBindingHash: hashSchema,
    expiresAt: z.string().datetime({ offset: true }),
    trialBudget: z.number().int().min(1).max(10_000),
    mode: z
      .enum(["PREPARE_ONLY", "EXECUTE_WHEN_READY"])
      .default("PREPARE_ONLY"),
  })
  .strict();
export type SignalModelResearchAuthorization = z.infer<
  typeof signalModelResearchAuthorizationSchema
>;

export const signalModelResearchAuthorizationRequestSchema = z
  .object({
    authorization: signalModelResearchAuthorizationSchema,
    plan: signalModelResearchPlanSchema,
  })
  .strict()
  .superRefine(({ authorization, plan }, context) => {
    if (authorization.marketId !== plan.source.marketId)
      context.addIssue({
        code: "custom",
        path: ["authorization", "marketId"],
        message: "Authorization market differs from plan",
      });
    if (authorization.sourceDigest !== plan.source.sourceDigest)
      context.addIssue({
        code: "custom",
        path: ["authorization", "sourceDigest"],
        message: "Authorization source digest differs from plan",
      });
    if (authorization.sourceBindingHash !== plan.source.sourceBindingHash)
      context.addIssue({
        code: "custom",
        path: ["authorization", "sourceBindingHash"],
        message: "Authorization binding differs from plan",
      });
    if (authorization.trialBudget !== plan.trialBudget)
      context.addIssue({
        code: "custom",
        path: ["authorization", "trialBudget"],
        message: "Authorization budget differs from plan",
      });
  });

export const signalModelResearchAuthorizationRecordSchema =
  signalModelResearchAuthorizationSchema
    .extend({
      grantedAt: z.string().datetime({ offset: true }),
      revokedAt: z.string().datetime({ offset: true }).nullable(),
      dispatchedJobId: z.string().uuid().nullable(),
    })
    .strict();
export type SignalModelResearchAuthorizationRecord = z.infer<
  typeof signalModelResearchAuthorizationRecordSchema
>;

export const signalModelResearchPreflightRequestSchema = z
  .object({
    plan: signalModelResearchPlanSchema,
  })
  .strict();

export const signalModelResearchPreflightSchema = z
  .object({
    status: z.enum(["READY", "WAITING", "UNAVAILABLE"]),
    marketId: marketIdSchema,
    sourceRunId: z.string().uuid(),
    sourceDigest: hashSchema.nullable(),
    sourceBindingHash: hashSchema.nullable(),
    stageCounts: z
      .object({
        TRAIN: z.number().int().nonnegative(),
        VALIDATION: z.number().int().nonnegative(),
        TEST: z.number().int().nonnegative(),
      })
      .strict(),
    usableTrainingRows: z.number().int().nonnegative(),
    independentSessions: z.number().int().nonnegative(),
    estimatedPower: z.number().finite().min(0).max(1).nullable(),
    estimatedPowerMethod: z
      .literal("UNVALIDATED_TRAINING_SESSION_MEAN_PROXY")
      .nullable(),
    estimatedPowerLimitations: z.array(z.string()),
    blockers: z.array(z.string()),
    missingFields: z.array(z.string()),
  })
  .strict();
export type SignalModelResearchPreflight = z.infer<
  typeof signalModelResearchPreflightSchema
>;

export const signalModelResearchReadinessSchema = z
  .object({
    authorizationId: z.string().uuid(),
    mode: z.enum(["PREPARE_ONLY", "EXECUTE_WHEN_READY"]),
    status: z.enum([
      "PREPARE_ONLY",
      "WAITING",
      "READY",
      "DISPATCHED",
      "REVOKED",
      "EXPIRED",
      "COMPLETED",
      "INSUFFICIENT",
      "FAILED",
    ]),
    blockers: z.array(z.string()),
    lastCheckedAt: z.string().datetime({ offset: true }).nullable(),
    nextAction: z.string().min(1),
  })
  .strict();
export type SignalModelResearchReadiness = z.infer<
  typeof signalModelResearchReadinessSchema
>;

export const signalModelResearchDispatchSchema = z.discriminatedUnion("state", [
  z
    .object({ state: z.literal("DISPATCHED"), jobId: z.string().uuid() })
    .strict(),
  z
    .object({
      state: z.enum(["WAITING", "PREPARE_ONLY", "REVOKED", "EXPIRED", "USED"]),
    })
    .strict(),
]);
export type SignalModelResearchDispatch = z.infer<
  typeof signalModelResearchDispatchSchema
>;

export const signalModelResearchJobPayloadSchema = z
  .object({
    version: z.literal("signal-model-research-v1"),
    authorizationId: z.string().uuid(),
    planHash: hashSchema,
    plan: signalModelResearchPlanSchema,
  })
  .strict();

export const signalModelResearchTrainingExampleSchema = z
  .object({
    sourceKey: z.string().min(1).max(200),
    strategy: z.string().min(1).max(120),
    entryTime: z.string().datetime({ offset: true }),
    score: z.number().int().min(0).max(100),
    atrPct: z.number().finite().nullable(),
    rvolAtTime: z.number().finite().nullable(),
    rMultiple: z.number().finite(),
  })
  .strict();

export const signalModelResearchTrainingRequestSchema = z
  .object({
    sourceKind: z.literal("CAPTURED_BACKTEST_RESEARCH"),
    marketId: marketIdSchema,
    strategy: z.string().min(1).max(120),
    trainingRows: z
      .array(signalModelResearchTrainingExampleSchema)
      .min(1)
      .max(100_000),
    minimumSamples: z.number().int().min(20).max(100_000),
    l2Penalty: z.number().finite().min(0).max(100),
  })
  .strict();
export type SignalModelResearchTrainingRequest = z.infer<
  typeof signalModelResearchTrainingRequestSchema
>;

export const signalModelResearchReportSchema = z
  .object({
    experimentId: z.string().uuid(),
    authorizationId: z.string().uuid(),
    candidateModelId: z.string().uuid().nullable().optional(),
    sourceDigest: hashSchema,
    planHash: hashSchema,
    status: z.enum([
      "WAITING",
      "INSUFFICIENT",
      "COMPLETED",
      "INTERRUPTED",
      "FAILED",
    ]),
    selectedCandidateIdentity: hashSchema.nullable(),
    selectedThreshold: z.number().finite().min(0).max(100).nullable(),
    evaluation: z.record(z.string(), z.unknown()).nullable(),
    reasonCodes: z.array(z.string()),
  })
  .strict();
export type SignalModelResearchReport = z.infer<
  typeof signalModelResearchReportSchema
>;
