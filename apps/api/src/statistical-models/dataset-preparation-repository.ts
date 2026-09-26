import {
  paperEvidenceResearchQualificationSchema,
  paperEvidenceTrainingRowSchema,
  paperTrainingEvidenceCohortSchema,
  type PaperEvidenceCohort,
  type PaperEvidenceResearchQualification,
  type PaperEvidenceTrainingRow,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { canonicalJson, contentHash } from "../backtests/research-coverage.js";

export type DatasetPreparation = {
  id: string;
  marketId: "CA_TSX" | "US_EQUITIES";
  cohort: PaperEvidenceCohort;
  requestedCutoff: string;
  effectiveCutoff: string;
  sourceDigest: string;
  excludedCounts: Record<string, number>;
  researchQualification: PaperEvidenceResearchQualification;
  rows: PaperEvidenceTrainingRow[];
  createdAt: string;
};

export type DatasetPreparationInput = {
  marketId: "CA_TSX" | "US_EQUITIES";
  cohort: PaperEvidenceCohort;
  requestedCutoff: Date;
  effectiveCutoff: Date;
  sourceDigest: string;
  excludedCounts: Record<string, number>;
  researchQualification: PaperEvidenceResearchQualification;
  rows: PaperEvidenceTrainingRow[];
};

export interface DatasetPreparationStore {
  create(input: DatasetPreparationInput): Promise<DatasetPreparation>;
  get(id: string): Promise<DatasetPreparation | undefined>;
  listPending(): Promise<DatasetPreparation[]>;
  findPending(
    cohort: PaperEvidenceCohort,
  ): Promise<DatasetPreparation | undefined>;
}

type PreparationRow = {
  id: string;
  market_id: "CA_TSX" | "US_EQUITIES";
  cohort: unknown;
  requested_cutoff: Date;
  effective_cutoff: Date;
  source_digest: string;
  excluded_counts: unknown;
  research_qualification: unknown;
  qualified_rows: unknown;
  created_at: Date;
  dataset_id: string | null;
  job_id: string | null;
  job_payload: unknown;
};

export class PostgresDatasetPreparationStore implements DatasetPreparationStore {
  constructor(private readonly pool: Pool) {}

  async create(input: DatasetPreparationInput): Promise<DatasetPreparation> {
    const cohort = paperTrainingEvidenceCohortSchema.parse(input.cohort);
    if (cohort.marketId !== input.marketId)
      throw new Error("DATASET_PREPARATION_MARKET_MISMATCH");
    const rows = input.rows.map((row) =>
      paperEvidenceTrainingRowSchema.parse(row),
    );
    if (rows.some((row) => row.marketId !== input.marketId))
      throw new Error("DATASET_PREPARATION_ROW_MARKET_MISMATCH");
    const qualification = paperEvidenceResearchQualificationSchema.parse(
      input.researchQualification,
    );
    if (!qualification.qualified)
      throw new Error("DATASET_PREPARATION_UNQUALIFIED");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const owner = {
        marketId: input.marketId,
        strategy: cohort.strategy,
        strategyVersion: cohort.strategyVersion,
        profileConfigId: cohort.profileConfigId,
        configVersion: cohort.configVersion,
        executionModelVersion: cohort.executionModelVersion,
        assumptions: cohort.assumptions,
        signalSemanticsVersion: cohort.signalSemanticsVersion ?? "UNKNOWN",
        replayScope: cohort.replayScope ?? "UNKNOWN",
      };
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`dataset-preparation:${contentHash(owner)}`],
      );
      const existingOwner = await client.query<PreparationRow>(
        `SELECT p.id,p.market_id,p.cohort,p.requested_cutoff,p.effective_cutoff,p.source_digest,
                p.excluded_counts,p.research_qualification,p.qualified_rows,p.created_at,
                d.id AS dataset_id,j.id AS job_id,j.request_payload AS job_payload
           FROM statistical_training_dataset_preparation p
           LEFT JOIN statistical_training_dataset d
             ON d.source_digest=p.source_digest
           LEFT JOIN research_job j
             ON j.job_type='STATISTICAL_TRAINING'
            AND j.idempotency_key='paper-evidence:' || p.source_digest
          WHERE p.market_id=$1
            AND p.cohort->>'strategy'=$2
            AND p.cohort->>'strategyVersion'=$3
            AND p.cohort->>'profileConfigId'=$4
            AND p.cohort->>'configVersion'=$5
            AND p.cohort->>'executionModelVersion'=$6
            AND p.cohort->'assumptions'=$7::jsonb
            AND COALESCE(p.cohort->>'signalSemanticsVersion','UNKNOWN')=$8
            AND COALESCE(p.cohort->>'replayScope','UNKNOWN')=$9
          ORDER BY p.created_at,p.id
          FOR UPDATE OF p`,
        [
          owner.marketId,
          owner.strategy,
          owner.strategyVersion,
          owner.profileConfigId,
          owner.configVersion,
          owner.executionModelVersion,
          JSON.stringify(owner.assumptions),
          owner.signalSemanticsVersion,
          owner.replayScope,
        ],
      );
      for (const ownerRow of existingOwner.rows) {
        const mapped = mapPreparation(ownerRow);
        assertTrainingJobOwnership(ownerRow, mapped);
        if (mapped.sourceDigest === input.sourceDigest) {
          assertPreparationMatches(mapped, input, cohort, rows, qualification);
          await client.query("COMMIT");
          return mapped;
        }
        if (!ownerRow.job_id || !ownerRow.dataset_id) {
          await client.query("COMMIT");
          return mapped;
        }
      }
      const inserted = await client.query<PreparationRow>(
        `INSERT INTO statistical_training_dataset_preparation
        (market_id,cohort,requested_cutoff,effective_cutoff,source_digest,
         excluded_counts,research_qualification,qualified_rows)
       VALUES($1,$2::jsonb,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)
       ON CONFLICT(source_digest) DO NOTHING
       RETURNING id,market_id,cohort,requested_cutoff,effective_cutoff,source_digest,
                 excluded_counts,research_qualification,qualified_rows,created_at`,
        [
          input.marketId,
          JSON.stringify(cohort),
          input.requestedCutoff,
          input.effectiveCutoff,
          input.sourceDigest,
          JSON.stringify(input.excludedCounts),
          JSON.stringify(qualification),
          JSON.stringify(rows),
        ],
      );
      if (inserted.rows[0]) {
        await client.query("COMMIT");
        return mapPreparation(inserted.rows[0]);
      }
      const existing = await client.query<PreparationRow>(
        `SELECT id,market_id,cohort,requested_cutoff,effective_cutoff,source_digest,
                excluded_counts,research_qualification,qualified_rows,created_at
           FROM statistical_training_dataset_preparation WHERE source_digest=$1
           FOR UPDATE`,
        [input.sourceDigest],
      );
      const row = existing.rows[0];
      if (!row) throw new Error("DATASET_PREPARATION_SAVE_RACE");
      const mapped = mapPreparation(row);
      assertPreparationMatches(mapped, input, cohort, rows, qualification);
      await client.query("COMMIT");
      return mapped;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(id: string): Promise<DatasetPreparation | undefined> {
    const result = await this.pool.query<PreparationRow>(
      `SELECT id,market_id,cohort,requested_cutoff,effective_cutoff,source_digest,
              excluded_counts,research_qualification,qualified_rows,created_at
         FROM statistical_training_dataset_preparation WHERE id=$1`,
      [id],
    );
    return result.rows[0] ? mapPreparation(result.rows[0]) : undefined;
  }

  async listPending(): Promise<DatasetPreparation[]> {
    const result = await this.pool.query<PreparationRow>(
      `SELECT p.id,p.market_id,p.cohort,p.requested_cutoff,p.effective_cutoff,
              p.source_digest,p.excluded_counts,p.research_qualification,
              p.qualified_rows,p.created_at,d.id AS dataset_id,
              j.id AS job_id,j.request_payload AS job_payload
         FROM statistical_training_dataset_preparation p
         LEFT JOIN statistical_training_dataset d ON d.source_digest=p.source_digest
         LEFT JOIN research_job j
           ON j.job_type='STATISTICAL_TRAINING'
          AND j.idempotency_key='paper-evidence:' || p.source_digest
        ORDER BY p.created_at,p.id`,
    );
    return pendingPreparations(result.rows);
  }

  async findPending(
    cohort: PaperEvidenceCohort,
  ): Promise<DatasetPreparation | undefined> {
    const parsed = paperTrainingEvidenceCohortSchema.parse(cohort);
    const result = await this.pool.query<PreparationRow>(
      `SELECT p.id,p.market_id,p.cohort,p.requested_cutoff,p.effective_cutoff,
              p.source_digest,p.excluded_counts,p.research_qualification,
              p.qualified_rows,p.created_at,d.id AS dataset_id,
              j.id AS job_id,j.request_payload AS job_payload
         FROM statistical_training_dataset_preparation p
         LEFT JOIN statistical_training_dataset d ON d.source_digest=p.source_digest
         LEFT JOIN research_job j
           ON j.job_type='STATISTICAL_TRAINING'
          AND j.idempotency_key='paper-evidence:' || p.source_digest
        WHERE p.market_id=$1
          AND p.cohort->>'strategy'=$2
          AND p.cohort->>'strategyVersion'=$3
          AND p.cohort->>'profileConfigId'=$4
          AND p.cohort->>'configVersion'=$5
          AND p.cohort->>'executionModelVersion'=$6
          AND p.cohort->'assumptions'=$7::jsonb
          AND COALESCE(p.cohort->>'signalSemanticsVersion','UNKNOWN')=$8
          AND COALESCE(p.cohort->>'replayScope','UNKNOWN')=$9
        ORDER BY p.created_at DESC,p.id DESC LIMIT 1`,
      [
        parsed.marketId,
        parsed.strategy,
        parsed.strategyVersion,
        parsed.profileConfigId,
        parsed.configVersion,
        parsed.executionModelVersion,
        JSON.stringify(parsed.assumptions),
        parsed.signalSemanticsVersion ?? "UNKNOWN",
        parsed.replayScope ?? "UNKNOWN",
      ],
    );
    return pendingPreparations(result.rows)[0];
  }
}

