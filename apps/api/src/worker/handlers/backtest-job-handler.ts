import { createBacktestSchema, type MarketId } from "@tsx-scanner/contracts";
import type { ScannerFeatureClient } from "../../market-data/scanner-client.js";
import {
  versionFor,
  type ProfileEvidenceLinker,
} from "../../backtests/backtest-service.js";
import { checkBacktestRequest } from "../../backtests/backtest-policy.js";
import type {
  PostgresBacktestStore,
  ReplaySessionPolicy,
} from "../../backtests/backtest-repository.js";
import {
  buildBacktestEvidence,
  buildStrategyBacktestEvidence,
} from "../../backtests/evidence-service.js";
import { AuthoritativeBacktestAccumulator } from "../../backtests/authoritative-backtest-executor.js";
import { runCapturedReplaySessions } from "../../backtests/captured-replay-runner.js";
import { type ArtifactResearchLineage } from "../../backtests/research-lineage-service.js";
import { hashResearchSession } from "../../backtests/research-session-input.js";
import {
  CancelledError,
  CategorizedError,
  type ClaimedResearchJob,
  type JobContext,
  type ResearchJobHandler,
} from "../research-worker.js";
import { replayInputCandidateCount } from "../../backtests/replay-candidate-plan.js";

/** W8: the fully chunked example job type. Unlike the other three handlers (which run the existing
 * synchronous service as one atomic unit inside a job -- see synchronous-job-handler.ts), this
 * handler processes the run one market session at a time:
 *  - reads session dates via a cursor query, then loads one session's quotes/candles per
 *    iteration (backtest-repository's loadReplaySessionDates/loadReplaySession), so Node never
 *    holds more than one session's history in memory;
 *  - asks the scanner for signal/context evidence for that session only, then immediately feeds
 *    the same session's ordered facts into the authoritative TypeScript execution accumulator;
 *    neither process retains the full replay history;
 *  - persists progress and heartbeats between sessions, checking for a cancellation request before
 *    starting the next one.
 *
 * Resume policy: NOT safely resumable mid-run. The authoritative accumulator is in-process, so a
 * lost worker lease requeues the job and starts again from session 1. Restarting is deterministic
 * and session-bounded but not incremental; there is no partial credit for streamed sessions.
 */
export class BacktestJobHandler implements ResearchJobHandler {
  constructor(
    private readonly store: PostgresBacktestStore,
    private readonly scanner: ScannerFeatureClient,
    private readonly policy:
      ReplaySessionPolicy | Readonly<Record<MarketId, ReplaySessionPolicy>>,
    private readonly profileEvidence?: ProfileEvidenceLinker,
    private readonly lineage?: ArtifactResearchLineage,
  ) {}

  async execute(
    job: ClaimedResearchJob,
    context: JobContext,
  ): Promise<{ resultRefId: string }> {
    const parsed = createBacktestSchema.safeParse(job.requestPayload);
    if (!parsed.success)
      throw new CategorizedError(
        "VALIDATION",
        `Backtest job payload failed validation: ${parsed.error.message}`,
      );
    const input = parsed.data;

    const capturedHistoryAvailability =
      await this.store.getCapturedHistoryAvailability(input.marketId);
    const violation = checkBacktestRequest(input, capturedHistoryAvailability);
    if (violation)
      throw new CategorizedError(
        violation.code === "HISTORY_UNAVAILABLE"
          ? "HISTORY_UNAVAILABLE"
          : "VALIDATION",
        violation.message,
      );
    const configVersion = versionFor(input.parameters);
    const replayInput = await this.store.resolveReplayInput(
      input,
      capturedHistoryAvailability,
    );
    // A replay with no candidate-bearing session would only evaluate the
    // benchmark context and persist an empty result; reject it instead of
    // letting it consume scanner work or satisfy eligibility elsewhere.
    if (replayInputCandidateCount(replayInput) === 0)
      throw new CategorizedError(
        "VALIDATION",
        `NO_REPLAY_CANDIDATES: ${
          replayInput.warnings.join(" ") ||
          "the replay input resolves no candidate instruments."
        }`,
      );
    const policy = this.policyFor(input.marketId);
    const dates = await this.store.loadReplaySessionDates(
      input,
      replayInput,
      policy,
    );
    const hashes: Record<string, string> = {};
    if (this.lineage)
      for (const date of dates) {
        if ((await context.heartbeat()).cancellationRequested)
          throw new CancelledError();
        hashes[date] = hashResearchSession(
          date,
          await this.store.loadReplaySession(replayInput, policy, date),
        );
      }
    const researchEvidence = await this.lineage?.resolve({
      kind: "BACKTEST",
      marketId: input.marketId,
      scope: { input, replayInput },
      sessionDates: dates,
      inputCutoff: `${input.endDate}T23:59:59.999Z`,
      sessionPayloadHashes: hashes,
    });
    const run = await this.store.create(
      input,
      configVersion,
      capturedHistoryAvailability,
      replayInput,
      undefined,
      researchEvidence,
    );
    await this.store.markRunning(run.id);

    try {
      const runMetadata = {
        runId: run.id,
        marketId: input.marketId,
        configVersion,
        strategies: input.strategies,
        parameters: input.parameters,
        assumptions: {
          startingCapital: input.startingCapital,
          positionSize: input.positionSize,
          slippageBps: input.slippageBps,
          feePerTrade: input.feePerTrade,
        },
      };
      // Nothing to chunk; the engine still needs to run once to produce a (empty, warned) result
      // exactly as the previous single-request path did for a range with no captured history.
      const accumulator = new AuthoritativeBacktestAccumulator(
        run.id,
        configVersion,
        input,
        undefined,
        researchEvidence !== undefined,
      );
      if (dates.length === 0) {
        const signals = await this.scanner.runBacktestSignals({
          ...runMetadata,
          sessions: [],
        });
        accumulator.addReplayWarnings(signals);
      } else {
        await runCapturedReplaySessions({
          context,
          store: researchEvidence
            ? {
                loadReplaySession: (_snapshot, _policy, date) =>
                  this.store.loadVerifiedReplaySession(
                    researchEvidence.coverageReportHash,
                    date,
                  ),
              }
            : this.store,
          scanner: this.scanner,
          runId: run.id,
          dates,
          replayInput,
          metadata: runMetadata,
          accumulator,
          policy,
        });
      }
      const result = accumulator.finish().output;
      const evidence = buildBacktestEvidence(
        result,
        new Date(),
        input.marketId,
      );
      const completed = await this.store.complete(run.id, result, evidence);
      const strategyEvidence = buildStrategyBacktestEvidence(
        result,
        new Date(),
        input.strategies,
        input.marketId,
      );
      await this.profileEvidence?.linkBacktestEvidence(
        completed,
        strategyEvidence,
      );
      return { resultRefId: completed.id };
    } catch (error) {
      if (error instanceof CancelledError) {
        await this.store.fail(run.id, "Cancelled by request");
        throw error;
      }
      const message =
        error instanceof Error ? error.message : "Unknown replay failure";
      await this.store.fail(run.id, message);
      throw new CategorizedError(
        "UPSTREAM_ENGINE",
        `Backtest replay failed: ${message}`,
        { cause: error },
      );
    }
  }

  private policyFor(marketId: MarketId): ReplaySessionPolicy {
    if ("timezone" in this.policy) return this.policy;
    const policy = this.policy[marketId];
    if (!policy)
      throw new CategorizedError(
        "VALIDATION",
        `No replay session policy is configured for ${marketId}`,
      );
    return policy;
  }
}
