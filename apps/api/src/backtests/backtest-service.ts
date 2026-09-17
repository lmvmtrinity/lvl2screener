import { createHash } from "node:crypto";
import type {
  BacktestComparison,
  BacktestEvidenceReport,
  BacktestReplayResult,
  BacktestSignalReplayResult,
  BacktestRun,
  CapturedHistoryAvailability,
  CreateBacktest,
  ReplayInputSnapshot,
  ResearchEvidenceBinding,
} from "@tsx-scanner/contracts";
import type { MarketId } from "@tsx-scanner/contracts";
import type { ReplaySessionPolicy } from "./backtest-repository.js";
export type { ReplaySessionPolicy } from "./backtest-repository.js";
import {
  buildBacktestEvidence,
  buildStrategyBacktestEvidence,
  type StrategyBacktestEvidence,
} from "./evidence-service.js";
import { DomainError } from "../errors.js";
import {
  AuthoritativeBacktestAccumulator,
  type HistoricalReplaySession,
} from "./authoritative-backtest-executor.js";
import { admitReplaySession } from "./replay-quote-admission.js";
import {
  checkBacktestRequest,
  checkCapturedHistoryRange,
} from "./backtest-policy.js";
import {
  researchSessionDates,
  type ArtifactResearchLineage,
} from "./research-lineage-service.js";
import { hashResearchSession } from "./research-session-input.js";
import { replayInputCandidateCount } from "./replay-candidate-plan.js";

export class BacktestError extends DomainError {
  constructor(
    readonly code:
      | "RUN_NOT_FOUND"
      | "INVALID_RANGE"
      | "HISTORY_UNAVAILABLE"
      | "REPLAY_INPUT_UNAVAILABLE"
      | "REPLAY_COVERAGE_INCOMPLETE"
      | "NO_REPLAY_CANDIDATES"
      | "REPLAY_FAILED",
    message: string,
    readonly runId?: string,
  ) {
    // Every current call site treats every BacktestError code as "not found" (404); kept as-is
    // to avoid a behavior change during this restructuring.
    super(code, message, 404);
  }
}

export interface BacktestEngine {
  runBacktest(payload: unknown): Promise<BacktestReplayResult>;
}

export interface BacktestSignalEngine {
  runBacktestSignals(payload: unknown): Promise<BacktestSignalReplayResult>;
}

export interface BacktestStore {
  loadVerifiedReplayInput?(reportHash: string): Promise<ReplayInputSnapshot>;
  loadVerifiedReplaySession?(
    reportHash: string,
    date: string,
  ): Promise<Record<string, unknown>>;
  create(
    input: CreateBacktest,
    configVersion: string,
    capturedHistoryAvailability: CapturedHistoryAvailability,
    replayInput: ReplayInputSnapshot,
    supersedesBacktestRunId?: string,
    researchEvidence?: ResearchEvidenceBinding,
  ): Promise<BacktestRun>;
  markRunning(id: string): Promise<void>;
  complete(
    id: string,
    output: BacktestReplayResult,
    evidence: BacktestEvidenceReport,
  ): Promise<BacktestRun>;
  fail(id: string, error: string): Promise<void>;
  list(limit?: number): Promise<BacktestRun[]>;
  get(id: string): Promise<BacktestRun | undefined>;
  loadReplayData(
    input: CreateBacktest,
    replayInput: ReplayInputSnapshot,
    policy: ReplaySessionPolicy,
  ): Promise<Record<string, unknown>>;
  loadReplaySessionDates?(
    input: CreateBacktest,
    replayInput: ReplayInputSnapshot,
    policy: ReplaySessionPolicy,
  ): Promise<string[]>;
  loadReplaySession?(
    replayInput: ReplayInputSnapshot,
    policy: ReplaySessionPolicy,
    date: string,
  ): Promise<Record<string, unknown>>;
  resolveReplayInput(
    input: CreateBacktest,
    capturedHistoryAvailability: CapturedHistoryAvailability,
  ): Promise<ReplayInputSnapshot>;
  getCapturedHistoryAvailability(
    marketId?: MarketId,
  ): Promise<CapturedHistoryAvailability>;
}

export interface ProfileEvidenceLinker {
  linkBacktestEvidence(
    run: BacktestRun,
    evidence: StrategyBacktestEvidence[],
  ): Promise<void>;
  replaceBacktestEvidence?(
    source: BacktestRun,
    replacement: BacktestRun,
    evidence: StrategyBacktestEvidence[],
  ): Promise<void>;
}

export class BacktestService {
  constructor(
    private readonly store: BacktestStore,
    private readonly engine: BacktestSignalEngine,
    private readonly policy:
      ReplaySessionPolicy | Readonly<Record<MarketId, ReplaySessionPolicy>>,
    private readonly profileEvidence?: ProfileEvidenceLinker,
    private readonly lineage?: ArtifactResearchLineage,
  ) {}

  async listRuns(limit = 100): Promise<BacktestRun[]> {
    return this.store.list(limit);
  }

