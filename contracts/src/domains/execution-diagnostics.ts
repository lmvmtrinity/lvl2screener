import { z } from "zod";
import { marketIdSchema } from "./markets.js";

const isoDateTime = z.string().datetime({ offset: true });
const hash = z.string().regex(/^[a-f0-9]{64}$/);

export const executionDiagnosticsModeSchema = z.enum([
  "RUN_END",
  "AS_OF",
  "CURRENT_ACCOUNT",
]);
export type ExecutionDiagnosticsMode = z.infer<
  typeof executionDiagnosticsModeSchema
>;

export const executionDiagnosticsQuerySchema = z
  .object({
    marketId: marketIdSchema,
    mode: executionDiagnosticsModeSchema.default("RUN_END"),
    asOf: isoDateTime.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode === "AS_OF" && !value.asOf)
      ctx.addIssue({
        code: "custom",
        path: ["asOf"],
        message: "AS_OF diagnostics require asOf",
      });
    if (value.mode !== "AS_OF" && value.asOf !== undefined)
      ctx.addIssue({
        code: "custom",
        path: ["asOf"],
        message: "asOf is only valid for AS_OF diagnostics",
      });
  });

export const executionDiagnosticUnknownSchema = z.enum([
  "MISSING_QUOTE_HISTORY",
  "UNVERIFIED_EVENT_SEQUENCE",
  "MISSING_ORDER_HISTORY",
  "AMBIGUOUS_FILL_QUOTE_LINK",
  "MISSING_HISTORICAL_BUDGET",
  "MISSING_ALLOCATION_INPUTS",
]);

export const executionDiagnosticScopeSchema = z
  .object({
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    accountId: z.string().min(1),
    selectedRunId: z.string().min(1),
    runIds: z.array(z.string().min(1)),
    temporalScope: executionDiagnosticsModeSchema,
    asOf: isoDateTime,
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

const bookSideSchema = z.enum(["BID", "ASK"]);

export const snapshotReplenishmentDiagnosticSchema = z
  .object({
    scope: executionDiagnosticScopeSchema,
    stretches: z.array(
      z
        .object({
          runId: z.string().min(1),
          instrumentId: z.string().min(1),
          side: bookSideSchema,
          startAt: isoDateTime,
          endAt: isoDateTime,
          snapshotCount: z.number().int().min(2),
          displayedShares: z.number().int().nonnegative(),
          initialBudgetShares: z.number().int().nonnegative().nullable(),
          totalFilledShares: z.number().int().nonnegative(),
          fillsAfterFirstSnapshotShares: z.number().int().nonnegative(),
          excessOverInitialBudgetShares: z
            .number()
            .int()
            .nonnegative()
            .nullable(),
          assessment: z.literal("REPLENISHMENT_UNVERIFIED"),
        })
        .strict(),
    ),
    excluded: z.array(
      z
        .object({ evidenceId: z.string().min(1), reason: z.string().min(1) })
        .strict(),
    ),
    unlinkedFillShares: z
      .object({
        BID: z.number().int().nonnegative(),
        ASK: z.number().int().nonnegative(),
      })
      .strict(),
    unavailable: z.array(executionDiagnosticUnknownSchema),
  })
  .strict();

export const resourceContentionDiagnosticSchema = z
  .object({
    scope: executionDiagnosticScopeSchema,
    rows: z.array(
      z
        .object({
          runId: z.string().min(1),
          instrumentId: z.string().min(1),
          orderId: z.string().min(1),
          quoteEvidenceId: z.string().min(1),
          side: bookSideSchema,
          canonicalRank: z.number().int().positive().nullable(),
          requestedShares: z.number().int().nonnegative().nullable(),
          filledShares: z.number().int().nonnegative(),
          remainingOwnedShares: z.number().int().nonnegative().nullable(),
          initialBudgetShares: z.number().int().nonnegative().nullable(),
          remainingBudgetBeforeOrder: z.number().int().nonnegative().nullable(),
          reason: z.enum([
            "RECORDED_REASON",
            "CAPACITY_BOUND_CONFIRMED",
            "FILLED",
            "PARTIAL_FILL",
            "UNAVAILABLE",
          ]),
          recordedReason: z.string().nullable(),
          unavailable: z.array(executionDiagnosticUnknownSchema),
        })
        .strict(),
    ),
  })
  .strict();

export const executionDiagnosticReportSchema = z
  .object({
    reportVersion: z.string().min(1),
    sourceDigest: hash,
    generatedAt: isoDateTime,
    scope: executionDiagnosticScopeSchema,
    replenishment: snapshotReplenishmentDiagnosticSchema,
    contention: resourceContentionDiagnosticSchema,
  })
  .strict();
export type ExecutionDiagnosticReport = z.infer<
  typeof executionDiagnosticReportSchema
>;

export const executionDiagnosticResponseSchema = z
  .object({
    status: z.enum(["READY", "PENDING", "UNAVAILABLE"]),
    runId: z.string().min(1),
    accountId: z.string().min(1),
    marketId: marketIdSchema,
    currency: z.enum(["CAD", "USD"]),
    temporalScope: executionDiagnosticsModeSchema,
    asOf: isoDateTime.nullable(),
    reportId: z.string().uuid().nullable(),
    jobId: z.string().uuid().nullable(),
    reportVersion: z.string().nullable(),
    sourceDigest: hash.nullable(),
    generatedAt: isoDateTime.nullable(),
    report: executionDiagnosticReportSchema.nullable(),
    reason: z.string().nullable(),
  })
  .strict();
export type ExecutionDiagnosticResponse = z.infer<
  typeof executionDiagnosticResponseSchema
>;