function assertPreparationMatches(
  existing: DatasetPreparation,
  input: DatasetPreparationInput,
  cohort: PaperEvidenceCohort,
  rows: PaperEvidenceTrainingRow[],
  qualification: PaperEvidenceResearchQualification,
): void {
  if (
    existing.marketId !== input.marketId ||
    canonicalJson(existing.cohort) !== canonicalJson(cohort) ||
    existing.requestedCutoff !== input.requestedCutoff.toISOString() ||
    existing.effectiveCutoff !== input.effectiveCutoff.toISOString() ||
    canonicalJson(existing.excludedCounts) !==
      canonicalJson(input.excludedCounts) ||
    canonicalJson(existing.rows) !== canonicalJson(rows) ||
    canonicalJson(existing.researchQualification) !==
      canonicalJson(qualification)
  )
    throw new Error("DATASET_PREPARATION_CONFLICT");
}

function mapPreparation(row: PreparationRow): DatasetPreparation {
  return {
    id: row.id,
    marketId: row.market_id,
    cohort: paperTrainingEvidenceCohortSchema.parse(row.cohort),
    requestedCutoff: row.requested_cutoff.toISOString(),
    effectiveCutoff: row.effective_cutoff.toISOString(),
    sourceDigest: row.source_digest,
    excludedCounts: row.excluded_counts as Record<string, number>,
    researchQualification: paperEvidenceResearchQualificationSchema.parse(
      row.research_qualification,
    ),
    rows: Array.isArray(row.qualified_rows)
      ? row.qualified_rows.map((value) =>
          paperEvidenceTrainingRowSchema.parse(value),
        )
      : [],
    createdAt: row.created_at.toISOString(),
  };
}

function pendingPreparations(rows: PreparationRow[]): DatasetPreparation[] {
  const pending: DatasetPreparation[] = [];
  for (const row of rows) {
    const preparation = mapPreparation(row);
    assertTrainingJobOwnership(row, preparation);
    if (!row.job_id) {
      pending.push(preparation);
      continue;
    }
  }
  return pending;
}

function assertTrainingJobOwnership(
  row: PreparationRow,
  preparation: DatasetPreparation,
): void {
  if (
    row.job_id &&
    (!row.dataset_id ||
      !validTrainingJob(row.job_payload, preparation, row.dataset_id))
  )
    throw new Error("DATASET_PREPARATION_JOB_CONFLICT");
}

function validTrainingJob(
  payload: unknown,
  preparation: DatasetPreparation,
  datasetId: string,
): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const value = payload as Record<string, unknown>;
  return (
    value.sourceKind === "PAPER_EVIDENCE" &&
    value.trainingDatasetId === datasetId &&
    value.sourceDigest === preparation.sourceDigest &&
    value.marketId === preparation.marketId &&
    value.strategy === preparation.cohort.strategy &&
    canonicalJson(value.cohort) === canonicalJson(preparation.cohort)
  );
}
