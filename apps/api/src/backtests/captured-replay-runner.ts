import {
  createBacktestSchema,
  type BacktestReplayResult,
  type CreateBacktest,
  type FrozenStudyPlan,
  type ResearchCoverageReport,
  type StudyStage,
  type StudyStageResult,
} from "@tsx-scanner/contracts";
import type { ScannerFeatureClient } from "../market-data/scanner-client.js";
import type { JobContext } from "../worker/research-worker.js";
import type { ResearchEvidenceStore } from "./research-evidence-repository.js";
import {
  assertCapturedHistoryAvailable,
  versionFor,
  type BacktestStore,
  type ReplaySessionPolicy,
} from "./backtest-service.js";
import {
  AuthoritativeBacktestAccumulator,
  type HistoricalReplaySession,
} from "./authoritative-backtest-executor.js";
import { buildBacktestEvidence } from "./evidence-service.js";
import { admitReplaySession } from "./replay-quote-admission.js";
import {
  assertFrozenSessionPayload,
  deriveStudySessionPairs,
} from "./strategy-study-replay.js";
import type { StudyRunner } from "./strategy-study-service.js";
import { CancelledError } from "../worker/research-worker.js";
import { canonicalJson } from "./research-coverage.js";
import {
  sessionResultHash,
  type StudySessionAuthority,
} from "./study-session-authority.js";
import type { StudyExecutionFence } from "./strategy-study-service.js";

type PreparedProfile = {
  input: CreateBacktest;
  replayInput: Awaited<ReturnType<BacktestStore["resolveReplayInput"]>>;
  dates: string[];
};

export class CapturedReplayRunner implements StudyRunner {
  constructor(
    private readonly store: BacktestStore,
    private readonly scanner: ScannerFeatureClient,
    private readonly policies:
      | ReplaySessionPolicy
      | Readonly<Record<"CA_TSX" | "US_EQUITIES", ReplaySessionPolicy>>,
    private readonly evidence: ResearchEvidenceStore,
    private readonly context: JobContext,
    private readonly authority?: StudySessionAuthority,
    private readonly fence?: StudyExecutionFence,
  ) {}

  async run(
    plan: FrozenStudyPlan,
    stage: StudyStage,
  ): Promise<StudyStageResult> {
    const binding = plan.inputs[stage].binding;
    if (canonicalJson(binding) !== canonicalJson(plan.binding))
      throw new Error("STUDY_INPUT_BINDING_MISMATCH");
    const report = await this.evidence.getReport(binding.coverageReportHash);
    if (!report || report.status !== "VERIFIED")
      throw new Error("COVERAGE_NOT_VERIFIED");
    if (report.inputHash !== binding.inputHash)
      throw new Error("STUDY_INPUT_BINDING_MISMATCH");
    if (report.marketId !== plan.comparison.marketId)
      throw new Error("STUDY_MARKET_MISMATCH");

    const baseline = await this.prepare(plan, stage, "baseline", report);
    const challenger = await this.prepare(plan, stage, "challenger", report);
    if (canonicalJson(baseline.dates) !== canonicalJson(challenger.dates))
      throw new Error("STUDY_SESSION_SCOPE_MISMATCH");

    const baselineRun = await this.executeProfile(
      plan,
      stage,
      baseline,
      "baseline",
      binding,
      report,
    );
    const challengerRun = await this.executeProfile(
      plan,
      stage,
      challenger,
      "challenger",
      binding,
      report,
    );
    return {
      stage,
      binding,
      baselineRunId: baselineRun.id,
      challengerRunId: challengerRun.id,
      baselineClosedTrades: baselineRun.output.metrics.closedTrades,
      challengerClosedTrades: challengerRun.output.metrics.closedTrades,
      challengerAverageR:
        challengerRun.output.metrics.closedTrades > 0
          ? challengerRun.output.metrics.averageR
          : null,
      sessions: deriveStudySessionPairs(
        baselineRun.output,
        challengerRun.output,
        plan.comparison.marketId,
        stage === "TEST" ? plan.comparison.expectedSessions : baseline.dates,
        plan.comparison.unit,
      ),
    };
  }

