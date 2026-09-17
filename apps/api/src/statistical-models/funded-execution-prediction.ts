import type { Pool } from "pg";
import {
  FUNDED_EXECUTION_PREDICTION_VERSION,
  fundedExecutionPredictionOutputSchema,
  fundedExecutionPredictionRecordSchema,
  type FundedExecutionPredictionOutput,
  type FundedExecutionPredictionRecord,
  type FundedSourceKind,
} from "@tsx-scanner/contracts";
import { contentHash } from "./funded-execution-digest.js";

/**
 * Forward prediction boundary for later FP04 shadow observation (FP02).
 *
 * The persistence boundary loads the actual immutable challenger row and the
 * funded decision evidence row inside the same transaction and binds the
 * prediction to their persisted identity. A caller supplies only the
 * challenger ID, the decision owner identity, the expected decision sequence
 * and content digest, a deadline and diagnostic outputs. The prediction time is
 * database-owned, the database trigger enforces the deadline against the actual
 * wall-clock time immediately before the insert (`clock_timestamp()`, not the
 * transaction start time), and the database enforces
 * `challenger.createdAt <= decisionAt <= predictionAt <= deadlineAt`, so a late
 * prediction cannot be backdated and cannot invent a model, artifact, cohort,
 * market, currency, source or decision relationship. Insertion is race-safe:
 * concurrent identical requests resolve to the single durable winner, while a
 * concurrent request with a different digest fails as a visible conflict.
 *
 * This service has no funded order, ledger, reservation, profile or policy
 * dependency and cannot return an action or authority recommendation.
 *
 * Retry durability: an exact retry first acquires a transaction-scoped lock on
 * the prediction identity and reloads the durable record, so a committed
 * prediction whose response was lost resolves to its original immutable record
 * even after the deadline. Only a genuinely new prediction consults the
 * database clock and is refused after its deadline; the trigger independently
 * enforces the same bound at the insert.
 */

export interface FundedExecutionPredictionInput {
  readonly challengerId: string;
  readonly marketId: "CA_TSX" | "US_EQUITIES";
  readonly currency: "CAD" | "USD";
  readonly sourceKind: FundedSourceKind;
  readonly runId: string;
  readonly observationId: string;
  readonly expectedDecisionSequence: number;
  readonly expectedDecisionInputDigest: string;
  readonly deadlineAt: string;
  readonly output: FundedExecutionPredictionOutput;
  readonly warnings: readonly string[];
}

export interface FundedExecutionPredictionStore {
  recordPrediction(
    input: FundedExecutionPredictionInput,
  ): Promise<FundedExecutionPredictionRecord>;
}

export class FundedExecutionPredictionService {
  constructor(private readonly store: FundedExecutionPredictionStore) {}

  async record(
    input: FundedExecutionPredictionInput,
  ): Promise<FundedExecutionPredictionRecord> {
    if (
      (input.marketId === "CA_TSX" && input.currency !== "CAD") ||
      (input.marketId === "US_EQUITIES" && input.currency !== "USD")
    )
      throw new Error("FUNDED_EXECUTION_PREDICTION_CURRENCY_MISMATCH");
    if (!Number.isFinite(Date.parse(input.deadlineAt)))
      throw new Error("FUNDED_EXECUTION_PREDICTION_INVALID_DEADLINE");
    if (
      !Number.isInteger(input.expectedDecisionSequence) ||
      input.expectedDecisionSequence <= 0
    )
      throw new Error("FUNDED_EXECUTION_PREDICTION_INVALID_SEQUENCE");
    const output = fundedExecutionPredictionOutputSchema.parse(input.output);
    const warnings = input.warnings.map((warning) => {
      if (typeof warning !== "string" || warning.length === 0)
        throw new Error("FUNDED_EXECUTION_PREDICTION_INVALID_WARNING");
      return warning;
    });
    return this.store.recordPrediction({ ...input, output, warnings });
  }
}

interface ChallengerRow {
  id: string;
  market_id: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  cohort_digest: string;
  model_version: string;
  model_type: string;
  artifact_digest: string;
  feature_version: string;
  status: string;
  created_at: Date | string;
}

interface DecisionRow {
  run_id: string;
  observation_id: string;
  sequence: number;
  market_id: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  content_digest: string;
  cohort_digest: string;
  source_kind: FundedSourceKind;
  evidence_schema_version: number;
  decision_at: Date | string;
}

interface PredictionRow {
  market_id: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
  model_id: string;
  model_version: string;
  model_type: string;
  artifact_digest: string;
  cohort_digest: string;
  feature_version: string;
  source_kind: FundedSourceKind;
  run_id: string;
  observation_id: string;
  decision_sequence: number;
  decision_input_digest: string;
  decision_at: Date | string;
  prediction_at: Date | string;
  deadline_at: Date | string;
  output: unknown;
  warnings: unknown;
  digest: string;
}

