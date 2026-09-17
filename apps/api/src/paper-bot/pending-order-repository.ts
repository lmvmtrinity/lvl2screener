import type { FundedPortfolioPolicy } from "./funded-policy.js";
import type { Pool, PoolClient } from "pg";
import { isDeepStrictEqual } from "node:util";
import {
  allocateEntryLiquidity,
  openEntryLiquidity,
  type EntryLiquidityState,
} from "./shared-entry-liquidity.js";
import type { QuoteFact } from "./types.js";
import { submitEntryOrder, type PendingEntryOrder } from "./pending-order.js";
import { cancelEntryOrder } from "./pending-order.js";
import { allocateExitLiquidity } from "./shared-exit-liquidity.js";

export class PostgresPendingOrderStore {
  constructor(private readonly pool: Pool) {}

  private async requireFundedEffects(
    client: PoolClient,
    runId: string,
    hasEffects: boolean,
  ): Promise<void> {
    if (hasEffects) return;
    const binding = await client.query(
      "SELECT 1 FROM paper_funded_run WHERE run_id=$1",
      [runId],
    );
    if (binding.rows.length)
      throw new Error("Funded runs require transactional ledger effects");
  }

  async submit(
    runId: string,
    instrumentId: string,
    input: Parameters<typeof submitEntryOrder>[0],
    persistEffects?: (
      client: PoolClient,
      order: PendingEntryOrder,
    ) => Promise<void>,
    validateRetry?: (
      client: PoolClient,
      order: PendingEntryOrder,
    ) => Promise<void>,
    causeFactId?: string,
  ): Promise<PendingEntryOrder> {
    const initial = submitEntryOrder(input);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT id,scheduled_close_at FROM paper_bot_run WHERE id=$1 FOR UPDATE",
        [runId],
      );
      await this.requireFundedEffects(client, runId, !!persistEffects);
      const result = await client.query<{
        state: PendingEntryOrder;
        inserted: boolean;
      }>(
        `INSERT INTO paper_entry_order(order_id,run_id,instrument_id,submission,state,last_fact_at,last_fact_id)
       VALUES($1,$2,$3,$4::jsonb,$4::jsonb,$5::timestamptz,$6)
       ON CONFLICT(order_id) DO UPDATE SET order_id=EXCLUDED.order_id
       WHERE paper_entry_order.run_id=EXCLUDED.run_id
         AND paper_entry_order.instrument_id=EXCLUDED.instrument_id
         AND paper_entry_order.submission=EXCLUDED.submission
       RETURNING state, (xmax=0) AS inserted`,
        [
          initial.orderId,
          runId,
          instrumentId,
          JSON.stringify(initial),
          initial.submittedAt,
          causeFactId ?? null,
        ],
      );
      if (!result.rows[0])
        throw new Error("Order ID reused with different submission");
      if (result.rows[0].inserted) await persistEffects?.(client, initial);
      else await validateRetry?.(client, initial);
      await client.query("COMMIT");
      return result.rows[0].state;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async allocateQuote(
    runId: string,
    instrumentId: string,
    quote: QuoteFact,
    participation: number,
    impactBps: number,
    persistEffects?: (
      client: PoolClient,
      orders: readonly PendingEntryOrder[],
    ) => Promise<void>,
    portfolio?: FundedPortfolioPolicy,
    causeFactId?: string,
  ): Promise<{ liquidity: EntryLiquidityState; orders: PendingEntryOrder[] }> {
    const initial = openEntryLiquidity(
      instrumentId,
      quote,
      participation,
      impactBps,
    );
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const run = await client.query(
        "SELECT id,scheduled_close_at FROM paper_bot_run WHERE id=$1 FOR UPDATE",
        [runId],
      );
      if (!run.rows[0]) throw new Error("Order run not found");
      await this.requireFundedEffects(client, runId, !!persistEffects);
      const prior = await client.query<{
        state: EntryLiquidityState;
        orders: PendingEntryOrder[];
      }>(
        "SELECT state,orders FROM paper_entry_liquidity WHERE run_id=$1 AND instrument_id=$2",
        [runId, instrumentId],
      );
      const previous = prior.rows[0];
      if (
        previous &&
        Date.parse(previous.state.quote.timestamp) >=
          Date.parse(quote.timestamp)
      ) {
        if (
          Date.parse(previous.state.quote.timestamp) >
          Date.parse(quote.timestamp)
        )
          throw new Error("Out-of-order shared quote");
        if (
          !isDeepStrictEqual(previous.state.quote, quote) ||
          previous.state.participation !== participation ||
          previous.state.impactBps !== impactBps
        )
          throw new Error("Conflicting shared quote retry");
        await client.query("COMMIT");
        return { liquidity: previous.state, orders: previous.orders };
      }
      const pending = await client.query<{ state: PendingEntryOrder }>(
        "SELECT state FROM paper_entry_order WHERE run_id=$1 AND instrument_id=$2 AND (state->>'status'='PENDING' OR (state->>'status'='FILLED' AND state->'execution'->>'status' IN ('OPEN','CLOSE_PENDING'))) ORDER BY order_id FOR UPDATE",
        [runId, instrumentId],
      );
      const closeAt = new Date(run.rows[0].scheduled_close_at).toISOString();
      const exits = allocateExitLiquidity(
        pending.rows.map((row) => row.state),
        quote,
        participation,
        impactBps,
        closeAt,
        portfolio,
      );
      const eligible = exits.orders.map((order) =>
        order.status === "PENDING" &&
        Date.parse(quote.timestamp) >= Date.parse(closeAt)
          ? cancelEntryOrder(order, quote.timestamp, "SESSION_CLOSED")
          : order,
      );
      const result = allocateEntryLiquidity(
        { ...initial, consumedBidShares: exits.consumedShares },
        instrumentId,
        eligible,
      );
      const changed = result.orders.filter(
        (order, index) => !isDeepStrictEqual(order, pending.rows[index]?.state),
      );
      await persistEffects?.(client, changed);
      for (const order of changed) {
        await client.query(
          `UPDATE paper_entry_order
              SET state=$2::jsonb,last_fact_at=$3::timestamptz,
                  last_fact_id=$4::text,
                  revision=revision+1,updated_at=now()
            WHERE order_id=$1`,
          [
            order.orderId,
            JSON.stringify(order),
            quote.timestamp,
            causeFactId ?? null,
          ],
        );
      }
      await client.query(
        `INSERT INTO paper_entry_liquidity(run_id,instrument_id,quote_at,state,orders) VALUES($1,$2,$3,$4::jsonb,$5::jsonb)
         ON CONFLICT(run_id,instrument_id) DO UPDATE SET quote_at=EXCLUDED.quote_at,state=EXCLUDED.state,orders=EXCLUDED.orders`,
        [
          runId,
          instrumentId,
          quote.timestamp,
          JSON.stringify(result.liquidity),
          JSON.stringify(result.orders),
        ],
      );
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async pending(runId: string): Promise<PendingEntryOrder[]> {
    const result = await this.pool.query<{ state: PendingEntryOrder }>(
      `SELECT state FROM paper_entry_order WHERE run_id=$1 AND state->>'status'='PENDING'
       ORDER BY (state->>'releaseAt')::timestamptz, created_at, order_id`,
      [runId],
    );
    return result.rows.map((row) => row.state);
  }

  async transition(
    runId: string,
    orderId: string,
    evolve: (state: PendingEntryOrder) => PendingEntryOrder,
    persistEffects?: (
      client: PoolClient,
      state: PendingEntryOrder,
    ) => Promise<void>,
    factAt?: string,
    causeFactId?: string,
  ): Promise<PendingEntryOrder> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM paper_bot_run WHERE id=$1 FOR UPDATE",
        [runId],
      );
      await this.requireFundedEffects(client, runId, !!persistEffects);
      const result = await client.query<{ state: PendingEntryOrder }>(
        "SELECT state FROM paper_entry_order WHERE order_id=$1 AND run_id=$2 FOR UPDATE",
        [orderId, runId],
      );
      const current = result.rows[0]?.state;
      if (!current) throw new Error("Order not found in run");
      if (current.status !== "PENDING") {
        await client.query("COMMIT");
        return current;
      }
      const next = evolve(structuredClone(current));
      const immutable = (state: PendingEntryOrder) => {
        const { status, lastQuoteAt, execution, reason, ...submission } = state;
        void status;
        void lastQuoteAt;
        void execution;
        void reason;
        return JSON.stringify(submission);
      };
      if (immutable(next) !== immutable(current))
        throw new Error("Order submission is immutable");
      if (JSON.stringify(next) !== JSON.stringify(current)) {
        await persistEffects?.(client, next);
        await client.query(
          `UPDATE paper_entry_order
              SET state=$2::jsonb,
                  last_fact_at=COALESCE($3::timestamptz,last_fact_at),
                  last_fact_id=$4::text,
                  revision=revision+1,updated_at=now()
            WHERE order_id=$1`,
          [orderId, JSON.stringify(next), factAt ?? null, causeFactId ?? null],
        );
      }
      await client.query("COMMIT");
      return next;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}
