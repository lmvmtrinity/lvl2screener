import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { migrate } from "../src/database/migrate.js";
import { contentHash } from "../src/backtests/research-coverage.js";
import {
  ResearchLineageService,
  type ArtifactCoverageScope,
} from "../src/backtests/research-lineage-service.js";
import { ResearchCoverageService } from "../src/backtests/research-coverage-service.js";
import { PostgresResearchEvidenceStore } from "../src/backtests/research-evidence-repository.js";
import { PostgresCoverageRequestRepository } from "../src/backtests/coverage-request-repository.js";
import { ResearchJobRepository } from "../src/research-jobs/research-job-repository.js";
import { CoverageVerificationJobHandler } from "../src/worker/handlers/coverage-verification-job-handler.js";
import type { ReplaySessionPolicy } from "../src/backtests/backtest-repository.js";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";
import { PostgresCalibrationStore } from "../src/calibration/calibration-repository.js";
import {
  createBacktestSchema,
  createCalibrationSchema,
  replayInputSnapshotSchema,
} from "@tsx-scanner/contracts";

const url = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
describe.skipIf(!url)("artifact lineage real asynchronous resolution", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await migrate(pool);
  }, 60000);
  afterAll(async () => pool?.end());
  it("reuses verified BACKTEST/CALIBRATION requests across audit clocks, rejects changed payloads, and leaves DATASET derivation unproven", async () => {
    const date = "2026-09-10",
      start = `${date}T15:00:00.000Z`,
      end = `${date}T15:00:01.000Z`;
    const payload = {
      instruments: [randomUUID()],
      quotes: [{ timestamp: start, bid: 10, ask: 11 }],
    };
    const sessionPayloadHashes = { [date]: contentHash({ date, payload }) };
    const runtime = {
      current: async () => ({
        engineRevision: "a".repeat(40),
        runtimeFingerprint: "b".repeat(64),
        featureVersion: "1.2.0",
      }),
    };
    const policy: ReplaySessionPolicy = {
      timezone: "America/Toronto",
      openingRange: { start: "09:30", end: "09:45" },
      scanning: { start: "09:30", end: "16:00" },
      entries: {
        preferredStart: "09:45",
        preferredEnd: "15:00",
        hardEnd: "15:30",
      },
    };
    const lineage = new ResearchLineageService(pool, runtime, {
      CA_TSX: policy,
      US_EQUITIES: { ...policy, timezone: "America/New_York" },
    });
    const evidence = new PostgresResearchEvidenceStore(pool),
      jobs = new ResearchJobRepository(pool);
    const coverage = new ResearchCoverageService(
      {
        readFrozenInputs: async () => ({
          expected: [
            {
              cellId: "fixture",
              marketId: "CA_TSX",
              instrumentId: payload.instruments[0]!,
              sessionDate: date,
              role: "CANDIDATE",
              membership: "REQUIRED",
              membershipSourceHash: contentHash("membership"),
              calendarSourceHash: contentHash("calendar"),
              windowStart: start,
              windowEnd: end,
              maxQuoteGapMs: 1000,
              warmupTimeframe: "Daily",
              warmupWindowStart: `${date}T00:00:00.000Z`,
              warmupBefore: start,
              requiredWarmupBars: 0,
            },
          ],
          receipts: [
            {
              cellId: "fixture",
              inputHash: contentHash(payload),
              provenance: "VERIFIED",
              provenanceReasons: [],
              quoteTimes: [start, end],
              invalidQuoteCount: 0,
              warmupTimeframe: "Daily",
              warmupBarTimes: [],
              invalidWarmupBarCount: 0,
            },
          ],
          sessionPayloadHashes,
          sessionPayloads: { [date]: payload },
        }),
      },
      () => new Date("2026-09-10T21:00:00.000Z"),
    );
    const handler = new CoverageVerificationJobHandler(
      coverage,
      evidence,
      jobs,
      new PostgresCoverageRequestRepository(pool),
      runtime,
    );
    const nonce = randomUUID();
    async function verifyPending(input: ArtifactCoverageScope) {
      const pending = await pool.query<{ latest_job_id: string }>(
        "SELECT latest_job_id FROM research_coverage_request WHERE request->'manifest'->'manifest'->'purpose'->'scope'->>'nonce'=$1 AND request->'manifest'->'manifest'->'purpose'->>'kind'=$2 ORDER BY created_at DESC LIMIT 1",
        [nonce, input.kind],
      );
      expect(pending.rows).toHaveLength(1);
      // Claim only this fixture through the real queue without consuming another suite's work.
      await pool.query(
        "UPDATE research_job SET created_at='1900-01-01' WHERE id=$1",
        [pending.rows[0]!.latest_job_id],
      );
      const job = await jobs.claimNext(
        ["COVERAGE_VERIFICATION"],
        "lineage-fixture",
        60000,
      );
      expect(job?.id).toBe(pending.rows[0]!.latest_job_id);
      const result = await handler.execute(job!, {
        jobId: job!.id,
        heartbeat: (progress) =>
          jobs.heartbeat(job!.id, job!.leaseOwner, 60000, progress),
      });
      await jobs.complete(job!.id, job!.leaseOwner, result.resultRefId);
      const binding = await evidence.getBinding({
        kind: "JOB",
        id: job!.id,
        marketId: "CA_TSX",
      });
      expect(binding).not.toBeNull();
      return binding;
    }
    const replayInput = (clock: string) =>
      replayInputSnapshotSchema.parse({
        version: "replay-input-v1",
        marketId: "CA_TSX",
        resolvedAt: clock,
        inputHash: contentHash(clock),
        requestedSymbols: ["TEST"],
        candidateInstruments: [
          {
            instrumentId: payload.instruments[0],
            symbol: "TEST",
            sector: null,
          },
        ],
        benchmarks: [],
        universeRefreshRunId: null,
        warnings: [],
        capturedHistoryAvailability: {
          observedAt: clock,
          source: "CAPTURED_QUOTES",
          tables: {
            quoteSnapshot: { earliest: start, latest: end },
            candle: { earliest: null, latest: null },
          },
          replay: { earliestDate: date, latestDate: date },
        },
      });
    for (const kind of ["BACKTEST", "CALIBRATION"] as const) {
      const input: ArtifactCoverageScope = {
        kind,
        marketId: "CA_TSX",
        scope: { nonce, replayInput: replayInput(start) },
        sessionDates: [date],
        inputCutoff: "2026-09-10T21:00:00.000Z",
        sessionPayloadHashes,
      };
      expect(await lineage.resolve(input)).toBeUndefined();
      const binding = await verifyPending(input);
      const retry = {
        ...input,
        scope: { nonce, replayInput: replayInput(end) },
      };
      expect(await lineage.resolve(retry)).toEqual(binding);
      const owner =
        kind === "BACKTEST"
          ? await new PostgresBacktestStore(pool).create(
              createBacktestSchema.parse({
                name: `lineage-${nonce}`,
                startDate: date,
                endDate: date,
              }),
              "fixture-v1",
              replayInput(end).capturedHistoryAvailability,
              replayInput(end),
              undefined,
              binding!,
            )
          : await new PostgresCalibrationStore(pool).create(
              createCalibrationSchema.parse({
                name: `lineage-${nonce}`,
                startDate: date,
                endDate: date,
                strategy: "ORB_RETEST",
              }),
              1,
              false,
              replayInput(end).capturedHistoryAvailability,
              undefined,
              binding!,
            );
      expect(owner.researchEvidence).toEqual(binding);
      expect(
        await evidence.getBinding({ kind, id: owner.id, marketId: "CA_TSX" }),
      ).toEqual(binding);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM research_coverage_request WHERE request->'manifest'->'manifest'->'purpose'->'scope'->>'nonce'=$1 AND request->'manifest'->'manifest'->'purpose'->>'kind'=$2",
            [nonce, kind],
          )
        ).rows[0].count,
      ).toBe(1);
      const changed = {
        ...retry,
        sessionPayloadHashes: {
          [date]: contentHash("different actual payload"),
        },
      };
      expect(await lineage.resolve(changed)).toBeUndefined();
      await verifyPending(changed);
      expect(await lineage.resolve(changed)).toBeUndefined();
    }
    const dataset: ArtifactCoverageScope = {
      kind: "DATASET",
      marketId: "CA_TSX",
      scope: { nonce, sourceDigest: contentHash(nonce), rows: [] },
      sessionDates: [date],
      inputCutoff: "2026-09-10T21:00:00.000Z",
      sessionPayloadHashes,
    };
    expect(await lineage.resolve(dataset)).toBeUndefined();
    await verifyPending(dataset);
    expect(await lineage.resolve(dataset)).toBeUndefined();
    const waiting = await pool.query(
      "SELECT r.receipt FROM research_evidence_work w JOIN research_evidence_work_receipt r USING(work_key) WHERE w.processor_version='dataset-derivation-v1' AND w.scope_hash=$1",
      [contentHash(dataset)],
    );
    expect(waiting.rows[0]?.receipt).toMatchObject({
      state: "WAITING",
      reasonCodes: ["DATASET_DERIVATION_UNPROVEN"],
    });
  });
});