export class PostgresFundedExecutionPredictionStore implements FundedExecutionPredictionStore {
  constructor(private readonly pool: Pool) {}

  async recordPrediction(
    input: FundedExecutionPredictionInput,
  ): Promise<FundedExecutionPredictionRecord> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // Lock and validate the actual immutable challenger row and decision
      // evidence row in this transaction. Caller identity values are only
      // expectations to compare against persisted state.
      const challengerResult = await client.query<ChallengerRow>(
        `SELECT id,market_id,currency,cohort_digest,model_version,model_type,
                artifact_digest,feature_version,status,created_at
           FROM funded_execution_challenger WHERE id=$1 FOR SHARE`,
        [input.challengerId],
      );
      const challenger = challengerResult.rows[0];
      if (!challenger)
        throw new Error("FUNDED_EXECUTION_PREDICTION_CHALLENGER_NOT_FOUND");
      if (challenger.status !== "INACTIVE")
        throw new Error("FUNDED_EXECUTION_PREDICTION_CHALLENGER_NOT_INACTIVE");
      if (challenger.market_id !== input.marketId)
        throw new Error("FUNDED_EXECUTION_PREDICTION_MARKET_MISMATCH");
      if (challenger.currency !== input.currency)
        throw new Error("FUNDED_EXECUTION_PREDICTION_CURRENCY_MISMATCH");

      const decisionResult = await client.query<DecisionRow>(
        `SELECT run_id,observation_id,sequence,market_id,currency,content_digest,
                cohort_digest,source_kind,evidence_schema_version,decision_at
           FROM funded_decision_evidence
          WHERE run_id=$1 AND observation_id=$2 FOR SHARE`,
        [input.runId, input.observationId],
      );
      const decision = decisionResult.rows[0];
      if (!decision)
        throw new Error("FUNDED_EXECUTION_PREDICTION_DECISION_NOT_FOUND");
      if (Number(decision.evidence_schema_version) !== 2)
        throw new Error("FUNDED_EXECUTION_PREDICTION_DECISION_NOT_V2");
      if (Number(decision.sequence) !== input.expectedDecisionSequence)
        throw new Error("FUNDED_EXECUTION_PREDICTION_SEQUENCE_MISMATCH");
      if (decision.content_digest !== input.expectedDecisionInputDigest)
        throw new Error("FUNDED_EXECUTION_PREDICTION_INPUT_DIGEST_MISMATCH");
      if (
        decision.market_id !== challenger.market_id ||
        decision.currency !== challenger.currency
      )
        throw new Error("FUNDED_EXECUTION_PREDICTION_OWNERSHIP_MISMATCH");
      if (decision.cohort_digest !== challenger.cohort_digest)
        throw new Error("FUNDED_EXECUTION_PREDICTION_COHORT_MISMATCH");
      if (decision.source_kind !== input.sourceKind)
        throw new Error("FUNDED_EXECUTION_PREDICTION_SOURCE_MISMATCH");

      const decisionAtMs = asTime(decision.decision_at);
      const challengerCreatedAtMs = asTime(challenger.created_at);
      if (challengerCreatedAtMs > decisionAtMs)
        throw new Error("FUNDED_EXECUTION_PREDICTION_PRECEDES_MODEL");

