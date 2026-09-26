import type { MarketId } from "@tsx-scanner/contracts";
import { researchCoverageReportSchema } from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import {
  contentHash,
  coverageReportHash,
} from "../backtests/research-coverage.js";
import {
  datasetRowsDigest,
  researchSessionDates,
} from "../backtests/research-lineage-service.js";
import { PostgresPaperEvidenceTrainingStore } from "./paper-evidence-training-repository.js";
import {
  evidenceWorkKey,
  PostgresEvidenceAutomationRepository,
} from "./evidence-automation-repository.js";

const PROCESSOR = "dataset-lineage-proof-v2";

type CandidateRow = {
  request_hash: string;
  request_id: string;
  request_created_at: string;
  report_hash: string;
  manifest_hash: string;
  recipe: {
    marketId?: string;
    featureVersion?: string;
    engineRevision?: string;
    runtimeFingerprint?: string;
    inputCutoff?: string;
    sessionDates?: string[];
  };
  report_payload: unknown;
  purpose: {
    kind?: string;
    marketId?: string;
    inputCutoff?: string;
    preparationId?: string;
    sessionDates?: string[];
    scope?: { sourceDigest?: string; cohort?: unknown; rows?: unknown };
  };
  dataset_id: string | null;
  preparation_id: string | null;
  preparation_cohort: unknown;
  preparation_rows: unknown;
  preparation_requested_cutoff: Date | null;
};

type ContinuationCursor = {
  createdAt: string;
  requestId: string;
  reportHash: string;
};

/** Coverage of a date/instrument does not prove how a frozen feature was derived.
 * Inspect each immutable request/report once and expose that missing prerequisite.
 * A future provenance format must use a new processor version to revisit these.
 */
export class ResearchDatasetLineageReconciler {
  private readonly cursors = new Map<MarketId, ContinuationCursor>();

  constructor(private readonly pool: Pool) {}

