import {
  createBacktestSchema,
  replayInputSnapshotSchema,
  type CreateBacktest,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import type { ApiConfig } from "../config.js";
import type {
  PostgresBacktestStore,
  ReplaySessionPolicy,
} from "../backtests/backtest-repository.js";
import type { ScannerFeatureClient } from "../market-data/scanner-client.js";
import { fundedAccountSummary } from "./funded-ledger.js";
import { PostgresFundedLedgerStore } from "./funded-ledger-repository.js";
import {
  historicalFundedAssumptions,
  historicalFundedPolicy,
  historicalMarketRisk,
} from "./funded-historical-config.js";
import { provisionHistoricalFundedRun } from "./funded-historical-provisioning.js";
import { planFundedHistoricalRange } from "./funded-historical-range-plan.js";
import { projectFundedHistoricalReplay } from "./funded-historical-read-service.js";
import { bridgeFundedHistoricalSession } from "./funded-historical-signal-bridge.js";
import type { FundedReportingService } from "./funded-reporting-service.js";
import { replayFundedHistoricalSession } from "./funded-replay-service.js";
import { PostgresPaperBotStore } from "./paper-bot-repository.js";
import { zonedSessionBoundary } from "./session-time.js";

export interface FundedHistoricalRangeInput {
  readonly backtestRunId: string;
  /** Dedicated replay account; never a live funded account. */
  readonly accountId: string;
  readonly apply: boolean;
  /** Approved per-job session bound (A3 policies always set this). */
  readonly maxSessions?: number;
}

export interface FundedHistoricalRunnerDependencies {
  readonly pool: Pool;
  readonly config: ApiConfig;
  readonly engine: ScannerFeatureClient;
  readonly store: PostgresBacktestStore;
  readonly reporting: FundedReportingService;
  /** Called before each session so a job can observe cancellation safely. */
  readonly betweenSessions?: () => Promise<void>;
}

export interface FundedHistoricalSessionResult {
  readonly sessionDate: string;
  readonly sessionStartAt: string;
  readonly scheduledCloseAt: string;
  readonly fundedRunId: string;
  readonly reusedRun: boolean;
  readonly bridge: Awaited<ReturnType<typeof bridgeFundedHistoricalSession>>;
  readonly replay: Awaited<ReturnType<typeof replayFundedHistoricalSession>>;
  readonly runStatus?: string;
  readonly projection?: ReturnType<typeof projectFundedHistoricalReplay>;
}

export interface FundedHistoricalRangeResult {
  readonly backtestRunId: string;
  readonly marketId: "CA_TSX" | "US_EQUITIES";
  readonly accountId: string;
  readonly currency: "CAD" | "USD";
  readonly applied: boolean;
  readonly sessionCount: number;
  readonly sessions: FundedHistoricalSessionResult[];
  readonly accountSummary?: ReturnType<typeof fundedAccountSummary>;
}

/**
 * One reusable funded historical replay range: load the completed baseline,
 * plan its retained sessions, provision a dedicated run per session and apply
 * the deterministic funded order/ledger machinery. Shared by the operator CLI
 * and the A3 policy-gated job handler so both follow the exact same execution
 * path. Applying a range stops on unresolved exposure; re-running is idempotent
 * per provisioned run.
 */
export async function runFundedHistoricalRange(
  input: FundedHistoricalRangeInput,
  deps: FundedHistoricalRunnerDependencies,
): Promise<FundedHistoricalRangeResult> {
  const run = await deps.store.get(input.backtestRunId);
  if (!run || run.status !== "COMPLETED")
    throw new Error(
      "Funded historical replay requires a COMPLETED backtest run",
    );
  if (!run.replayInput)
    throw new Error("Backtest run has no immutable replay input");
  const replayInput = replayInputSnapshotSchema.parse(run.replayInput);
  if (replayInput.marketId !== run.marketId)
    throw new Error("Backtest run and replay input markets do not match");
  const request: CreateBacktest = createBacktestSchema.parse({
    name: run.name,
    marketId: run.marketId,
    startDate: run.startDate,
    endDate: run.endDate,
    strategies: run.strategies,
    symbols: run.symbols,
    startingCapital: run.startingCapital,
    positionSize: run.positionSize,
    slippageBps: run.slippageBps,
    feePerTrade: run.feePerTrade,
    parameters: run.parameters,
  });
  const risk = historicalMarketRisk(deps.config, run.marketId);
  const policy: ReplaySessionPolicy = {
    marketId: run.marketId,
    timezone: risk.timezone,
    openingRange: {
      start: deps.config.OPENING_RANGE_START,
      end: deps.config.OPENING_RANGE_END,
    },
    scanning: {
      start: deps.config.SCANNING_START,
      end: deps.config.SCANNING_END,
    },
    entries: {
      preferredStart: deps.config.ENTRY_PREFERRED_START,
      preferredEnd: deps.config.ENTRY_PREFERRED_END,
      hardEnd: deps.config.ENTRY_HARD_END,
    },
    benchmarkMaxStalenessSeconds: deps.config.BENCHMARK_MAX_STALENESS_SECONDS,
  };
  const dates = planFundedHistoricalRange(
    await deps.store.loadReplaySessionDates(request, replayInput, policy),
    input.maxSessions ?? 20,
  );
  if (dates.length > 1 && !input.apply)
    throw new Error(
      "Multi-session funded historical replay requires apply; a preview would leave an active funded run that blocks the next session.",
    );
  const currency = run.marketId === "US_EQUITIES" ? "USD" : "CAD";
  const sessions: FundedHistoricalSessionResult[] = [];
  for (const sessionDate of dates) {
    await deps.betweenSessions?.();
    const sessionStartAt = zonedSessionBoundary(
      sessionDate,
      deps.config.OPENING_RANGE_START,
      risk.timezone,
    );
    const scheduledCloseAt = zonedSessionBoundary(
      sessionDate,
      deps.config.SCANNING_END,
      risk.timezone,
    );
    const provisioned = await provisionHistoricalFundedRun(deps.pool, {
      marketId: run.marketId,
      sessionDate,
      sessionTimezone: risk.timezone,
      scheduledCloseAt,
      sessionStartAt,
      assumptions: historicalFundedAssumptions(deps.config, run.marketId),
      policy: historicalFundedPolicy(deps.config, run.marketId),
      accountId: input.accountId,
      currency,
      initialCash: risk.initialCash,
      dailyLossLimit: risk.dailyLossLimit,
    });
    const bridge = await bridgeFundedHistoricalSession({
      pool: deps.pool,
      runId: provisioned.runId,
      marketId: run.marketId,
      session: await deps.store.loadReplaySession(
        replayInput,
        policy,
        sessionDate,
      ),
      request,
      engine: deps.engine,
    });
    const replay = await replayFundedHistoricalSession(
      deps.pool,
      provisioned.runId,
      input.apply,
    );
    let runStatus: string | undefined;
    let projection:
      ReturnType<typeof projectFundedHistoricalReplay> | undefined;
    if (input.apply) {
      await new PostgresPaperBotStore(deps.pool).completeRun(provisioned.runId);
      runStatus = (
        await deps.pool.query<{ status: string }>(
          "SELECT status FROM paper_bot_run WHERE id=$1",
          [provisioned.runId],
        )
      ).rows[0]?.status;
      const report = await deps.reporting.report(provisioned.runId);
      if (
        Object.keys(report.positions).length > 0 ||
        Object.keys(report.reservations).length > 0
      )
        throw new Error("FUNDED_HISTORICAL_UNRESOLVED_EXPOSURE");
      projection = projectFundedHistoricalReplay(report);
    }
    sessions.push({
      sessionDate,
      sessionStartAt,
      scheduledCloseAt,
      fundedRunId: provisioned.runId,
      reusedRun: provisioned.reused,
      bridge,
      replay,
      runStatus,
      projection,
    });
  }
  const last = sessions[sessions.length - 1];
  const accountSummary =
    input.apply && last
      ? fundedAccountSummary(
          await new PostgresFundedLedgerStore(deps.pool).read(input.accountId),
          last.scheduledCloseAt,
          30_000,
        )
      : undefined;
  return {
    backtestRunId: input.backtestRunId,
    marketId: run.marketId,
    accountId: input.accountId,
    currency,
    applied: input.apply,
    sessionCount: sessions.length,
    sessions,
    accountSummary,
  };
}