  async getRun(id: string): Promise<BacktestRun> {
    const run = await this.store.get(id);
    if (!run)
      throw new BacktestError("RUN_NOT_FOUND", "Backtest run not found");
    return run;
  }

  async getCapturedHistoryAvailability(
    marketId: MarketId = "CA_TSX",
  ): Promise<CapturedHistoryAvailability> {
    return this.store.getCapturedHistoryAvailability(marketId);
  }

  async createRun(
    input: CreateBacktest,
    researchEvidence?: ResearchEvidenceBinding,
  ): Promise<BacktestRun> {
    const structural = checkBacktestRequest(input);
    if (structural)
      throw new BacktestError(structural.code, structural.message);
    const capturedHistoryAvailability =
      await this.getCapturedHistoryAvailability(input.marketId);
    const ranged = checkBacktestRequest(input, capturedHistoryAvailability);
    if (ranged) throw new BacktestError(ranged.code, ranged.message);
    const replayInput = await this.store.resolveReplayInput(
      input,
      capturedHistoryAvailability,
    );
    if (replayInputCandidateCount(replayInput) === 0)
      throw new BacktestError(
        "NO_REPLAY_CANDIDATES",
        replayInput.warnings.join(" ") ||
          "The requested range resolves no candidate-bearing session.",
        undefined,
      );
    return this.executeRun(
      input,
      capturedHistoryAvailability,
      replayInput,
      undefined,
      undefined,
      undefined,
      researchEvidence,
    );
  }

  async createReplacementRun(source: BacktestRun): Promise<BacktestRun> {
    if (!source.replayInput)
      throw new BacktestError(
        "REPLAY_INPUT_UNAVAILABLE",
        `Legacy run ${source.id} has no immutable replay-input snapshot and cannot be reproduced exactly.`,
        source.id,
      );
    const input: CreateBacktest = {
      name: `${source.name} · authoritative replacement`,
      marketId: source.marketId,
      startDate: source.startDate,
      endDate: source.endDate,
      strategies: source.strategies,
      symbols: source.symbols,
      dataSource: source.dataSource,
      startingCapital: source.startingCapital,
      positionSize: source.positionSize,
      slippageBps: source.slippageBps,
      feePerTrade: source.feePerTrade,
      parameters: source.parameters,
    };
    const availability = await this.getCapturedHistoryAvailability(
      input.marketId,
    );
    assertCapturedHistoryAvailable(input, availability);
    const replay = (await this.store.loadReplayData(
      input,
      source.replayInput,
      this.policyFor(input.marketId),
    )) as { sessions: HistoricalReplaySession[] };
    assertReplayCoverage(source, replay.sessions);
    return this.executeRun(
      input,
      availability,
      source.replayInput,
      source.id,
      replay,
      source,
    );
  }

