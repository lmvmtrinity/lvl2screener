import { z } from "zod";
import { marketIdSchema } from "./markets.js";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const instrumentIdSchema = z.string().uuid();
const isoDateTimeSchema = z.string().datetime({ offset: true });

export const researchEvidenceBindingSchema = z
  .object({
    manifestHash: sha256Schema,
    coverageReportHash: sha256Schema,
    inputHash: sha256Schema,
    engineRevision: z.string().regex(/^[0-9a-f]{40}$/),
    runtimeFingerprint: sha256Schema,
    verifiedAt: isoDateTimeSchema,
  })
  .strict();
export type ResearchEvidenceBinding = z.infer<
  typeof researchEvidenceBindingSchema
>;

export const expectedInputCellSchema = z
  .object({
    cellId: z.string().min(1),
    marketId: marketIdSchema,
    instrumentId: instrumentIdSchema,
    sessionDate: z.string().date(),
    role: z.enum(["CANDIDATE", "MARKET_BENCHMARK", "SECTOR_BENCHMARK"]),
    membership: z.enum(["REQUIRED", "NOT_REQUIRED", "UNKNOWN"]),
    membershipSourceHash: sha256Schema.nullable(),
    calendarSourceHash: sha256Schema.nullable(),
    windowStart: isoDateTimeSchema,
    windowEnd: isoDateTimeSchema,
    maxQuoteGapMs: z.number().int().positive(),
    warmupTimeframe: z.enum(["Daily", "OneMinute", "FiveMinutes"]),
    warmupWindowStart: isoDateTimeSchema,
    requiredWarmupBars: z.number().int().nonnegative(),
    warmupBefore: isoDateTimeSchema,
  })
  .strict();
export type ExpectedInputCell = z.infer<typeof expectedInputCellSchema>;

