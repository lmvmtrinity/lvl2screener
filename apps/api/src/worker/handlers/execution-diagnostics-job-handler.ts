import { z } from "zod";
import type { FundedReportingService } from "../../paper-bot/funded-reporting-service.js";
import {
  CategorizedError,
  type ClaimedResearchJob,
  type JobContext,
  type ResearchJobHandler,
} from "../research-worker.js";

const executionDiagnosticsJobPayloadSchema = z
  .object({
    runId: z.string().min(1),
    accountId: z.string().min(1),
    marketId: z.enum(["CA_TSX", "US_EQUITIES"]),
    mode: z.literal("RUN_END"),
    reportVersion: z.string().min(1),
    sourceRevision: z.string().min(1).optional(),
  })
  .strict();

/** Builds and persists one immutable RUN_END diagnostics artifact. The worker owns this write so
 * GET remains read-only and a settlement/restart cannot be coupled to report-generation failure. */
export class ExecutionDiagnosticsJobHandler implements ResearchJobHandler {
  constructor(private readonly reporting: FundedReportingService) {}

  async execute(
    job: ClaimedResearchJob,
    context: JobContext,
  ): Promise<{ resultRefId: string }> {
    const parsed = executionDiagnosticsJobPayloadSchema.safeParse(
      job.requestPayload,
    );
    if (!parsed.success)
      throw new CategorizedError("VALIDATION", parsed.error.message);
    const first = await context.heartbeat({
      message: "Preparing execution diagnostics evidence",
    });
    if (first.cancellationRequested)
      throw new CategorizedError("CANCELLED", "Cancelled by request");
    try {
      const stored = await this.reporting.saveExecutionDiagnostics(
        parsed.data.runId,
        { mode: "RUN_END", marketId: parsed.data.marketId },
        parsed.data.reportVersion,
      );
      if (
        stored.identity.accountId !== parsed.data.accountId ||
        stored.identity.marketId !== parsed.data.marketId
      )
        throw new CategorizedError(
          "VALIDATION",
          "EXECUTION_DIAGNOSTIC_SCOPE_MISMATCH",
        );
      const last = await context.heartbeat({
        message: "Execution diagnostics report retained",
      });
      if (last.cancellationRequested)
        throw new CategorizedError("CANCELLED", "Cancelled by request");
      return { resultRefId: stored.id };
    } catch (error) {
      if (error instanceof CategorizedError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes("snapshot") ||
        message.includes("history") ||
        message.includes("HISTORICAL")
      )
        throw new CategorizedError("HISTORY_UNAVAILABLE", message);
      throw error;
    }
  }
}

export { executionDiagnosticsJobPayloadSchema };
