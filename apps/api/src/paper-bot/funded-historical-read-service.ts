import type {
  FundedHistoricalReplay,
  FundedHistoricalReplayList,
  FundedLiveAccountActivity,
  FundedLiveAccountResponse,
  MarketId,
} from "@tsx-scanner/contracts";
import {
  fundedHistoricalReplayListSchema,
  fundedHistoricalReplaySchema,
  fundedLiveAccountResponseSchema,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { FundedReportingService } from "./funded-reporting-service.js";
import { fundedAccountSummary, type FundedLedger } from "./funded-ledger.js";
import type { PendingEntryOrder } from "./pending-order.js";

export type FundedHistoricalReport = Awaited<
  ReturnType<FundedReportingService["report"]>
>;

/** Bounded read projection: funded account results only, never signal outcomes. */
export function projectFundedHistoricalReplay(
  report: FundedHistoricalReport,
): FundedHistoricalReplay {
  const orderCounts = { pending: 0, filled: 0, cancelled: 0, rejected: 0 };
  const orders = report.orders.map((order) => {
    const execution = order.execution;
    const position =
      execution && "position" in execution ? execution.position : undefined;
    const exit = execution?.status === "CLOSED" ? execution.exit : undefined;
    if (order.status === "PENDING") orderCounts.pending += 1;
    else if (order.status === "FILLED") orderCounts.filled += 1;
    else if (order.status === "CANCELLED") orderCounts.cancelled += 1;
    else orderCounts.rejected += 1;
    return {
      orderId: order.orderId,
      instrumentId: order.instrumentId,
      status: order.status,
      executionStatus: execution?.status ?? null,
      reason: order.reason ?? null,
      shares: position?.shares ?? null,
      entryPrice: position?.entryPrice ?? null,
      exitReason: exit?.exitReason ?? null,
      netPnl: exit?.financials.netPnl ?? null,
      rMultiple: exit?.financials.rMultiple ?? null,
    };
  });
  return fundedHistoricalReplaySchema.parse({
    projection: "FUNDED_PORTFOLIO_REPLAY",
    runId: report.runId,
    accountId: report.accountId,
    marketId: report.cohort.marketId,
    currency: report.cohort.currency,
    sessionDate: report.cohort.sessionDate,
    runStatus: report.runStatus,
    executionModelVersion: report.cohort.executionModelVersion,
    temporalScope: report.temporalScope,
    asOf: report.asOf,
    qualifiedForCapitalAllocation: false,
    qualificationReason: report.qualificationReason,
    isCurrentAccount: report.ordersScope === "ACCOUNT",
    summary: {
      cash: report.summary.cash,
      equity: report.summary.equity,
      realizedPnl: report.summary.realizedPnl,
      dailyPnl: report.summary.dailyPnl,
      reservedCash: report.summary.reservedCash,
      openRisk: report.summary.openRisk,
      remainingDailyRisk: report.summary.remainingDailyRisk,
      staleMarks: report.summary.staleMarks,
      entriesAllowed: report.summary.entriesAllowed,
    },
    orderCounts,
    orders,
    warnings: report.warnings,
  });
}

export class FundedHistoricalReadService {
  private readonly reporting: FundedReportingService;

  constructor(
    private readonly pool: Pool,
    reporting?: FundedReportingService,
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.reporting = reporting ?? new FundedReportingService(pool);
  }

  async list(
    marketId: MarketId,
    limit = 50,
  ): Promise<FundedHistoricalReplayList> {
    const runs = await this.pool.query<{ runId: string }>(
      `SELECT r.id AS "runId"
       FROM paper_bot_run r JOIN paper_funded_run b ON b.run_id=r.id
       WHERE r.source='BACKTEST' AND r.market_id=$1
       ORDER BY r.session_date DESC,r.started_at DESC,r.id
       LIMIT $2`,
      [marketId, limit],
    );
    const values: FundedHistoricalReplay[] = [];
    for (const row of runs.rows) values.push(await this.get(row.runId));
    return fundedHistoricalReplayListSchema.parse({ marketId, runs: values });
  }

  async get(runId: string): Promise<FundedHistoricalReplay> {
    return projectFundedHistoricalReplay(await this.reporting.report(runId));
  }

  /**
   * The latest live funded run's account state for one market. The summary is
   * the account's current ledger valuation and the activity counts belong to
   * that run alone; a market with no bound live run is explicitly unavailable
   * rather than inferred from another market's account.
   */
  async liveAccount(marketId: MarketId): Promise<FundedLiveAccountResponse> {
    const currency = marketId === "CA_TSX" ? "CAD" : "USD";
    const binding = await this.pool.query<{
      runId: string;
      accountId: string;
      currency: "CAD" | "USD";
      status: "RUNNING" | "CLOSE_PENDING" | "COMPLETED" | "FAILED";
      sessionDate: string;
      unknownPolicy: boolean;
    }>(
      `SELECT b.run_id AS "runId",b.account_id AS "accountId",b.currency,
         r.status,r.session_date::text AS "sessionDate",
         (b.policy IS NULL) AS "unknownPolicy"
       FROM paper_funded_run b
       JOIN paper_bot_run r ON r.id=b.run_id
       WHERE r.source='LIVE' AND r.market_id=$1
       ORDER BY r.session_date DESC,r.started_at DESC,r.id
       LIMIT 1`,
      [marketId],
    );
    const row = binding.rows[0];
    if (!row)
      return fundedLiveAccountResponseSchema.parse({
        status: "UNAVAILABLE",
        marketId,
        currency,
        reason: "NO_LIVE_FUNDED_RUN",
      });
    const [account, orders] = await Promise.all([
      this.pool.query<{ state: FundedLedger }>(
        "SELECT state FROM paper_funded_account WHERE id=$1",
        [row.accountId],
      ),
      this.pool.query<{ state: PendingEntryOrder }>(
        `SELECT state FROM paper_entry_order WHERE run_id=$1
         ORDER BY created_at,order_id`,
        [row.runId],
      ),
    ]);
    const state = account.rows[0]?.state;
    if (!state) throw new Error("Funded live account state is unavailable");
    if (state.currency !== row.currency)
      throw new Error("Funded live account currency mismatch");
    const asOf = this.clock().toISOString();
    const summary = fundedAccountSummary(state, asOf, LIVE_FUNDED_MARK_AGE_MS);
    return fundedLiveAccountResponseSchema.parse({
      status: "READY",
      account: {
        projection: "FUNDED_PAPER_ACCOUNT",
        marketId,
        currency: row.currency,
        accountId: row.accountId,
        runId: row.runId,
        runStatus: row.status,
        sessionDate: row.sessionDate,
        asOf,
        temporalScope: "CURRENT_ACCOUNT",
        qualifiedForCapitalAllocation: false,
        qualificationReason: FUNDED_QUALIFICATION_REASON,
        summary,
        activity: summarizeFundedOrders(orders.rows.map(({ state: o }) => o)),
        warnings: [
          ...(row.unknownPolicy ? ["UNKNOWN_FUNDED_POLICY"] : []),
          ...(summary.staleMarks ? ["STALE_POSITION_MARKS"] : []),
          ...(!summary.entriesAllowed ? ["FUNDED_ENTRIES_BLOCKED"] : []),
          ...(orders.rows.some(
            ({ state: order }) => order.execution?.status === "CLOSE_PENDING",
          )
            ? ["UNRESOLVED_CLOSE_QUANTITY"]
            : []),
          "SIMULATED_LIQUIDITY_NOT_GUARANTEED",
        ],
      },
    });
  }
}

const LIVE_FUNDED_MARK_AGE_MS = 30_000;
const FUNDED_QUALIFICATION_REASON =
  "Out-of-sample and walk-forward qualification is not established by execution reporting";

/** Counts only the selected run's orders; open and closed are execution states. */
function summarizeFundedOrders(
  orders: PendingEntryOrder[],
): FundedLiveAccountActivity {
  let closed = 0;
  let open = 0;
  let pending = 0;
  let rejected = 0;
  let cancelled = 0;
  let wins = 0;
  let cumulativeR = 0;
  let hasRMultiple = false;
  for (const order of orders) {
    if (order.status === "PENDING") pending += 1;
    else if (order.status === "REJECTED") rejected += 1;
    else if (order.status === "CANCELLED") cancelled += 1;
    const execution = order.execution;
    if (execution?.status === "CLOSED") {
      closed += 1;
      if (execution.exit.financials.netPnl > 0) wins += 1;
      const rMultiple = execution.exit.financials.rMultiple;
      if (rMultiple !== null) {
        cumulativeR += rMultiple;
        hasRMultiple = true;
      }
    } else if (
      execution?.status === "OPEN" ||
      execution?.status === "CLOSE_PENDING"
    )
      open += 1;
  }
  return {
    decisions: orders.length,
    closed,
    open,
    pending,
    rejected,
    cancelled,
    wins,
    cumulativeR: hasRMultiple ? Number(cumulativeR.toFixed(2)) : null,
  };
}
