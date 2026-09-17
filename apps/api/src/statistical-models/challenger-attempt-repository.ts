import {
  challengerAttemptSchema,
  challengerOutcomeSchema,
  statisticalPredictionInputSchema,
  statisticalModelArtifactSchema,
  type ChallengerAttempt,
  type ChallengerOutcome,
  type StatisticalModelArtifact,
  type StatisticalPredictionInput,
} from "@tsx-scanner/contracts";
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { contentHash } from "../backtests/research-coverage.js";
import {
  challengerActiveBoundaries,
  challengerPopulationPredicate,
  challengerTimelyCapturePredicate,
} from "./challenger-population.js";

export type ChallengerPredictionInput = StatisticalPredictionInput & {
  profileConfigId: string;
};

const challengerPredictionInputSchema = statisticalPredictionInputSchema.extend(
  {
    profileConfigId: z.string().uuid(),
  },
);

export interface ChallengerAttemptStore {
  capture(
    attempt: ChallengerAttempt,
    input: ChallengerPredictionInput,
  ): Promise<"INSERTED" | "EXISTING">;
  finish(attempt: ChallengerAttempt, outcome: ChallengerOutcome): Promise<void>;
  expire(now: Date, limit: number): Promise<number>;
}

export type ChallengerAttemptRecord = ChallengerAttempt & {
  outcome: ChallengerOutcome | null;
};

export type ChallengerPendingWork = {
  attempt: ChallengerAttempt;
  input: ChallengerPredictionInput;
  artifact: StatisticalModelArtifact;
  marketId: "CA_TSX" | "US_EQUITIES";
};

type AttemptRow = {
  experiment_id: string;
  observation_id: string;
  model_version: string;
  input_hash: string;
  observed_at: Date;
  recorded_at: Date;
  deadline_at: Date;
  input_snapshot: ChallengerPredictionInput;
};

type OutcomeRow = {
  status: ChallengerOutcome["status"];
  completed_at: Date;
  outcome: unknown;
};

export class PostgresChallengerAttemptStore implements ChallengerAttemptStore {
  constructor(private readonly pool: Pool | PoolClient) {}

