import type { Pool, PoolClient } from "pg";
import { PostgresPendingOrderStore } from "./pending-order-repository.js";
import { PostgresFundedLedgerStore } from "./funded-ledger-repository.js";
import { cancelEntryOrder, type submitEntryOrder } from "./pending-order.js";
import { costSnapshotOf, roundMoney } from "./financials.js";
import type { LedgerEvent } from "./funded-ledger.js";
import { FundedRiskVeto } from "./funded-ledger.js";
import type { QuoteFact } from "./types.js";
import { isDeepStrictEqual } from "node:util";
import {
  fundedPolicy,
  normalizeFundedPolicy,
  type FundedPolicy,
} from "./funded-policy.js";
import { fundedAccountSummary, type FundedLedger } from "./funded-ledger.js";
import { requestQuoteSessionClose } from "./execution-core.js";
import { expireEntryOrder, type PendingEntryOrder } from "./pending-order.js";

export interface FundedCancellationNoOp {
  readonly status: "NO_OP";
  readonly orderId: string;
  readonly reason: "RESERVATION_VETO" | "PRE_SUBMISSION_INVALIDATION";
}

function sameFundedPolicy(
  left: FundedPolicy | null,
  right: FundedPolicy,
): boolean {
  const normalizedLeft = left ? normalizeFundedPolicy(left) : null;
  const normalizedRight = normalizeFundedPolicy(right);
  return !!normalizedLeft && isDeepStrictEqual(normalizedLeft, normalizedRight);
}

function quoteMatchesFundedPolicy(
  policy: FundedPolicy | null,
  participation: number,
  impactBps: number,
): boolean {
  if (!policy) return false;
  const bound = normalizeFundedPolicy(policy);
  // Liquidity is the only quote-time input owned by the funded policy. Keep
  // the bound portfolio object untouched; rebuilding with fundedPolicy() would
  // silently replace custom caps and would manufacture v2 controls for legacy
  // bindings that intentionally have no portfolio policy.
  return (
    Number.isFinite(participation) &&
    participation > 0 &&
    participation <= 1 &&
    Number.isFinite(impactBps) &&
    impactBps >= 0 &&
    impactBps <= 10_000 &&
    bound.participation === participation &&
    bound.impactBps === impactBps
  );
}

/**
 * The final realized exit of a closed order, shared with the decision
 * evidence capture so cooldown/consecutive-stop state is computed by the same
 * rule the reservation transaction used.
 */
export function finalExitOf(
  state: PendingEntryOrder,
): { at: string; stopped: boolean } | undefined {
  const execution = state.execution;
  if (!execution || execution.status !== "CLOSED" || !("position" in execution))
    return undefined;
  const fills = execution.position.exitFills ?? [];
  const final = fills[fills.length - 1];
  return final
    ? { at: final.exitTime, stopped: final.exitReason === "STOP" }
    : undefined;
}

export class FundedOrderService {
  private readonly orders: PostgresPendingOrderStore;
  private readonly ledger: PostgresFundedLedgerStore;

  constructor(
    private readonly pool: Pool,
    private readonly runId: string,
    private readonly accountId: string,
    private readonly currency: "CAD" | "USD",
  ) {
    this.orders = new PostgresPendingOrderStore(pool);
    this.ledger = new PostgresFundedLedgerStore(pool);
  }