export const retainedInputReceiptSchema = z
  .object({
    cellId: z.string().min(1),
    inputHash: sha256Schema,
    provenance: z.enum(["VERIFIED", "UNKNOWN"]),
    provenanceReasons: z.array(z.string().min(1)),
    quoteTimes: z.array(isoDateTimeSchema),
    invalidQuoteCount: z.number().int().nonnegative(),
    warmupTimeframe: z.enum(["Daily", "OneMinute", "FiveMinutes"]),
    warmupBarTimes: z.array(isoDateTimeSchema),
    invalidWarmupBarCount: z.number().int().nonnegative(),
    quoteRecords: z.array(z.record(z.string(), z.unknown())).optional(),
    warmupBarRecords: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict();
export type RetainedInputReceipt = z.infer<typeof retainedInputReceiptSchema>;

export const coverageCellResultSchema = z
  .object({
    cellId: z.string().min(1),
    status: z.enum(["VERIFIED", "INCOMPLETE", "UNKNOWN", "NOT_REQUIRED"]),
    validQuotes: z.number().int().nonnegative(),
    validWarmupBars: z.number().int().nonnegative(),
    maximumGapMs: z.number().int().nonnegative().nullable(),
    reasons: z.array(z.string().min(1)),
  })
  .strict();
export type CoverageCellResult = z.infer<typeof coverageCellResultSchema>;

const researchCoverageReportFields = {
  marketId: marketIdSchema,
  manifestHash: sha256Schema,
  expectedInputsHash: sha256Schema,
  inputHash: sha256Schema,
  sessionPayloadHashes: z.record(z.string().date(), sha256Schema),
  verifiedAt: isoDateTimeSchema,
  status: z.enum(["VERIFIED", "INCOMPLETE", "UNKNOWN"]),
  cells: z.array(coverageCellResultSchema),
} as const;

export const researchCoverageReportV1Schema = z
  .object({
    version: z.literal("research-coverage-v1"),
    ...researchCoverageReportFields,
  })
  .strict();
export const researchCoverageReportV2Schema = z
  .object({
    version: z.literal("research-coverage-v2"),
    ...researchCoverageReportFields,
  })
  .strict();
/** Read union: v1 remains decodable, while newly extracted reports are v2. */
export const researchCoverageReportSchema = z.union([
  researchCoverageReportV1Schema,
  researchCoverageReportV2Schema,
]);
export type ResearchCoverageReport = z.infer<
  typeof researchCoverageReportSchema
>;

export const sessionPairSchema = z
  .object({
    sessionDate: z.string().date(),
    baseline: z.number().nullable(),
    challenger: z.number().nullable(),
    coverage: z.enum(["VERIFIED", "MISSING"]),
  })
  .strict();
export type SessionPair = z.infer<typeof sessionPairSchema>;

export const sessionComparisonConfigSchema = z
  .object({
    marketId: z.enum(["CA_TSX", "US_EQUITIES"]),
    unit: z.enum(["R", "CAD", "USD"]),
    expectedSessions: z.array(z.string().date()).min(1),
    minimumSessions: z.number().int().positive(),
    blockLength: z.number().int().positive(),
    bootstrapSamples: z.number().int().min(1_000),
    seed: z.number().int().min(0).max(4_294_967_295),
  })
  .strict();
export type SessionComparisonConfig = z.infer<
  typeof sessionComparisonConfigSchema
>;

export const sessionComparisonResultSchema = z
  .object({
    version: z.literal("paired-session-v1"),
    status: z.enum(["AVAILABLE", "INSUFFICIENT", "UNVERIFIED"]),
    unit: z.enum(["R", "CAD", "USD"]),
    basis: z.literal("MEAN_PAIRED_SESSION_DIFFERENCE"),
    expectedSessions: z.number().int().nonnegative(),
    observedSessions: z.number().int().nonnegative(),
    estimate: z.number().nullable(),
    lower: z.number().nullable(),
    upper: z.number().nullable(),
    confidenceLevel: z.literal(0.95),
    method: z
      .object({
        kind: z.literal("CIRCULAR_MOVING_BLOCK_BOOTSTRAP"),
        blockLength: z.number().int().positive(),
        bootstrapSamples: z.number().int().min(1_000),
        seed: z.number().int().min(0).max(4_294_967_295),
      })
      .strict(),
    reasonCodes: z.array(z.string().min(1)),
  })
  .strict();
export type SessionComparisonResult = z.infer<
  typeof sessionComparisonResultSchema
>;

export const sampledExcursionSchema = z
  .object({
    basis: z.literal("SAMPLED_EXECUTABLE_BID_SINGLE_LOT"),
    status: z.enum(["AVAILABLE", "UNAVAILABLE"]),
    adversePct: z.number().nullable(),
    favorablePct: z.number().nullable(),
    samples: z.number().int().nonnegative(),
    reasonCodes: z.array(z.string().min(1)),
  })
  .strict();
export type SampledExcursion = z.infer<typeof sampledExcursionSchema>;

export const researchOwnerKindSchema = z.enum([
  "JOB",
  "BACKTEST",
  "CALIBRATION",
  "DATASET",
  "MODEL",
]);
export const researchOwnerSchema = z
  .object({
    kind: researchOwnerKindSchema,
    id: z.string().uuid(),
    marketId: marketIdSchema,
  })
  .strict();
export type ResearchOwner = z.infer<typeof researchOwnerSchema>;

/**
 * The persisted coverage job keeps ownership nested under `request` for the
 * readable v1 payload. Keep this schema at the contract boundary so every
 * consumer derives market ownership from the same validated shape.
 */
export const coverageVerificationJobPayloadSchema = z
  .object({
    request: z
      .object({
        marketId: marketIdSchema,
        manifestHash: sha256Schema,
        inputCutoff: isoDateTimeSchema,
        sessionDates: z.array(z.string().date()).min(1),
      })
      .strict(),
    manifest: z
      .object({
        hash: sha256Schema,
        marketId: marketIdSchema,
        manifest: z.unknown(),
      })
      .strict(),
    engineRevision: z.string().regex(/^[0-9a-f]{40}$/),
    runtimeFingerprint: sha256Schema,
  })
  .strict();
export type CoverageVerificationJobPayload = z.infer<
  typeof coverageVerificationJobPayloadSchema
>;

export const frozenCoverageRecipeSchema = z
  .object({
    version: z.literal("research-coverage-recipe-v2"),
    marketId: marketIdSchema,
    engineRevision: z.string().regex(/^[0-9a-f]{40}$/),
    runtimeFingerprint: sha256Schema,
    featureVersion: z.string().min(1),
    sessionDates: z.array(z.string().date()).min(1),
    inputCutoff: isoDateTimeSchema,
    streamRequirements: z
      .array(
        z.object({
          timeframe: z.enum(["Daily", "OneMinute", "FiveMinutes"]),
          warmupDays: z.number().int().nonnegative().max(3660),
          requiredWarmupBars: z.number().int().nonnegative().max(1_000_000),
          includeInSession: z.boolean(),
        }),
      )
      .min(1),
    maxQuoteGapMs: z.number().int().positive().max(86_400_000),
    replayPolicyHash: sha256Schema,
    membershipPolicyHash: sha256Schema,
    calendarPolicyHash: sha256Schema,
    // Legacy recipes remain readable; new production preparation retains the complete policy.
    replayPolicy: z
      .object({
        marketId: marketIdSchema,
        timezone: z.enum(["America/Toronto", "America/New_York"]),
        openingRange: z.object({ start: z.string(), end: z.string() }),
        scanning: z.object({ start: z.string(), end: z.string() }),
        entries: z.object({
          preferredStart: z.string(),
          preferredEnd: z.string(),
          hardEnd: z.string(),
        }),
        benchmarkMaxStalenessSeconds: z.number().nonnegative().optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const identities = value.streamRequirements.map(
      (stream) => stream.timeframe,
    );
    if (new Set(identities).size !== identities.length)
      ctx.addIssue({
        code: "custom",
        path: ["streamRequirements"],
        message: "Duplicate stream requirement",
      });
    if (new Set(value.sessionDates).size !== value.sessionDates.length)
      ctx.addIssue({
        code: "custom",
        path: ["sessionDates"],
        message: "Duplicate session date",
      });
  });
export type FrozenCoverageRecipe = z.infer<typeof frozenCoverageRecipeSchema>;

export const createCoverageRequestSchema = z
  .object({
    manifest: z
      .object({
        hash: sha256Schema,
        marketId: marketIdSchema,
        manifest: z.unknown(),
      })
      .strict(),
    recipe: frozenCoverageRecipeSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.manifest.marketId !== value.recipe.marketId)
      ctx.addIssue({
        code: "custom",
        path: ["manifest", "marketId"],
        message: "Coverage market mismatch",
      });
  });
export type CreateCoverageRequest = z.infer<typeof createCoverageRequestSchema>;

export const coverageVerificationJobPayloadV2Schema = z
  .object({
    version: z.literal("coverage-verification-v2"),
    requestId: z.string().uuid(),
    request: createCoverageRequestSchema,
  })
  .strict();
export type CoverageVerificationJobPayloadV2 = z.infer<
  typeof coverageVerificationJobPayloadV2Schema
>;

export const coverageRequestRecordSchema = z.object({
  id: z.string().uuid(),
  requestHash: sha256Schema,
  marketId: marketIdSchema,
  createdAt: isoDateTimeSchema,
  latestJobId: z.string().uuid().nullable(),
  reportHash: sha256Schema.nullable().optional(),
  coverageStatus: z
    .enum(["VERIFIED", "INCOMPLETE", "UNKNOWN"])
    .nullable()
    .optional(),
});
export type CoverageRequestRecord = z.infer<typeof coverageRequestRecordSchema>;
