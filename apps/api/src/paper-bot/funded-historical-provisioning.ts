import type { MarketId } from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../backtests/execution-provenance.js";
import { PostgresFundedLedgerStore } from "./funded-ledger-repository.js";
import { FundedOrderService } from "./funded-order-service.js";
import type { FundedPolicy } from "./funded-policy.js";
import {
  PostgresPaperBotStore,
  type PaperBotRun,
} from "./paper-bot-repository.js";
import type { AssumptionsSnapshot } from "./types.js";

export interface ProvisionHistoricalFundedRunInput {
  readonly marketId: MarketId;
  readonly sessionDate: string;
  readonly sessionTimezone: string;
  readonly scheduledCloseAt: string;
  readonly sessionStartAt: string;
  readonly assumptions: AssumptionsSnapshot;
  readonly policy: FundedPolicy;
  readonly accountId: string;
  readonly currency: "CAD" | "USD";
  readonly initialCash: number;
  readonly dailyLossLimit: number;
  readonly executionModelVersion?: string;
}

export interface ProvisionedHistoricalFundedRun {
  readonly runId: string;
  readonly accountId: string;
  readonly reused: boolean;
}

/**
 * Injectable seams keep provisioning testable without a database. Production
 * callers pass only the pool; the defaults use the same funded components as
 * the live path.
 */
export interface ProvisioningDependencies {
  findActiveRun?(
    input: ProvisionHistoricalFundedRunInput,
    executionModelVersion: string,
  ): Promise<ProvisionedHistoricalFundedRun | undefined>;
  startRun?(input: ProvisionHistoricalFundedRunInput): Promise<PaperBotRun>;
  ensureLedger?(
    accountId: string,
    input: ProvisionHistoricalFundedRunInput,
  ): Promise<unknown>;
  bind?(runId: string, input: ProvisionHistoricalFundedRunInput): Promise<void>;
  failRun?(runId: string, reason: string): Promise<void>;
}

function findActiveHistoricalRun(
  pool: Pool,
  input: ProvisionHistoricalFundedRunInput,
  executionModelVersion: string,
): Promise<ProvisionedHistoricalFundedRun | undefined> {
  return pool
    .query<{ runId: string; accountId: string }>(
      `SELECT r.id AS "runId",b.account_id AS "accountId"
       FROM paper_bot_run r JOIN paper_funded_run b ON b.run_id=r.id
       WHERE r.source='BACKTEST' AND r.market_id=$1 AND r.session_date=$2::date
         AND r.execution_model_version=$3 AND b.account_id=$4
         AND r.status IN ('RUNNING','CLOSE_PENDING')
       ORDER BY r.started_at DESC LIMIT 1`,
      [
        input.marketId,
        input.sessionDate,
        executionModelVersion,
        input.accountId,
      ],
    )
    .then((result) =>
      result.rows[0]
        ? {
            runId: result.rows[0].runId,
            accountId: result.rows[0].accountId,
            reused: true,
          }
        : undefined,
    );
}

/**
 * Provisions one historical funded session: an immutable replay account, a
 * BACKTEST `paper_bot_run` that stays RUNNING for the funded clock, and the
 * funded binding. Re-provisioning the same session/account reuses the active
 * run instead of creating a second concurrent one.
 */
export async function provisionHistoricalFundedRun(
  pool: Pool,
  input: ProvisionHistoricalFundedRunInput,
  dependencies: ProvisioningDependencies = {},
): Promise<ProvisionedHistoricalFundedRun> {
  const executionModelVersion =
    input.executionModelVersion ?? AUTHORITATIVE_EXECUTION_MODEL_VERSION;
  const existing = await (
    dependencies.findActiveRun ??
    ((value, version) => findActiveHistoricalRun(pool, value, version))
  )(input, executionModelVersion);
  if (existing) return existing;
  await (
    dependencies.ensureLedger ??
    ((accountId, value) =>
      new PostgresFundedLedgerStore(pool).ensure(accountId, [
        value.currency,
        value.initialCash,
        value.sessionDate,
        value.sessionStartAt,
        value.dailyLossLimit,
      ]))
  )(input.accountId, input);
  const run = await (
    dependencies.startRun ??
    ((value) =>
      new PostgresPaperBotStore(pool).startBacktestRun({
        source: "BACKTEST",
        marketId: value.marketId,
        sessionDate: value.sessionDate,
        sessionTimezone: value.sessionTimezone,
        scheduledCloseAt: value.scheduledCloseAt,
        executionModelVersion,
        assumptions: value.assumptions,
      }))
  )(input);
  try {
    await (
      dependencies.bind ??
      ((runId, value) =>
        new FundedOrderService(
          pool,
          runId,
          value.accountId,
          value.currency,
        ).bind(value.policy, {
          session: value.sessionDate,
          at: value.sessionStartAt,
        }))
    )(run.id, input);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await (
      dependencies.failRun ??
      ((runId, message) =>
        pool.query(
          "UPDATE paper_bot_run SET status='FAILED',failed_at=now(),failure_reason=$2 WHERE id=$1",
          [runId, message],
        ))
    )(run.id, reason).catch(() => undefined);
    throw error;
  }
  return { runId: run.id, accountId: input.accountId, reused: false };
}
