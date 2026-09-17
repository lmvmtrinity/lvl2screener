import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EvidenceWorkIdentity } from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import {
  evidenceWorkKey,
  PostgresEvidenceAutomationRepository,
} from "../src/statistical-models/evidence-automation-repository.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

describe.skipIf(!databaseUrl)(
  "evidence automation PostgreSQL acceptance",
  () => {
    let pool: Pool;
    let repository: PostgresEvidenceAutomationRepository;
    const identity: EvidenceWorkIdentity = {
      kind: "COVERAGE",
      marketId: "CA_TSX",
      scopeHash: "1".repeat(64),
      inputIdentityHash: "2".repeat(64),
      processorVersion: "coverage-v1",
    };

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 4 });
      await migrate(pool);
      repository = new PostgresEvidenceAutomationRepository(pool);
    });

    afterAll(async () => {
      await pool?.end();
    });

    it("reuses an unchanged receipt and appends one dispatch identity", async () => {
      const workKey = evidenceWorkKey(identity);
      await repository.record(identity, {
        workKey,
        identity,
        state: "WAITING",
        jobId: null,
        reasonCodes: ["SOURCE_REVISION_UNAVAILABLE"],
        recordedAt: "2026-09-10T00:00:00.000Z",
      });
      await repository.record(identity, {
        workKey,
        identity,
        state: "WAITING",
        jobId: null,
        reasonCodes: ["SOURCE_REVISION_UNAVAILABLE"],
        recordedAt: "2026-09-10T00:01:00.000Z",
      });
      const job = await pool.query<{ id: string }>(
        `INSERT INTO research_job(job_type,request_payload)
       VALUES('COVERAGE_VERIFICATION','{"marketId":"CA_TSX"}'::jsonb)
       RETURNING id`,
      );
      const jobId = job.rows[0]!.id;
      await repository.record(identity, {
        workKey,
        identity,
        state: "DISPATCHED",
        jobId,
        reasonCodes: [],
        recordedAt: "2026-09-10T00:02:00.000Z",
      });
      const rows = (await repository.list("CA_TSX")).filter(
        (row) => row.workKey === workKey,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.jobId).toBe(jobId);
      expect(rows[0]?.receipt?.state).toBe("DISPATCHED");
      const receipts = await pool.query(
        "SELECT count(*)::int AS count FROM research_evidence_work_receipt WHERE work_key=$1",
        [workKey],
      );
      expect(receipts.rows[0].count).toBe(2);
      expect(
        (await repository.list("US_EQUITIES")).some(
          (row) => row.workKey === workKey,
        ),
      ).toBe(false);
    });
    it("advances the completed-source watermark once and keeps the hint waiting", async () => {
      await pool.query(
        `INSERT INTO universe_refresh_run(
          market_id,provider,policy_version,policy,status,started_at,completed_at
        ) VALUES('CA_TSX','FIXTURE','fixture-v1','{}'::jsonb,'COMPLETED',
          '2026-09-10T00:10:00Z','2026-09-10T00:11:00Z')`,
      );
      expect(await repository.catchUp!("CA_TSX")).toBeGreaterThanOrEqual(1);
      expect(await repository.catchUp!("CA_TSX")).toBe(0);
      const rows = await repository.list("CA_TSX");
      expect(
        rows.some((row) =>
          row.receipt?.reasonCodes.includes("RESEARCH_SCOPE_UNAVAILABLE"),
        ),
      ).toBe(true);
    });
  },
);
