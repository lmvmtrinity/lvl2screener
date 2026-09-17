import {
  challengerExperimentSchema,
  type ChallengerExperiment,
  type ChallengerScope,
  type ExperimentAction,
} from "@tsx-scanner/contracts";
import type { MarketId } from "@tsx-scanner/contracts";
import { featureSnapshotSchema } from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import { contentHash } from "../backtests/research-coverage.js";
import type {
  ChallengerObservationCapture,
  PaperSignalObservation,
} from "../paper-bot/paper-bot-repository.js";
import {
  PostgresChallengerAttemptStore,
  type ChallengerPredictionInput,
} from "./challenger-attempt-repository.js";
import {
  nextExperimentState,
  ChallengerExperimentError,
  validateAcceptance,
  type ChallengerExperimentStore,
  type ChallengerModelSnapshot,
} from "./challenger-experiment-service.js";
import {
  challengerPopulationPredicate,
  challengerActiveBoundaries,
  challengerTimelyCapturePredicate,
} from "./challenger-population.js";
import { challengerScopeSchema } from "@tsx-scanner/contracts";
import {
  PostgresChallengerAcceptanceRepository,
  type ChallengerAcceptanceRecords,
} from "./challenger-acceptance-repository.js";

type ExperimentRow = {
  id: string;
  model_id: string;
  model_version: string;
  artifact_hash: string;
  market_id: MarketId;
  currency: "CAD" | "USD";
  scope: unknown;
  research_evidence: unknown;
  baseline_identity_hash: string;
  acceptance_plan_hash: string;
  starts_at: Date;
  ends_at: Date;
  max_prediction_lag_ms: number;
  registered_at: Date;
  registration_request_id?: string;
  registration_request_hash?: string;
  state?: string;
};

