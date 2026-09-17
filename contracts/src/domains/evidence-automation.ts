import { z } from "zod";
import { marketIdSchema } from "./markets.js";

export const evidenceAutomationStageKeySchema = z.enum([
  "COVERAGE",
  "QUALIFICATION",
  "STUDY",
  "TRAINING",
  "FORWARD_OBSERVATION",
  "DIAGNOSTICS",
]);
export type EvidenceAutomationStageKey = z.infer<
  typeof evidenceAutomationStageKeySchema
>;

export const evidenceAutomationStateSchema = z.enum([
  "UNKNOWN",
  "WAITING",
  "QUEUED",
  "RUNNING",
  "SUCCEEDED",
  "NO_NEW_EVIDENCE",
  "PAUSED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
]);
export type EvidenceAutomationState = z.infer<
  typeof evidenceAutomationStateSchema
>;

const evidenceProgressSchema = z
  .object({
    completed: z.number().int().nonnegative(),
    total: z.number().int().positive(),
    unit: z.string().trim().min(1).max(80),
  })
  .strict()
  .refine((value) => value.completed <= value.total, {
    message: "completed cannot exceed total",
  });

const evidenceNextActionSchema = z
  .object({
    kind: z.enum(["AUTOMATIC", "USER_REVIEW", "NONE"]),
    label: z.string().trim().min(1).max(240),
  })
  .strict();

export const evidenceAutomationStageSchema = z
  .object({
    key: evidenceAutomationStageKeySchema,
    marketId: marketIdSchema,
    scopeId: z.string().trim().min(1).max(200),
    state: evidenceAutomationStateSchema,
    asOf: z.string().datetime(),
    lastAttemptAt: z.string().datetime().nullable(),
    lastSuccessAt: z.string().datetime().nullable(),
    nextCheckAt: z.string().datetime().nullable(),
    progress: evidenceProgressSchema.nullable(),
    reasonCodes: z.array(z.string().trim().min(1).max(120)),
    nextAction: evidenceNextActionSchema,
    jobId: z.string().uuid().nullable(),
    relatedScopes: z
      .array(
        z
          .object({
            scopeId: z.string().min(1).max(200),
            state: evidenceAutomationStateSchema,
            lastAttemptAt: z.string().datetime().nullable().optional(),
            progress: evidenceProgressSchema.nullable().optional(),
            reasonCodes: z.array(z.string()),
            jobId: z.string().uuid().nullable(),
            reportId: z
              .union([z.string().uuid(), z.string().regex(/^[a-f0-9]{64}$/)])
              .nullable(),
          })
          .strict(),
      )
      .optional(),
    reportId: z
      .union([z.string().uuid(), z.string().regex(/^[a-f0-9]{64}$/)])
      .nullable(),
  })
  .strict();
export type EvidenceAutomationStage = z.infer<
  typeof evidenceAutomationStageSchema
>;

export const evidenceAutomationResponseSchema = z
  .object({ stages: z.array(evidenceAutomationStageSchema) })
  .strict();

export const evidenceWorkIdentitySchema = z
  .object({
    kind: z.enum(["COVERAGE", "STUDY", "DIAGNOSTICS"]),
    marketId: marketIdSchema,
    scopeHash: z.string().regex(/^[a-f0-9]{64}$/),
    inputIdentityHash: z.string().regex(/^[a-f0-9]{64}$/),
    processorVersion: z.string().trim().min(1).max(120),
  })
  .strict();
export type EvidenceWorkIdentity = z.infer<typeof evidenceWorkIdentitySchema>;

export const evidenceWorkReceiptSchema = z
  .object({
    workKey: z.string().regex(/^[a-f0-9]{64}$/),
    identity: evidenceWorkIdentitySchema,
    state: z.enum(["WAITING", "DISPATCHED", "NO_NEW_EVIDENCE", "FAILED"]),
    jobId: z.string().uuid().nullable(),
    reasonCodes: z.array(z.string().trim().min(1).max(120)),
    recordedAt: z.string().datetime(),
  })
  .strict();
export type EvidenceWorkReceipt = z.infer<typeof evidenceWorkReceiptSchema>;