  async withMarketLease<T>(
    marketId: "CA_TSX" | "US_EQUITIES",
    operation: () => Promise<T>,
  ): Promise<T | null> {
    if (!("totalCount" in this.pool))
      throw new Error("CHALLENGER_WORKER_POOL_REQUIRED");
    const client = await this.pool.connect();
    const key = `challenger-observer:${marketId}`;
    let acquired = false;
    try {
      const lock = await client.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
        [key],
      );
      acquired = lock.rows[0]!.acquired;
      return acquired ? await operation() : null;
    } finally {
      try {
        if (acquired)
          await client.query(
            "SELECT pg_advisory_unlock(hashtextextended($1,0))",
            [key],
          );
      } finally {
        client.release();
      }
    }
  }

  async reconcileMissingAttempts(
    marketId: "CA_TSX" | "US_EQUITIES",
    limit: number,
  ): Promise<{ terminalized: number; unknown: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("CHALLENGER_RECONCILE_LIMIT_INVALID");
    const rows = await this.pool.query<{
      experiment_id: string;
      observation_id: string;
      model_version: string;
      observed_at: Date;
      deadline_at: Date;
      input: unknown;
    }>(
      `WITH active_boundaries AS (${challengerActiveBoundaries})
       SELECT e.id AS experiment_id,o.id AS observation_id,e.model_version,o.signal_timestamp AS observed_at,
         o.signal_timestamp+e.max_prediction_lag_ms*interval '1 millisecond' AS deadline_at,
         jsonb_build_object('marketId',r.market_id,'instrumentId',o.instrument_id,'symbol',o.symbol,
           'timestamp',to_char(o.signal_timestamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'profileId',o.profile_id,'profileName',o.profile_name,'profileConfigId',o.profile_config_id,
           'strategy',o.strategy_key,'deterministicScore',o.score,
           'atrPct',o.feature_snapshot->'atrPct','rvolAtTime',o.feature_snapshot->'rvolAtTime') AS input
       FROM challenger_experiment e
       JOIN active_boundaries t ON t.experiment_id=e.id
       JOIN challenger_baseline_record b ON b.identity_hash=e.baseline_identity_hash
       JOIN paper_bot_run r ON r.market_id=e.market_id
       JOIN paper_signal_observation o ON o.run_id=r.id
       WHERE e.market_id=$1 AND ${challengerPopulationPredicate} AND ${challengerTimelyCapturePredicate}
         AND o.signal_timestamp+e.max_prediction_lag_ms*interval '1 millisecond'<=clock_timestamp()
         AND NOT EXISTS(SELECT 1 FROM challenger_attempt a WHERE a.experiment_id=e.id AND a.observation_id=o.id)
       ORDER BY e.id,o.id LIMIT $2`,
      [marketId, limit],
    );
    let terminalized = 0,
      unknown = 0;
    for (const row of rows.rows) {
      const parsed = challengerPredictionInputSchema.safeParse(row.input);
      if (!parsed.success) {
        unknown++;
        continue;
      }
      const attempt = {
        experimentId: row.experiment_id,
        observationId: row.observation_id,
        modelVersion: row.model_version,
        observedAt: row.observed_at.toISOString(),
        deadlineAt: row.deadline_at.toISOString(),
        recordedAt: new Date().toISOString(),
        inputHash: contentHash(parsed.data),
      };
      try {
        await this.capture(attempt, parsed.data);
        // Read the DB-owned receipt time; retries cannot substitute a new timestamp.
        const stored = await this.pool.query<AttemptRow>(
          `SELECT * FROM challenger_attempt WHERE experiment_id=$1 AND observation_id=$2`,
          [row.experiment_id, row.observation_id],
        );
        await this.finish(mapAttempt(stored.rows[0]!), {
          status: "MISSED_DEADLINE",
          completedAt: new Date().toISOString(),
          reason: "CAPTURE_RECOVERED_AFTER_DEADLINE",
        });
        terminalized++;
      } catch (error) {
        if (!isOutcomeConflict(error)) throw error;
      }
    }
    return { terminalized, unknown };
  }

  async capture(
    rawAttempt: ChallengerAttempt,
    input: ChallengerPredictionInput,
  ): Promise<"INSERTED" | "EXISTING"> {
    const attempt = challengerAttemptSchema.parse(rawAttempt);
    const canonicalInput = challengerPredictionInputSchema.parse(input);
    if (contentHash(canonicalInput) !== attempt.inputHash)
      throw new Error("INPUT_HASH_MISMATCH");
    const result = await this.pool.query(
      `INSERT INTO challenger_attempt(
         experiment_id,observation_id,model_version,input_hash,observed_at,
         recorded_at,deadline_at,input_snapshot
       ) VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6,$7::jsonb)
       ON CONFLICT(experiment_id,observation_id) DO NOTHING`,
      [
        attempt.experimentId,
        attempt.observationId,
        attempt.modelVersion,
        attempt.inputHash,
        attempt.observedAt,
        attempt.deadlineAt,
        JSON.stringify(canonicalInput),
      ],
    );
    if (result.rowCount === 1) return "INSERTED";
    const existing = await this.pool.query<AttemptRow>(
      `SELECT experiment_id,observation_id,model_version,input_hash,observed_at,
              recorded_at,deadline_at,input_snapshot
         FROM challenger_attempt
        WHERE experiment_id=$1 AND observation_id=$2`,
      [attempt.experimentId, attempt.observationId],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("CHALLENGER_ATTEMPT_MISSING_AFTER_CONFLICT");
    if (
      row.model_version !== attempt.modelVersion ||
      row.input_hash !== attempt.inputHash ||
      contentHash(row.input_snapshot) !== contentHash(canonicalInput)
    )
      throw new Error("ATTEMPT_CONFLICT");
    return "EXISTING";
  }

  async finish(
    rawAttempt: ChallengerAttempt,
    rawOutcome: ChallengerOutcome,
  ): Promise<void> {
    const attempt = challengerAttemptSchema.parse(rawAttempt);
    const outcome = challengerOutcomeSchema.parse(rawOutcome);
    const storedAttempt = await this.pool.query<AttemptRow>(
      `SELECT experiment_id,observation_id,model_version,input_hash,observed_at,
              recorded_at,deadline_at,input_snapshot
         FROM challenger_attempt
        WHERE experiment_id=$1 AND observation_id=$2`,
      [attempt.experimentId, attempt.observationId],
    );
    const existingAttempt = storedAttempt.rows[0];
    if (!existingAttempt) throw new Error("CHALLENGER_ATTEMPT_NOT_FOUND");
    if (!sameAttempt(existingAttempt, attempt))
      throw new Error("ATTEMPT_CONFLICT");
    const prior = await this.pool.query<OutcomeRow>(
      `SELECT status,completed_at,outcome FROM challenger_outcome
        WHERE experiment_id=$1 AND observation_id=$2`,
      [attempt.experimentId, attempt.observationId],
    );
    if (prior.rows[0]) {
      const saved = challengerOutcomeSchema.parse(prior.rows[0].outcome);
      if (contentHash(saved) !== contentHash(outcome))
        throw new Error("CHALLENGER_OUTCOME_CONFLICT");
      return;
    }
    const inserted = await this.pool.query(
      `INSERT INTO challenger_outcome(experiment_id,observation_id,status,completed_at,outcome)
       VALUES($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT(experiment_id,observation_id) DO NOTHING`,
      [
        attempt.experimentId,
        attempt.observationId,
        outcome.status,
        outcome.completedAt,
        JSON.stringify(outcome),
      ],
    );
    if (inserted.rowCount === 1) return;
    const raced = await this.pool.query<OutcomeRow>(
      `SELECT status,completed_at,outcome FROM challenger_outcome
        WHERE experiment_id=$1 AND observation_id=$2`,
      [attempt.experimentId, attempt.observationId],
    );
    const saved = raced.rows[0]
      ? challengerOutcomeSchema.parse(raced.rows[0].outcome)
      : null;
    if (!saved || contentHash(saved) !== contentHash(outcome))
      throw new Error("CHALLENGER_OUTCOME_CONFLICT");
  }

  async expire(now: Date, limit: number): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
      throw new Error("CHALLENGER_EXPIRY_LIMIT_INVALID");
    const result = await this.pool.query<AttemptRow>(
      `SELECT a.experiment_id,a.observation_id,a.model_version,a.input_hash,
              a.observed_at,a.recorded_at,a.deadline_at,a.input_snapshot
         FROM challenger_attempt a
        WHERE a.deadline_at <= $1
          AND NOT EXISTS (
            SELECT 1 FROM challenger_outcome o
             WHERE o.experiment_id=a.experiment_id
               AND o.observation_id=a.observation_id
          )
        ORDER BY a.deadline_at,a.experiment_id,a.observation_id
        LIMIT $2`,
      [now, limit],
    );
    let expired = 0;
    for (const row of result.rows) {
      try {
        await this.finish(mapAttempt(row), {
          status: "MISSED_DEADLINE",
          completedAt: now.toISOString(),
          reason: "DEADLINE_EXPIRED",
        });
        expired += 1;
      } catch (error) {
        // A concurrent observer may have won the terminal outcome. It is
        // already durable and must not turn an otherwise healthy expiry pass
        // into a retry storm.
        if (!isOutcomeConflict(error)) throw error;
      }
    }
    return expired;
  }

  async listPending(limit = 100): Promise<ChallengerAttemptRecord[]> {
    const result = await this.pool.query<AttemptRow & { status: null }>(
      `SELECT a.experiment_id,a.observation_id,a.model_version,a.input_hash,
              a.observed_at,a.recorded_at,a.deadline_at,a.input_snapshot,
              NULL::text AS status
         FROM challenger_attempt a
        WHERE NOT EXISTS (
          SELECT 1 FROM challenger_outcome o
           WHERE o.experiment_id=a.experiment_id
             AND o.observation_id=a.observation_id
        )
        ORDER BY a.deadline_at,a.experiment_id,a.observation_id LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({ ...mapAttempt(row), outcome: null }));
  }

  async listPendingWork(
    marketId: "CA_TSX" | "US_EQUITIES",
    limit = 100,
  ): Promise<ChallengerPendingWork[]> {
    const result = await this.pool.query<
      AttemptRow & { artifact: unknown; market_id: "CA_TSX" | "US_EQUITIES" }
    >(
      `SELECT a.experiment_id,a.observation_id,a.model_version,a.input_hash,
              a.observed_at,a.recorded_at,a.deadline_at,a.input_snapshot,
              m.artifact,e.market_id
         FROM challenger_attempt a
         JOIN challenger_experiment e ON e.id=a.experiment_id
         JOIN statistical_model m ON m.id=e.model_id
        WHERE e.market_id=$1
          AND m.status='COMPLETED' AND m.artifact IS NOT NULL
          AND COALESCE((SELECT state FROM challenger_experiment_transition t
                         WHERE t.experiment_id=e.id
                         ORDER BY t.sequence DESC LIMIT 1),'REGISTERED') <> 'REVOKED'
          AND a.deadline_at > clock_timestamp()
          AND NOT EXISTS (
            SELECT 1 FROM challenger_outcome o
             WHERE o.experiment_id=a.experiment_id
               AND o.observation_id=a.observation_id
          )
        ORDER BY a.deadline_at,a.experiment_id,a.observation_id LIMIT $2`,
      [marketId, limit],
    );
    return result.rows.map((row) => ({
      attempt: mapAttempt(row),
      input: challengerPredictionInputSchema.parse(row.input_snapshot),
      artifact: statisticalModelArtifactSchema.parse(row.artifact),
      marketId: row.market_id,
    }));
  }

  async listWithOutcomes(
    experimentId: string,
  ): Promise<ChallengerAttemptRecord[]> {
    const result = await this.pool.query<
      AttemptRow & { outcome: unknown | null }
    >(
      `SELECT a.experiment_id,a.observation_id,a.model_version,a.input_hash,
              a.observed_at,a.recorded_at,a.deadline_at,a.input_snapshot,
              o.outcome
         FROM challenger_attempt a
         LEFT JOIN challenger_outcome o
           ON o.experiment_id=a.experiment_id AND o.observation_id=a.observation_id
        WHERE a.experiment_id=$1
        ORDER BY a.observed_at,a.observation_id`,
      [experimentId],
    );
    return result.rows.map((row) => ({
      ...mapAttempt(row),
      outcome: row.outcome ? challengerOutcomeSchema.parse(row.outcome) : null,
    }));
  }
}

function mapAttempt(
  row: AttemptRow,
): Omit<ChallengerAttempt, "input"> & { input: ChallengerPredictionInput } {
  const input = challengerPredictionInputSchema.parse(row.input_snapshot);
  return challengerAttemptSchema.parse({
    experimentId: row.experiment_id,
    observationId: row.observation_id,
    modelVersion: row.model_version,
    inputHash: row.input_hash,
    observedAt: row.observed_at.toISOString(),
    recordedAt: row.recorded_at.toISOString(),
    deadlineAt: row.deadline_at.toISOString(),
    input,
  }) as Omit<ChallengerAttempt, "input"> & {
    input: ChallengerPredictionInput;
  };
}

function sameAttempt(row: AttemptRow, attempt: ChallengerAttempt): boolean {
  return (
    row.model_version === attempt.modelVersion &&
    row.input_hash === attempt.inputHash &&
    row.observed_at.toISOString() === attempt.observedAt &&
    row.recorded_at.toISOString() === attempt.recordedAt &&
    row.deadline_at.toISOString() === attempt.deadlineAt
  );
}

function isOutcomeConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message === "CHALLENGER_OUTCOME_CONFLICT" ||
      error.message === "23505")
  );
}
