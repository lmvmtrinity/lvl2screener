import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  CreateCoverageRequest,
  EvidenceWorkIdentity,
  EvidenceWorkReceipt,
} from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { contentHash } from "../src/backtests/research-coverage.js";
import { PostgresCoverageRequestRepository } from "../src/backtests/coverage-request-repository.js";
import {
  evidenceWorkKey,
  PostgresEvidenceAutomationRepository,
} from "../src/statistical-models/evidence-automation-repository.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

function identity(
  overrides: Partial<EvidenceWorkIdentity> = {},
): EvidenceWorkIdentity {
  return {
    kind: "COVERAGE",
    marketId: "CA_TSX",
    scopeHash: "a".repeat(64),
    inputIdentityHash: "b".repeat(64),
    processorVersion: "recovery-suite-v1",
    ...overrides,
  };
}

function receipt(
  value: EvidenceWorkIdentity,
  overrides: Partial<EvidenceWorkReceipt> = {},
): EvidenceWorkReceipt {
  return {
    workKey: evidenceWorkKey(value),
    identity: value,
    state: "WAITING",
    jobId: null,
    reasonCodes: [],
    recordedAt: new Date().toISOString(),
    ...overrides,
  };
}

function coverageInput(nonce: string): CreateCoverageRequest {
  const manifest = {
    version: "artifact-coverage-v1",
    purpose: { case: nonce },
  };
  return {
    manifest: { hash: contentHash(manifest), marketId: "CA_TSX", manifest },
    recipe: {
      version: "research-coverage-recipe-v2",
      marketId: "CA_TSX",
      engineRevision: "a".repeat(40),
      runtimeFingerprint: "b".repeat(64),
      featureVersion: "fixture",
      sessionDates: ["2026-09-09"],
      inputCutoff: "2026-09-10T00:00:00.000Z",
      streamRequirements: [
        {
          timeframe: "OneMinute",
          warmupDays: 1,
          requiredWarmupBars: 2,
          includeInSession: true,
        },
      ],
      maxQuoteGapMs: 30000,
      replayPolicyHash: "1".repeat(64),
      membershipPolicyHash: "2".repeat(64),
      calendarPolicyHash: "3".repeat(64),
    },
  };
}

