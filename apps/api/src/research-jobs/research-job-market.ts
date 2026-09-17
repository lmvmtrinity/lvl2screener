import {
  coverageVerificationJobPayloadSchema,
  coverageVerificationJobPayloadV2Schema,
  marketIdSchema,
  strategyStudyJobPayloadSchema,
  type MarketId,
  type ResearchJobType,
} from "@tsx-scanner/contracts";
import { z } from "zod";

/** Resolve the market from the validated, job-specific payload. Unknown or
 * malformed payloads fail closed; a missing market is never treated as a
 * default Canadian job. */
export function researchJobMarket(
  jobType: ResearchJobType,
  payload: unknown,
): MarketId {
  if (jobType === "COVERAGE_VERIFICATION") {
    if (
      typeof payload === "object" &&
      payload !== null &&
      (payload as { version?: unknown }).version === "coverage-verification-v2"
    )
      return coverageVerificationJobPayloadV2Schema.parse(payload).request
        .recipe.marketId;
    const parsed = coverageVerificationJobPayloadSchema.parse(payload);
    if (parsed.request.marketId !== parsed.manifest.marketId)
      throw new Error("EVIDENCE_MANIFEST_MARKET_MISMATCH");
    return parsed.request.marketId;
  }
  if (jobType === "STRATEGY_STUDY")
    return strategyStudyJobPayloadSchema.parse(payload).plan.comparison
      .marketId;
  const parsed = z
    .object({ marketId: marketIdSchema })
    .passthrough()
    .parse(payload);
  return parsed.marketId;
}