  private async executeRun(
    input: CreateBacktest,
    capturedHistoryAvailability: CapturedHistoryAvailability,
    replayInput: ReplayInputSnapshot,
    supersedesBacktestRunId?: string,
    preparedReplay?: { sessions: HistoricalReplaySession[] },
    source?: BacktestRun,
    researchEvidence?: ResearchEvidenceBinding,
  ): Promise<BacktestRun> {
    if (replayInput.marketId !== input.marketId)
      throw new BacktestError(
        "REPLAY_INPUT_UNAVAILABLE",
        `Replay input market ${replayInput.marketId} does not match requested market ${input.marketId}.`,
      );
    const configVersion = versionFor(input.parameters);
    if (this.lineage && !researchEvidence) {
      preparedReplay ??= (await this.store.loadReplayData(
        input,
        replayInput,
        this.policyFor(input.marketId),
      )) as { sessions: HistoricalReplaySession[] };
      const dates = researchSessionDates(
        preparedReplay.sessions.map((session) => replaySessionStart(session)),
        input.marketId,
      );
      const hashes = Object.fromEntries(
        preparedReplay.sessions.map((session) => {
          const date = researchSessionDates(
            [replaySessionStart(session)],
            input.marketId,
          )[0]!;
          return [date, hashResearchSession(date, session)];
        }),
      );
      researchEvidence = await this.lineage.resolve({
        kind: "BACKTEST",
        marketId: input.marketId,
        scope: { input, replayInput },
        sessionDates: dates,
        inputCutoff: `${input.endDate}T23:59:59.999Z`,
        sessionPayloadHashes: hashes,
      });
    }
    const run = await this.store.create(
      input,
      configVersion,
      capturedHistoryAvailability,
      replayInput,
      supersedesBacktestRunId,
      researchEvidence,
    );
    await this.store.markRunning(run.id);
    let completed: BacktestRun;
    let strategyEvidence: StrategyBacktestEvidence[];
    try {
      const replay =
        preparedReplay ??
        ((await this.store.loadReplayData(
          input,
          replayInput,
          this.policyFor(input.marketId),
        )) as {
          sessions: HistoricalReplaySession[];
        });
      const metadata = {
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
      const accumulator = new AuthoritativeBacktestAccumulator(
        run.id,
        configVersion,
        input,
        undefined,
        Boolean(researchEvidence),
      );
      if (replay.sessions.length === 0) {
        accumulator.addReplayWarnings(
          await this.engine.runBacktestSignals({ ...metadata, sessions: [] }),
        );
      }
      for (const session of replay.sessions) {
        const admittedSession = admitReplaySession(session);
        const signals = await this.engine.runBacktestSignals({
          ...metadata,
          sessions: [admittedSession],
        });
        accumulator.ingestSession(session, signals);
      }
      const output = accumulator.finish().output;
      completed = await this.store.complete(
        run.id,
        output,
        buildBacktestEvidence(output, new Date(), input.marketId),
      );
      strategyEvidence = buildStrategyBacktestEvidence(
        output,
        new Date(),
        input.strategies,
        input.marketId,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown replay failure";
      await this.store.fail(run.id, message);
      throw new BacktestError(
        "REPLAY_FAILED",
        `Backtest replay failed: ${message}`,
        run.id,
      );
    }
    if (source && this.profileEvidence?.replaceBacktestEvidence)
      await this.profileEvidence.replaceBacktestEvidence(
        source,
        completed,
        strategyEvidence,
      );
    else
      await this.profileEvidence?.linkBacktestEvidence(
        completed,
        strategyEvidence,
      );
    return completed;
  }

  private policyFor(marketId: MarketId): ReplaySessionPolicy {
    if ("timezone" in this.policy) return this.policy;
    const policy = this.policy[marketId];
    if (!policy)
      throw new BacktestError(
        "REPLAY_INPUT_UNAVAILABLE",
        `No replay session policy is configured for ${marketId}`,
      );
    return policy;
  }

  async compare(ids: string[]): Promise<BacktestComparison> {
    const runs = await Promise.all(ids.map((id) => this.getRun(id)));
    const differences = comparisonDifferences(runs);
    return { comparable: differences.length === 0, differences, runs };
  }
}

function assertReplayCoverage(
  source: BacktestRun,
  sessions: readonly HistoricalReplaySession[],
): void {
  if (!source.dataQuality) return;
  const actual = {
    sessions: sessions.length,
    quotes: sessions.reduce((sum, value) => sum + value.quotes.length, 0),
    candles: sessions.reduce((sum, value) => sum + value.candles.length, 0),
  };
  const expected = {
    sessions: source.dataQuality.sessions,
    quotes: source.dataQuality.quoteSnapshots,
    candles: source.dataQuality.candles,
  };
  if (
    actual.sessions < expected.sessions ||
    actual.quotes < expected.quotes ||
    actual.candles < expected.candles
  )
    throw new BacktestError(
      "REPLAY_COVERAGE_INCOMPLETE",
      `Legacy run ${source.id} cannot be reproduced from retained history: expected at least ${expected.sessions} sessions/${expected.quotes} quotes/${expected.candles} candles, found ${actual.sessions}/${actual.quotes}/${actual.candles}.`,
      source.id,
    );
}

export function assertCapturedHistoryAvailable(
  input: Pick<CreateBacktest, "startDate" | "endDate">,
  availability: CapturedHistoryAvailability,
): void {
  const violation = checkCapturedHistoryRange(input, availability);
  if (violation) throw new BacktestError(violation.code, violation.message);
}

export function versionFor(parameters: CreateBacktest["parameters"]): string {
  const ordered = Object.fromEntries(
    Object.entries(parameters).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
  return `phase8-${createHash("sha256").update(JSON.stringify(ordered)).digest("hex").slice(0, 12)}`;
}

function comparisonDifferences(runs: BacktestRun[]): string[] {
  if (runs.length < 2) return [];
  const first = runs[0]!;
  const differences: string[] = [];
  const check = (label: string, value: (run: BacktestRun) => unknown) => {
    const baseline = JSON.stringify(value(first));
    if (runs.slice(1).some((run) => JSON.stringify(value(run)) !== baseline))
      differences.push(label);
  };
  if (
    runs.some((run) => !run.executionModelVersion || !run.executionAssumptions)
  ) {
    differences.push("execution model provenance");
  } else {
    check("execution model", (run) => run.executionModelVersion);
    check("execution assumptions", (run) => run.executionAssumptions);
  }
  check("date range", (run) => [run.startDate, run.endDate]);
  check("universe", (run) =>
    run.replayInput
      ? run.replayInput.inputHash
      : `LEGACY_UNRESOLVED_UNIVERSE:${[...run.symbols].sort().join(",")}`,
  );
  check("data source", (run) => run.dataSource);
  check("starting capital", (run) => run.startingCapital);
  check("position size", (run) => run.positionSize);
  check("slippage", (run) => run.slippageBps);
  check("fees", (run) => run.feePerTrade);
  return differences;
}

function replaySessionStart(value: HistoricalReplaySession): string {
  const start = (value.session as { startTime?: unknown }).startTime;
  if (typeof start !== "string")
    throw new Error("RESEARCH_SESSION_START_UNAVAILABLE");
  return start;
}