export class PostgresChallengerExperimentStore
  implements ChallengerExperimentStore, ChallengerObservationCapture
{
  constructor(private readonly pool: Pool) {}

  getAcceptance(baselineHash: string, planHash: string, marketId: MarketId) {
    return new PostgresChallengerAcceptanceRepository(this.pool).get(
      baselineHash,
      planHash,
      marketId,
    );
  }

  async getRegistration(
    requestId: string,
    requestHash: string,
  ): Promise<ChallengerExperiment | null> {
    const result = await this.pool.query<{
      id: string;
      registration_request_hash: string;
    }>(
      "SELECT id,registration_request_hash FROM challenger_experiment WHERE registration_request_id=$1",
      [requestId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.registration_request_hash !== requestHash)
      throw new Error("EXPERIMENT_REGISTRATION_IDEMPOTENCY_CONFLICT");
    return this.get(row.id);
  }

  async getModel(id: string): Promise<ChallengerModelSnapshot | null> {
    const result = await this.pool.query<{
      id: string;
      market_id: MarketId;
      strategy_name: string;
      model_version: string;
      status: string;
      active: boolean;
      artifact: unknown;
      completed_at: Date | null;
      research_evidence: unknown;
      research_evidence_verified: boolean;
      model_scope: unknown;
      scope_artifact_hash: string | null;
      source_scope: unknown;
      training_label_cutoff_at: Date | null;
    }>(
      `SELECT m.id,m.market_id,m.strategy_name,m.model_version,m.status,m.active,
              m.artifact,m.completed_at,m.research_evidence,
              ms.scope AS model_scope,
              ms.artifact_hash AS scope_artifact_hash,
              ms.scope AS source_scope,
              ms.training_label_cutoff_at,
              EXISTS (
                SELECT 1
                  FROM research_evidence_binding b
                  JOIN research_coverage_report c
                    ON c.hash=b.coverage_report_hash
                   AND c.market_id=b.market_id
                   AND c.input_hash=b.input_hash
                 WHERE b.owner_kind='MODEL'
                   AND b.owner_id=m.id
                   AND b.market_id=m.market_id
                   AND b.binding=m.research_evidence
                   AND c.status='VERIFIED'
                   AND (m.source_kind<>'PAPER_EVIDENCE' OR d.research_evidence=m.research_evidence)
              ) AS research_evidence_verified
         FROM statistical_model m
         LEFT JOIN statistical_training_dataset d ON d.id=m.training_dataset_id
         LEFT JOIN backtest_run b ON b.id=m.backtest_run_id
         LEFT JOIN challenger_model_scope ms ON ms.model_id=m.id
           AND ms.artifact_hash IS NOT NULL AND ms.source_digest IS NOT NULL
           AND ms.source_id=COALESCE(m.training_dataset_id,m.backtest_run_id)
           AND (m.source_kind<>'PAPER_EVIDENCE' OR ms.source_digest=d.source_digest)
        WHERE m.id=$1`,
      [id],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      marketId: row.market_id,
      strategy: row.strategy_name as ChallengerScope["strategy"],
      modelVersion: row.model_version,
      status: row.status,
      active: row.active,
      artifact: row.artifact,
      completedAt: row.completed_at?.toISOString() ?? null,
      researchEvidence: row.research_evidence,
      researchEvidenceVerified: row.research_evidence_verified,
      scope:
        row.scope_artifact_hash === contentHash(row.artifact)
          ? resolvedScope({
              ...row,
              source_scope: row.model_scope ?? row.source_scope,
            })
          : null,
      trainingLabelCutoffAt:
        row.training_label_cutoff_at?.toISOString() ?? null,
    };
  }

  async register(
    input: ChallengerExperiment,
    requestId = input.id,
    registrationHash?: string,
  ): Promise<ChallengerExperiment> {
    const value = challengerExperimentSchema.parse(input);
    const requestHash = registrationHash ?? contentHash(value);
    try {
      const result = await this.pool.query<ExperimentRow>(
        `INSERT INTO challenger_experiment(
           id,model_id,model_version,artifact_hash,market_id,currency,scope,
           research_evidence,baseline_identity_hash,acceptance_plan_hash,
           starts_at,ends_at,max_prediction_lag_ms,registered_at,
           registration_request_id,registration_request_hash
       ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16)
         RETURNING id,model_id,model_version,artifact_hash,market_id,currency,scope,
           research_evidence,baseline_identity_hash,acceptance_plan_hash,starts_at,
           ends_at,max_prediction_lag_ms,registered_at`,
        [
          value.id,
          value.modelId,
          value.modelVersion,
          value.artifactHash,
          value.scope.marketId,
          value.scope.currency,
          JSON.stringify(value.scope),
          JSON.stringify(value.researchEvidence),
          value.baselineIdentityHash,
          value.acceptancePlanHash,
          value.startsAt,
          value.endsAt,
          value.maxPredictionLagMs,
          value.registeredAt,
          requestId,
          requestHash,
        ],
      );
      return this.readRow(result.rows[0]!, "REGISTERED");
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.pool.query<ExperimentRow>(
        `SELECT id,model_id,model_version,artifact_hash,market_id,currency,scope,
                research_evidence,baseline_identity_hash,acceptance_plan_hash,
                starts_at,ends_at,max_prediction_lag_ms,registered_at,
                registration_request_hash
           FROM challenger_experiment WHERE registration_request_id=$1`,
        [requestId],
      );
      const row = existing.rows[0];
      if (!row || row.registration_request_hash !== requestHash)
        throw new Error("EXPERIMENT_REGISTRATION_IDEMPOTENCY_CONFLICT");
      return this.readRow(row, "REGISTERED");
    }
  }

  async registerWithAcceptance(
    input: ChallengerExperiment,
    records: ChallengerAcceptanceRecords,
    requestId = input.id,
    registrationHash?: string,
  ): Promise<ChallengerExperiment> {
    const value = challengerExperimentSchema.parse(input);
    const requestHash = registrationHash ?? contentHash(value);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const model = await client.query<{
        active: boolean;
        status: string;
        model_version: string;
        artifact: unknown;
      }>(
        "SELECT active,status,model_version,artifact FROM statistical_model WHERE id=$1 FOR SHARE",
        [value.modelId],
      );
      const source = model.rows[0];
      if (
        !source ||
        source.active ||
        source.status !== "COMPLETED" ||
        source.model_version !== value.modelVersion ||
        contentHash(source.artifact) !== value.artifactHash
      )
        throw new Error("EXPERIMENT_MODEL_SCOPE");
      validateAcceptance(value, records);
      await new PostgresChallengerAcceptanceRepository(client).persist(
        value.modelId,
        value.scope,
        records,
      );
      const registrationClock = await client.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      value.registeredAt = registrationClock.rows[0]!.now.toISOString();
      if (Date.parse(value.startsAt) < Date.parse(value.registeredAt))
        throw new ChallengerExperimentError(
          "EXPERIMENT_START_NOT_PROSPECTIVE",
          "The frozen window must start no earlier than database registration",
        );
      const result = await client.query<ExperimentRow>(
        `INSERT INTO challenger_experiment(
           id,model_id,model_version,artifact_hash,market_id,currency,scope,
           research_evidence,baseline_identity_hash,acceptance_plan_hash,
           starts_at,ends_at,max_prediction_lag_ms,registered_at,
           registration_request_id,registration_request_hash
         ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT(registration_request_id) DO NOTHING
         RETURNING id,model_id,model_version,artifact_hash,market_id,currency,scope,
           research_evidence,baseline_identity_hash,acceptance_plan_hash,starts_at,
           ends_at,max_prediction_lag_ms,registered_at`,
        [
          value.id,
          value.modelId,
          value.modelVersion,
          value.artifactHash,
          value.scope.marketId,
          value.scope.currency,
          JSON.stringify(value.scope),
          JSON.stringify(value.researchEvidence),
          value.baselineIdentityHash,
          value.acceptancePlanHash,
          value.startsAt,
          value.endsAt,
          value.maxPredictionLagMs,
          value.registeredAt,
          requestId,
          requestHash,
        ],
      );
      if (result.rows[0]) {
        await client.query("COMMIT");
        return this.readRow(result.rows[0], "REGISTERED");
      }
      const existing = await client.query<ExperimentRow>(
        `SELECT id,model_id,model_version,artifact_hash,market_id,currency,scope,
                research_evidence,baseline_identity_hash,acceptance_plan_hash,
                starts_at,ends_at,max_prediction_lag_ms,registered_at,
                registration_request_hash
           FROM challenger_experiment WHERE registration_request_id=$1`,
        [requestId],
      );
      const row = existing.rows[0];
      if (!row || row.registration_request_hash !== requestHash)
        throw new Error("EXPERIMENT_REGISTRATION_IDEMPOTENCY_CONFLICT");
      await client.query("COMMIT");
      return this.readRow(row, "REGISTERED");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<ChallengerExperiment | null> {
    const result = await this.pool.query<ExperimentRow & { state: string }>(
      `SELECT e.id,e.model_id,e.model_version,e.artifact_hash,e.market_id,e.currency,
              e.scope,e.research_evidence,e.baseline_identity_hash,e.acceptance_plan_hash,
              e.starts_at,e.ends_at,e.max_prediction_lag_ms,e.registered_at,
              COALESCE(t.state,'REGISTERED') AS state
         FROM challenger_experiment e
         LEFT JOIN LATERAL (
           SELECT state FROM challenger_experiment_transition
            WHERE experiment_id=e.id ORDER BY sequence DESC LIMIT 1
         ) t ON true
        WHERE e.id=$1`,
      [id],
    );
    return result.rows[0]
      ? this.readRow(result.rows[0], result.rows[0].state)
      : null;
  }

  async list(marketId: MarketId, limit = 100): Promise<ChallengerExperiment[]> {
    const result = await this.pool.query<ExperimentRow & { state: string }>(
      `SELECT e.id,e.model_id,e.model_version,e.artifact_hash,e.market_id,e.currency,
              e.scope,e.research_evidence,e.baseline_identity_hash,e.acceptance_plan_hash,
              e.starts_at,e.ends_at,e.max_prediction_lag_ms,e.registered_at,
              COALESCE(t.state,'REGISTERED') AS state
         FROM challenger_experiment e
         LEFT JOIN LATERAL (
           SELECT state FROM challenger_experiment_transition
            WHERE experiment_id=e.id ORDER BY sequence DESC LIMIT 1
         ) t ON true
        WHERE e.market_id=$1 ORDER BY e.registered_at DESC LIMIT $2`,
      [marketId, limit],
    );
    return result.rows.map((row) => this.readRow(row, row.state));
  }

  async transition(
    id: string,
    action: ExperimentAction,
    requestId: string,
  ): Promise<ChallengerExperiment> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const experiment = await client.query<ExperimentRow>(
        `SELECT id,model_id,model_version,artifact_hash,market_id,currency,scope,
                research_evidence,baseline_identity_hash,acceptance_plan_hash,
                starts_at,ends_at,max_prediction_lag_ms,registered_at
           FROM challenger_experiment WHERE id=$1 FOR UPDATE`,
        [id],
      );
      const row = experiment.rows[0];
      if (!row) throw new Error("EXPERIMENT_NOT_FOUND");
      const requestHash = contentHash({ action });
      const prior = await client.query<{ state: string; request_hash: string }>(
        `SELECT state,request_hash FROM challenger_experiment_transition
          WHERE experiment_id=$1 AND request_id=$2`,
        [id, requestId],
      );
      if (prior.rows[0]) {
        if (prior.rows[0].request_hash !== requestHash)
          throw new Error("EXPERIMENT_TRANSITION_IDEMPOTENCY_CONFLICT");
        await client.query("COMMIT");
        return (await this.get(id))!;
      }
      const current = await client.query<{ state: string }>(
        `SELECT state FROM challenger_experiment_transition
          WHERE experiment_id=$1 ORDER BY sequence DESC LIMIT 1`,
        [id],
      );
      const state = (current.rows[0]?.state ??
        "REGISTERED") as ChallengerExperiment["state"];
      const next = nextExperimentState(state, action);
      if (action === "START" || action === "RESUME") {
        const model = await client.query<{
          active: boolean;
          status: string;
          artifact: unknown;
          model_version: string;
          scope: unknown;
        }>(
          `SELECT m.active,m.status,m.artifact,m.model_version,s.scope
           FROM statistical_model m JOIN challenger_model_scope s ON s.model_id=m.id
           WHERE m.id=$1 AND s.artifact_hash IS NOT NULL AND s.training_label_cutoff_at<=$2::timestamptz FOR SHARE OF m`,
          [row.model_id, row.starts_at],
        );
        const source = model.rows[0];
        if (
          !source ||
          source.active ||
          source.status !== "COMPLETED" ||
          source.model_version !== row.model_version ||
          contentHash(source.artifact) !== row.artifact_hash ||
          contentHash(source.scope) !== contentHash(row.scope)
        )
          throw new Error("EXPERIMENT_MODEL_SCOPE");
        const records = await new PostgresChallengerAcceptanceRepository(
          client,
        ).get(
          row.baseline_identity_hash,
          row.acceptance_plan_hash,
          row.market_id,
        );
        if (!records) throw new Error("EXPERIMENT_ACCEPTANCE_PLAN_NOT_FOUND");
        validateAcceptance(this.readRow(row, state), records);
      }
      const sequence = await client.query<{ next: number }>(
        `SELECT COALESCE(max(sequence),0)+1 AS next
           FROM challenger_experiment_transition WHERE experiment_id=$1`,
        [id],
      );
      await client.query(
        `INSERT INTO challenger_experiment_transition(
           experiment_id,sequence,request_id,action,state,effective_at,request_hash
         ) VALUES($1,$2,$3,$4,$5,clock_timestamp(),$6)`,
        [id, sequence.rows[0]!.next, requestId, action, next, requestHash],
      );
      if (action === "REVOKE") {
        await client.query(
          `INSERT INTO challenger_outcome(
             experiment_id,observation_id,status,completed_at,outcome
           )
           SELECT a.experiment_id,a.observation_id,'EXPERIMENT_REVOKED',
                  clock_timestamp(),
                  jsonb_build_object(
                    'status','EXPERIMENT_REVOKED',
                    'completedAt',clock_timestamp(),
                    'reason','EXPERIMENT_REVOKED'
                  )
             FROM challenger_attempt a
            WHERE a.experiment_id=$1
              AND NOT EXISTS (
                SELECT 1 FROM challenger_outcome o
                 WHERE o.experiment_id=a.experiment_id
                   AND o.observation_id=a.observation_id
              )`,
          [id],
        );
      }
      await client.query("COMMIT");
      return (await this.get(id))!;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async captureForObservation(
    client: PoolClient,
    observation: PaperSignalObservation,
  ): Promise<void> {
    // A legacy observation has no database-owned capture time. It can remain
    // visible to paper reporting, but it cannot establish that a challenger
    // attempt was created prospectively.
    if (!observation.capturedAt) return;
    const features = featureSnapshotSchema.safeParse(
      observation.featureSnapshot,
    );
    if (!features.success) throw new Error("CHALLENGER_INPUT_INVALID");
    const candidates = await client.query<{
      experiment_id: string;
      model_version: string;
      max_prediction_lag_ms: number;
    }>(
      `WITH active_boundaries AS (${challengerActiveBoundaries})
       SELECT e.id AS experiment_id,e.model_version,e.max_prediction_lag_ms
         FROM challenger_experiment e
         JOIN active_boundaries t ON t.experiment_id=e.id
         JOIN challenger_baseline_record b ON b.identity_hash=e.baseline_identity_hash
         JOIN paper_signal_observation o ON o.id=$1
         JOIN paper_bot_run r ON r.id=o.run_id
        WHERE ${challengerPopulationPredicate}
          AND ${challengerTimelyCapturePredicate}
          AND NOT EXISTS(SELECT 1 FROM challenger_attempt a WHERE a.experiment_id=e.id AND a.observation_id=o.id)
        ORDER BY e.id FOR UPDATE OF e`,
      [observation.id],
    );
    const store = new PostgresChallengerAttemptStore(client);
    for (const candidate of candidates.rows) {
      const input: ChallengerPredictionInput = {
        marketId: observation.marketId,
        instrumentId: observation.instrumentId,
        symbol: observation.symbol,
        timestamp: observation.signalTimestamp,
        profileId: observation.profileId,
        profileName: observation.profileName,
        strategy:
          observation.strategyKey as ChallengerPredictionInput["strategy"],
        deterministicScore: observation.score,
        atrPct: features.data.atrPct,
        rvolAtTime: features.data.rvolAtTime,
        profileConfigId: observation.profileConfigId,
      };
      const observedAt = new Date(observation.signalTimestamp);
      const attempt = {
        experimentId: candidate.experiment_id,
        observationId: observation.id,
        modelVersion: candidate.model_version,
        inputHash: contentHash(input),
        observedAt: observedAt.toISOString(),
        recordedAt: new Date().toISOString(),
        deadlineAt: new Date(
          observedAt.getTime() + candidate.max_prediction_lag_ms,
        ).toISOString(),
      };
      // Challenger capture is optional evidence. Keep each compatible
      // experiment in its own savepoint so a failure for one candidate cannot
      // erase captures already made for other compatible experiments.
      await client.query("SAVEPOINT challenger_candidate_capture");
      try {
        await store.capture(attempt, input);
        await client.query("RELEASE SAVEPOINT challenger_candidate_capture");
      } catch {
        await client.query(
          "ROLLBACK TO SAVEPOINT challenger_candidate_capture",
        );
        await client.query("RELEASE SAVEPOINT challenger_candidate_capture");
        await client.query(
          `INSERT INTO challenger_capture_failure(experiment_id,observation_id,reason)
          VALUES($1,$2,'CAPTURE_FAILED') ON CONFLICT DO NOTHING`,
          [candidate.experiment_id, observation.id],
        );
      }
    }
  }

  private readRow(row: ExperimentRow, state: string): ChallengerExperiment {
    return challengerExperimentSchema.parse({
      id: row.id,
      modelId: row.model_id,
      modelVersion: row.model_version,
      artifactHash: row.artifact_hash,
      scope: row.scope,
      researchEvidence: row.research_evidence,
      baselineIdentityHash: row.baseline_identity_hash,
      acceptancePlanHash: row.acceptance_plan_hash,
      startsAt: row.starts_at.toISOString(),
      endsAt: row.ends_at.toISOString(),
      maxPredictionLagMs: row.max_prediction_lag_ms,
      registeredAt: row.registered_at.toISOString(),
      state,
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

function resolvedScope(row: {
  market_id: MarketId;
  strategy_name: string;
  model_version: string;
  source_scope: unknown;
}): ChallengerScope | null {
  if (typeof row.source_scope !== "object" || row.source_scope === null)
    return null;
  const source = row.source_scope as Record<string, unknown>;
  const direct = challengerScopeSchema.safeParse(source);
  if (direct.success) return direct.data;
  const assumptions = source.assumptions;
  if (typeof assumptions !== "object" || assumptions === null) return null;
  const parsed = challengerScopeSchema.safeParse({
    marketId: row.market_id,
    currency: row.market_id === "CA_TSX" ? "CAD" : "USD",
    strategy: row.strategy_name,
    strategyVersion: source.strategyVersion,
    profileConfigId: source.profileConfigId,
    configVersion: source.configVersion,
    executionModelVersion: source.executionModelVersion,
    executionAssumptionsHash: contentHash(assumptions),
    signalSemanticsVersion: source.signalSemanticsVersion,
    replayScope: source.replayScope,
  });
  return parsed.success ? parsed.data : null;
}