  async bind(
    policy: FundedPolicy = fundedPolicy(),
    session?: { session: string; at: string },
  ): Promise<void> {
    const canonicalPolicy = normalizeFundedPolicy(policy);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await client.query<{
        market_id: string;
        status: string;
        session_date: Date | string;
      }>(
        "SELECT market_id,status,session_date FROM paper_bot_run WHERE id=$1 FOR UPDATE",
        [this.runId],
      );
      if (
        !run.rows[0] ||
        { CA_TSX: "CAD", US_EQUITIES: "USD" }[run.rows[0].market_id] !==
          this.currency
      )
        throw new Error("Funded run market/currency mismatch");
      const account = await client.query<{ state: { currency: string } }>(
        "SELECT state FROM paper_funded_account WHERE id=$1 FOR UPDATE",
        [this.accountId],
      );
      if (account.rows[0]?.state.currency !== this.currency)
        throw new Error("Funded account currency mismatch");
      const existing = await client.query(
        "SELECT account_id,currency,policy FROM paper_funded_run WHERE run_id=$1",
        [this.runId],
      );
      if (!existing.rows[0]) {
        const priorRuns = (
          await client.query<{
            run_id: string;
            status: string;
            policy: FundedPolicy | null;
          }>(
            `SELECT b.run_id,r.status,b.policy FROM paper_funded_run b
           JOIN paper_bot_run r ON r.id=b.run_id
           WHERE b.account_id=$1 AND b.run_id<>$2
           ORDER BY b.created_at DESC FOR UPDATE OF b,r`,
            [this.accountId, this.runId],
          )
        ).rows;
        for (const prior of priorRuns) {
          if (prior.status !== "COMPLETED")
            throw new Error("Funded account has an active run");
          const unresolved = await client.query(
            `SELECT 1 FROM paper_entry_order
             WHERE run_id=$1 AND (state->>'status'='PENDING'
               OR state->'execution'->>'status' IN ('OPEN','CLOSE_PENDING'))
             UNION ALL SELECT 1 FROM paper_funded_fact
             WHERE run_id=$1 AND outcome IS NULL
             LIMIT 1`,
            [prior.run_id],
          );
          if (unresolved.rows.length)
            throw new Error("Funded account has unresolved prior orders");
          if (prior.policy && !sameFundedPolicy(prior.policy, canonicalPolicy))
            throw new Error("Funded account policy is immutable");
        }
        const orders = await client.query(
          "SELECT 1 FROM paper_entry_order WHERE run_id=$1 LIMIT 1",
          [this.runId],
        );
        if (orders.rows.length)
          throw new Error("Cannot bind a run with existing unfunded orders");
        await client.query(
          "INSERT INTO paper_funded_run(run_id,account_id,currency,policy) VALUES($1,$2,$3,$4::jsonb)",
          [
            this.runId,
            this.accountId,
            this.currency,
            JSON.stringify(canonicalPolicy),
          ],
        );
        if (session) {
          if (!session.session || !Number.isFinite(Date.parse(session.at)))
            throw new Error("Invalid funded session rollover");
          const state = account.rows[0]!.state as FundedLedger;
          // A prior session may finish selling after today's open. Determine
          // the reset boundary under the account lock, not from a stale read.
          const sessionAt = new Date(
            Math.max(Date.parse(session.at), Date.parse(state.lastEventAt)),
          ).toISOString();
          if (state.session !== session.session) {
            await this.ledger.applyInTransaction(client, this.accountId, [
              {
                id: `session:${this.accountId}:${session.session}`,
                at: sessionAt,
                currency: this.currency,
                type: "SESSION",
                session: session.session,
              },
            ]);
          }
          // The funded clock belongs to the newly bound run as well as to the
          // account ledger. Persisting the rollover boundary prevents a fresh
          // run from replaying retained quotes from before the SESSION event.
          await client.query(
            `UPDATE paper_funded_run
             SET clock_at=GREATEST(COALESCE(clock_at,'-infinity'::timestamptz),$2::timestamptz)
             WHERE run_id=$1`,
            [this.runId, sessionAt],
          );
        }
      } else if (
        existing.rows[0].account_id !== this.accountId ||
        existing.rows[0].currency !== this.currency ||
        !sameFundedPolicy(existing.rows[0].policy, canonicalPolicy)
      ) {
        throw new Error("Funded run binding is immutable");
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async verifyBinding(
    client: PoolClient,
    instrumentId?: string,
  ): Promise<void> {
    const result = await client.query(
      "SELECT 1 FROM paper_funded_run WHERE run_id=$1 AND account_id=$2 AND currency=$3",
      [this.runId, this.accountId, this.currency],
    );
    if (!result.rows.length)
      throw new Error("Funded run is not bound to this account");
    if (instrumentId !== undefined) {
      const instrument = await client.query(
        `SELECT 1 FROM instrument i JOIN paper_bot_run r ON r.market_id=i.market_id
         WHERE r.id=$1 AND i.id=$2 AND i.currency=$3`,
        [this.runId, instrumentId, this.currency],
      );
      if (!instrument.rows.length)
        throw new Error("Instrument does not match funded run market/currency");
    }
  }

  private async assertBinding(instrumentId?: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await this.verifyBinding(client, instrumentId);
    } finally {
      client.release();
    }
  }

  private async verifyTime(
    client: PoolClient,
    at: string,
    entry = false,
    retainedSignal?: import("./funded-session-driver.js").FundedSessionFact,
  ): Promise<void> {
    const result = await client.query<{
      clock_at: Date | null;
      scheduled_close_at: Date;
      status: string;
    }>(
      `SELECT b.clock_at,r.scheduled_close_at,r.status FROM paper_funded_run b
       JOIN paper_bot_run r ON r.id=b.run_id WHERE b.run_id=$1`,
      [this.runId],
    );
    const row = result.rows[0];
    if (
      !row ||
      !Number.isFinite(Date.parse(at)) ||
      (row.clock_at && Date.parse(at) < row.clock_at.getTime())
    )
      throw new Error("Fact precedes funded clock");
    if (entry) {
      if (Date.parse(at) >= row.scheduled_close_at.getTime())
        throw new Error("Funded session is closed for submissions");
      if (row.status !== "RUNNING") {
        // Wall-clock settlement may mark a run CLOSE_PENDING before its inbox
        // reaches a pre-close signal. Recover only the exact claimed envelope,
        // under the existing run lock, without admitting a new submission.
        const recovery =
          row.status === "CLOSE_PENDING" && retainedSignal
            ? await client.query(
                `SELECT 1 FROM paper_funded_run b JOIN paper_funded_fact f
                 ON f.run_id=b.run_id AND f.fact_id=b.inflight_fact_id
               WHERE b.run_id=$1 AND f.outcome IS NULL
                 AND f.fact->>'type'='SIGNAL' AND f.fact=$2::jsonb
                 AND f.fact_at=$3::timestamptz`,
                [this.runId, JSON.stringify(retainedSignal), at],
              )
            : undefined;
        if (!recovery?.rows.length)
          throw new Error("Funded session is closed for submissions");
      }
    }
  }

  private async checkPortfolio(
    client: PoolClient,
    order: PendingEntryOrder,
    instrumentId: string,
    at: string,
    ledgerState: FundedLedger,
    additionalRisk: number,
    overrides: readonly PendingEntryOrder[] = [],
  ): Promise<void> {
    const binding = await client.query<{ policy: FundedPolicy }>(
      "SELECT policy FROM paper_funded_run WHERE run_id=$1 FOR UPDATE",
      [this.runId],
    );
    const portfolio = normalizeFundedPolicy(binding.rows[0]!.policy).portfolio;
    // Legacy policies remain explicit legacy projections, without invented controls.
    if (!portfolio) return;
    const summary = fundedAccountSummary(ledgerState, at, 30_000);
    const storedActive = await client.query<{
      instrumentId: string;
      sector: string | null;
      state: PendingEntryOrder;
    }>(
      `SELECT o.instrument_id AS "instrumentId",i.industry_sector AS sector,o.state FROM paper_entry_order o
         JOIN instrument i ON i.id=o.instrument_id
         WHERE o.run_id=$1 AND (o.state->>'status'='PENDING'
           OR o.state->'execution'->>'status' IN ('OPEN','CLOSE_PENDING'))
         FOR UPDATE`,
      [this.runId],
    );
    const active = {
      rows: storedActive.rows
        .map((row) => ({
          ...row,
          state:
            overrides.find((value) => value.orderId === row.state.orderId) ??
            row.state,
        }))
        .filter(
          (row) =>
            row.state.status === "PENDING" ||
            row.state.execution?.status === "OPEN" ||
            row.state.execution?.status === "CLOSE_PENDING",
        ),
    };
    if (active.rows.length > portfolio.maxOpenPositions)
      throw new FundedRiskVeto(
        order.orderId,
        "Funded portfolio maximum open positions veto",
        "MAX_OPEN_POSITIONS",
      );
    if (
      summary.openRisk + summary.reservedRisk + additionalRisk >
      portfolio.maxTotalOpenRisk
    )
      throw new FundedRiskVeto(
        order.orderId,
        "Funded portfolio maximum open risk veto",
        "MAX_TOTAL_OPEN_RISK",
      );
    const required =
      portfolio.contextRequirement === "MARKET_AND_SECTOR_REQUIRED"
        ? ["MARKET_RELATIVE_STRENGTH", "SECTOR_RELATIVE_STRENGTH"]
        : ["MARKET_RELATIVE_STRENGTH"];
    const readings =
      order.context?.contexts ??
      (order.context?.contextStatus
        ? [
            {
              signalKey: "MARKET_RELATIVE_STRENGTH",
              status: order.context.contextStatus,
              timestamp: order.context.contextTimestamp ?? "",
            },
          ]
        : []);
    for (const key of required) {
      const reading = readings.find((value) => value.signalKey === key);
      const age = Date.parse(at) - Date.parse(reading?.timestamp ?? "");
      if (
        portfolio.requireFreshContext &&
        (!reading ||
          ["UNAVAILABLE", "STALE"].includes(reading.status) ||
          !Number.isFinite(age) ||
          age < 0 ||
          age > portfolio.contextMaxAgeSeconds * 1000)
      )
        throw new FundedRiskVeto(
          order.orderId,
          "Funded portfolio context unavailable or stale veto",
          "CONTEXT_UNAVAILABLE_OR_STALE",
        );
      if (portfolio.vetoOnWeakContext && reading?.status === "WEAK")
        throw new FundedRiskVeto(
          order.orderId,
          "Funded portfolio weak-context veto",
          "WEAK_CONTEXT",
        );
    }
    const orderNotional = (value: PendingEntryOrder): number =>
      value.status === "FILLED" &&
      value.execution &&
      "position" in value.execution
        ? value.execution.position.entryPrice *
          (value.execution.position.remainingShares ??
            value.execution.position.shares)
        : value.assumptions.positionSize;
    if (portfolio.maxSymbolNotional !== undefined) {
      const symbolNotional = active.rows
        .filter((row) => row.instrumentId === instrumentId)
        .reduce((total, row) => total + orderNotional(row.state), 0);
      if (symbolNotional > portfolio.maxSymbolNotional)
        throw new FundedRiskVeto(
          order.orderId,
          "Funded portfolio symbol exposure veto",
          "SYMBOL_EXPOSURE",
        );
    }
    if (portfolio.maxSectorNotional !== undefined) {
      const currentSector = active.rows.find(
        (row) => row.instrumentId === instrumentId,
      )?.sector;
      if (!currentSector)
        throw new FundedRiskVeto(
          order.orderId,
          "Funded portfolio sector exposure unavailable",
          "SECTOR_EXPOSURE",
        );
      const sectorNotional = active.rows
        .filter((row) => row.sector === currentSector)
        .reduce((total, row) => total + orderNotional(row.state), 0);
      if (sectorNotional > portfolio.maxSectorNotional)
        throw new FundedRiskVeto(
          order.orderId,
          "Funded portfolio sector exposure veto",
          "SECTOR_EXPOSURE",
        );
    }
    const history = await client.query<{
      state: PendingEntryOrder;
      instrumentId: string;
    }>(
      `SELECT o.state,o.instrument_id AS "instrumentId" FROM paper_entry_order o
         JOIN paper_funded_run b ON b.run_id=o.run_id
         JOIN paper_bot_run r ON r.id=o.run_id
         WHERE b.account_id=$1 AND o.order_id<>$2 AND r.session_date::text=$3
         FOR UPDATE OF o`,
      [this.accountId, order.orderId, ledgerState.session],
    );
    const closed = history.rows
      .map((row) => {
        const exit = finalExitOf(
          overrides.find((value) => value.orderId === row.state.orderId) ??
            row.state,
        );
        return exit ? { ...exit, instrumentId: row.instrumentId } : undefined;
      })
      .filter(
        (
          value,
        ): value is { at: string; stopped: boolean; instrumentId: string } =>
          !!value,
      )
      .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
    const lastStop = closed.find(
      (value) => value.stopped && value.instrumentId === instrumentId,
    );
    if (
      lastStop &&
      Date.parse(at) <
        Date.parse(lastStop.at) + portfolio.cooldownMinutesAfterStop * 60_000
    )
      throw new FundedRiskVeto(
        order.orderId,
        "Funded portfolio post-stop cooldown veto",
        "POST_STOP_COOLDOWN",
      );
    let consecutiveStops = 0;
    for (const result of closed) {
      if (!result.stopped) break;
      consecutiveStops += 1;
    }
    if (consecutiveStops >= portfolio.maxConsecutiveStops)
      throw new FundedRiskVeto(
        order.orderId,
        "Funded portfolio consecutive-stop limit veto",
        "CONSECUTIVE_STOP_LIMIT",
      );
  }

  async submit(
    instrumentId: string,
    input: Parameters<typeof submitEntryOrder>[0],
    maximumDebit: number,
    maximumRisk: number,
    causeFactId?: string,
  ) {
    await this.assertBinding(instrumentId);
    const costs = costSnapshotOf(input.assumptions);
    if (costs.currency !== this.currency)
      throw new Error("Order costs do not match funded currency");
    const reserve = async (
      client: PoolClient,
      order: ReturnType<typeof submitEntryOrder>,
    ) => {
      await this.verifyBinding(client, instrumentId);
      const account = await client.query<{ state: FundedLedger }>(
        "SELECT state FROM paper_funded_account WHERE id=$1 FOR UPDATE",
        [this.accountId],
      );
      const ledgerState = account.rows[0]?.state;
      if (!ledgerState) throw new Error("Funded account not found");
      const existingOrder = await client.query<{ state: PendingEntryOrder }>(
        "SELECT state FROM paper_entry_order WHERE run_id=$1 AND order_id=$2 FOR UPDATE",
        [this.runId, order.orderId],
      );
      const retryHasEffects =
        !!ledgerState.reservations[order.orderId] ||
        (existingOrder.rows[0] !== undefined &&
          existingOrder.rows[0].state.status !== "PENDING");
      if (!retryHasEffects)
        await this.checkPortfolio(
          client,
          order,
          instrumentId,
          order.submittedAt,
          ledgerState,
          maximumRisk,
        );
      await this.ledger.applyInTransaction(
        client,
        this.accountId,
        [
          {
            id: `reserve:${order.orderId}`,
            at: order.submittedAt,
            currency: this.currency,
            type: "RESERVE",
            orderId: order.orderId,
            debit: maximumDebit,
            risk: maximumRisk,
          },
        ],
        { causeRunId: causeFactId ? this.runId : undefined, causeFactId },
      );
    };
    return this.orders.submit(
      this.runId,
      instrumentId,
      input,
      async (client, order) => {
        await this.verifyTime(client, order.submittedAt, true, {
          type: "SIGNAL",
          instrumentId,
          order: input,
          maximumDebit,
          maximumRisk,
        });
        await reserve(client, order);
      },
      reserve,
      causeFactId,
    );
  }

  async cancel(
    orderId: string,
    at: string,
    reason: Parameters<typeof cancelEntryOrder>[2],
    preSubmissionEventId?: string,
    causeFactId?: string,
  ): Promise<PendingEntryOrder | FundedCancellationNoOp> {
    await this.assertBinding();
    if (preSubmissionEventId) {
      const proven = await this.pool.query(
        `SELECT 1 FROM paper_funded_fact
         WHERE run_id=$1 AND fact_id=$2
           AND fact->>'type'='CANCEL'
           AND fact->>'orderId'=$3
           AND fact->>'preSubmissionEventId'=$4`,
        [
          this.runId,
          `funded-invalidation:${preSubmissionEventId}`,
          orderId,
          preSubmissionEventId,
        ],
      );
      if (!proven.rows.length)
        throw new Error("Pre-submission invalidation provenance is unknown");
      const existing = await this.pool.query(
        "SELECT 1 FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
        [this.runId, orderId],
      );
      if (!existing.rows.length)
        return {
          status: "NO_OP",
          orderId,
          reason: "PRE_SUBMISSION_INVALIDATION",
        };
    } else {
      const existing = await this.pool.query(
        "SELECT 1 FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
        [this.runId, orderId],
      );
      const veto = await this.pool.query(
        `SELECT 1 FROM paper_funded_fact
         WHERE run_id=$1 AND fact->>'type'='SIGNAL'
           AND fact->'order'->>'orderId'=$2
           AND outcome->>'status'='RISK_VETO'
         LIMIT 1`,
        [this.runId, orderId],
      );
      if (!existing.rows.length && veto.rows.length)
        return { status: "NO_OP", orderId, reason: "RESERVATION_VETO" };
      if (!existing.rows.length) {
        // Later invalidations do not repeat the original pre-submission marker.
        // Require the acknowledged, same-run suppression and its original
        // envelope identity before treating an absent order as intentional.
        const suppressed = await this.pool.query(
          `SELECT 1 FROM paper_funded_fact
           WHERE run_id=$1 AND fact->>'type'='CANCEL'
             AND fact->>'orderId'=$2
             AND fact->'preSubmissionEventId' IS NOT NULL
             AND fact_id='funded-invalidation:' || (fact->>'preSubmissionEventId')
             AND outcome->>'status'='PRE_SUBMISSION_SUPPRESSED'
             AND fact_at <= $3::timestamptz
           LIMIT 1`,
          [this.runId, orderId, at],
        );
        if (suppressed.rows.length)
          return {
            status: "NO_OP",
            orderId,
            reason: "PRE_SUBMISSION_INVALIDATION",
          };
      }
    }
    return this.orders.transition(
      this.runId,
      orderId,
      (order) => cancelEntryOrder(order, at, reason),
      async (client) => {
        await this.verifyBinding(client);
        await this.verifyTime(client, at);
        await this.ledger.applyInTransaction(
          client,
          this.accountId,
          [
            {
              id: `release:${orderId}`,
              at,
              currency: this.currency,
              type: "RELEASE",
              orderId,
            },
          ],
          { causeRunId: causeFactId ? this.runId : undefined, causeFactId },
        );
      },
      at,
      causeFactId,
    );
  }

  /** Advance expiry and close intent without inventing a market quote or fill. */
  async advanceClock(at: string, causeFactId?: string): Promise<void> {
    if (!Number.isFinite(Date.parse(at)))
      throw new Error("Invalid funded clock");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await client.query<{
        scheduled_close_at: Date;
        clock_at: Date | null;
      }>(
        `SELECT r.scheduled_close_at,b.clock_at FROM paper_bot_run r
         JOIN paper_funded_run b ON b.run_id=r.id WHERE r.id=$1 FOR UPDATE OF r,b`,
        [this.runId],
      );
      await this.verifyBinding(client);
      const row = run.rows[0];
      if (!row) throw new Error("Funded run not found");
      const account = await client.query<{ state: { lastEventAt: string } }>(
        "SELECT state FROM paper_funded_account WHERE id=$1 FOR UPDATE",
        [this.accountId],
      );
      if (
        Date.parse(at) <
        Math.max(
          row.clock_at?.getTime() ?? 0,
          Date.parse(account.rows[0]!.state.lastEventAt),
        )
      )
        throw new Error("Out-of-order funded clock");
      const orders = await client.query<{ state: PendingEntryOrder }>(
        `SELECT state FROM paper_entry_order WHERE run_id=$1 AND
         (state->>'status'='PENDING' OR state->'execution'->>'status'='OPEN') FOR UPDATE`,
        [this.runId],
      );
      const events: LedgerEvent[] = [];
      for (const { state } of orders.rows) {
        let next = state;
        if (state.status === "PENDING") {
          next =
            Date.parse(at) >= row.scheduled_close_at.getTime()
              ? cancelEntryOrder(state, at, "SESSION_CLOSED")
              : expireEntryOrder(state, at);
          if (next !== state)
            events.push({
              id: `release:${state.orderId}`,
              at,
              currency: this.currency,
              type: "RELEASE",
              orderId: state.orderId,
            });
        } else if (
          state.execution?.status === "OPEN" &&
          Date.parse(at) >= row.scheduled_close_at.getTime()
        ) {
          next = {
            ...state,
            execution: requestQuoteSessionClose(
              state.execution,
              row.scheduled_close_at.toISOString(),
              null,
              state.assumptions,
            ).state,
          };
        }
        if (!isDeepStrictEqual(next, state))
          await client.query(
            `UPDATE paper_entry_order
                SET state=$2::jsonb,last_fact_at=$3::timestamptz,
                    last_fact_id=$4::text,
                    revision=revision+1,updated_at=now()
              WHERE order_id=$1`,
            [state.orderId, JSON.stringify(next), at, causeFactId ?? null],
          );
      }
      await this.ledger.applyInTransaction(client, this.accountId, events, {
        causeRunId: causeFactId ? this.runId : undefined,
        causeFactId,
      });
      await client.query(
        "UPDATE paper_funded_run SET clock_at=$2 WHERE run_id=$1",
        [this.runId, at],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async quote(
    instrumentId: string,
    quote: QuoteFact,
    participation: number,
    impactBps: number,
    causeFactId?: string,
  ): ReturnType<PostgresPendingOrderStore["allocateQuote"]> {
    await this.assertBinding(instrumentId);
    const binding = await this.pool.query<{ policy: FundedPolicy | null }>(
      "SELECT policy FROM paper_funded_run WHERE run_id=$1",
      [this.runId],
    );
    const boundPolicy = binding.rows[0]?.policy ?? null;
    if (
      !boundPolicy ||
      !quoteMatchesFundedPolicy(boundPolicy, participation, impactBps)
    )
      throw new Error("Quote does not match immutable funded policy");
    const canonicalPolicy = normalizeFundedPolicy(boundPolicy);
    try {
      return await this.orders.allocateQuote(
        this.runId,
        instrumentId,
        quote,
        participation,
        impactBps,
        async (client, orders) => {
          await this.verifyBinding(client, instrumentId);
          await this.verifyTime(client, quote.timestamp);
          const events: LedgerEvent[] = [
            {
              id: `mark:${this.runId}:${instrumentId}:${quote.timestamp}`,
              at: quote.timestamp,
              currency: this.currency,
              type: "MARK",
              instrumentId,
              bid: quote.bid,
            },
          ];
          for (const order of orders) {
            if (
              order.status === "FILLED" &&
              order.execution?.status === "OPEN" &&
              Date.parse(order.execution.position.entryTime) ===
                Date.parse(quote.timestamp)
            ) {
              const position = order.execution.position;
              const costs = costSnapshotOf(order.assumptions);
              if (costs.currency !== this.currency)
                throw new Error("Fill currency mismatch");
              events.push({
                id: `buy:${order.orderId}`,
                at: quote.timestamp,
                currency: this.currency,
                type: "BUY",
                orderId: order.orderId,
                positionId: order.orderId,
                instrumentId,
                shares: position.shares,
                price: position.entryPrice,
                stop: position.stop,
                fee: costs.entryCommission,
              });
            } else if (
              order.status === "FILLED" &&
              order.execution &&
              "position" in order.execution
            ) {
              const position = order.execution.position;
              const costs = costSnapshotOf(order.assumptions);
              let sold = 0;
              for (const fill of position.exitFills ?? []) {
                const shares = fill.filledShares ?? position.shares;
                const fee =
                  roundMoney(
                    ((costs.exitCommission + costs.estimatedRegulatoryFees) *
                      (sold + shares)) /
                      position.shares,
                  ) -
                  roundMoney(
                    ((costs.exitCommission + costs.estimatedRegulatoryFees) *
                      sold) /
                      position.shares,
                  );
                sold += shares;
                if (Date.parse(fill.exitTime) === Date.parse(quote.timestamp))
                  events.push({
                    id: `sell:${order.orderId}:${fill.exitTime}`,
                    at: quote.timestamp,
                    currency: this.currency,
                    type: "SELL",
                    positionId: order.orderId,
                    shares,
                    price: fill.financials.exitPrice,
                    fee: roundMoney(fee),
                  });
              }
            } else if (
              order.status === "CANCELLED" ||
              order.status === "REJECTED"
            ) {
              events.push({
                id: `release:${order.orderId}`,
                at: quote.timestamp,
                currency: this.currency,
                type: "RELEASE",
                orderId: order.orderId,
              });
            }
          }
          events.push({
            id: `post-fill-mark:${this.runId}:${instrumentId}:${quote.timestamp}`,
            at: quote.timestamp,
            currency: this.currency,
            type: "MARK",
            instrumentId,
            bid: quote.bid,
          });
          const marks = events.filter((event) => event.type === "MARK");
          const sales = events.filter((event) => event.type === "SELL");
          const other = events.filter(
            (event) => event.type !== "MARK" && event.type !== "SELL",
          );
          const projected = await this.ledger.applyInTransaction(
            client,
            this.accountId,
            [marks[0]!, ...sales, ...other, ...marks.slice(1)],
            { causeRunId: causeFactId ? this.runId : undefined, causeFactId },
          );
          for (const event of other) {
            if (event.type !== "BUY") continue;
            const order = orders.find(
              (value) => value.orderId === event.orderId,
            )!;
            await this.checkPortfolio(
              client,
              order,
              instrumentId,
              quote.timestamp,
              projected,
              0,
              orders,
            );
          }
        },
        canonicalPolicy.portfolio,
        causeFactId,
      );
    } catch (error) {
      if (!(error instanceof FundedRiskVeto)) throw error;
      const cancelled = await this.cancel(
        error.orderId,
        quote.timestamp,
        "RISK_VETO",
        undefined,
        causeFactId,
      );
      if (cancelled.status !== "CANCELLED") throw error;
      return this.quote(
        instrumentId,
        quote,
        participation,
        impactBps,
        causeFactId,
      );
    }
  }
}
