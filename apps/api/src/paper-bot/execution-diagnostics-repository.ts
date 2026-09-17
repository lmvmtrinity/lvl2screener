import type { Pool, PoolClient } from "pg";
import { fundedFactSchema } from "./funded-fact-schema.js";
import type {
  DiagnosticAllocationInput,
  DiagnosticFill,
  DiagnosticQuote,
  ExecutionDiagnosticEvidence,
  ExecutionDiagnosticScope,
} from "./execution-diagnostics-types.js";
import { contentHash } from "../backtests/research-coverage.js";
import { resolvePreAllocationState } from "./diagnostic-order-history.js";

export type ExecutionDiagnosticsRequest =
  | { mode: "RUN_END"; marketId?: "CA_TSX" | "US_EQUITIES" }
  | { mode: "AS_OF"; at: string; marketId?: "CA_TSX" | "US_EQUITIES" }
  | { mode: "CURRENT_ACCOUNT"; marketId?: "CA_TSX" | "US_EQUITIES" };

export type ExecutionDiagnosticTarget = {
  runId: string;
  accountId: string;
  currency: "CAD" | "USD";
  marketId: "CA_TSX" | "US_EQUITIES";
  temporalScope: ExecutionDiagnosticScope["temporalScope"];
  asOf: string | null;
  runIds: string[];
};

type RunRow = {
  accountId: string;
  currency: "CAD" | "USD";
  accountCurrency: "CAD" | "USD";
  marketId: "CA_TSX" | "US_EQUITIES";
  status: string;
  assumptions: Record<string, unknown>;
  boundaryAt: Date | string | null;
};

type QuoteRow = {
  run_id: string;
  fact_id: string;
  fact: unknown;
  outcome: unknown;
  fact_at: Date | string;
};

type EventRow = {
  event_id: string;
  event: unknown;
  event_sequence: string | number;
  event_sequence_verified: boolean;
};

type OrderRow = {
  order_id: string;
  run_id: string;
  instrument_id: string;
  submission: unknown;
  state: unknown;
};

type HistoryRow = {
  order_id: string;
  revision: string | number;
  fact_at: Date | string;
  state: unknown;
};

function iso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function parsedTime(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time))
    throw new Error("Invalid execution diagnostics time");
  return time;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function scopedRunIds(value: string[]): string[] {
  return [...new Set(value)].sort();
}

function eventOrderId(event: Record<string, unknown>): string | null {
  return stringValue(event.type === "BUY" ? event.orderId : event.positionId);
}

function eventSide(event: Record<string, unknown>): "BID" | "ASK" | null {
  if (event.type === "BUY") return "ASK";
  if (event.type === "SELL") return "BID";
  return null;
}

function eventShares(event: Record<string, unknown>): number | null {
  const shares = numberValue(event.shares);
  return shares !== null && Number.isSafeInteger(shares) && shares >= 0
    ? shares
    : null;
}

export function executionDiagnosticSourceDigest(
  evidence: ExecutionDiagnosticEvidence,
): string {
  return contentHash({
    scope: evidence.scope,
    quotes: evidence.quotes,
    fills: evidence.fills,
    allocations: evidence.allocations,
    unavailable: evidence.unavailable,
  });
}

export class ExecutionDiagnosticsRepository {
  constructor(private readonly pool: Pool) {}

