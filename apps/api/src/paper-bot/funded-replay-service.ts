import { normalizedQuoteSize } from "./normalized-quote-size.js";
import { loadFundedObservationEvidence } from "./funded-live-adapter.js";
import type { Pool } from "pg";
import { FundedFactAdapter } from "./funded-fact-adapter.js";
import { fundedEnvelopesSchema } from "./funded-fact-schema.js";
import { factTime } from "./funded-session-driver.js";
import { submitEntryOrder } from "./pending-order.js";
import { openEntryLiquidity } from "./shared-entry-liquidity.js";
import {
  buildFundedHistoricalFacts,
  type FundedHistoricalReplayInput,
} from "./funded-historical-adapter.js";
import { normalizeFundedPolicy, type FundedPolicy } from "./funded-policy.js";
import { FundedDecisionEvidenceRepository } from "./funded-decision-evidence-repository.js";
import { FundedDecisionOutcomeProjector } from "./funded-decision-outcome-projector.js";
import { PostgresPaperBotStore } from "./paper-bot-repository.js";

interface HistoricalRunRow {
  source: string;
  marketId: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  executionModelVersion: string;
  sessionDate: string;
  sessionTimezone: string;
  scheduledCloseAt: Date | string;
  assumptions: FundedHistoricalReplayInput["assumptions"];
  policy: FundedPolicy | null;
}

/** Explicit supplied-fact replay. It neither reconstructs strategies nor certifies retention coverage. */
export async function replayFundedFacts(
  pool: Pool,
  runId: string,
  input: unknown,
  apply = false,
) {
  const facts = fundedEnvelopesSchema.parse(input);
  for (const { fact } of facts) {
    if (fact.type === "SIGNAL") submitEntryOrder(fact.order);
    if (fact.type === "QUOTE")
      openEntryLiquidity(
        fact.instrumentId,
        fact.quote,
        fact.participation,
        fact.impactBps,
      );
  }
  const result = await pool.query(
    `SELECT r.source,r.market_id,b.policy FROM paper_bot_run r JOIN paper_funded_run b ON b.run_id=r.id WHERE r.id=$1`,
    [runId],
  );
  const run = result.rows[0];
  if (!run || run.source !== "BACKTEST" || !run.policy)
    throw new Error(
      "Funded replay requires an existing BACKTEST run with an explicit funded policy",
    );
  const adapter = new FundedFactAdapter(pool, runId);
  if (apply) {
    await adapter.enqueue(facts);
    await adapter.drain();
  }
  const outcomes = apply
    ? (
        await pool.query(
          'SELECT fact_id,outcome FROM paper_funded_fact WHERE run_id=$1 ORDER BY fact_at,priority,sort_key COLLATE "C",fact_id COLLATE "C"',
          [runId],
        )
      ).rows
    : [];
  return {
    runId,
    applied: apply,
    replayScope: "SUPPLIED_EXECUTION_FACTS",
    qualifiedForCapitalAllocation: false,
    rawCoverageVerified: false,
    marketId: run.market_id,
    policy: run.policy,
    factCount: facts.length,
    firstFactAt: facts.length
      ? new Date(
          Math.min(...facts.map(({ fact }) => factTime(fact))),
        ).toISOString()
      : null,
    lastFactAt: facts.length
      ? new Date(
          Math.max(...facts.map(({ fact }) => factTime(fact))),
        ).toISOString()
      : null,
    outcomes,
  };
}

/**
 * Replays one retained paper session through the funded inbox. Unlike the
 * supplied-facts command, this path owns the raw-input lookup and refuses to
 * proceed without signal semantic provenance and post-signal quote coverage.
 */
