import type { MarketId } from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { contentHash } from "../backtests/research-coverage.js";
import { researchSessionDates } from "../backtests/research-lineage-service.js";
import { PostgresPaperEvidenceTrainingStore } from "./paper-evidence-training-repository.js";
import {
  evidenceWorkKey,
  PostgresEvidenceAutomationRepository,
} from "./evidence-automation-repository.js";

const PROCESSOR = "dataset-lineage-proof-v2";

/** Coverage of a date/instrument does not prove how a frozen feature was derived.
 * Inspect each immutable request/report once and expose that missing prerequisite.
 * A future provenance format must use a new processor version to revisit these.
 */
export class ResearchDatasetLineageReconciler {
  constructor(private readonly pool: Pool) {}

  async catchUp(
    marketId: MarketId,
    limit = 100,
    budgetMs = 1000,
  ): Promise<number> {
    const started = Date.now();
    const candidates = await this.pool.query<{
      request_hash: string;
      report_hash: string;
      purpose: {
        kind?: string;
        marketId?: string;
        inputCutoff?: string;
        sessionDates?: string[];
        scope?: { sourceDigest?: string; cohort?: unknown; rows?: unknown };
      };
      dataset_id: string | null;
    }>(
      `SELECT q.request_hash,r.report_hash,q.request->'manifest'->'manifest'->'purpose' AS purpose,d.id AS dataset_id
      FROM research_coverage_request q
      JOIN research_coverage_request_result r ON r.request_id=q.id AND r.status='VERIFIED'
      JOIN research_coverage_report report ON report.hash=r.report_hash AND report.status='VERIFIED' AND report.market_id=q.market_id
      LEFT JOIN statistical_training_dataset d ON d.source_digest=q.request->'manifest'->'manifest'->'purpose'->'scope'->>'sourceDigest'
      WHERE q.market_id=$1 AND q.request->'manifest'->'manifest'->>'version'='artifact-coverage-v1'
        AND q.request->'manifest'->'manifest'->'purpose'->>'kind'='DATASET'
        AND NOT EXISTS (SELECT 1 FROM research_evidence_work w
          WHERE w.market_id=q.market_id AND w.scope_hash=q.request_hash
            AND w.input_identity_hash=r.report_hash AND w.processor_version=$2)
      ORDER BY q.created_at,q.id,r.report_hash LIMIT $3`,
      [marketId, PROCESSOR, Math.max(1, Math.min(100, Math.floor(limit)))],
    );
    const datasets = new PostgresPaperEvidenceTrainingStore(this.pool);
    const work = new PostgresEvidenceAutomationRepository(this.pool);
    let processed = 0;
    for (const candidate of candidates.rows) {
      if (Date.now() - started >= budgetMs) break;
      const original = candidate.dataset_id
        ? await datasets.getDataset(candidate.dataset_id)
        : undefined;
      const rows = original ? await datasets.listDatasetRows(original.id) : [];
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
      const derivation = original?.researchDerivation;
      const derivationComplete =
        derivation?.complete === true &&
        derivation.sourceDigest === original?.sourceDigest &&
        derivation.rowCount === rows.length;
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
    }
    return processed;
  }
}
