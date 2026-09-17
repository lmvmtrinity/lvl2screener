import { z } from "zod";
import { researchEvidenceBindingSchema } from "./research-evidence.js";
import { scannerAlertSchema } from "./alerts.js";
import {
  contextEvaluationSchema,
  strategyEvaluationSchema,
  strategyStateEventSchema,
} from "./scoring.js";
import { universeAutomationSchema } from "./universe.js";

export const browserEventSchema = z.object({
  type: z.enum([
    "snapshot",
    "market.status",
    "candidate.updated",
    "strategy.state_changed",
  ]),
  timestamp: z.string().datetime(),
  market: z.unknown().optional(),
  candidates: z.array(strategyEvaluationSchema).optional(),
  contexts: z.array(contextEvaluationSchema).optional(),
  universe: universeAutomationSchema.optional(),
  alerts: z.array(scannerAlertSchema).optional(),
  event: strategyStateEventSchema.optional(),
  // W6b: monotonically increasing per-connection cycle counter and a frame
  // schema version, added alongside change-detection suppression so a client
  // can tell "frames were suppressed because nothing changed" (seq jumps by
  // more than 1) apart from "this is a fresh connection" (seq resets low).
  // Optional so a client built against the pre-W6b frame shape — or a server
  // rolled back to it — still parses cleanly either direction.
  seq: z.number().int().nonnegative().optional(),
  version: z.number().int().nonnegative().optional(),
});
export type BrowserEvent = z.infer<typeof browserEventSchema>;

// W8: durable research jobs. POST /api/backtests, /api/calibrations, /api/ranking-research, and
// /api/statistical-models each enqueue one of these instead of running synchronously; the client
// polls GET /api/research-jobs/:id (or requests cancellation) until the job reaches a terminal
// status, then reads the finished result from result.refId's existing detail endpoint.
export const researchJobTypeSchema = z.enum([
  "BACKTEST",
  "CALIBRATION",
  "RANKING_RESEARCH",
  "STATISTICAL_TRAINING",
  "COVERAGE_VERIFICATION",
  "STRATEGY_STUDY",
  "EXECUTION_DIAGNOSTICS",
  "FUNDED_HISTORICAL_REPLAY",
  "FUNDED_EXECUTION_TRAINING",
  "FUNDED_COMPARISON",
]);
export type ResearchJobType = z.infer<typeof researchJobTypeSchema>;

export const researchJobStatusSchema = z.enum([
  "QUEUED",
  "RUNNING",
  "CANCELLING",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
]);
export type ResearchJobStatus = z.infer<typeof researchJobStatusSchema>;

export const researchJobErrorCategorySchema = z.enum([
  "VALIDATION",
  "HISTORY_UNAVAILABLE",
  "UPSTREAM_ENGINE",
  "CANCELLED",
  "LEASE_EXPIRED",
  "UNKNOWN",
]);
export type ResearchJobErrorCategory = z.infer<
  typeof researchJobErrorCategorySchema
>;

export const researchJobProgressSchema = z.object({
  totalSessions: z.number().int().nonnegative().optional(),
  completedSessions: z.number().int().nonnegative().optional(),
  message: z.string().optional(),
});
export type ResearchJobProgress = z.infer<typeof researchJobProgressSchema>;

export const researchJobSchema = z.object({
  id: z.string().uuid(),
  jobType: researchJobTypeSchema,
  status: researchJobStatusSchema,
  resultRefId: z.string().uuid().nullable(),
  progress: researchJobProgressSchema,
  error: z.string().nullable(),
  errorCategory: researchJobErrorCategorySchema.nullable(),
  attemptCount: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  cancellationRequested: z.boolean(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  completedAt: z.string().datetime().nullable(),
  researchEvidence: researchEvidenceBindingSchema.nullable().optional(),
  /** Internal read-model ownership context; mutation routes do not accept it. */
  requestPayload: z.unknown().optional(),
});
export type ResearchJob = z.infer<typeof researchJobSchema>;
