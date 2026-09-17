import { researchJobSchema, type ResearchJob } from "@tsx-scanner/contracts";
import { getJson, sendJson } from "./api.js";

const TERMINAL_STATUSES = new Set<ResearchJob["status"]>([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "INTERRUPTED",
]);

function isTerminalResearchJob(job: ResearchJob): boolean {
  return TERMINAL_STATUSES.has(job.status);
}

/** W8: POST /api/backtests (and calibrations/ranking-research/statistical-models) now returns 202
 * plus a job id instead of the finished result. This polls GET /api/research-jobs/:id until the
 * job reaches a terminal status, so callers can show progress instead of one long spinner over a
 * held-open request. Aborting `signal` stops polling (used when the view unmounts or the user
 * cancels) without leaving a dangling timer. */
export async function pollResearchJob(
  jobId: string,
  options: {
    intervalMs?: number;
    signal?: AbortSignal;
    onUpdate?: (job: ResearchJob) => void;
  } = {},
): Promise<ResearchJob> {
  const intervalMs = options.intervalMs ?? 1_500;
  for (;;) {
    const job = researchJobSchema.parse(
      await getJson(`/api/research-jobs/${jobId}`, options.signal),
    );
    options.onUpdate?.(job);
    if (isTerminalResearchJob(job)) return job;
    await sleep(intervalMs, options.signal);
  }
}

export async function cancelResearchJob(jobId: string): Promise<ResearchJob> {
  return researchJobSchema.parse(
    await sendJson(`/api/research-jobs/${jobId}/cancel`, "POST", {}),
  );
}

/** Human-readable summary for a job that did not succeed, for the same error banner the old
 * synchronous try/catch used to populate directly from a thrown Error. */
export function researchJobFailureMessage(job: ResearchJob): string {
  if (job.error) return job.error;
  if (job.status === "CANCELLED") return "Cancelled by request.";
  if (job.status === "INTERRUPTED" && job.jobType === "STRATEGY_STUDY")
    return "Study interrupted after a durable stage claim; inspect the retained study before any new authorization.";
  if (job.status === "INTERRUPTED")
    return "Interrupted (the worker restarted); please try again.";
  return `Job ended with status ${job.status}.`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

export function isAbortError(reason: unknown): boolean {
  return reason instanceof DOMException && reason.name === "AbortError";
}
