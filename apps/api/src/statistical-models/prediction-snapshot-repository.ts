import {
  paperModelForwardMonitoringSchema,
  type PaperModelForwardMonitoring,
  type StatisticalPrediction,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";

export interface PredictionSnapshotStore {
  insert(input: {
    observationId: string;
    modelId: string;
    modelVersion: string;
    strategy: string;
    input: unknown;
    prediction: StatisticalPrediction;
  }): Promise<void>;
  monitoring(): Promise<PaperModelForwardMonitoring[]>;
}

export class PostgresPredictionSnapshotStore implements PredictionSnapshotStore {
  constructor(private readonly pool: Pool) {}
  async insert(input: {
    observationId: string;
    modelId: string;
    modelVersion: string;
    strategy: string;
    input: unknown;
    prediction: StatisticalPrediction;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO paper_model_prediction_snapshot
        (observation_id,model_id,model_version,strategy_name,input_snapshot,prediction)
       VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)
       ON CONFLICT(observation_id,model_id,model_version) DO NOTHING`,
      [
        input.observationId,
        input.modelId,
        input.modelVersion,
        input.strategy,
        JSON.stringify(input.input),
        JSON.stringify(input.prediction),
      ],
    );
  }
  async monitoring(): Promise<PaperModelForwardMonitoring[]> {
    const result = await this.pool.query<{
      model_id: string;
      model_version: string;
      strategy_name: string;
      predictions: number;
      closed_outcomes: number;
      positives: number;
      observed_win_rate: number | null;
      average_predicted_probability: number | null;
      brier_score: number | null;
      first_prediction_at: Date | null;
      last_prediction_at: Date | null;
    }>(`SELECT s.model_id,s.model_version,s.strategy_name,
      count(*)::int AS predictions,
      count(e.id) FILTER (WHERE e.status='CLOSED')::int AS closed_outcomes,
      count(e.id) FILTER (WHERE e.status='CLOSED' AND e.r_multiple>0)::int AS positives,
      avg(CASE WHEN e.status='CLOSED' THEN CASE WHEN e.r_multiple>0 THEN 1.0 ELSE 0.0 END END) AS observed_win_rate,
      avg((s.prediction->>'setupProbability')::numeric) AS average_predicted_probability,
      avg(CASE WHEN e.status='CLOSED' THEN power((s.prediction->>'setupProbability')::numeric - CASE WHEN e.r_multiple>0 THEN 1 ELSE 0 END, 2) END) AS brier_score,
      min(s.created_at) AS first_prediction_at,max(s.created_at) AS last_prediction_at
      FROM paper_model_prediction_snapshot s
      LEFT JOIN paper_execution e ON e.observation_id=s.observation_id AND e.model='QUOTE'
      GROUP BY s.model_id,s.model_version,s.strategy_name
      ORDER BY max(s.created_at) DESC`);
    return result.rows.map((row) =>
      paperModelForwardMonitoringSchema.parse({
        modelId: row.model_id,
        modelVersion: row.model_version,
        strategy: row.strategy_name,
        predictions: Number(row.predictions),
        closedOutcomes: Number(row.closed_outcomes),
        positives: Number(row.positives),
        observedWinRate:
          row.observed_win_rate === null ? null : Number(row.observed_win_rate),
        averagePredictedProbability:
          row.average_predicted_probability === null
            ? null
            : Number(row.average_predicted_probability),
        brierScore: row.brier_score === null ? null : Number(row.brier_score),
        firstPredictionAt: row.first_prediction_at?.toISOString() ?? null,
        lastPredictionAt: row.last_prediction_at?.toISOString() ?? null,
      }),
    );
  }
}