  private async prepare(
    plan: FrozenStudyPlan,
    stage: StudyStage,
    side: "baseline" | "challenger",
    report: ResearchCoverageReport,
  ): Promise<PreparedProfile> {
    const input = createBacktestSchema.parse(plan.inputs[stage][side]);
    if (input.marketId !== plan.comparison.marketId)
      throw new Error("STUDY_MARKET_MISMATCH");
    if (input.startDate > input.endDate) throw new Error("INVALID_STUDY_RANGE");
    if (this.store.loadVerifiedReplayInput && plan.sessionPlan) {
      const replayInput = await this.store.loadVerifiedReplayInput(
        plan.binding.coverageReportHash,
      );
      const dates = plan.sessionPlan.sessions[stage];
      if (
        replayInput.marketId !== input.marketId ||
        dates.some((date) => !report.sessionPayloadHashes[date])
      )
        throw new Error("STUDY_SESSION_SCOPE_MISMATCH");
      return { input, replayInput, dates };
    }
    const availability = await this.store.getCapturedHistoryAvailability(
      input.marketId,
    );
    assertCapturedHistoryAvailable(input, availability);
    const replayInput = await this.store.resolveReplayInput(
      input,
      availability,
    );
    if (!this.store.loadReplaySessionDates || !this.store.loadReplaySession)
      throw new Error("CAPTURED_REPLAY_STORE_UNAVAILABLE");
    const policy = this.policyFor(input.marketId);
    const dates = await this.store.loadReplaySessionDates(
      input,
      replayInput,
      policy,
    );
    const expectedDates = plan.sessionPlan
      ? plan.sessionPlan.sessions[stage]
      : stage === "TEST"
        ? plan.comparison.expectedSessions
        : null;
    if (expectedDates && canonicalJson(dates) !== canonicalJson(expectedDates))
      throw new Error("STUDY_SESSION_SCOPE_MISMATCH");
    // Materialize one session inside executeProfile immediately before its scanner request. This
    // keeps the study cursor bounded and prevents a preflight reload from changing the object the
    // engine evaluates.
    void report;
    return { input, replayInput, dates };
  }

  private async executeProfile(
    plan: FrozenStudyPlan,
    stage: StudyStage,
    prepared: PreparedProfile,
    side: "baseline" | "challenger",
    binding: FrozenStudyPlan["binding"],
    report: ResearchCoverageReport,
  ): Promise<{ id: string; output: BacktestReplayResult }> {
    const configVersion = versionFor(prepared.input.parameters);
    const run = await this.store.create(
      prepared.input,
      configVersion,
      prepared.replayInput.capturedHistoryAvailability,
      prepared.replayInput,
      undefined,
      binding,
    );
    await this.store.markRunning(run.id);
    try {
      const accumulator = new AuthoritativeBacktestAccumulator(
        run.id,
        configVersion,
        prepared.input,
        undefined,
        true,
      );
      const metadata = {
        runId: run.id,
        marketId: prepared.input.marketId,
        configVersion,
        strategies: prepared.input.strategies,
        parameters: prepared.input.parameters,
        assumptions: {
          startingCapital: prepared.input.startingCapital,
          positionSize: prepared.input.positionSize,
          slippageBps: prepared.input.slippageBps,
          feePerTrade: prepared.input.feePerTrade,
        },
      };
      if (prepared.dates.length === 0) {
        accumulator.addReplayWarnings(
          await this.scanner.runBacktestSignals({ ...metadata, sessions: [] }),
        );
      }
      if (!this.store.loadReplaySession)
        throw new Error("CAPTURED_REPLAY_STORE_UNAVAILABLE");
      const policy = this.policyFor(prepared.input.marketId);
      for (let index = 0; index < prepared.dates.length; index++) {
        const { cancellationRequested } = await this.context.heartbeat({
          totalSessions: prepared.dates.length,
          completedSessions: index,
          message: `${stage}: ${prepared.dates[index]}`,
        });
        if (cancellationRequested) throw new CancelledError();
        const date = prepared.dates[index]!;
        if (this.authority && this.fence) {
          const state = await this.authority.begin(
            {
              experimentId: plan.experimentId,
              stage,
              side,
              sessionDate: date,
            },
            this.fence,
          );
          if (state !== "STARTED")
            throw new Error("STUDY_SESSION_ALREADY_ACCEPTED");
        }
        const session = this.store.loadVerifiedReplaySession
          ? await this.store.loadVerifiedReplaySession(
              binding.coverageReportHash,
              date,
            )
          : await this.store.loadReplaySession(
              prepared.replayInput,
              policy,
              date,
            );
        assertFrozenSessionPayload(session, report.sessionPayloadHashes, date);
        const admittedSession = admitReplaySession(session);
        const signals = await runWithLeaseHeartbeat(
          this.context,
          (signal) =>
            this.scanner.runBacktestSignalChunk(
              run.id,
              metadata,
              admittedSession,
              index === prepared.dates.length - 1,
              signal,
            ),
          this.authority && this.fence
            ? () => this.authority!.assertCurrent(this.fence!)
            : undefined,
        );
        if (this.authority && this.fence)
          await this.authority.accept(
            {
              experimentId: plan.experimentId,
              stage,
              side,
              sessionDate: date,
            },
            this.fence,
            sessionResultHash({ date, signals }),
          );
        accumulator.ingestSession(
          session as unknown as HistoricalReplaySession,
          signals,
        );
      }
      const output = accumulator.finish().output;
      await this.context.heartbeat({
        totalSessions: prepared.dates.length,
        completedSessions: prepared.dates.length,
        message: `${stage}: persisting ${run.id}`,
      });
      await this.store.complete(
        run.id,
        output,
        buildBacktestEvidence(output, new Date(), prepared.input.marketId),
      );
      return { id: run.id, output };
    } catch (error) {
      await this.store
        .fail(
          run.id,
          error instanceof CancelledError
            ? "Cancelled by request"
            : error instanceof Error
              ? error.message
              : String(error),
        )
        .catch(() => undefined);
      throw error;
    }
  }