export async function replayFundedHistoricalSession(
  pool: Pool,
  runId: string,
  apply = false,
) {
  const selected = await pool.query<HistoricalRunRow>(
    `SELECT r.source,r.market_id AS "marketId",r.execution_model_version AS "executionModelVersion",
       r.session_date::text AS "sessionDate",r.session_timezone AS "sessionTimezone",
       r.scheduled_close_at AS "scheduledCloseAt",r.assumptions,b.currency,b.policy
     FROM paper_bot_run r
     JOIN paper_funded_run b ON b.run_id=r.id
     WHERE r.id=$1`,
    [runId],
  );
  const run = selected.rows[0];
  if (!run || run.source !== "BACKTEST" || !run.policy)
    throw new Error(
      "Historical funded replay requires an existing BACKTEST run with an explicit funded policy",
    );
  const expectedCurrency = run.marketId === "CA_TSX" ? "CAD" : "USD";
  if (run.currency !== expectedCurrency)
    throw new Error("Historical funded replay market/currency mismatch");
  const policy = normalizeFundedPolicy(run.policy);
  const retainedObservations = await new PostgresPaperBotStore(
    pool,
  ).findEligibleObservationsForFunding(runId);
  const observations = await Promise.all(
    retainedObservations.map((observation) =>
      loadFundedObservationEvidence(pool, run.marketId, observation),
    ),
  );
  const instrumentIds = [
    ...new Set(observations.map((observation) => observation.instrumentId)),
  ];
  const quotes = await pool.query<{
    instrumentId: string;
    timestamp: Date | string;
    bid: number | string;
    ask: number | string;
    bidSize: number | string;
    askSize: number | string;
    sizeUnit: "SHARES" | "BOARD_LOTS" | "UNKNOWN" | null;
    sizeMultiplier: number | string | null;
    isDelayed: boolean;
    isHalted: boolean;
  }>(
    `SELECT q.instrument_id AS "instrumentId",q.timestamp,q.bid::float8,q.ask::float8,
       q.bid_size::float8 AS "bidSize",q.ask_size::float8 AS "askSize",
       q.size_unit AS "sizeUnit",q.size_multiplier::float8 AS "sizeMultiplier",
       q.is_delayed AS "isDelayed",q.is_halted AS "isHalted"
     FROM quote_snapshot q
     JOIN instrument i ON i.id=q.instrument_id AND i.market_id=$1
     WHERE q.instrument_id=ANY($2::uuid[])
       AND q.timestamp >= ($3::date AT TIME ZONE $4)
       AND q.timestamp <= $5::timestamptz
     ORDER BY q.timestamp,q.instrument_id,q.source`,
    [
      run.marketId,
      instrumentIds,
      run.sessionDate,
      run.sessionTimezone,
      run.scheduledCloseAt,
    ],
  );
  const invalidations = await pool.query<{
    eventId: string;
    orderId: string;
    at: Date | string;
  }>(
    `SELECT e.id AS "eventId",o.id AS "orderId",e.timestamp AS at
     FROM strategy_state_event e
     JOIN strategy_signal s ON s.id=e.signal_id
     JOIN scanner_profile_config c
       ON c.profile_id=e.profile_id AND c.config_version=s.config_version
     JOIN paper_signal_observation o
       ON o.run_id=$1 AND o.instrument_id=e.instrument_id
      AND o.profile_config_id=c.id
      AND o.setup_instance_id=e.setup_instance_id
     WHERE e.new_state='INVALIDATED'
       AND e.timestamp >= o.signal_timestamp
       AND e.timestamp <= $2::timestamptz
     ORDER BY e.timestamp,e.id`,
    [runId, run.scheduledCloseAt],
  );
  const input: FundedHistoricalReplayInput = {
    runId,
    marketId: run.marketId,
    executionModelVersion: run.executionModelVersion,
    sessionDate: run.sessionDate,
    sessionTimezone: run.sessionTimezone,
    scheduledCloseAt: new Date(run.scheduledCloseAt).toISOString(),
    assumptions: run.assumptions,
    policy,
    observations,
    invalidations: invalidations.rows.map((row) => ({
      eventId: row.eventId,
      orderId: row.orderId,
      at: new Date(row.at).toISOString(),
    })),
    quotes: quotes.rows.map((row) => ({
      instrumentId: row.instrumentId,
      timestamp: new Date(row.timestamp).toISOString(),
      bid: Number(row.bid),
      ask: Number(row.ask),
      bidSize: Number(row.bidSize),
      askSize: Number(row.askSize),
      ...normalizedQuoteSize(row.sizeUnit, row.sizeMultiplier),
      dataStatus: row.isHalted
        ? "HALTED"
        : row.isDelayed
          ? "DELAYED"
          : "REALTIME",
      actionable: !row.isHalted && !row.isDelayed,
    })),
  };
  const prepared = buildFundedHistoricalFacts(input);
  const adapter = new FundedFactAdapter(pool, runId);
  // FP01: the replay writes the same immutable decision contract as live,
  // through the same production capture path, under a distinct replay cohort.
  // The funded run owns its bridged observations, so the durable capture
  // source is complete for every retained signal.
  const evidence = new FundedDecisionEvidenceRepository(pool);
  const projector = new FundedDecisionOutcomeProjector(pool, evidence);
  // Historical pre-submission invalidations keep the live refusal contract.
  // Their exact semantics travel as additive sidecars committed atomically
  // with the CANCEL facts; the ordered drain captures each chronological
  // cursor. No evidence intent is written before the replay starts, and the
  // strict driver envelope is unchanged.
  const processed = apply
    ? (await adapter.enqueue(prepared.envelopes, {
        repository: evidence,
        refusalRequests: prepared.refusalRequests.map((request) => ({
          ...request,
          deferBoundary: true,
        })),
      }),
      await adapter.drain(undefined, { repository: evidence }))
    : 0;
  const repair = apply
    ? await evidence.repairMissingDecisions(runId)
    : { repaired: 0, failed: 0, remaining: 0 };
  const projection = apply
    ? await projector.projectPending(runId)
    : { projected: 0, failed: 0, remaining: 0 };
  const decisionCount = apply
    ? ((
        await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM funded_decision_evidence WHERE run_id=$1",
          [runId],
        )
      ).rows[0]?.count ?? 0)
    : 0;
  const outcomes = apply
    ? (
        await pool.query(
          'SELECT fact_id,outcome FROM paper_funded_fact WHERE run_id=$1 ORDER BY fact_at,priority,sort_key COLLATE "C",fact_id COLLATE "C"',
          [runId],
        )
      ).rows
    : [];
  return {
    runId,
    applied: apply,
    processed,
    replayScope: "HISTORICAL_RETAINED_RAW",
    qualifiedForCapitalAllocation: false,
    rawCoverageVerified: prepared.coverage.rawCoverageVerified,
    executionModelVersion: run.executionModelVersion,
    marketId: run.marketId,
    coverage: prepared.coverage,
    factCount: prepared.envelopes.length,
    decisions: decisionCount,
    captureRepair: repair,
    outcomeProjection: projection,
    outcomes,
  };
}
