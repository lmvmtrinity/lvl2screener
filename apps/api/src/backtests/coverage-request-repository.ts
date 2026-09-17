import {
  createCoverageRequestSchema,
  type CoverageRequestRecord,
  type CreateCoverageRequest,
  type ResearchCoverageReport,
} from "@tsx-scanner/contracts";
import type { Pool, PoolClient } from "pg";
import { contentHash } from "./research-coverage.js";
import { ResearchJobRepository } from "../research-jobs/research-job-repository.js";
import {
  evidenceWorkKey,
  PostgresEvidenceAutomationRepository,
} from "../statistical-models/evidence-automation-repository.js";

type RequestRow = {
  id: string;
  market_id: "CA_TSX" | "US_EQUITIES";
  request_hash: string;
  created_at: Date;
  latest_job_id: string | null;
};

export class PostgresCoverageRequestRepository {
  constructor(private readonly pool: Pool) {}

  async create(
    raw: CreateCoverageRequest,
    idempotencyKey: string,
  ): Promise<CoverageRequestRecord> {
    const input = createCoverageRequestSchema.parse(raw);
    if (input.manifest.hash !== contentHash(input.manifest.manifest))
      throw new Error("COVERAGE_MANIFEST_HASH_MISMATCH");
    if (!idempotencyKey.trim()) throw new Error("IDEMPOTENCY_KEY_REQUIRED");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const requestHash = contentHash(input);
      // Serialize key reuse before consulting either identity constraint.
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`coverage-key:${idempotencyKey}`],
      );
      const alias = await client.query<{ request_hash: string }>(
        "SELECT request_hash FROM research_coverage_request_key WHERE idempotency_key=$1",
        [idempotencyKey],
      );
      if (alias.rows[0] && alias.rows[0].request_hash !== requestHash)
        throw new Error("COVERAGE_REQUEST_IDEMPOTENCY_CONFLICT");
      const inserted = await client.query<RequestRow>(
        `INSERT INTO research_coverage_request(
           market_id,request_hash,request,idempotency_key
         ) VALUES($1,$2,$3::jsonb,$4)
         ON CONFLICT DO NOTHING
         RETURNING id,market_id,request_hash,created_at,latest_job_id`,
        [
          input.recipe.marketId,
          requestHash,
          JSON.stringify(input),
          idempotencyKey,
        ],
      );
      let row = inserted.rows[0];
      if (!row) {
        const existing = await client.query<RequestRow>(
          `SELECT id,market_id,request_hash,created_at,latest_job_id
             FROM research_coverage_request
            WHERE idempotency_key=$1
               OR (market_id=$2 AND request_hash=$3)
            ORDER BY (idempotency_key=$1) DESC
            LIMIT 1 FOR UPDATE`,
          [idempotencyKey, input.recipe.marketId, requestHash],
        );
        row = existing.rows[0];
        if (!row) throw new Error("COVERAGE_REQUEST_SAVE_RACE");
        if (row.request_hash !== requestHash)
          throw new Error("COVERAGE_REQUEST_IDEMPOTENCY_CONFLICT");
      }
      if (!row.latest_job_id) {
        const job = await new ResearchJobRepository(client).createStrictJob(
          "COVERAGE_VERIFICATION",
          {
            version: "coverage-verification-v2",
            requestId: row.id,
            request: input,
          },
          `coverage-request:${row.id}`,
        );
        await client.query(
          `UPDATE research_coverage_request SET latest_job_id=$2 WHERE id=$1`,
          [row.id, job.id],
        );
        row = { ...row, latest_job_id: job.id };
      }
      const identity = {
        kind: "COVERAGE" as const,
        marketId: input.recipe.marketId,
        scopeHash: input.manifest.hash,
        inputIdentityHash: requestHash,
        processorVersion: "coverage-request-v2",
      };
      await client.query(
        "INSERT INTO research_coverage_request_key(idempotency_key,request_id,request_hash) VALUES($1,$2,$3) ON CONFLICT(idempotency_key) DO NOTHING",
        [idempotencyKey, row.id, requestHash],
      );
      await client.query(
        `INSERT INTO research_coverage_source_receipt(request_id,source_identity_hash,source_descriptor)
        VALUES($1,$2,$3::jsonb) ON CONFLICT(request_id,source_identity_hash) DO NOTHING`,
        [
          row.id,
          contentHash(input.manifest.manifest),
          JSON.stringify(input.manifest.manifest),
        ],
      );
      const clock = await client.query<{ now: Date }>(
        "SELECT clock_timestamp() AS now",
      );
      await new PostgresEvidenceAutomationRepository(
        this.pool,
      ).recordWithClient(client, identity, {
        workKey: evidenceWorkKey(identity),
        identity,
        state: "DISPATCHED",
        jobId: row.latest_job_id,
        reasonCodes: [],
        recordedAt: clock.rows[0]!.now.toISOString(),
      });
      await client.query("COMMIT");
      return mapRequest(row);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async get(
    id: string,
    marketId: "CA_TSX" | "US_EQUITIES",
  ): Promise<CoverageRequestRecord | null> {
    const result = await this.pool.query<RequestRow>(
      `SELECT id,market_id,request_hash,created_at,latest_job_id
         FROM research_coverage_request WHERE id=$1 AND market_id=$2`,
      [id, marketId],
    );
    if (!result.rows[0]) return null;
    const report = await this.pool.query<{
      report_hash: string;
      status: ResearchCoverageReport["status"];
    }>(
      "SELECT report_hash,status FROM research_coverage_request_result WHERE request_id=$1 ORDER BY recorded_at DESC LIMIT 1",
      [id],
    );
    return {
      ...mapRequest(result.rows[0]),
      reportHash: report.rows[0]?.report_hash ?? null,
      coverageStatus: report.rows[0]?.status ?? null,
    };
  }

  async recordResult(
    requestId: string,
    jobId: string,
    reportHash: string,
    status: ResearchCoverageReport["status"],
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.recordResultWithClient(
        client,
        requestId,
        jobId,
        reportHash,
        status,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async recordResultWithClient(
    client: PoolClient,
    requestId: string,
    jobId: string,
    reportHash: string,
    status: ResearchCoverageReport["status"],
  ): Promise<void> {
    const workKey = contentHash({ requestId, jobId, reportHash });
    await client.query(
      `INSERT INTO research_coverage_request_result(
         work_key,request_id,job_id,report_hash,status
       ) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT(work_key) DO NOTHING`,
      [workKey, requestId, jobId, reportHash, status],
    );
  }
}

function mapRequest(row: RequestRow): CoverageRequestRecord {
  return {
    id: row.id,
    requestHash: row.request_hash,
    marketId: row.market_id,
    createdAt: row.created_at.toISOString(),
    latestJobId: row.latest_job_id,
  };
}