  private policyFor(marketId: "CA_TSX" | "US_EQUITIES"): ReplaySessionPolicy {
    if ("timezone" in this.policies) return this.policies;
    const policy = this.policies[marketId];
    if (!policy) throw new Error(`NO_REPLAY_POLICY:${marketId}`);
    return policy;
  }
}

/** Shared session-bounded loop used by both ordinary backtest jobs and frozen studies. The
 * accumulator remains the single owner of execution/economics; this helper only coordinates
 * one retained session at a time, heartbeats and cooperative cancellation. */
export async function runCapturedReplaySessions(input: {
  context: JobContext;
  store: Pick<BacktestStore, "loadReplaySession">;
  scanner: ScannerFeatureClient;
  runId: string;
  dates: readonly string[];
  replayInput: PreparedProfile["replayInput"];
  metadata: Record<string, unknown>;
  accumulator: AuthoritativeBacktestAccumulator;
  policy: ReplaySessionPolicy;
}): Promise<void> {
  if (!input.store.loadReplaySession)
    throw new Error("CAPTURED_REPLAY_STORE_UNAVAILABLE");
  for (let index = 0; index < input.dates.length; index++) {
    const date = input.dates[index]!;
    const heartbeat = await input.context.heartbeat({
      totalSessions: input.dates.length,
      completedSessions: index,
      message: `Loading session ${date}`,
    });
    if (heartbeat.cancellationRequested) throw new CancelledError();
    const session = await input.store.loadReplaySession(
      input.replayInput,
      input.policy,
      date,
    );
    const admittedSession = admitReplaySession(session);
    const signals = await runWithLeaseHeartbeat(input.context, (signal) =>
      input.scanner.runBacktestSignalChunk(
        input.runId,
        input.metadata,
        admittedSession,
        index === input.dates.length - 1,
        signal,
      ),
    );
    input.accumulator.ingestSession(
      session as unknown as HistoricalReplaySession,
      signals,
    );
  }
}

/** Keep a worker lease alive while the scanner processes one session. A cancellation or failed
 * heartbeat aborts the HTTP request; the caller never ingests a partial scanner response. */
async function runWithLeaseHeartbeat<T>(
  context: JobContext,
  operation: (signal: AbortSignal) => Promise<T>,
  assertAuthority?: () => Promise<void>,
): Promise<T> {
  const intervalMs = Math.max(250, Math.floor((context.leaseMs ?? 60_000) / 3));
  const controller = new AbortController();
  let stopped = false;
  let terminalError: unknown;
  let heartbeatInFlight: Promise<void> | undefined;

  const heartbeat = async (): Promise<void> => {
    if (stopped || heartbeatInFlight) return;
    heartbeatInFlight = context
      .heartbeat()
      .then((result) => {
        if (result.cancellationRequested) {
          terminalError = new CancelledError();
          controller.abort(terminalError);
        }
        return assertAuthority?.();
      })
      .catch((error: unknown) => {
        terminalError = error;
        controller.abort(error);
      })
      .finally(() => {
        heartbeatInFlight = undefined;
      });
    await heartbeatInFlight;
  };

  const timer = setInterval(() => {
    void heartbeat();
  }, intervalMs);
  timer.unref?.();
  try {
    const result = await operation(controller.signal);
    if (terminalError) throw terminalError;
    return result;
  } catch (error) {
    if (terminalError) throw terminalError;
    throw error;
  } finally {
    stopped = true;
    clearInterval(timer);
    await heartbeatInFlight?.catch(() => undefined);
  }
}
