import {
  fundedComparisonJobPayloadSchema,
  type FundedComparisonFailureReason,
  type FundedComparisonJobPayload,
  type FundedComparisonSpecification,
} from "@tsx-scanner/contracts";
import { LeaseLostError } from "../../research-jobs/research-job-repository.js";
import {
  FundedComparisonIncompleteError,
  FundedComparisonServiceError,
  type FundedComparisonRunContext,
  type FundedComparisonRunOutcome,
} from "../../paper-bot/funded-comparison-service.js";
import {
  CancelledError,
  CategorizedError,
  type ClaimedResearchJob,
  type JobContext,
  type ResearchJobHandler,
} from "../research-worker.js";

/**
 * FP03 worker job. The handler re-verifies the exact frozen specification at
 * execution time (digest, market/currency, champion/challenger identity,
 * cutoff and retained shared-input identity) and then delegates to the
 * comparison service. Cancellation is observed only through the job heartbeat:
 * a cancelled or lease-lost attempt stops before the next session and leaves
 * its durable interruption receipt without rolling back committed evidence.
 */

export function buildFundedComparisonJobPayload(
  specificationId: string,
  specification: Pick<
    FundedComparisonSpecification,
    "comparisonSpecDigest" | "marketId" | "currency"
  >,
  maxSessions: number,
): FundedComparisonJobPayload {
  return fundedComparisonJobPayloadSchema.parse({
    specificationId,
    comparisonSpecDigest: specification.comparisonSpecDigest,
    marketId: specification.marketId,
    currency: specification.currency,
    maxSessions,
  });
}

export interface FundedComparisonJobService {
  verifyJobSpecification(payload: FundedComparisonJobPayload): Promise<unknown>;
  run(
    specificationId: string,
    context: FundedComparisonRunContext,
  ): Promise<FundedComparisonRunOutcome>;
}

export class FundedComparisonJobHandler implements ResearchJobHandler {
  constructor(private readonly service: FundedComparisonJobService) {}

  async execute(
    job: ClaimedResearchJob,
    context: JobContext,
  ): Promise<{ resultRefId: string }> {
    const parsed = fundedComparisonJobPayloadSchema.safeParse(
      job.requestPayload,
    );
    if (!parsed.success)
      throw new CategorizedError(
        "VALIDATION",
        `Funded comparison payload failed validation: ${parsed.error.message}`,
      );
    const payload = parsed.data;
    try {
      await this.service.verifyJobSpecification(payload);
    } catch (error) {
      throw categorizedOf(error);
    }
    let outcome: FundedComparisonRunOutcome;
    try {
      outcome = await this.service.run(payload.specificationId, {
        attemptId: job.id,
        maxSessions: payload.maxSessions,
        verification: "COMPLETED",
        betweenSessions: async () => {
          const { cancellationRequested } = await context.heartbeat({
            message: "Replaying funded comparison",
          });
          if (cancellationRequested)
            throw new CancelledError("Cancelled by request");
        },
      });
    } catch (error) {
      if (error instanceof CancelledError || error instanceof LeaseLostError)
        throw error;
      throw categorizedOf(error);
    }
    return { resultRefId: outcome.specificationId };
  }
}

function categorizedOf(error: unknown): CategorizedError {
  if (error instanceof CategorizedError) return error;
  if (error instanceof FundedComparisonIncompleteError)
    return new CategorizedError(
      "HISTORY_UNAVAILABLE",
      `FUNDED_COMPARISON_INCOMPLETE_SESSIONS: ${error.remainingSessions.join(",")}`,
    );
  if (error instanceof FundedComparisonServiceError)
    return new CategorizedError(
      errorCategoryOf(error.reason),
      `${error.reason}: ${error.message}`,
    );
  return new CategorizedError(
    "UNKNOWN",
    error instanceof Error ? error.message : String(error),
  );
}

const HISTORY_REASONS: readonly FundedComparisonFailureReason[] = [
  "BASELINE_LINEAGE_UNAVAILABLE",
  "REPLAY_LINEAGE_UNAVAILABLE",
  "RETAINED_INPUT_MISSING",
  "QUOTE_COVERAGE_MISSING",
  "CHAMPION_NOT_RETAINED",
  "TRAINING_CHRONOLOGY_UNPROVEN",
  "PREDICTION_DECISION_UNAVAILABLE",
];

const VALIDATION_REASONS: readonly FundedComparisonFailureReason[] = [
  "CONFLICTING_RETRY",
  "RESULT_DIGEST_CONFLICT",
  "SESSION_MEMBERSHIP_MISMATCH",
  "OPPORTUNITY_MEMBERSHIP_MISMATCH",
  "MARKET_CURRENCY_MISMATCH",
  "CHAMPION_POLICY_IDENTITY_MISMATCH",
  "CHALLENGER_POLICY_IDENTITY_MISMATCH",
  "MODEL_IDENTITY_MISMATCH",
  "ARTIFACT_IDENTITY_MISMATCH",
  "RUNTIME_IDENTITY_MISMATCH",
  "COST_IDENTITY_MISMATCH",
  "RISK_IDENTITY_MISMATCH",
  "SOURCE_CUTOFF_AFTER_FREEZE",
  "TRAINING_WINDOW_OVERLAP",
  "COMPARISON_WINDOW_NOT_AFTER_TRAINING",
  "LIVE_ACCOUNT_REPLAY_TARGET",
  "ACCOUNT_IDENTITY_COLLISION",
  "UNRESOLVED_ORDER",
  "UNRESOLVED_RESERVATION",
  "UNRESOLVED_POSITION",
  "INCOMPLETE_SESSION",
];

function errorCategoryOf(
  reason: FundedComparisonFailureReason,
): "VALIDATION" | "HISTORY_UNAVAILABLE" | "UNKNOWN" {
  if (VALIDATION_REASONS.includes(reason)) return "VALIDATION";
  if (HISTORY_REASONS.includes(reason)) return "HISTORY_UNAVAILABLE";
  return "UNKNOWN";
}
