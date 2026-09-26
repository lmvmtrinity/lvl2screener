import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  PaperEvidenceCohort,
  PaperEvidenceResearchQualification,
  PaperEvidenceTrainingRow,
  ResearchCoverageReport,
} from "@tsx-scanner/contracts";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { migrate } from "../src/database/migrate.js";
import {
  contentHash,
  coverageReportHash,
} from "../src/backtests/research-coverage.js";
import { ResearchLineageService } from "../src/backtests/research-lineage-service.js";
import type { ReplaySessionPolicy } from "../src/backtests/backtest-repository.js";
import { PostgresCoverageRequestRepository } from "../src/backtests/coverage-request-repository.js";
import { PostgresResearchEvidenceStore } from "../src/backtests/research-evidence-repository.js";
import { ResearchJobRepository } from "../src/research-jobs/research-job-repository.js";
import { PostgresDatasetPreparationStore } from "../src/statistical-models/dataset-preparation-repository.js";
import { PostgresPaperEvidenceTrainingStore } from "../src/statistical-models/paper-evidence-training-repository.js";
import { PaperEvidenceTrainingService } from "../src/statistical-models/paper-evidence-training-service.js";
import { PaperEvidenceTrainingScheduler } from "../src/statistical-models/paper-evidence-training-scheduler.js";
import { ResearchDatasetLineageReconciler } from "../src/statistical-models/research-dataset-lineage-reconciler.js";

const url = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

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

function runtime() {
  return {
    current: async () => ({
      engineRevision: "e".repeat(40),
      runtimeFingerprint: "f".repeat(64),
      featureVersion: "1.2.0",
    }),
  };
}

function cohort(): PaperEvidenceCohort {
  return {
    marketId: "CA_TSX",
    strategy: "ORB_RETEST",
    strategyVersion: "integration-1",
    profileConfigId: randomUUID(),
    configVersion: "1",
    executionModelVersion: "paper-model-v1",
    assumptions: { fixture: "real-lineage" },
    closedQuoteCount: 220,
    positives: 110,
    negatives: 110,
    firstSignalAt: "2026-09-10T15:00:00.000Z",
    lastSignalAt: "2026-09-10T15:00:00.000Z",
    missingFeatureCount: 0,
    signalSemanticsVersion: "setup-semantics-v2",
    replayScope: "FORWARD_LIVE",
  };
}

function rows(): PaperEvidenceTrainingRow[] {
  return [0, 1].map((index) => ({
    marketId: "CA_TSX" as const,
    sourceKey: `integration-source-${randomUUID()}`,
    executionId: randomUUID(),
    observationId: randomUUID(),
    instrumentId: randomUUID(),
    signalTimestamp: `2026-09-10T15:00:0${index}.000Z`,
    labelAvailableAt: `2026-09-10T16:00:0${index}.000Z`,
    deterministicScore: 80 + index,
    atrPct: 1,
    rvolAtTime: 2,
    rMultiple: index === 0 ? 1 : -1,
  }));
}

function qualification(
  sourceRows: PaperEvidenceTrainingRow[],
): PaperEvidenceResearchQualification {
  return {
    policyVersion: "paper-research-qualification-v2",
    qualified: true,
    reasons: [],
    sourceRowCount: 220,
    acceptedRowCount: sourceRows.length,
    distinctSessionCount: 4,
    chronologicalSplitAt: "2026-09-10T15:00:00.500Z",
    walkForwardWindows: [],
    excludedCounts: {},
  };
}

async function requestForPreparation(pool: Pool, preparationId: string) {
  const result = await pool.query<{
    id: string;
    latest_job_id: string;
    request_hash: string;
    request: any;
  }>(
    `SELECT id,latest_job_id,request_hash,request
       FROM research_coverage_request
      WHERE request->'manifest'->'manifest'->'purpose'->>'preparationId'=$1`,
    [preparationId],
  );
  expect(result.rows).toHaveLength(1);
  return result.rows[0]!;
}

async function settleCoverage(
  pool: Pool,
  request: Awaited<ReturnType<typeof requestForPreparation>>,
  status: ResearchCoverageReport["status"],
): Promise<string> {
  const evidence = new PostgresResearchEvidenceStore(pool);
  const date = request.request.recipe.sessionDates[0]!;
  const payload = { source: "synthetic-verified-session", date };
  const report: ResearchCoverageReport = {
    version: "research-coverage-v2",
    marketId: "CA_TSX",
    manifestHash: request.request.manifest.hash,
    expectedInputsHash: contentHash(request.request.recipe),
    inputHash: contentHash({ requestHash: request.request_hash }),
    sessionPayloadHashes: { [date]: contentHash({ date, payload }) },
    verifiedAt: "2026-09-10T21:05:00.000Z",
    status,
    cells: [],
  };
  const reportHash = await evidence.saveReport(report);
  await evidence.saveManifest(request.request.manifest);
  await pool.query(
    "UPDATE research_job SET status='SUCCEEDED',completed_at=clock_timestamp() WHERE id=$1",
    [request.latest_job_id],
  );
  if (status === "VERIFIED") {
    await evidence.bind(
      { kind: "JOB", id: request.latest_job_id, marketId: "CA_TSX" },
      {
        manifestHash: report.manifestHash,
        coverageReportHash: coverageReportHash(report),
        inputHash: report.inputHash,
        engineRevision: request.request.recipe.engineRevision,
        runtimeFingerprint: request.request.recipe.runtimeFingerprint,
        verifiedAt: report.verifiedAt,
      },
    );
  }
  await new PostgresCoverageRequestRepository(pool).recordResult(
    request.id,
    request.latest_job_id,
    reportHash,
    status,
  );
  return reportHash;
}

