import type {
  ContextEvaluation,
  StrategyEvaluation,
  StrategyStateEvent,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import type { PersistenceMetrics } from "../observability/persistence-metrics.js";
import { chunkRows, countUpsertOutcome } from "./batch-utils.js";

export interface StrategySignalStore {
  saveStrategyResults(
    evaluations: StrategyEvaluation[],
    events: StrategyStateEvent[],
    contexts?: ContextEvaluation[],
  ): Promise<void>;
}

// See batch-utils.ts for the jsonb_to_recordset rationale and why these bounds are payload-size
// safety valves, not parameter-limit workarounds.
const EVALUATION_CHUNK_SIZE = 500;
const EVENT_CHUNK_SIZE = 1000;
const CONTEXT_CHUNK_SIZE = 500;

export class PostgresStrategySignalStore implements StrategySignalStore {
  constructor(
    private readonly pool: Pool,
    private readonly metrics?: PersistenceMetrics,
  ) {}

  /** Persists one cycle's worth of setup evaluations/signals, state-change events, and context
   *  evaluations in a single transaction with set-based bulk statements -- no per-row round trips.
   *  Ordering matters within the transaction: strategy_signal/strategy_evaluation are written
   *  before strategy_state_event (which joins strategy_signal by (instrument, profile, timestamp)
   *  to resolve `signal_id`, matching what the row-by-row version relied on implicitly), and
   *  contexts are independent of both. */
  async saveStrategyResults(
    evaluations: StrategyEvaluation[],
    events: StrategyStateEvent[],
    contexts: ContextEvaluation[] = [],
  ): Promise<void> {
    if (
      evaluations.length === 0 &&
      events.length === 0 &&
      contexts.length === 0
    )
      return;
    if (
      contexts.some(
        (value) => value.marketId !== value.featureSnapshot.marketId,
      )
    ) {
      throw new Error(
        "Context evaluation market must match its feature snapshot",
      );
    }
    const started = performance.now();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const evaluationOutcome = await this.saveEvaluations(client, evaluations);
      const eventOutcome = await this.saveEvents(client, events);
      const contextOutcome = await this.saveContexts(client, contexts);
      await client.query("COMMIT");
      const latencyMs = Math.round((performance.now() - started) * 100) / 100;
      this.metrics?.record(
        "strategy_signal",
        evaluationOutcome.signal.written,
        evaluationOutcome.signal.conflicts,
        latencyMs,
      );
      this.metrics?.record(
        "strategy_evaluation",
        evaluationOutcome.evaluation.written,
        evaluationOutcome.evaluation.conflicts,
        latencyMs,
      );
      this.metrics?.record(
        "strategy_state_event",
        eventOutcome.written,
        eventOutcome.conflicts,
        latencyMs,
      );
      this.metrics?.record(
        "context_evaluation",
        contextOutcome.written,
        contextOutcome.conflicts,
        latencyMs,
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** Writes `strategy_signal` and `strategy_evaluation` set-wise, resolving each row's
   *  previous-state value with one `LEFT JOIN LATERAL` per statement (scoped to the batch's
   *  distinct (instrument, profile) keys) instead of one correlated subquery per row. Within one
   *  batch this is equivalent to the old row-by-row loop as long as each (instrument, profile)
   *  pair appears at most once per cycle (the normal case: one evaluation per profile per
   *  instrument per cycle) -- the lookup reads the table state committed before this statement
   *  started, which is exactly what each sequential per-row `INSERT ... SELECT` also saw. If the
   *  same (instrument, profile) pair appeared twice in one batch, both rows would resolve
   *  previous-state from the same pre-batch value instead of chaining off each other; that shape
   *  does not occur in the current cycle design (one evaluation per profile per instrument per
   *  poll), so it is a documented, accepted difference rather than a bug fix target. */
  private async saveEvaluations(
    client: PoolClient,
    evaluations: StrategyEvaluation[],
  ): Promise<{
    signal: { written: number; conflicts: number };
    evaluation: { written: number; conflicts: number };
  }> {
    if (
      evaluations.some(
        (value) => value.marketId !== value.featureSnapshot.marketId,
      )
    ) {
      throw new Error(
        "Strategy evaluation market must match its feature snapshot",
      );
    }
    const signal = { written: 0, conflicts: 0 };
    const evaluation = { written: 0, conflicts: 0 };
    for (const chunk of chunkRows(evaluations, EVALUATION_CHUNK_SIZE)) {
      const rows = chunk.map(toEvaluationRow);
      const payload = JSON.stringify(rows);

      const signalResult = await client.query<{ inserted: boolean }>(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
             market_id text, instrument_id uuid, profile_id uuid, strategy_name text, strategy_version text,
             config_version text, ts timestamptz, state text, score integer,
             entry_reference numeric, stop_reference numeric, target_reference numeric,
             estimated_rr numeric, feature_snapshot_json jsonb, reason_codes jsonb,
             feature_version text, score_version text, score_components jsonb,
             setup_instance_id uuid, formation_evidence jsonb
           )
         ),
         prev AS (
           SELECT DISTINCT ON (i.instrument_id, i.profile_id)
                  i.instrument_id, i.profile_id, s.state
           FROM input i
           LEFT JOIN LATERAL (
             SELECT state FROM strategy_signal s2
             WHERE s2.market_id=i.market_id AND s2.instrument_id = i.instrument_id AND s2.profile_id = i.profile_id
             ORDER BY s2.timestamp DESC LIMIT 1
           ) s ON TRUE
         )
         INSERT INTO strategy_signal (
           market_id, instrument_id, profile_id, strategy_name, strategy_version, config_version, timestamp,
           previous_state, state, score, entry_reference, stop_reference, target_reference,
           estimated_rr, feature_snapshot_id, feature_snapshot_json, reason_codes, score_version,
           score_components, setup_instance_id, formation_evidence
         )
         SELECT i.market_id, i.instrument_id, i.profile_id, i.strategy_name, i.strategy_version,
                i.config_version, i.ts, COALESCE(p.state, 'INACTIVE'), i.state, i.score,
                i.entry_reference, i.stop_reference, i.target_reference, i.estimated_rr,
                fs.id, i.feature_snapshot_json, i.reason_codes, i.score_version,
                i.score_components, i.setup_instance_id, i.formation_evidence
         FROM input i
         JOIN prev p ON p.instrument_id = i.instrument_id
           AND p.profile_id IS NOT DISTINCT FROM i.profile_id
         JOIN feature_snapshot fs ON fs.instrument_id = i.instrument_id
           AND fs.market_id = i.market_id AND fs.timestamp = i.ts AND fs.feature_version = i.feature_version
         ON CONFLICT (profile_id, instrument_id, timestamp) WHERE profile_id IS NOT NULL DO UPDATE SET
           strategy_name = EXCLUDED.strategy_name,
           strategy_version = EXCLUDED.strategy_version,
           config_version = EXCLUDED.config_version,
           previous_state = EXCLUDED.previous_state,
           state = EXCLUDED.state,
           score = EXCLUDED.score,
           entry_reference = EXCLUDED.entry_reference,
           stop_reference = EXCLUDED.stop_reference,
           target_reference = EXCLUDED.target_reference,
           estimated_rr = EXCLUDED.estimated_rr,
           feature_snapshot_id = EXCLUDED.feature_snapshot_id,
           feature_snapshot_json = EXCLUDED.feature_snapshot_json,
           reason_codes = EXCLUDED.reason_codes,
           score_version = EXCLUDED.score_version,
           score_components = EXCLUDED.score_components,
           setup_instance_id = EXCLUDED.setup_instance_id,
           formation_evidence = EXCLUDED.formation_evidence,
           updated_at = now()
         RETURNING (xmax = 0) AS inserted`,
        [payload],
      );
      const signalOutcome = countUpsertOutcome(signalResult.rows);
      signal.written += signalOutcome.written;
      signal.conflicts += signalOutcome.conflicts;

      const evaluationResult = await client.query<{ inserted: boolean }>(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
             market_id text, instrument_id uuid, profile_id uuid, strategy_name text, strategy_version text,
             config_version text, ts timestamptz, state text, score integer,
             entry_reference numeric, stop_reference numeric, target_reference numeric,
             estimated_rr numeric, reason_codes jsonb, feature_version text, score_version text,
             score_components jsonb, score_explanation jsonb, setup_instance_id uuid,
             formation_evidence jsonb
           )
         ),
         prev AS (
           SELECT DISTINCT ON (i.profile_id, i.instrument_id)
                  i.profile_id, i.instrument_id, e.state
           FROM input i
           LEFT JOIN LATERAL (
             SELECT state FROM strategy_evaluation e2
             WHERE e2.market_id=i.market_id AND e2.profile_id = i.profile_id AND e2.instrument_id = i.instrument_id
             ORDER BY e2.timestamp DESC LIMIT 1
           ) e ON TRUE
         )
         INSERT INTO strategy_evaluation (
           market_id, profile_id, instrument_id, feature_snapshot_id, timestamp, strategy_key,
           strategy_version, config_version, previous_state, state, score, entry_reference,
           stop_reference, target_reference, estimated_rr, reason_codes, score_version,
           score_components, score_explanation, setup_instance_id, formation_evidence
         )
         SELECT i.market_id, i.profile_id, i.instrument_id, fs.id, i.ts, i.strategy_name, i.strategy_version,
                i.config_version, COALESCE(p.state, 'INACTIVE'), i.state, i.score,
                i.entry_reference, i.stop_reference, i.target_reference, i.estimated_rr,
                i.reason_codes, i.score_version, i.score_components, i.score_explanation,
                i.setup_instance_id, i.formation_evidence
         FROM input i
         JOIN prev p ON p.instrument_id = i.instrument_id
           AND p.profile_id IS NOT DISTINCT FROM i.profile_id
         JOIN feature_snapshot fs ON fs.instrument_id = i.instrument_id
           AND fs.market_id = i.market_id AND fs.timestamp = i.ts AND fs.feature_version = i.feature_version
         ON CONFLICT (profile_id, instrument_id, feature_snapshot_id) DO UPDATE SET
           strategy_key = EXCLUDED.strategy_key,
           strategy_version = EXCLUDED.strategy_version,
           config_version = EXCLUDED.config_version,
           previous_state = EXCLUDED.previous_state,
           state = EXCLUDED.state,
           score = EXCLUDED.score,
           entry_reference = EXCLUDED.entry_reference,
           stop_reference = EXCLUDED.stop_reference,
           target_reference = EXCLUDED.target_reference,
           estimated_rr = EXCLUDED.estimated_rr,
           reason_codes = EXCLUDED.reason_codes,
           score_version = EXCLUDED.score_version,
           score_components = EXCLUDED.score_components,
           score_explanation = EXCLUDED.score_explanation,
           setup_instance_id = EXCLUDED.setup_instance_id,
           formation_evidence = EXCLUDED.formation_evidence
         RETURNING (xmax = 0) AS inserted`,
        [payload],
      );
      const evaluationOutcome = countUpsertOutcome(evaluationResult.rows);
      evaluation.written += evaluationOutcome.written;
      evaluation.conflicts += evaluationOutcome.conflicts;
    }
    return { signal, evaluation };
  }

  private async saveEvents(
    client: PoolClient,
    events: StrategyStateEvent[],
  ): Promise<{ written: number; conflicts: number }> {
    const outcome = { written: 0, conflicts: 0 };
    if (events.length === 0) return outcome;
    for (const chunk of chunkRows(events, EVENT_CHUNK_SIZE)) {
      const result = await client.query<{ inserted: boolean }>(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
             event_id uuid, market_id text, instrument_id uuid, profile_id uuid, strategy_name text,
             strategy_version text, ts timestamptz, previous_state text, new_state text,
             score integer, reason_codes jsonb, payload jsonb, setup_instance_id uuid,
             formation_evidence jsonb
           )
         )
         INSERT INTO strategy_state_event (
           id, market_id, signal_id, instrument_id, profile_id, strategy_name, strategy_version, timestamp,
           previous_state, new_state, score, reason_codes, payload, setup_instance_id, formation_evidence
         )
         SELECT i.event_id, i.market_id, s.id, i.instrument_id, i.profile_id, i.strategy_name,
                i.strategy_version, i.ts, i.previous_state, i.new_state, i.score,
                i.reason_codes, i.payload, i.setup_instance_id, i.formation_evidence
         FROM input i
         JOIN strategy_signal s ON s.market_id=i.market_id AND s.instrument_id = i.instrument_id
           AND s.profile_id = i.profile_id AND s.timestamp = i.ts
         ON CONFLICT (id) DO NOTHING
         RETURNING (xmax = 0) AS inserted`,
        [
          JSON.stringify(
            chunk.map((event) => ({
              event_id: event.eventId,
              market_id: event.marketId,
              instrument_id: event.instrumentId,
              profile_id: event.profileId,
              strategy_name: event.strategy,
              strategy_version: event.strategyVersion,
              ts: event.timestamp,
              previous_state: event.previousState,
              new_state: event.state,
              score: event.score,
              reason_codes: event.reasonCodes,
              payload: event,
              setup_instance_id: event.setupInstanceId,
              formation_evidence: event.formationEvidence,
            })),
          ),
        ],
      );
      // ON CONFLICT DO NOTHING never returns a conflicted row, so every returned row is an
      // insert; rows dropped by the conflict (already-recorded event ids) are the difference
      // between the chunk size and the rows actually matched/returned.
      outcome.written += result.rows.length;
      outcome.conflicts += chunk.length - result.rows.length;
    }
    return outcome;
  }

  private async saveContexts(
    client: PoolClient,
    contexts: ContextEvaluation[],
  ): Promise<{ written: number; conflicts: number }> {
    const outcome = { written: 0, conflicts: 0 };
    if (contexts.length === 0) return outcome;
    for (const chunk of chunkRows(contexts, CONTEXT_CHUNK_SIZE)) {
      const result = await client.query<{ inserted: boolean }>(
        `WITH input AS (
           SELECT * FROM jsonb_to_recordset($1::jsonb) AS t(
             market_id text, profile_id uuid, instrument_id uuid, ts timestamptz, signal_key text,
             signal_version text, config_version text, status text, context_score integer,
             context_score_version text, context_score_components jsonb,
             missing_data_flags jsonb, observed_value numeric, benchmark_symbol text,
             benchmark_value numeric, benchmark_timestamp timestamptz, lookback text,
             reason_codes jsonb, feature_version text
           )
         )
         INSERT INTO context_evaluation (
           market_id, profile_id, instrument_id, feature_snapshot_id, timestamp, signal_key, signal_version,
           config_version, status, context_score, context_score_version,
           context_score_components, missing_data_flags, observed_value,
           benchmark_instrument_id, benchmark_value, benchmark_timestamp, lookback, reason_codes
         )
         SELECT i.market_id, i.profile_id, i.instrument_id, fs.id, i.ts, i.signal_key, i.signal_version,
                i.config_version, i.status, i.context_score, i.context_score_version,
                i.context_score_components, i.missing_data_flags, i.observed_value,
                bi.id, i.benchmark_value, i.benchmark_timestamp, i.lookback, i.reason_codes
         FROM input i
         JOIN feature_snapshot fs ON fs.instrument_id = i.instrument_id
           AND fs.market_id=i.market_id AND fs.timestamp = i.ts AND fs.feature_version = i.feature_version
         LEFT JOIN instrument bi ON upper(bi.symbol) = upper(i.benchmark_symbol)
         ON CONFLICT (profile_id, instrument_id, feature_snapshot_id) DO UPDATE SET
           signal_key = EXCLUDED.signal_key,
           signal_version = EXCLUDED.signal_version,
           config_version = EXCLUDED.config_version,
           status = EXCLUDED.status,
           context_score = EXCLUDED.context_score,
           context_score_version = EXCLUDED.context_score_version,
           context_score_components = EXCLUDED.context_score_components,
           missing_data_flags = EXCLUDED.missing_data_flags,
           observed_value = EXCLUDED.observed_value,
           benchmark_instrument_id = EXCLUDED.benchmark_instrument_id,
           benchmark_value = EXCLUDED.benchmark_value,
           benchmark_timestamp = EXCLUDED.benchmark_timestamp,
           lookback = EXCLUDED.lookback,
           reason_codes = EXCLUDED.reason_codes
         RETURNING (xmax = 0) AS inserted`,
        [
          JSON.stringify(
            chunk.map((context) => ({
              market_id: context.marketId,
              profile_id: context.profileId,
              instrument_id: context.instrumentId,
              ts: context.timestamp,
              signal_key: context.signal,
              signal_version: context.signalVersion,
              config_version: context.configVersion,
              status: context.status,
              context_score: context.contextScore,
              context_score_version: context.contextScoreVersion,
              context_score_components: context.contextScoreComponents,
              missing_data_flags: context.missingDataFlags,
              observed_value: context.observedValue,
              benchmark_symbol: context.benchmarkSymbol,
              benchmark_value: context.benchmarkValue,
              benchmark_timestamp: context.benchmarkTimestamp,
              lookback: context.lookback,
              reason_codes: context.reasonCodes,
              feature_version: context.featureSnapshot.featureVersion,
            })),
          ),
        ],
      );
      const chunkOutcome = countUpsertOutcome(result.rows);
      outcome.written += chunkOutcome.written;
      outcome.conflicts += chunkOutcome.conflicts;
    }
    return outcome;
  }
}

function toEvaluationRow(value: StrategyEvaluation) {
  return {
    market_id: value.marketId,
    instrument_id: value.instrumentId,
    profile_id: value.profileId,
    strategy_name: value.strategy,
    strategy_version: value.strategyVersion,
    config_version: value.configVersion,
    ts: value.timestamp,
    state: value.state,
    score: value.score,
    entry_reference: value.entryReference,
    stop_reference: value.stopReference,
    target_reference: value.targetReference,
    estimated_rr: value.estimatedRr,
    feature_snapshot_json: value.featureSnapshot,
    reason_codes: value.reasonCodes,
    feature_version: value.featureSnapshot.featureVersion,
    score_version: value.scoreVersion,
    score_components: value.scoreComponents,
    score_explanation: value.scoreExplanation,
    setup_instance_id: value.setupInstanceId,
    formation_evidence: value.formationEvidence,
  };
}
