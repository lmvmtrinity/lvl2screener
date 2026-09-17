import {
  paperTrainingEvidenceCohortSchema,
  paperEvidenceTrainingRowSchema,
  statisticalTrainingDatasetSchema,
  type PaperEvidenceCohort,
  type PaperEvidenceResearchQualification,
  type PaperEvidenceTrainingRow,
  type StatisticalTrainingDataset,
  type ResearchEvidenceBinding,
  type DatasetResearchDerivation,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { PostgresResearchEvidenceStore } from "../backtests/research-evidence-repository.js";

type CohortRow = {
  market_id: "CA_TSX" | "US_EQUITIES";
  strategy: string;
  strategy_version: string;
  profile_config_id: string;
  config_version: string;
  execution_model_version: string;
  assumptions: unknown;
  closed_quote_count: number;
  positives: number;
  negatives: number;
  first_signal_at: Date | null;
  last_signal_at: Date | null;
  missing_feature_count: number;
  signal_semantics_version: string | null;
  replay_scope: string | null;
};
type TrainingRow = {
  market_id: "CA_TSX" | "US_EQUITIES";
  execution_id: string;
  observation_id: string;
  instrument_id: string;
  signal_timestamp: Date;
  label_available_at: Date;
  score: number;
  atr_pct: number | string | null;
  rvol_at_time: number | string | null;
  r_multiple: number | string;
};
type DatasetRow = {
  id: string;
  market_id: "CA_TSX" | "US_EQUITIES";
  source_kind: "PAPER_EVIDENCE";
  policy_version: string;
  cohort: unknown;
  requested_cutoff: Date;
  effective_cutoff: Date;
  source_digest: string;
  source_row_count: number;
  excluded_counts: unknown;
  research_qualification: unknown;
  research_evidence: unknown;
  research_derivation: unknown;
  created_at: Date;
};

export interface PaperEvidenceTrainingStore {
  countDatasets(): Promise<number>;
  listCohorts(): Promise<PaperEvidenceCohort[]>;
  rowsFor(
    cohort: PaperEvidenceCohort,
    cutoff: Date,
  ): Promise<PaperEvidenceTrainingRow[]>;
  /**
   * A broader, but still compatible, prior population for empirical-payoff
   * shrinkage.  It never crosses strategy, profile, execution model, or the
   * immutable assumptions snapshot.
   */
  compatibleBaselineRowsFor?(
    cohort: PaperEvidenceCohort,
    cutoff: Date,
  ): Promise<PaperEvidenceTrainingRow[]>;
  createDataset(input: {
    policyVersion: string;
    cohort: PaperEvidenceCohort;
    requestedCutoff: Date;
    effectiveCutoff: Date;
    sourceDigest: string;
    excludedCounts: Record<string, number>;
    researchQualification: PaperEvidenceResearchQualification;
    researchEvidence?: ResearchEvidenceBinding;
    researchDerivation?: DatasetResearchDerivation | null;
    rows: PaperEvidenceTrainingRow[];
  }): Promise<StatisticalTrainingDataset>;
  getDataset(id: string): Promise<StatisticalTrainingDataset | undefined>;
  latestDatasetFor(
    cohort: PaperEvidenceCohort,
  ): Promise<StatisticalTrainingDataset | undefined>;
  listDatasetRows(id: string): Promise<PaperEvidenceTrainingRow[]>;
}

/**
 * Reads only completed, LIVE, QUOTE evidence. This repository deliberately
 * does not share the reporting aggregate queries: training membership must be
 * explicit, ordered, and reproducible.
 */
export class PostgresPaperEvidenceTrainingStore implements PaperEvidenceTrainingStore {
  constructor(private readonly pool: Pool) {}

  async countDatasets(): Promise<number> {
    const result = await this.pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM statistical_training_dataset WHERE source_kind='PAPER_EVIDENCE'",
    );
    return Number(result.rows[0]!.count);
  }

  async listCohorts(): Promise<PaperEvidenceCohort[]> {
    const result = await this.pool.query<CohortRow>(COHORT_SQL);
    return result.rows.map(mapCohort);
  }

  async rowsFor(
    cohort: PaperEvidenceCohort,
    cutoff: Date,
  ): Promise<PaperEvidenceTrainingRow[]> {
    const result = await this.pool.query<TrainingRow>(ROWS_SQL, [
      cohort.strategy,
      cohort.marketId,
      cohort.strategyVersion,
      cohort.profileConfigId,
      cohort.configVersion,
      cohort.executionModelVersion,
      JSON.stringify(cohort.assumptions),
      cohort.signalSemanticsVersion ?? "UNKNOWN",
      cohort.replayScope ?? "UNKNOWN",
      cutoff,
    ]);
    return result.rows.map(mapTrainingRow);
  }

  async compatibleBaselineRowsFor(
    cohort: PaperEvidenceCohort,
    cutoff: Date,
  ): Promise<PaperEvidenceTrainingRow[]> {
    const result = await this.pool.query<TrainingRow>(BASELINE_ROWS_SQL, [
      cohort.strategy,
      cohort.marketId,
      cohort.profileConfigId,
      cohort.executionModelVersion,
      JSON.stringify(cohort.assumptions),
      cohort.signalSemanticsVersion ?? "UNKNOWN",
      cohort.replayScope ?? "UNKNOWN",
      cutoff,
    ]);
    return result.rows.map(mapTrainingRow);
  }

  async createDataset(input: {
    policyVersion: string;
    cohort: PaperEvidenceCohort;
    requestedCutoff: Date;
    effectiveCutoff: Date;
    sourceDigest: string;
    excludedCounts: Record<string, number>;
    researchQualification: PaperEvidenceResearchQualification;
    researchEvidence?: ResearchEvidenceBinding;
    researchDerivation?: DatasetResearchDerivation | null;
    rows: PaperEvidenceTrainingRow[];
  }): Promise<StatisticalTrainingDataset> {
    if (input.rows.some((row) => row.marketId !== input.cohort.marketId)) {
      throw new Error(
        "A training dataset cannot contain evidence from another market",
      );
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<DatasetRow>(
        `INSERT INTO statistical_training_dataset
          (market_id,source_kind,policy_version,cohort,requested_cutoff,effective_cutoff,source_digest,source_row_count,excluded_counts,research_qualification,research_evidence,research_derivation)
         VALUES ($1,'PAPER_EVIDENCE',$2,$3::jsonb,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb)
         ON CONFLICT(source_digest) DO NOTHING
         RETURNING id,market_id,source_kind,policy_version,cohort,requested_cutoff,effective_cutoff,source_digest,source_row_count,excluded_counts,research_qualification,research_evidence,research_derivation,created_at`,
        [
          input.cohort.marketId,
          input.policyVersion,
          JSON.stringify(input.cohort),
          input.requestedCutoff,
          input.effectiveCutoff,
          input.sourceDigest,
          input.rows.length,
          JSON.stringify(input.excludedCounts),
          JSON.stringify(input.researchQualification),
          input.researchEvidence
            ? JSON.stringify(input.researchEvidence)
            : null,
          input.researchDerivation
            ? JSON.stringify(input.researchDerivation)
            : null,
        ],
      );
      if (!inserted.rows[0]) {
        const existing = await client.query<DatasetRow>(
          `SELECT id,market_id,source_kind,policy_version,cohort,requested_cutoff,effective_cutoff,source_digest,source_row_count,excluded_counts,research_qualification,research_evidence,research_derivation,created_at
             FROM statistical_training_dataset WHERE source_digest=$1`,
          [input.sourceDigest],
        );
        await client.query("COMMIT");
        return mapDataset(existing.rows[0]!);
      }
      const dataset = inserted.rows[0];
      if (input.researchEvidence)
        await new PostgresResearchEvidenceStore(this.pool).bindWithClient(
          client,
          {
            kind: "DATASET",
            id: dataset.id,
            marketId: input.cohort.marketId,
          },
          input.researchEvidence,
        );
      for (const [ordinal, row] of input.rows.entries()) {
        await client.query(
          `INSERT INTO statistical_training_dataset_member(dataset_id,ordinal,source_key,signal_timestamp,normalized_row)
           VALUES($1,$2,$3,$4,$5::jsonb)`,
          [
            dataset.id,
            ordinal,
            row.sourceKey,
            row.signalTimestamp,
            JSON.stringify(row),
          ],
        );
      }
      await client.query("COMMIT");
      return mapDataset(dataset);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getDataset(
    id: string,
  ): Promise<StatisticalTrainingDataset | undefined> {
    const result = await this.pool.query<DatasetRow>(
      `SELECT id,market_id,source_kind,policy_version,cohort,requested_cutoff,effective_cutoff,source_digest,source_row_count,excluded_counts,research_qualification,research_evidence,research_derivation,created_at
         FROM statistical_training_dataset WHERE id=$1`,
      [id],
    );
    return result.rows[0] ? mapDataset(result.rows[0]) : undefined;
  }
  async latestDatasetFor(
    cohort: PaperEvidenceCohort,
  ): Promise<StatisticalTrainingDataset | undefined> {
    const result = await this.pool.query<DatasetRow>(
      `SELECT id,market_id,source_kind,policy_version,cohort,requested_cutoff,effective_cutoff,source_digest,source_row_count,excluded_counts,research_qualification,research_evidence,research_derivation,created_at
         FROM statistical_training_dataset WHERE market_id=$1 AND cohort=$2::jsonb
         ORDER BY created_at DESC LIMIT 1`,
      [cohort.marketId, JSON.stringify(cohort)],
    );
    return result.rows[0] ? mapDataset(result.rows[0]) : undefined;
  }

  async listDatasetRows(id: string): Promise<PaperEvidenceTrainingRow[]> {
    const result = await this.pool.query<{ normalized_row: unknown }>(
      `SELECT normalized_row FROM statistical_training_dataset_member
        WHERE dataset_id=$1 ORDER BY ordinal`,
      [id],
    );
    return result.rows.map((row) =>
      paperEvidenceTrainingRowSchema.parse(row.normalized_row),
    );
  }
}

const COHORT_SQL = `
  SELECT r.market_id,o.strategy_key AS strategy,o.strategy_version,o.profile_config_id,o.config_version,
         r.execution_model_version,r.assumptions,
         COALESCE(o.source_event_payload->>'signalSemanticsVersion','UNKNOWN') AS signal_semantics_version,
         COALESCE(r.assumptions->>'evidenceScope','UNKNOWN') AS replay_scope,
         count(*)::int AS closed_quote_count,
         count(*) FILTER (WHERE e.r_multiple > 0)::int AS positives,
         count(*) FILTER (WHERE e.r_multiple <= 0)::int AS negatives,
         min(o.signal_timestamp) AS first_signal_at,max(o.signal_timestamp) AS last_signal_at,
         count(*) FILTER (WHERE o.feature_snapshot->>'atrPct' IS NULL OR o.feature_snapshot->>'rvolAtTime' IS NULL)::int AS missing_feature_count
    FROM paper_execution e
    JOIN paper_signal_observation o ON o.id=e.observation_id
    JOIN paper_bot_run r ON r.id=o.run_id
   WHERE r.source='LIVE' AND r.status='COMPLETED'
     AND e.model='QUOTE' AND e.status='CLOSED' AND e.r_multiple IS NOT NULL
  GROUP BY r.market_id,o.strategy_key,o.strategy_version,o.profile_config_id,o.config_version,
            r.execution_model_version,r.assumptions,
            COALESCE(o.source_event_payload->>'signalSemanticsVersion','UNKNOWN'),
            COALESCE(r.assumptions->>'evidenceScope','UNKNOWN')
   ORDER BY max(o.signal_timestamp) DESC`;

const ROWS_SQL = `
  SELECT r.market_id,e.id AS execution_id,o.id AS observation_id,o.instrument_id,o.signal_timestamp,
         e.exit_time AS label_available_at,o.score,
         NULLIF(o.feature_snapshot->>'atrPct','') AS atr_pct,
         NULLIF(o.feature_snapshot->>'rvolAtTime','') AS rvol_at_time,e.r_multiple
    FROM paper_execution e
    JOIN paper_signal_observation o ON o.id=e.observation_id
    JOIN paper_bot_run r ON r.id=o.run_id
   WHERE r.source='LIVE' AND r.status='COMPLETED'
     AND e.model='QUOTE' AND e.status='CLOSED' AND e.r_multiple IS NOT NULL
     AND o.strategy_key=$1 AND r.market_id=$2 AND o.strategy_version=$3 AND o.profile_config_id=$4
     AND o.config_version=$5 AND r.execution_model_version=$6 AND r.assumptions=$7::jsonb
     AND COALESCE(o.source_event_payload->>'signalSemanticsVersion','UNKNOWN')=$8
     AND COALESCE(r.assumptions->>'evidenceScope','UNKNOWN')=$9
     AND o.signal_timestamp < $10 AND e.exit_time <= $10
   ORDER BY o.signal_timestamp,e.id`;

const BASELINE_ROWS_SQL = `
  SELECT r.market_id,e.id AS execution_id,o.id AS observation_id,o.instrument_id,o.signal_timestamp,
         e.exit_time AS label_available_at,o.score,
         NULLIF(o.feature_snapshot->>'atrPct','') AS atr_pct,
         NULLIF(o.feature_snapshot->>'rvolAtTime','') AS rvol_at_time,e.r_multiple
    FROM paper_execution e
    JOIN paper_signal_observation o ON o.id=e.observation_id
    JOIN paper_bot_run r ON r.id=o.run_id
   WHERE r.source='LIVE' AND r.status='COMPLETED'
     AND e.model='QUOTE' AND e.status='CLOSED' AND e.r_multiple IS NOT NULL
     AND o.strategy_key=$1 AND r.market_id=$2 AND o.profile_config_id=$3
     AND r.execution_model_version=$4 AND r.assumptions=$5::jsonb
     AND COALESCE(o.source_event_payload->>'signalSemanticsVersion','UNKNOWN')=$6
     AND COALESCE(r.assumptions->>'evidenceScope','UNKNOWN')=$7
     AND o.signal_timestamp < $8 AND e.exit_time <= $8
   ORDER BY o.signal_timestamp,e.id`;

function mapCohort(row: CohortRow): PaperEvidenceCohort {
  return paperTrainingEvidenceCohortSchema.parse({
    marketId: row.market_id,
    strategy: row.strategy,
    strategyVersion: row.strategy_version,
    profileConfigId: row.profile_config_id,
    configVersion: row.config_version,
    executionModelVersion: row.execution_model_version,
    assumptions: row.assumptions,
    closedQuoteCount: Number(row.closed_quote_count),
    positives: Number(row.positives),
    negatives: Number(row.negatives),
    firstSignalAt: iso(row.first_signal_at),
    lastSignalAt: iso(row.last_signal_at),
    missingFeatureCount: Number(row.missing_feature_count),
    signalSemanticsVersion: row.signal_semantics_version ?? "UNKNOWN",
    replayScope: row.replay_scope ?? "UNKNOWN",
  });
}
function mapTrainingRow(row: TrainingRow): PaperEvidenceTrainingRow {
  return paperEvidenceTrainingRowSchema.parse({
    marketId: row.market_id,
    sourceKey: `paper_execution:${row.execution_id}`,
    executionId: row.execution_id,
    observationId: row.observation_id,
    instrumentId: row.instrument_id,
    signalTimestamp: row.signal_timestamp.toISOString(),
    labelAvailableAt: row.label_available_at.toISOString(),
    deterministicScore: Number(row.score),
    atrPct: numeric(row.atr_pct),
    rvolAtTime: numeric(row.rvol_at_time),
    rMultiple: Number(row.r_multiple),
  });
}
function mapDataset(row: DatasetRow): StatisticalTrainingDataset {
  return statisticalTrainingDatasetSchema.parse({
    id: row.id,
    marketId: row.market_id,
    sourceKind: row.source_kind,
    policyVersion: row.policy_version,
    cohort: row.cohort,
    requestedCutoff: row.requested_cutoff.toISOString(),
    effectiveCutoff: row.effective_cutoff.toISOString(),
    sourceDigest: row.source_digest,
    sourceRowCount: Number(row.source_row_count),
    excludedCounts: row.excluded_counts,
    researchQualification: row.research_qualification,
    researchEvidence: row.research_evidence ?? null,
    researchDerivation: row.research_derivation ?? null,
    createdAt: row.created_at.toISOString(),
  });
}
const iso = (value: Date | null) => value?.toISOString() ?? null;
const numeric = (value: number | string | null) =>
  value === null ? null : Number(value);