  /** Resolves the requested time boundary without reading the evidence payload. This is used by
   * the HTTP status surface so a missing RUN_END snapshot can be reported as UNAVAILABLE without
   * doing a heavy reconstruction or mutating the read-only path. */
  async describe(
    runId: string,
    request: ExecutionDiagnosticsRequest,
  ): Promise<ExecutionDiagnosticTarget> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const run = await this.resolveRun(client, runId);
      if (request.marketId && request.marketId !== run.marketId)
        throw new Error("EXECUTION_DIAGNOSTIC_MARKET_MISMATCH");
      if (request.mode === "RUN_END" && !run.boundaryAt) {
        await client.query("COMMIT");
        return {
          runId,
          accountId: run.accountId,
          currency: run.currency,
          marketId: run.marketId,
          temporalScope: "RUN_END",
          asOf: null,
          runIds: [runId],
        };
      }
      const temporal = await this.resolveTemporalScope(
        client,
        runId,
        run,
        request,
      );
      await client.query("COMMIT");
      return {
        runId,
        accountId: run.accountId,
        currency: run.currency,
        marketId: run.marketId,
        temporalScope: temporal.mode,
        asOf: temporal.asOf,
        runIds: temporal.runIds,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async load(
    runId: string,
    request: ExecutionDiagnosticsRequest,
  ): Promise<ExecutionDiagnosticEvidence> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const run = await this.resolveRun(client, runId);
      if (request.marketId && request.marketId !== run.marketId)
        throw new Error("EXECUTION_DIAGNOSTIC_MARKET_MISMATCH");
      const temporal = await this.resolveTemporalScope(
        client,
        runId,
        run,
        request,
      );
      const marketScope =
        run.marketId === "CA_TSX"
          ? ({ marketId: "CA_TSX", currency: "CAD" } as const)
          : ({ marketId: "US_EQUITIES", currency: "USD" } as const);
      const scope: ExecutionDiagnosticScope = {
        ...marketScope,
        accountId: run.accountId,
        selectedRunId: runId,
        runIds: temporal.runIds,
        temporalScope: temporal.mode,
        asOf: temporal.asOf,
      };
      const unavailable = new Set<
        ExecutionDiagnosticEvidence["unavailable"][number]
      >();
      const quotes = await this.loadQuotes(
        client,
        scope,
        run.assumptions,
        unavailable,
      );
      const orders = await this.loadOrders(client, scope);
      const knownOrderIds = await this.loadKnownOrderIds(client, scope);
      const history = await this.loadOrderHistory(client, orders);
      // Accounts roll through sessions and accumulate hundreds of thousands
      // of MARK rows; only entry fills back these diagnostics. Verification of
      // the whole durable stream is a bounded EXISTS, not a materialized scan.
      if (await this.hasUnverifiedEvents(client, run.accountId, temporal.asOf))
        unavailable.add("UNVERIFIED_EVENT_SEQUENCE");
      const events = await this.loadEvents(
        client,
        run.accountId,
        temporal.asOf,
      );
      const fills = this.toFills(
        events,
        orders,
        knownOrderIds,
        quotes,
        unavailable,
      );
      const allocations = this.toAllocations(
        orders,
        history,
        quotes,
        fills,
        unavailable,
        temporal.asOf,
      );
      const evidence = {
        scope,
        quotes,
        fills,
        allocations,
        unavailable: [...unavailable].sort(),
      } satisfies ExecutionDiagnosticEvidence;
      await client.query("COMMIT");
      return evidence;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async resolveRun(client: PoolClient, runId: string): Promise<RunRow> {
    const result = await client.query<RunRow>(
      `SELECT b.account_id AS "accountId",b.currency,
              a.state->>'currency' AS "accountCurrency",
              r.market_id AS "marketId",
              r.status,r.assumptions,s.boundary_at AS "boundaryAt"
         FROM paper_funded_run b
         JOIN paper_funded_account a ON a.id=b.account_id
         JOIN paper_bot_run r ON r.id=b.run_id
         LEFT JOIN paper_funded_run_snapshot s ON s.run_id=b.run_id
        WHERE b.run_id=$1`,
      [runId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("Run has no funded account binding");
    const expectedCurrency = row.marketId === "CA_TSX" ? "CAD" : "USD";
    if (
      row.currency !== expectedCurrency ||
      row.accountCurrency !== row.currency
    )
      throw new Error("EXECUTION_DIAGNOSTIC_MARKET_CURRENCY_MISMATCH");
    return row;
  }

  private async resolveTemporalScope(
    client: PoolClient,
    runId: string,
    run: RunRow,
    request: ExecutionDiagnosticsRequest,
  ): Promise<{
    mode: ExecutionDiagnosticScope["temporalScope"];
    asOf: string;
    runIds: string[];
  }> {
    if (request.mode === "CURRENT_ACCOUNT") {
      const now = await client.query<{ asOf: Date }>(
        'SELECT transaction_timestamp() AS "asOf"',
      );
      const runs = await client.query<{ runId: string }>(
        `SELECT b.run_id AS "runId"
           FROM paper_funded_run b
           JOIN paper_bot_run r ON r.id=b.run_id
          WHERE b.account_id=$1 AND b.currency=$2 AND r.market_id=$3
          ORDER BY b.run_id`,
        [run.accountId, run.currency, run.marketId],
      );
      return {
        mode: "CURRENT_ACCOUNT",
        asOf: now.rows[0]!.asOf.toISOString(),
        runIds: scopedRunIds(runs.rows.map((value) => value.runId)),
      };
    }
    const boundary = run.boundaryAt ? iso(run.boundaryAt) : null;
    if (request.mode === "RUN_END") {
      if (!boundary) throw new Error("Funded run-end snapshot is unavailable");
      return { mode: "RUN_END", asOf: boundary, runIds: [runId] };
    }
    const parsed = Date.parse(request.at);
    if (!Number.isFinite(parsed))
      throw new Error("Invalid execution diagnostics as-of time");
    const asOf = new Date(parsed).toISOString();
    if (boundary && parsedTime(asOf) > parsedTime(boundary))
      throw new Error(
        "Historical funded report time is after the completed run boundary",
      );
    return { mode: "AS_OF", asOf, runIds: [runId] };
  }

  private async loadQuotes(
    client: PoolClient,
    scope: ExecutionDiagnosticScope,
    assumptions: Record<string, unknown>,
    unavailable: Set<ExecutionDiagnosticEvidence["unavailable"][number]>,
  ): Promise<DiagnosticQuote[]> {
    const result = await client.query<QuoteRow>(
      `SELECT f.run_id,f.fact_id,f.fact,f.outcome,f.fact_at
         FROM paper_funded_fact f
         JOIN paper_funded_run b ON b.run_id=f.run_id
         JOIN paper_bot_run r ON r.id=f.run_id
        WHERE b.account_id=$1 AND f.run_id=ANY($2::uuid[])
          AND r.market_id=$3 AND b.currency=$4
          AND f.fact_at <= $5::timestamptz
          AND f.outcome IS NOT NULL
          AND f.fact->>'type'='QUOTE'
        ORDER BY f.fact_at,f.priority,f.sort_key COLLATE "C",f.fact_id COLLATE "C"`,
      [
        scope.accountId,
        scope.runIds,
        scope.marketId,
        scope.currency,
        scope.asOf,
      ],
    );
    const maxQuoteAgeSeconds = numberValue(assumptions.maxQuoteAgeSeconds);
    if (maxQuoteAgeSeconds === null)
      unavailable.add("MISSING_HISTORICAL_BUDGET");
    const quotes: DiagnosticQuote[] = [];
    for (const row of result.rows) {
      const parsed = fundedFactSchema.safeParse(row.fact);
      if (!parsed.success || parsed.data.type !== "QUOTE") continue;
      quotes.push({
        runId: row.run_id,
        instrumentId: parsed.data.instrumentId,
        evidenceId: row.fact_id,
        quote: parsed.data.quote,
        decisionAt: parsed.data.quote.timestamp,
        maxQuoteAgeSeconds,
        participation: parsed.data.participation,
        source: "FUNDED_FACT",
      });
    }
    if (quotes.length === 0) unavailable.add("MISSING_QUOTE_HISTORY");
    return quotes;
  }

  private async loadOrders(
    client: PoolClient,
    scope: ExecutionDiagnosticScope,
  ): Promise<OrderRow[]> {
    const result = await client.query<OrderRow>(
      `SELECT o.order_id,o.run_id,o.instrument_id,o.submission,o.state
         FROM paper_entry_order o
        WHERE o.run_id=ANY($1::uuid[])
        ORDER BY o.run_id,o.order_id`,
      [scope.runIds],
    );
    return result.rows;
  }

  private async loadOrderHistory(
    client: PoolClient,
    orders: readonly OrderRow[],
  ): Promise<HistoryRow[]> {
    if (orders.length === 0) return [];
    const result = await client.query<HistoryRow>(
      `SELECT h.order_id,h.revision,h.fact_at,h.state
         FROM paper_entry_order_history h
        WHERE h.order_id=ANY($1::text[])
        ORDER BY h.order_id,h.revision`,
      [orders.map((order) => order.order_id)],
    );
    return result.rows;
  }

  private async loadKnownOrderIds(
    client: PoolClient,
    scope: ExecutionDiagnosticScope,
  ): Promise<Set<string>> {
    const result = await client.query<{ order_id: string }>(
      `SELECT o.order_id
         FROM paper_entry_order o
         JOIN paper_funded_run b ON b.run_id=o.run_id
         JOIN paper_bot_run r ON r.id=o.run_id
        WHERE b.account_id=$1 AND b.currency=$2 AND r.market_id=$3`,
      [scope.accountId, scope.currency, scope.marketId],
    );
    return new Set(result.rows.map((row) => row.order_id));
  }

  private async loadEvents(
    client: PoolClient,
    accountId: string,
    asOf: string,
  ): Promise<EventRow[]> {
    const result = await client.query<EventRow>(
      `SELECT event_id,event,event_sequence,event_sequence_verified
         FROM paper_funded_event
        WHERE account_id=$1 AND (event->>'at')::timestamptz <= $2::timestamptz
          AND event->>'type' IN ('BUY','SELL')
        ORDER BY event_sequence`,
      [accountId, asOf],
    );
    return result.rows;
  }

  private async hasUnverifiedEvents(
    client: PoolClient,
    accountId: string,
    asOf: string,
  ): Promise<boolean> {
    const result = await client.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM paper_funded_event
          WHERE account_id=$1
            AND NOT event_sequence_verified
            AND (event->>'at')::timestamptz <= $2::timestamptz
       ) AS exists`,
      [accountId, asOf],
    );
    return Boolean(result.rows[0]?.exists);
  }

  private toFills(
    events: readonly EventRow[],
    orders: readonly OrderRow[],
    knownOrderIds: ReadonlySet<string>,
    quotes: readonly DiagnosticQuote[],
    unavailable: Set<ExecutionDiagnosticEvidence["unavailable"][number]>,
  ): DiagnosticFill[] {
    const orderById = new Map(orders.map((order) => [order.order_id, order]));
    const fills: DiagnosticFill[] = [];
    for (const row of events) {
      const event = record(row.event);
      if (!event || !["BUY", "SELL"].includes(stringValue(event.type) ?? ""))
        continue;
      const orderId = eventOrderId(event);
      const side = eventSide(event);
      const shares = eventShares(event);
      const at = stringValue(event.at);
      const order = orderId ? orderById.get(orderId) : undefined;
      if (!order && orderId && knownOrderIds.has(orderId)) continue;
      if (!order || !side || shares === null || !at) {
        unavailable.add("MISSING_ORDER_HISTORY");
        continue;
      }
      const resolvedOrderId = order.order_id;
      const candidates = quotes.filter(
        (quote) =>
          quote.runId === order.run_id &&
          quote.instrumentId === order.instrument_id &&
          Date.parse(quote.quote.timestamp) === Date.parse(at),
      );
      const quoteEvidenceId =
        candidates.length === 1 ? candidates[0]!.evidenceId : null;
      const linkUnknown =
        candidates.length === 1 ? null : ("AMBIGUOUS_FILL_QUOTE_LINK" as const);
      if (linkUnknown) unavailable.add(linkUnknown);
      fills.push({
        runId: order.run_id,
        instrumentId: order.instrument_id,
        orderId: resolvedOrderId,
        eventId: row.event_id,
        eventSequence: Number(row.event_sequence),
        at,
        side,
        shares,
        quoteEvidenceId,
        linkUnknown,
      });
    }
    return fills;
  }

  private toAllocations(
    orders: readonly OrderRow[],
    history: readonly HistoryRow[],
    quotes: readonly DiagnosticQuote[],
    fills: readonly DiagnosticFill[],
    unavailable: Set<ExecutionDiagnosticEvidence["unavailable"][number]>,
    asOf: string,
  ): DiagnosticAllocationInput[] {
    const historyByOrder = new Map<string, HistoryRow[]>();
    for (const row of history) {
      const values = historyByOrder.get(row.order_id) ?? [];
      values.push(row);
      historyByOrder.set(row.order_id, values);
    }
    const allocations: DiagnosticAllocationInput[] = [];
    for (const order of orders) {
      // Submission is immutable order input. The mutable current state is
      // never a substitute for the state immediately before a historical
      // quote allocation.
      const submission = record(order.submission);
      const submittedAt = stringValue(submission?.submittedAt);
      const releaseAt = stringValue(submission?.releaseAt);
      const expiresAt = stringValue(submission?.expiresAt);
      if (!submittedAt || !releaseAt || !expiresAt) {
        unavailable.add("MISSING_ORDER_HISTORY");
        continue;
      }
      const orderHistory = historyByOrder.get(order.order_id) ?? [];
      const orderQuotes = quotes.filter(
        (quote) =>
          quote.runId === order.run_id &&
          quote.instrumentId === order.instrument_id &&
          parsedTime(quote.quote.timestamp) >= parsedTime(releaseAt) &&
          parsedTime(quote.quote.timestamp) <= parsedTime(expiresAt) &&
          parsedTime(quote.quote.timestamp) <= parsedTime(asOf),
      );
      for (const quote of orderQuotes) {
        const before = resolvePreAllocationState({
          history: orderHistory.map((row) => ({
            revision: Number(row.revision),
            factAt: iso(row.fact_at),
            state: record(row.state) ?? {},
          })),
          quoteAt: quote.quote.timestamp,
          // No durable quote-to-order revision link is retained by legacy
          // rows. The resolver therefore fails closed on ambiguous equal-time
          // history rather than inventing an ordering from insertion order.
          appliedRevision: null,
        });
        if (before.completeness !== "EXACT" || !before.state) {
          unavailable.add(
            before.reason === "UNVERIFIED_EVENT_SEQUENCE"
              ? "UNVERIFIED_EVENT_SEQUENCE"
              : "MISSING_ORDER_HISTORY",
          );
        }
        const state = before.state;
        const currentStatus = stringValue(state?.status);
        if (before.completeness === "EXACT" && currentStatus !== "PENDING")
          continue;
        // Requested size is a submission-time fact. The current terminal
        // position is intentionally not consulted: later fills must not alter
        // an earlier RUN_END/AS_OF diagnostic.
        const requestedShares = numberValue(submission?.requestedShares);
        allocations.push({
          runId: order.run_id,
          instrumentId: order.instrument_id,
          orderId: order.order_id,
          quoteEvidenceId: quote.evidenceId,
          side: "ASK",
          submittedAt,
          releaseAt,
          requestedShares,
          beforeShares: null,
          afterShares: null,
          explicitReason: null,
          completeness: before.completeness,
        });
      }
    }
    const knownAllocationIds = new Set(
      allocations.map(
        (allocation) =>
          `${allocation.orderId}\u0000${allocation.quoteEvidenceId}`,
      ),
    );
    for (const fill of fills) {
      if (fill.side !== "BID" || !fill.quoteEvidenceId) continue;
      const key = `${fill.orderId}\u0000${fill.quoteEvidenceId}`;
      if (knownAllocationIds.has(key)) continue;
      allocations.push({
        runId: fill.runId,
        instrumentId: fill.instrumentId,
        orderId: fill.orderId,
        quoteEvidenceId: fill.quoteEvidenceId,
        side: "BID",
        submittedAt: fill.at,
        releaseAt: fill.at,
        requestedShares: null,
        beforeShares: null,
        afterShares: null,
        explicitReason: null,
        completeness: "PARTIAL",
      });
    }
    return allocations;
  }
}
