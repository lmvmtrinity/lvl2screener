import {
  evidenceWorkIdentitySchema,
  evidenceWorkReceiptSchema,
  type MarketId,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import { contentHash } from "../backtests/research-coverage.js";
import {
  evidenceWorkKey,
  type PostgresEvidenceAutomationRepository,
} from "../statistical-models/evidence-automation-repository.js";
import { ResearchJobRepository } from "../research-jobs/research-job-repository.js";

type CompletedRun = {
  runId: string;
  accountId: string;
  marketId: MarketId;
  currency: "CAD" | "USD";
  boundaryAt: Date;
  snapshotState: unknown;
  snapshotOrders: unknown;
  sourceRevision: string;
};

type EligibleRun = { runId: string };

const DIAGNOSTIC_REPORT_VERSION = "execution-diagnostics-v2";
const SOURCE_REVISION_STATEMENT_TIMEOUT_MS = 120_000;

/** Cheap eligibility scan: completed runs with no diagnostics job for this report version, or
 * runs whose retained boundary evidence changed after the newest matching job was created.
 * This keeps the expensive source-revision digest off the steady-state poll path. */
const ELIGIBLE_SOURCES_SQL = `
  WITH candidates AS (
    SELECT b.run_id,b.account_id,s.boundary_at,
           (SELECT max(j.created_at) FROM research_job j
             WHERE j.job_type='EXECUTION_DIAGNOSTICS'
               AND j.request_payload->>'runId'=b.run_id::text
               AND j.request_payload->>'reportVersion'='${DIAGNOSTIC_REPORT_VERSION}') AS last_job_at
      FROM paper_funded_run b
      JOIN paper_bot_run r ON r.id=b.run_id
      JOIN paper_funded_run_snapshot s ON s.run_id=b.run_id
     WHERE r.status='COMPLETED' AND r.market_id=$1
  )
  SELECT run_id AS "runId" FROM candidates c
   WHERE c.last_job_at IS NULL
      OR EXISTS (
           SELECT 1 FROM paper_funded_fact f
            WHERE f.run_id=c.run_id AND f.fact_at<=c.boundary_at
              AND f.processed_at>c.last_job_at)
      OR EXISTS (
           SELECT 1 FROM paper_funded_event e
            WHERE e.account_id=c.account_id AND e.recorded_at>c.last_job_at
              AND e.recorded_at<=c.boundary_at)
      OR EXISTS (
           SELECT 1 FROM paper_entry_order o
            WHERE o.run_id=c.run_id AND o.updated_at>c.last_job_at
              AND (o.submission->>'submittedAt')::timestamptz<=c.boundary_at)
   ORDER BY c.boundary_at,c.run_id
   LIMIT $2`;

/** Content-addressed source revision for the selected runs only. Each retained source is
 * hashed as per-row digests aggregated with `string_agg` rather than one `jsonb_agg` of
 * every row: a single funded run can exceed PostgreSQL's 256 MB jsonb array-element limit,
 * which previously made catch-up fail forever for oversized runs. Row ordering is
 * unchanged, so the digest still changes whenever any retained fact, order history or
 * account event changes. Only eligible runs (never dispatched, or changed since their last
 * job) are recomputed, so existing evidence-work identities remain valid. */
const SOURCE_REVISION_SQL = `
  WITH sources AS (
    SELECT b.run_id AS "runId",b.account_id AS "accountId",b.currency,
           r.market_id AS "marketId",s.boundary_at AS "boundaryAt",
           s.state AS "snapshotState",s.orders AS "snapshotOrders",
           md5(concat_ws('|',
             md5(jsonb_build_array(s.state,s.orders)::text),
             (SELECT md5(string_agg(md5(jsonb_build_array(f.fact_id,f.fact,f.outcome)::text),'|' ORDER BY f.fact_id))
              FROM paper_funded_fact f WHERE f.run_id=b.run_id AND f.fact_at<=s.boundary_at),
             (SELECT md5(string_agg(md5(jsonb_build_array(o.order_id,o.submission,h.revision,h.fact_at,h.state)::text),'|' ORDER BY o.order_id,h.revision))
              FROM paper_entry_order o LEFT JOIN paper_entry_order_history h ON h.order_id=o.order_id AND h.fact_at<=s.boundary_at
              WHERE o.run_id=b.run_id AND (o.submission->>'submittedAt')::timestamptz<=s.boundary_at),
             (SELECT md5(string_agg(md5(jsonb_build_array(e.event_id,e.event_sequence,e.event_sequence_verified,e.event)::text),'|' ORDER BY e.event_sequence))
              FROM paper_funded_event e WHERE e.account_id=b.account_id AND (e.event->>'at')::timestamptz<=s.boundary_at)
           )) AS "sourceRevision"
      FROM paper_funded_run b
      JOIN paper_bot_run r ON r.id=b.run_id
      JOIN paper_funded_run_snapshot s ON s.run_id=b.run_id
     WHERE r.status='COMPLETED' AND r.market_id=$1 AND b.run_id=ANY($2::uuid[])
  )
  SELECT * FROM sources s WHERE NOT EXISTS (
    SELECT 1 FROM research_job j JOIN research_evidence_work w ON w.job_id=j.id
     WHERE j.job_type='EXECUTION_DIAGNOSTICS'
       AND j.request_payload->>'runId'=s."runId"::text
       AND j.request_payload->>'reportVersion'='${DIAGNOSTIC_REPORT_VERSION}'
       AND j.request_payload->>'sourceRevision'=s."sourceRevision"
  ) ORDER BY "boundaryAt","runId" LIMIT $3`;

/** Catches up immutable funded run boundaries after completion. Completion is the only source
 * hint; the snapshot and evidence-work identity make this restart-safe and independent of the
 * settlement transaction. */
export class ExecutionDiagnosticAutomation {
  constructor(
    private readonly pool: Pool,
    private readonly evidence: PostgresEvidenceAutomationRepository,
    private readonly jobs: ResearchJobRepository,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async catchUp(marketId: MarketId, limit = 100): Promise<number> {
    const eligible = await this.pool.query<EligibleRun>(ELIGIBLE_SOURCES_SQL, [
      marketId,
      limit,
    ]);
    if (eligible.rows.length === 0) return 0;
    const result = await this.sourceRevisionPage(
      marketId,
      eligible.rows.map((row) => row.runId),
      limit,
    );
    if (result.length === 0) return 0;
    const deadline = this.clock().getTime() + 1_000;
    const priorWork = new Map(
      (await this.evidence.list(marketId)).map((record) => [
        record.workKey,
        record,
      ]),
    );
    let dispatched = 0;
    for (const run of result) {
      if (this.clock().getTime() >= deadline) break;
      const boundaryAt = run.boundaryAt.toISOString();
      const snapshotHash = contentHash({
        state: run.snapshotState ?? null,
        orders: run.snapshotOrders ?? null,
      });
      const identity = evidenceWorkIdentitySchema.parse({
        kind: "DIAGNOSTICS",
        marketId,
        scopeHash: contentHash({
          runId: run.runId,
          accountId: run.accountId,
          marketId,
          currency: run.currency,
          boundaryAt,
        }),
        inputIdentityHash: contentHash({
          runId: run.runId,
          accountId: run.accountId,
          boundaryAt,
          snapshotHash,
          sourceRevision: run.sourceRevision,
        }),
        processorVersion: DIAGNOSTIC_REPORT_VERSION,
      });
      const workKey = evidenceWorkKey(identity);
      if (priorWork.get(workKey)?.jobId) continue;
      const client = await this.pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
          [workKey],
        );
        const job = await this.jobs.withClient(client).createStrictJob(
          "EXECUTION_DIAGNOSTICS",
          {
            runId: run.runId,
            accountId: run.accountId,
            marketId,
            mode: "RUN_END",
            reportVersion: DIAGNOSTIC_REPORT_VERSION,
            sourceRevision: run.sourceRevision,
          },
          `execution-diagnostics:${workKey}`,
        );
        const receipt = evidenceWorkReceiptSchema.parse({
          workKey,
          identity,
          state: "DISPATCHED",
          jobId: job.id,
          reasonCodes: [],
          recordedAt: this.clock().toISOString(),
        });
        await this.evidence.recordWithClient(client, identity, receipt);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      dispatched++;
    }
    return dispatched;
  }

  private async sourceRevisionPage(
    marketId: MarketId,
    runIds: readonly string[],
    limit: number,
  ): Promise<CompletedRun[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SET LOCAL statement_timeout = ${SOURCE_REVISION_STATEMENT_TIMEOUT_MS}`,
      );
      const result = await client.query<CompletedRun>(SOURCE_REVISION_SQL, [
        marketId,
        runIds,
        limit,
      ]);
      await client.query("COMMIT");
      return result.rows;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