describe.skipIf(!url)(
  "real dataset preparation and lineage producer lifecycle",
  () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = new Pool({ connectionString: url });
      await migrate(pool);
    }, 60000);
    afterAll(async () => pool?.end());

    it("freezes exact nonempty rows, proves VERIFIED lineage after restart, and preserves legacy/UNKNOWN", async () => {
      const training = new PostgresPaperEvidenceTrainingStore(pool);
      const preparations = new PostgresDatasetPreparationStore(pool);
      const lineage = new ResearchLineageService(pool, runtime(), {
        CA_TSX: policy,
        US_EQUITIES: { ...policy, timezone: "America/New_York" },
      });
      const frozenCohort = cohort();
      const frozenRows = rows();
      const frozenQualification = qualification(frozenRows);
      const first = new PaperEvidenceTrainingService(
        training,
        lineage,
        preparations,
      );
      const firstPass = await first.prepareAndMaterialize(
        frozenCohort,
        new Date("2026-09-10T21:00:00.000Z"),
        {
          qualification: frozenQualification,
          acceptedRows: frozenRows,
          qualifiedRows: frozenRows,
        },
      );
      expect(firstPass).toEqual({ dataset: undefined, pending: true });
      expect(await training.countDatasets()).toBe(0);
      const preparation = await preparations.findPending(frozenCohort);
      expect(preparation?.rows).toEqual(frozenRows);
      const request = await requestForPreparation(pool, preparation!.id);
      const reportHash = await settleCoverage(pool, request, "VERIFIED");
      const reconciler = new ResearchDatasetLineageReconciler(pool);
      expect(await reconciler.catchUp("CA_TSX", 100, 10000)).toBe(0);
      expect(
        (
          await pool.query(
            `SELECT count(*)::int AS count
               FROM research_evidence_work
              WHERE scope_hash=$1 AND processor_version='dataset-lineage-proof-v2'`,
            [request.request_hash],
          )
        ).rows[0]?.count,
      ).toBe(0);

      const second = new PaperEvidenceTrainingService(
        training,
        lineage,
        preparations,
      );
      const secondPass = await second.prepareAndMaterialize(
        {
          ...frozenCohort,
          closedQuoteCount: 260,
          positives: 130,
          negatives: 130,
          lastSignalAt: "2026-09-11T15:00:00.000Z",
        },
        new Date("2026-09-11T21:00:00.000Z"),
      );
      expect(secondPass.pending).toBe(false);
      expect(secondPass.dataset?.sourceDigest).toBe(preparation!.sourceDigest);
      expect(secondPass.dataset?.cohort).toEqual(preparation!.cohort);
      expect(secondPass.dataset?.requestedCutoff).toBe(
        preparation!.requestedCutoff,
      );
      expect(secondPass.dataset?.researchDerivation).toMatchObject({
        complete: true,
        sourceDigest: preparation!.sourceDigest,
        rowCount: frozenRows.length,
        reasons: [],
        coverageReportHash: reportHash,
      });
      expect(
        await pool.query(
          "SELECT count(*)::int AS count FROM research_coverage_request WHERE request->'manifest'->'manifest'->'purpose'->>'preparationId'=$1",
          [preparation!.id],
        ),
      ).toMatchObject({ rows: [{ count: 1 }] });

      expect(await reconciler.catchUp("CA_TSX", 100, 10000)).toBe(1);
      const receipt = await pool.query<{ receipt: any }>(
        `SELECT r.receipt
           FROM research_evidence_work w
           JOIN research_evidence_work_receipt r USING(work_key)
          WHERE w.scope_hash=$1 AND w.processor_version='dataset-lineage-proof-v2'`,
        [request.request_hash],
      );
      expect(receipt.rows.at(-1)?.receipt.reasonCodes).toEqual([]);

      const unknownCohort = cohort();
      const unknownRows = rows();
      unknownCohort.profileConfigId = randomUUID();
      const unknownQualification = qualification(unknownRows);
      const unknownFirst = new PaperEvidenceTrainingService(
        training,
        lineage,
        preparations,
      );
      const unknownPending = await unknownFirst.prepareAndMaterialize(
        unknownCohort,
        new Date("2026-09-12T21:00:00.000Z"),
        {
          qualification: unknownQualification,
          acceptedRows: unknownRows,
          qualifiedRows: unknownRows,
        },
      );
      expect(unknownPending.pending).toBe(true);
      const unknownPreparation = await preparations.findPending(unknownCohort);
      const unknownRequest = await requestForPreparation(
        pool,
        unknownPreparation!.id,
      );
      await settleCoverage(pool, unknownRequest, "UNKNOWN");
      const unknownFinal = await new PaperEvidenceTrainingService(
        training,
        lineage,
        preparations,
      ).prepareAndMaterialize(
        { ...unknownCohort, closedQuoteCount: 260 },
        new Date("2026-09-13T21:00:00.000Z"),
      );
      expect(unknownFinal.pending).toBe(false);
      expect(unknownFinal.dataset?.researchEvidence).toBeNull();
      expect(unknownFinal.dataset?.researchDerivation?.complete).toBe(false);
      expect(unknownFinal.dataset?.researchDerivation?.reasons).toContain(
        "COVERAGE_REPORT_UNVERIFIED",
      );

      const legacy = await training.createDataset({
        policyVersion: "paper-evidence-v1",
        cohort: { ...cohort(), profileConfigId: randomUUID() },
        requestedCutoff: new Date("2026-09-10T21:00:00.000Z"),
        effectiveCutoff: new Date("2026-09-10T21:00:00.000Z"),
        sourceDigest: contentHash({ legacy: randomUUID() }),
        excludedCounts: {},
        researchQualification: {
          ...frozenQualification,
          qualified: false,
          reasons: ["LEGACY_UNPROVEN"],
        },
        rows: [],
      });
      expect(
        (await training.getDataset(legacy.id))?.researchDerivation,
      ).toBeNull();
    });

    it("retries the exact dataset job after a scheduler crash between commits", async () => {
      const training = new PostgresPaperEvidenceTrainingStore(pool);
      const preparations = new PostgresDatasetPreparationStore(pool);
      const lineage = new ResearchLineageService(pool, runtime(), {
        CA_TSX: policy,
        US_EQUITIES: { ...policy, timezone: "America/New_York" },
      });
      const frozenCohort = cohort();
      const frozenRows = rows();
      const baselineDatasetCount = await training.countDatasets();
      const service = new PaperEvidenceTrainingService(
        training,
        lineage,
        preparations,
      );
      await expect(
        service.prepareAndMaterialize(
          frozenCohort,
          new Date("2026-09-14T21:00:00.000Z"),
          {
            qualification: qualification(frozenRows),
            acceptedRows: frozenRows,
            qualifiedRows: frozenRows,
          },
        ),
      ).resolves.toEqual({ dataset: undefined, pending: true });
      const preparation = await preparations.findPending(frozenCohort);
      const request = await requestForPreparation(pool, preparation!.id);
      await settleCoverage(pool, request, "VERIFIED");

      const realJobs = new ResearchJobRepository(pool);
      const crashingJobs = {
        createJob: async (
          jobType: Parameters<ResearchJobRepository["createJob"]>[0],
          payload: unknown,
          idempotencyKey?: string | null,
        ) => {
          if (idempotencyKey === `paper-evidence:${preparation!.sourceDigest}`)
            throw new Error("SIMULATED_SCHEDULER_CRASH_AFTER_DATASET");
          return realJobs.createJob(jobType, payload, idempotencyKey);
        },
      };
      const crashedScheduler = new PaperEvidenceTrainingScheduler(
        service,
        crashingJobs as never,
        () => new Date("2026-09-14T22:00:00.000Z"),
      );
      await expect(crashedScheduler.run()).rejects.toThrow(
        "SIMULATED_SCHEDULER_CRASH_AFTER_DATASET",
      );
      expect(await training.countDatasets()).toBe(baselineDatasetCount + 1);
      expect(await preparations.findPending(frozenCohort)).toMatchObject({
        id: preparation!.id,
        sourceDigest: preparation!.sourceDigest,
      });

      const retryScheduler = new PaperEvidenceTrainingScheduler(
        service,
        realJobs,
        () => new Date("2026-09-15T22:00:00.000Z"),
      );
      await expect(retryScheduler.run()).resolves.toBe(1);
      expect(
        await pool.query(
          `SELECT count(*)::int AS count
             FROM research_job
            WHERE job_type='STATISTICAL_TRAINING'
              AND idempotency_key=$1`,
          [`paper-evidence:${preparation!.sourceDigest}`],
        ),
      ).toMatchObject({ rows: [{ count: 1 }] });
      expect(await preparations.findPending(frozenCohort)).toBeUndefined();
    });
  },
);