describe.skipIf(!databaseUrl)("evidence automation recovery PostgreSQL", () => {
  let pool: Pool;
  let requests: PostgresCoverageRequestRepository;
  let automation: PostgresEvidenceAutomationRepository;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 6 });
    await migrate(pool);
    requests = new PostgresCoverageRequestRepository(pool);
    automation = new PostgresEvidenceAutomationRepository(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  const countsForRequest = async (requestId: string) => {
    const result = await pool.query<{
      requests: number;
      jobs: number;
      work: number;
      receipts: number;
    }>(
      `SELECT
           (SELECT count(*)::int FROM research_coverage_request WHERE id=$1) AS requests,
           (SELECT count(*)::int FROM research_job WHERE request_payload->>'requestId'=$1::text) AS jobs,
           (SELECT count(*)::int FROM research_evidence_work
             WHERE input_identity_hash IN
               (SELECT request_hash FROM research_coverage_request WHERE id=$1)) AS work,
           (SELECT count(*)::int FROM research_evidence_work_receipt r
             WHERE EXISTS (SELECT 1 FROM research_evidence_work w
               WHERE w.work_key=r.work_key AND w.input_identity_hash IN
                 (SELECT request_hash FROM research_coverage_request WHERE id=$1))) AS receipts`,
      [requestId],
    );
    return result.rows[0];
  };

  const watermarkSnapshot = async (marketId: "CA_TSX" | "US_EQUITIES") => {
    const result = await pool.query<{
      last_completed_at: Date | null;
      last_source_id: string | null;
    }>(
      `SELECT last_completed_at,last_source_id
           FROM research_evidence_source_watermark WHERE market_id=$1`,
      [marketId],
    );
    return result.rows[0] ?? null;
  };

  const restoreWatermark = async (
    marketId: "CA_TSX" | "US_EQUITIES",
    snapshot: Awaited<ReturnType<typeof watermarkSnapshot>>,
  ) => {
    if (!snapshot) {
      await pool.query(
        "DELETE FROM research_evidence_source_watermark WHERE market_id=$1",
        [marketId],
      );
      return;
    }
    await pool.query(
      `INSERT INTO research_evidence_source_watermark(
           market_id,last_completed_at,last_source_id,updated_at)
         VALUES($1,$2,$3,clock_timestamp())
         ON CONFLICT(market_id) DO UPDATE
           SET last_completed_at=EXCLUDED.last_completed_at,
               last_source_id=EXCLUDED.last_source_id,
               updated_at=clock_timestamp()`,
      [marketId, snapshot.last_completed_at, snapshot.last_source_id],
    );
  };

  const latestCompletedAt = async (marketId: "CA_TSX" | "US_EQUITIES") => {
    const result = await pool.query<{ at: Date }>(
      "SELECT COALESCE(max(completed_at), now()) AS at FROM universe_refresh_run WHERE market_id=$1",
      [marketId],
    );
    return result.rows[0]!.at;
  };

  const insertCompletedRun = async (
    id: string,
    marketId: "CA_TSX" | "US_EQUITIES",
    completedAtMs: number,
  ) => {
    await pool.query(
      `INSERT INTO universe_refresh_run(
           id,market_id,provider,policy_version,policy,status,started_at,completed_at)
         VALUES($1,$2,'RECOVERY_FIXTURE','recovery-fixture','{}'::jsonb,'COMPLETED',
           to_timestamp($3::double precision / 1000.0),
           to_timestamp($3::double precision / 1000.0))`,
      [id, marketId, completedAtMs],
    );
  };

  const catchUpReceiptCount = async (
    marketId: "CA_TSX" | "US_EQUITIES",
    sourceIds: readonly string[],
  ) => {
    const keys = await pool.query<{ work_key: string }>(
      `SELECT work_key FROM research_evidence_work
          WHERE market_id=$1 AND processor_version='coverage-catch-up-v1'
            AND scope_hash = ANY($2::text[])`,
      [
        marketId,
        sourceIds.map((sourceId) => contentHash({ marketId, sourceId })),
      ],
    );
    if (keys.rows.length === 0) return 0;
    const result = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM research_evidence_work_receipt
          WHERE work_key = ANY($1::text[])`,
      [keys.rows.map((row) => row.work_key)],
    );
    return result.rows[0]?.count ?? 0;
  };

  it("derives one work key per identical identity and separates market, version and input changes", () => {
    const base = identity();
    expect(evidenceWorkKey(base)).toBe(evidenceWorkKey(identity()));
    const variants: EvidenceWorkIdentity[] = [
      identity({ marketId: "US_EQUITIES" }),
      identity({ processorVersion: "recovery-suite-v2" }),
      identity({ scopeHash: "c".repeat(64) }),
      identity({ inputIdentityHash: "d".repeat(64) }),
    ];
    expect(
      new Set([evidenceWorkKey(base), ...variants.map(evidenceWorkKey)]).size,
    ).toBe(5);
  });

  it("keeps receipts append-only, deduplicates redelivery and rejects a conflicting job link", async () => {
    const value = identity({ scopeHash: contentHash({ case: "append-only" }) });
    const workKey = evidenceWorkKey(value);
    await automation.record(value, receipt(value));
    // Identical redelivery must not append a second receipt row.
    await automation.record(value, receipt(value));
    const job = await pool.query<{ id: string }>(
      `INSERT INTO research_job(job_type,request_payload)
         VALUES('COVERAGE_VERIFICATION','{"marketId":"CA_TSX"}'::jsonb)
         RETURNING id`,
    );
    const jobId = job.rows[0]!.id;
    await automation.record(
      value,
      receipt(value, { state: "DISPATCHED", jobId }),
    );
    await expect(
      automation.record(
        value,
        receipt(value, { state: "DISPATCHED", jobId: randomUUID() }),
      ),
    ).rejects.toThrow("EVIDENCE_WORK_JOB_CONFLICT");
    const counts = await pool.query<{ work: number; receipts: number }>(
      `SELECT
           (SELECT count(*)::int FROM research_evidence_work WHERE work_key=$1) AS work,
           (SELECT count(*)::int FROM research_evidence_work_receipt WHERE work_key=$1) AS receipts`,
      [workKey],
    );
    expect(counts.rows[0]).toEqual({ work: 1, receipts: 2 });
    const work = (await automation.list("CA_TSX")).find(
      (row) => row.workKey === workKey,
    );
    expect(work?.jobId).toBe(jobId);
    expect(work?.receipt?.state).toBe("DISPATCHED");
    expect(
      (await automation.list("US_EQUITIES")).some(
        (row) => row.workKey === workKey,
      ),
    ).toBe(false);
  });

  it("leaves no durable work when dispatch rolls back and recovers identically on retry", async () => {
    const value = identity({
      scopeHash: contentHash({ case: "crash-before-commit" }),
      inputIdentityHash: contentHash({ case: "crash-before-commit-input" }),
    });
    const workKey = evidenceWorkKey(value);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await automation.recordWithClient(client, value, receipt(value));
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM research_evidence_work WHERE work_key=$1",
          [workKey],
        )
      ).rows[0].count,
    ).toBe(0);
    await automation.record(value, receipt(value));
    expect(
      (
        await pool.query(
          "SELECT count(*)::int AS count FROM research_evidence_work WHERE work_key=$1",
          [workKey],
        )
      ).rows[0].count,
    ).toBe(1);
  });

  it("serves two concurrent dispatchers, duplicate delivery and restart with one strict job", async () => {
    const input = coverageInput(randomUUID());
    const [first, second] = await Promise.all([
      requests.create(input, randomUUID()),
      requests.create(input, randomUUID()),
    ]);
    expect(second.id).toBe(first.id);
    expect(second.latestJobId).toBe(first.latestJobId);
    const restarted = await new PostgresCoverageRequestRepository(pool).create(
      input,
      randomUUID(),
    );
    expect(restarted).toEqual(first);
    const jobs = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM research_job
          WHERE job_type='COVERAGE_VERIFICATION'
            AND request_payload->>'requestId'=$1::text`,
      [first.id],
    );
    expect(jobs.rows[0]?.count).toBe(1);
    const requestHash = await pool.query<{ request_hash: string }>(
      "SELECT request_hash FROM research_coverage_request WHERE id=$1",
      [first.id],
    );
    const work = (await automation.list("CA_TSX")).find(
      (row) =>
        row.identity.inputIdentityHash === requestHash.rows[0]?.request_hash &&
        row.identity.processorVersion === "coverage-request-v2",
    );
    expect(work?.jobId).toBe(first.latestJobId);
    expect(work?.receipt?.state).toBe("DISPATCHED");
  });

  it("rejects a changed payload under a reused key before any domain write", async () => {
    const input = coverageInput(randomUUID());
    const key = randomUUID();
    const created = await requests.create(input, key);
    const before = await countsForRequest(created.id);
    const changed: CreateCoverageRequest = {
      ...input,
      recipe: { ...input.recipe, featureVersion: "changed" },
    };
    await expect(requests.create(changed, key)).rejects.toThrow(
      "IDEMPOTENCY_CONFLICT",
    );
    expect(await countsForRequest(created.id)).toEqual(before);
  });

  it("advances the source watermark once per late revision, isolates markets and no-ops on restart", async () => {
    const caSnapshot = await watermarkSnapshot("CA_TSX");
    const usSnapshot = await watermarkSnapshot("US_EQUITIES");
    try {
      // Settle sources left by suites sharing this database before measuring.
      while (await automation.catchUp("CA_TSX", 100, 10_000)) {
        /* bounded pages */
      }
      const caBase = (await latestCompletedAt("CA_TSX")).getTime();
      const caSources: string[] = [];
      for (let index = 0; index < 3; index += 1) {
        const id = randomUUID();
        caSources.push(id);
        await insertCompletedRun(id, "CA_TSX", caBase + (index + 1) * 1_000);
      }
      // A late source revision is a new bounded identity, two per pass.
      expect(await automation.catchUp("CA_TSX", 2, 10_000)).toBe(2);
      expect(await automation.catchUp("CA_TSX", 2, 10_000)).toBe(1);
      expect(await catchUpReceiptCount("CA_TSX", caSources)).toBe(3);
      // Restart/unchanged prerequisites: no new receipt per poll.
      expect(await automation.catchUp("CA_TSX", 5, 10_000)).toBe(0);
      expect(await catchUpReceiptCount("CA_TSX", caSources)).toBe(3);
      const works = (await automation.list("CA_TSX")).filter((row) =>
        caSources.some(
          (sourceId) =>
            row.identity.scopeHash ===
            contentHash({ marketId: "CA_TSX", sourceId }),
        ),
      );
      expect(works).toHaveLength(3);
      for (const work of works) {
        expect(work.receipt?.state).toBe("WAITING");
        expect(work.receipt?.reasonCodes).toEqual([
          "SOURCE_REVISION_UNAVAILABLE",
          "RESEARCH_SCOPE_UNAVAILABLE",
        ]);
      }
      // Cross-market identity is isolated in both directions.
      const usSource = randomUUID();
      const usBase = (await latestCompletedAt("US_EQUITIES")).getTime();
      await insertCompletedRun(usSource, "US_EQUITIES", usBase + 1_000);
      expect(await automation.catchUp("CA_TSX", 100, 10_000)).toBe(0);
      expect(
        await automation.catchUp("US_EQUITIES", 10, 10_000),
      ).toBeGreaterThanOrEqual(1);
      expect(
        (await automation.list("CA_TSX")).some(
          (row) =>
            row.identity.scopeHash ===
            contentHash({ marketId: "US_EQUITIES", sourceId: usSource }),
        ),
      ).toBe(false);
      expect(
        (await automation.list("US_EQUITIES")).some(
          (row) =>
            row.identity.scopeHash ===
            contentHash({ marketId: "US_EQUITIES", sourceId: usSource }),
        ),
      ).toBe(true);
    } finally {
      await restoreWatermark("CA_TSX", caSnapshot);
      await restoreWatermark("US_EQUITIES", usSnapshot);
    }
  });
});
