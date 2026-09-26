import {
  createBacktestSchema,
  replayInputSnapshotSchema,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import type { ApiConfig } from "../config.js";
import type {
  PostgresBacktestStore,
  ReplaySessionPolicy,
} from "../backtests/backtest-repository.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../backtests/execution-provenance.js";
import {
  historicalFundedAccountId,
  historicalMarketRisk,
} from "./funded-historical-config.js";
import { planFundedHistoricalRange } from "./funded-historical-range-plan.js";
import { zonedSessionBoundary } from "./session-time.js";

export interface FundedHistoricalPreviewSession {
  readonly sessionDate: string;
  readonly sessionStartAt: string;
  readonly scheduledCloseAt: string;
  readonly existingRunId: string | null;
  readonly existingRunStatus: string | null;
  /** True when --apply would reuse this run instead of provisioning a new one. */
  readonly reusableRun: boolean;
}

export interface FundedHistoricalPreview {
  readonly backtestRunId: string;
  readonly mode: "PREVIEW";
  readonly effectFree: true;
  readonly applied: false;
  readonly writesPerformed: false;
  readonly marketId: MarketId;
  readonly currency: "CAD" | "USD";
  readonly accountId: string;
  readonly accountExists: boolean;
  readonly executionModelVersion: string;
  readonly risk: {
    readonly initialCash: number;
    readonly dailyLossLimit: number;
    readonly timezone: string;
  };
  readonly sessionCount: number;
  readonly multiSession: boolean;
  readonly requiresApply: true;
  readonly plannedSessions: FundedHistoricalPreviewSession[];
  readonly notes: string[];
}

export interface FundedHistoricalPreviewInput {
  readonly backtestRunId: string;
  /** Approved per-job session bound; matches the applied runner's default. */
  readonly maxSessions?: number;
}

export interface FundedHistoricalPreviewDependencies {
  readonly pool: Pool;
  readonly config: ApiConfig;
  readonly store: PostgresBacktestStore;
}

/**
 * Read-only funded historical replay plan. It resolves exactly the same
 * completed baseline, retained sessions, dedicated account identity and risk
 * configuration the applied runner would use, and reports which runs already
 * exist, without writing any funded account, run, binding, observation, order,
 * reservation, ledger or policy row. Replay results still require `--apply`.
 */
export async function planFundedHistoricalSession(
  input: FundedHistoricalPreviewInput,
  deps: FundedHistoricalPreviewDependencies,
): Promise<FundedHistoricalPreview> {
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
  const request = createBacktestSchema.parse({
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
  const currency = run.marketId === "US_EQUITIES" ? "USD" : "CAD";
  const accountId = historicalFundedAccountId(
    run.marketId,
    risk.initialCash,
    risk.dailyLossLimit,
  );
  const accountExists = await deps.pool
    .query<{ present: boolean }>(
      "SELECT true AS present FROM paper_funded_account WHERE id=$1",
      [accountId],
    )
    .then((result) => result.rows.length > 0);
  const existingRuns = dates.length
    ? await deps.pool.query<{
        id: string;
        session_date: string;
        status: string;
      }>(
        `SELECT r.id, r.session_date::text AS session_date, r.status
           FROM paper_bot_run r JOIN paper_funded_run b ON b.run_id=r.id
          WHERE r.source='BACKTEST' AND r.market_id=$1
            AND r.session_date=ANY($2::date[])
            AND r.execution_model_version=$3 AND b.account_id=$4
          ORDER BY r.started_at DESC`,
        [run.marketId, dates, AUTHORITATIVE_EXECUTION_MODEL_VERSION, accountId],
      )
    : {
        rows: [] as Array<{ id: string; session_date: string; status: string }>,
      };
  const runByDate = new Map<string, { id: string; status: string }>();
  for (const row of existingRuns.rows)
    if (!runByDate.has(row.session_date))
      runByDate.set(row.session_date, { id: row.id, status: row.status });
  const plannedSessions: FundedHistoricalPreviewSession[] = dates.map(
    (sessionDate) => {
      const existing = runByDate.get(sessionDate);
      return {
        sessionDate,
        sessionStartAt: zonedSessionBoundary(
          sessionDate,
          deps.config.OPENING_RANGE_START,
          risk.timezone,
        ),
        scheduledCloseAt: zonedSessionBoundary(
          sessionDate,
          deps.config.SCANNING_END,
          risk.timezone,
        ),
        existingRunId: existing?.id ?? null,
        existingRunStatus: existing?.status ?? null,
        reusableRun:
          existing !== undefined &&
          (existing.status === "RUNNING" ||
            existing.status === "CLOSE_PENDING"),
      };
    },
  );
  return {
    backtestRunId: input.backtestRunId,
    mode: "PREVIEW",
    effectFree: true,
    applied: false,
    writesPerformed: false,
    marketId: run.marketId,
    currency,
    accountId,
    accountExists,
    executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
    risk: {
      initialCash: risk.initialCash,
      dailyLossLimit: risk.dailyLossLimit,
      timezone: risk.timezone,
    },
    sessionCount: plannedSessions.length,
    multiSession: plannedSessions.length > 1,
    requiresApply: true,
    plannedSessions,
    notes: [
      "Preview is read-only: no funded account, run, binding, observation, order, reservation, ledger or policy row is written.",
      "Replay results require --apply, which provisions the dedicated replay account/run per session and applies deterministic order/ledger effects.",
      plannedSessions.length > 1
        ? "Multiple sessions are applied in one --apply run; the applied path stops on unresolved exposure."
        : "The applied path stops on unresolved exposure.",
    ],
  };
}
