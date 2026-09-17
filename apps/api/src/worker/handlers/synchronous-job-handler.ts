import type { ZodType } from "zod";
import {
  CancelledError,
  CategorizedError,
  type ClaimedResearchJob,
  type JobContext,
  type ResearchJobHandler,
} from "../research-worker.js";

/** W8: partial-treatment job handler shared by calibration, ranking research, and statistical
 * training. Unlike {@link BacktestJobHandler}, this does NOT decompose the run into per-session
 * chunks -- it runs the existing, unmodified synchronous service method (CalibrationService.create
 * / RankingResearchService.create / StatisticalModelService.create) as a single unit of work
 * inside the job. That still gets these three job types: a durable QUEUED row, a 202 response with
 * a pollable job id, lease/heartbeat so a crashed worker's job is detected and retried or
 * interrupted, attempt counting, a stored error category, and idempotency-key deduplication.
 *
 * What it does NOT get, and why that is an explicit, documented scope cut for this workstream
 * rather than an oversight:
 *  - No session-cursor memory bound -- these services still call the same DB queries they always
 *    did (already bounded well below the backtest one-big-query problem for calibration grids,
 *    reuse the already-completed backtest for ranking research, and read backtest trades for
 *    statistical training, none of which load raw quote/candle history at backtest scale).
 *  - No mid-run cancellation -- cancellation is only observed once, before the synchronous call
 *    starts; once running, the service call is awaited to completion (or failure) exactly as it
 *    was when invoked synchronously from the HTTP handler.
 *  - Resume policy is service-owned. Job identity and attempt count are forwarded to the
 *    callback. Calibration binds one run to that identity, freezes selection before TEST,
 *    returns completed retries and refuses interrupted or unlinked prior attempts. Ranking
 *    and statistical training still restart the synchronous call on retry.
 */
export class SynchronousJobHandler<
  TInput,
  TResult extends { id: string },
> implements ResearchJobHandler {
  constructor(
    private readonly inputSchema: ZodType<TInput>,
    private readonly execute_: (
      input: TInput,
      jobId: string,
      attemptCount: number,
    ) => Promise<TResult>,
    private readonly errorCategory: (
      error: unknown,
    ) =>
      | "VALIDATION"
      | "UPSTREAM_ENGINE"
      | "HISTORY_UNAVAILABLE"
      | "UNKNOWN" = () => "UPSTREAM_ENGINE",
  ) {}

  async execute(
    job: ClaimedResearchJob,
    context: JobContext,
  ): Promise<{ resultRefId: string }> {
    if (job.cancellationRequested) throw new CancelledError();
    const { cancellationRequested } = await context.heartbeat({
      message: "Running",
    });
    if (cancellationRequested) throw new CancelledError();
    const parsed = this.inputSchema.safeParse(job.requestPayload);
    if (!parsed.success)
      throw new CategorizedError(
        "VALIDATION",
        `Job payload failed validation: ${parsed.error.message}`,
      );
    try {
      const result = await this.execute_(parsed.data, job.id, job.attemptCount);
      return { resultRefId: result.id };
    } catch (error) {
      throw new CategorizedError(
        this.errorCategory(error),
        error instanceof Error ? error.message : String(error),
        { cause: error },
      );
    }
  }
}