  async catchUp(
    marketId: MarketId,
    limit = 100,
    budgetMs = 1000,
  ): Promise<number> {
    const started = Date.now();
    const pageSize = Math.max(1, Math.min(100, Math.floor(limit)));
    const datasets = new PostgresPaperEvidenceTrainingStore(this.pool);
    const work = new PostgresEvidenceAutomationRepository(this.pool);
    let processed = 0;
    let cursor = this.cursors.get(marketId);
    let fetchedAny = false;
    while (
      (!fetchedAny || processed < pageSize) &&
      (!fetchedAny || Date.now() - started < budgetMs)
    ) {
      const candidates = await this.pool.query<CandidateRow>(
        `SELECT q.request_hash,q.id AS request_id,q.created_at::text AS request_created_at,
                r.report_hash,
                q.request->'manifest'->>'hash' AS manifest_hash,
                q.request->'recipe' AS recipe,
                report.report AS report_payload,
                q.request->'manifest'->'manifest'->'purpose' AS purpose,
                d.id AS dataset_id,
                p.id AS preparation_id,
                p.cohort AS preparation_cohort,
                p.qualified_rows AS preparation_rows,
                p.requested_cutoff AS preparation_requested_cutoff
         FROM research_coverage_request q
         JOIN research_coverage_request_result r ON r.request_id=q.id AND r.status='VERIFIED'
         JOIN research_coverage_report report ON report.hash=r.report_hash AND report.status='VERIFIED' AND report.market_id=q.market_id
         LEFT JOIN statistical_training_dataset d ON d.source_digest=q.request->'manifest'->'manifest'->'purpose'->'scope'->>'sourceDigest'
         LEFT JOIN statistical_training_dataset_preparation p
           ON p.id::text=q.request->'manifest'->'manifest'->'purpose'->>'preparationId'
          AND p.market_id=q.market_id
          AND p.market_id=q.request->'manifest'->'manifest'->'purpose'->>'marketId'
          AND p.source_digest=q.request->'manifest'->'manifest'->'purpose'->'scope'->>'sourceDigest'
          AND p.cohort=q.request->'manifest'->'manifest'->'purpose'->'scope'->'cohort'
          AND p.qualified_rows=q.request->'manifest'->'manifest'->'purpose'->'scope'->'rows'
          AND to_char(p.requested_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
              =q.request->'manifest'->'manifest'->'purpose'->>'inputCutoff'
        WHERE q.market_id=$1
          AND q.request->'manifest'->'manifest'->>'version'='artifact-coverage-v1'
          AND q.request->'manifest'->'manifest'->'purpose'->>'kind'='DATASET'
          AND ($3::timestamptz IS NULL OR q.created_at > $3::timestamptz OR
               (q.created_at=$3::timestamptz AND (q.id,r.report_hash) > ($4::uuid,$5)))
          AND NOT EXISTS (SELECT 1 FROM research_evidence_work w
            WHERE w.market_id=q.market_id AND w.scope_hash=q.request_hash
              AND w.input_identity_hash=r.report_hash AND w.processor_version=$2)
        ORDER BY q.created_at,q.id,r.report_hash LIMIT $6`,
        [
          marketId,
          PROCESSOR,
          cursor?.createdAt ?? null,
          cursor?.requestId ?? null,
          cursor?.reportHash ?? null,
          pageSize,
        ],
      );
      fetchedAny = true;
      if (candidates.rows.length === 0) {
        this.cursors.delete(marketId);
        break;
      }
      for (const candidate of candidates.rows) {
        const nextCursor = {
          createdAt: candidate.request_created_at,
          requestId: candidate.request_id,
          reportHash: candidate.report_hash,
        };
        if (Date.now() - started >= budgetMs && processed > 0) break;
        // Coverage may finish before the normal startup/17:00 materialization.
        // Defer only the exact internal preparation; once a dataset exists, the
        // checks below remain authoritative and record any real mismatch.
        if (isExactPendingPreparation(candidate, marketId)) {
          cursor = nextCursor;
          this.cursors.set(marketId, cursor);
          continue;
        }
        const original = candidate.dataset_id
          ? await datasets.getDataset(candidate.dataset_id)
          : undefined;
        const rows = original
          ? await datasets.listDatasetRows(original.id)
          : [];
        const purpose = candidate.purpose;
        const matches =
          original &&
          original.marketId === marketId &&
          purpose.marketId === marketId &&
          original.sourceDigest === purpose.scope?.sourceDigest &&
          original.requestedCutoff === purpose.inputCutoff &&
          contentHash(original.cohort) ===
            contentHash(purpose.scope?.cohort ?? null) &&
          contentHash(rows) === contentHash(purpose.scope?.rows ?? null) &&
          contentHash(
            researchSessionDates(
              rows.map((row) => row.signalTimestamp),
              marketId,
            ),
          ) === contentHash(purpose.sessionDates ?? null);
        const report = researchCoverageReportSchema.safeParse(
          candidate.report_payload,
        );
        const binding = original?.researchEvidence;
        const derivation = original?.researchDerivation;
        const recipe = candidate.recipe;
        const derivationComplete =
          matches &&
          report.success &&
          report.data.status === "VERIFIED" &&
          report.data.marketId === marketId &&
          report.data.manifestHash === candidate.manifest_hash &&
          coverageReportHash(report.data) === candidate.report_hash &&
          original?.sourceRowCount === rows.length &&
          derivation?.complete === true &&
          derivation.reasons.length === 0 &&
          derivation.sourceDigest === original.sourceDigest &&
          derivation.rowsDigest === datasetRowsDigest(rows) &&
          derivation.rowCount === rows.length &&
          derivation.featureVersion === recipe.featureVersion &&
          derivation.engineRevision === recipe.engineRevision &&
          derivation.runtimeFingerprint === recipe.runtimeFingerprint &&
          derivation.sessionPayloadHashes !== null &&
          contentHash(derivation.sessionPayloadHashes) ===
            contentHash(report.data.sessionPayloadHashes) &&
          derivation.coverageManifestHash === candidate.manifest_hash &&
          derivation.coverageReportHash === candidate.report_hash &&
          binding?.manifestHash === candidate.manifest_hash &&
          binding.coverageReportHash === candidate.report_hash &&
          binding.inputHash === report.data.inputHash &&
          binding.engineRevision === recipe.engineRevision &&
          binding.runtimeFingerprint === recipe.runtimeFingerprint &&
          binding.verifiedAt === report.data.verifiedAt &&
          recipe.marketId === marketId &&
          recipe.inputCutoff === purpose.inputCutoff &&
          contentHash(recipe.sessionDates ?? null) ===
            contentHash(purpose.sessionDates ?? null);
        const identity = {
          kind: "COVERAGE" as const,
          marketId,
          scopeHash: candidate.request_hash,
          inputIdentityHash: candidate.report_hash,
          processorVersion: PROCESSOR,
        };
        // A dataset created after the E04 derivation format carries its own
        // manifest-defined derivation. When it is complete and matches this
        // request/report, the missing-prerequisite receipt must not survive as a
        // false negative; record the checked condition without an unmet reason.
        await work.record(identity, {
          identity,
          workKey: evidenceWorkKey(identity),
          state: "WAITING",
          jobId: null,
          reasonCodes:
            matches && derivationComplete
              ? []
              : [
                  matches
                    ? "DATASET_DERIVATION_UNPROVEN"
                    : "DATASET_COVERAGE_SCOPE_MISMATCH",
                ],
          recordedAt: new Date().toISOString(),
        });
        processed++;
        cursor = nextCursor;
        this.cursors.set(marketId, cursor);
        if (processed >= pageSize) break;
      }
      if (candidates.rows.length < pageSize) {
        this.cursors.delete(marketId);
        break;
      }
    }
    return processed;
  }
}