      const model = {
        modelId: challenger.id,
        modelVersion: challenger.model_version,
        modelType: "FUNDED_EXECUTION_QUALITY" as const,
        artifactDigest: challenger.artifact_digest,
        cohortDigest: challenger.cohort_digest,
        featureVersion: challenger.feature_version,
      };
      const digest = predictionDigest({
        model,
        marketId: input.marketId,
        currency: input.currency,
        sourceKind: input.sourceKind,
        runId: input.runId,
        observationId: input.observationId,
        decisionSequence: input.expectedDecisionSequence,
        decisionInputDigest: input.expectedDecisionInputDigest,
        deadlineAt: input.deadlineAt,
        output: input.output,
        warnings: input.warnings,
      });
      // Serialize every operation for this exact prediction identity. A durable
      // prediction whose response was lost must resolve to its immutable record
      // even after the deadline, so the reload happens before any clock check.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0)) AS locked",
        [
          predictionLockIdentity({
            challengerId: input.challengerId,
            runId: input.runId,
            observationId: input.observationId,
            decisionSequence: input.expectedDecisionSequence,
          }),
        ],
      );
      const existing = await client.query<PredictionRow>(
        `${PREDICTION_SELECT}
          WHERE model_id=$1 AND run_id=$2 AND observation_id=$3 AND decision_sequence=$4`,
        [
          input.challengerId,
          input.runId,
          input.observationId,
          input.expectedDecisionSequence,
        ],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].digest !== digest)
          throw new Error("CONFLICTING_FUNDED_EXECUTION_PREDICTION");
        await client.query("COMMIT");
        return mapPrediction(existing.rows[0]);
      }

      // Only a genuinely new prediction may consult the deadline, and only the
      // actual wall-clock time at this statement counts: a transaction that
      // began before the deadline must still fail when it reaches the insert
      // after it. The authority trigger independently enforces the same bound.
      const clock = await client.query<{ now: Date | string }>(
        "SELECT clock_timestamp() AS now",
      );
      const nowMs = asTime(clock.rows[0]!.now);
      if (nowMs < decisionAtMs)
        throw new Error("FUNDED_EXECUTION_PREDICTION_PRECEDES_DECISION");
      if (nowMs > Date.parse(input.deadlineAt))
        throw new Error("FUNDED_EXECUTION_PREDICTION_AFTER_DEADLINE");

      const inserted = await client.query<PredictionRow>(
        `INSERT INTO funded_execution_prediction(
           market_id,currency,model_id,model_version,model_type,artifact_digest,
           cohort_digest,feature_version,source_kind,run_id,observation_id,
           decision_sequence,decision_input_digest,decision_at,deadline_at,
           output,warnings,digest)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18)
         ON CONFLICT (model_id, run_id, observation_id, decision_sequence)
         DO NOTHING
         RETURNING ${PREDICTION_COLUMNS}`,
        [
          input.marketId,
          input.currency,
          challenger.id,
          challenger.model_version,
          challenger.model_type,
          challenger.artifact_digest,
          challenger.cohort_digest,
          challenger.feature_version,
          input.sourceKind,
          input.runId,
          input.observationId,
          input.expectedDecisionSequence,
          input.expectedDecisionInputDigest,
          asIso(decision.decision_at),
          input.deadlineAt,
          JSON.stringify(input.output),
          JSON.stringify(input.warnings),
          digest,
        ],
      );
      if (!inserted.rows[0]) {
        // Another transaction won the insert race. Reload the durable winner
        // and resolve by content digest: an exact retry returns the existing
        // immutable record, while a different digest stays a visible conflict.
        const raced = await client.query<PredictionRow>(
          `${PREDICTION_SELECT}
            WHERE model_id=$1 AND run_id=$2 AND observation_id=$3 AND decision_sequence=$4`,
          [
            input.challengerId,
            input.runId,
            input.observationId,
            input.expectedDecisionSequence,
          ],
        );
        const winner = raced.rows[0];
        if (!winner)
          throw new Error("FUNDED_EXECUTION_PREDICTION_WRITE_CONFLICT");
        if (winner.digest !== digest)
          throw new Error("CONFLICTING_FUNDED_EXECUTION_PREDICTION");
        await client.query("COMMIT");
        return mapPrediction(winner);
      }
      await client.query("COMMIT");
      return mapPrediction(inserted.rows[0]);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

const PREDICTION_COLUMNS = `market_id,currency,model_id,model_version,model_type,artifact_digest,
  cohort_digest,feature_version,source_kind,run_id,observation_id,decision_sequence,
  decision_input_digest,decision_at,prediction_at,deadline_at,output,warnings,digest`;

const PREDICTION_SELECT = `SELECT ${PREDICTION_COLUMNS} FROM funded_execution_prediction`;

/**
 * Content identity of a prediction. Database-owned times (`prediction_at`,
 * `created_at`) are excluded so an exact retry resolves to the same digest
 * while a changed output, model, decision or deadline fails as a conflict.
 */
export function predictionDigest(value: unknown): string {
  return contentHash(value);
}

/**
 * Transaction-scoped advisory lock identity for one exact prediction. It binds
 * the challenger and decision ownership so concurrent writers for the same
 * prediction serialize before the durable lookup.
 */
export function predictionLockIdentity(input: {
  challengerId: string;
  runId: string;
  observationId: string;
  decisionSequence: number;
}): string {
  return [
    "funded-execution-prediction",
    input.challengerId,
    input.runId,
    input.observationId,
    String(input.decisionSequence),
  ].join(":");
}

function mapPrediction(row: PredictionRow): FundedExecutionPredictionRecord {
  return fundedExecutionPredictionRecordSchema.parse({
    predictionVersion: FUNDED_EXECUTION_PREDICTION_VERSION,
    marketId: row.market_id,
    currency: row.currency,
    model: {
      modelId: row.model_id,
      modelVersion: row.model_version,
      modelType: row.model_type,
      artifactDigest: row.artifact_digest,
      cohortDigest: row.cohort_digest,
      featureVersion: row.feature_version,
    },
    runId: row.run_id,
    observationId: row.observation_id,
    decisionSequence: Number(row.decision_sequence),
    decisionInputDigest: row.decision_input_digest,
    sourceKind: row.source_kind,
    predictionAt: asIso(row.prediction_at),
    deadlineAt: asIso(row.deadline_at),
    output: row.output,
    warnings: row.warnings,
    digest: row.digest,
  });
}

function asIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function asTime(value: Date | string): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