function isExactPendingPreparation(
  candidate: CandidateRow,
  marketId: MarketId,
): boolean {
  if (!candidate.preparation_id || candidate.dataset_id) return false;
  const purpose = candidate.purpose;
  if (
    purpose.marketId !== marketId ||
    candidate.recipe.marketId !== marketId ||
    candidate.recipe.marketId !== purpose.marketId ||
    candidate.recipe.inputCutoff !== purpose.inputCutoff ||
    !sameInstant(candidate.preparation_requested_cutoff, purpose.inputCutoff) ||
    !Array.isArray(candidate.recipe.sessionDates) ||
    !Array.isArray(purpose.sessionDates) ||
    contentHash(candidate.recipe.sessionDates) !==
      contentHash(purpose.sessionDates) ||
    contentHash(candidate.preparation_cohort) !==
      contentHash(purpose.scope?.cohort ?? null) ||
    contentHash(candidate.preparation_rows) !==
      contentHash(purpose.scope?.rows ?? null)
  )
    return false;
  const derivedDates = preparationSessionDates(
    candidate.preparation_rows,
    marketId,
  );
  return (
    derivedDates !== undefined &&
    contentHash(derivedDates) === contentHash(purpose.sessionDates)
  );
}

function preparationSessionDates(
  value: unknown,
  marketId: MarketId,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const timestamps: string[] = [];
  for (const row of value) {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof (row as { signalTimestamp?: unknown }).signalTimestamp !== "string"
    )
      return undefined;
    const timestamp = (row as { signalTimestamp: string }).signalTimestamp;
    if (!Number.isFinite(new Date(timestamp).getTime())) return undefined;
    timestamps.push(timestamp);
  }
  return researchSessionDates(timestamps, marketId);
}

function sameInstant(value: Date | null, iso: string | undefined): boolean {
  if (!value || !iso) return false;
  const parsed = new Date(iso);
  return (
    Number.isFinite(parsed.getTime()) && value.getTime() === parsed.getTime()
  );
}
