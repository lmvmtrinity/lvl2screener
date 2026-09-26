import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { migrate } from "../src/database/migrate.js";
import {
  contentHash,
  coverageReportHash,
} from "../src/backtests/research-coverage.js";
import { PostgresResearchEvidenceStore } from "../src/backtests/research-evidence-repository.js";
import { datasetRowsDigest } from "../src/backtests/research-lineage-service.js";
import { PostgresPaperEvidenceTrainingStore } from "../src/statistical-models/paper-evidence-training-repository.js";
import { ResearchDatasetLineageReconciler } from "../src/statistical-models/research-dataset-lineage-reconciler.js";
import type {
  DatasetResearchDerivation,
  PaperEvidenceCohort,
  PaperEvidenceTrainingRow,
  ResearchCoverageReport,
} from "@tsx-scanner/contracts";

const url = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

async function seedDerivationFixture(
  pool: Pool,
  patch: Partial<DatasetResearchDerivation> = {},
  purposeMarketId: "CA_TSX" | "US_EQUITIES" = "CA_TSX",
  marketId: "CA_TSX" | "US_EQUITIES" = "CA_TSX",
): Promise<string> {
  const store = new PostgresPaperEvidenceTrainingStore(pool);
  const evidence = new PostgresResearchEvidenceStore(pool);
  const cutoff = "2026-09-11T21:00:00.000Z";
  const cohort: PaperEvidenceCohort = {
    marketId,
    strategy: "ORB_RETEST" as const,
    strategyVersion: "1",
    profileConfigId: randomUUID(),
    configVersion: "1",
    executionModelVersion: "1",
    assumptions: { fixture: randomUUID() },
    closedQuoteCount: 1,
    positives: 1,
    negatives: 0,
    firstSignalAt: "2026-09-11T15:00:00.000Z",
    lastSignalAt: "2026-09-11T15:00:00.000Z",
    missingFeatureCount: 0,
  };
  const rows: PaperEvidenceTrainingRow[] = [
    {
      marketId,
      sourceKey: randomUUID(),
      executionId: randomUUID(),
      observationId: randomUUID(),
      instrumentId: randomUUID(),
      signalTimestamp: "2026-09-11T15:00:00.000Z",
      labelAvailableAt: "2026-09-11T16:00:00.000Z",
      deterministicScore: 80,
      atrPct: 1,
      rvolAtTime: 2,
      rMultiple: 1,
    },
  ];
  const sourceDigest = contentHash({ source: randomUUID() });
  const purpose = {
    kind: "DATASET",
    marketId: purposeMarketId,
    inputCutoff: cutoff,
    sessionDates: ["2026-09-11"],
    scope: { sourceDigest, cohort, rows },
  };
  const manifest = { version: "artifact-coverage-v1", purpose };
  const manifestHash = contentHash(manifest);
  const recipe = {
    version: "research-coverage-recipe-v2",
    marketId,
    engineRevision: "e".repeat(40),
    runtimeFingerprint: "f".repeat(64),
    featureVersion: "1.2.0",
    sessionDates: ["2026-09-11"],
    inputCutoff: cutoff,
    streamRequirements: [
      {
        timeframe: "OneMinute" as const,
        warmupDays: 0,
        requiredWarmupBars: 0,
        includeInSession: true,
      },
    ],
    maxQuoteGapMs: 30_000,
    replayPolicyHash: "1".repeat(64),
    membershipPolicyHash: "2".repeat(64),
    calendarPolicyHash: "3".repeat(64),
  };
  const request = {
    manifest: { hash: manifestHash, marketId, manifest },
    recipe,
  };
  const requestHash = contentHash(request);
  const report = {
    version: "research-coverage-v2" as const,
    marketId,
    manifestHash,
    expectedInputsHash: "4".repeat(64),
    inputHash: contentHash({ requestHash }),
    sessionPayloadHashes: { "2026-09-11": "5".repeat(64) },
    verifiedAt: "2026-09-11T21:05:00.000Z",
    status: "VERIFIED" as const,
    cells: [],
  };
  const reportHash = await evidence.saveReport(report);
  await evidence.saveManifest({
    hash: manifestHash,
    marketId,
    manifest,
  });
  const binding = {
    manifestHash,
    coverageReportHash: reportHash,
    inputHash: report.inputHash,
    engineRevision: recipe.engineRevision,
    runtimeFingerprint: recipe.runtimeFingerprint,
    verifiedAt: report.verifiedAt,
  };
  const derivation: DatasetResearchDerivation = {
    version: "dataset-derivation-v1",
    complete: true,
    featureVersion: recipe.featureVersion,
    engineRevision: recipe.engineRevision,
    runtimeFingerprint: recipe.runtimeFingerprint,
    sourceDigest,
    rowsDigest: contentHash(rows.map((row) => row.sourceKey)),
    rowCount: rows.length,
    sessionPayloadHashes: report.sessionPayloadHashes,
    coverageManifestHash: manifestHash,
    coverageReportHash: reportHash,
    reasons: [],
    capturedAt: "2026-09-11T21:05:00.000Z",
    ...patch,
  };
  const dataset = await store.createDataset({
    policyVersion: "test",
    cohort,
    requestedCutoff: new Date(cutoff),
    effectiveCutoff: new Date(cutoff),
    sourceDigest,
    excludedCounts: {},
    researchQualification: {
      policyVersion: "test",
      qualified: false,
      reasons: ["INSUFFICIENT_ROWS"],
      sourceRowCount: 1,
      acceptedRowCount: 1,
      distinctSessionCount: 1,
      chronologicalSplitAt: null,
      walkForwardWindows: [],
      excludedCounts: {},
    },
    researchEvidence: binding,
    researchDerivation: derivation,
    rows,
  });
  const requestId = randomUUID();
  const jobId = randomUUID();
  await pool.query(
    "INSERT INTO research_coverage_request(id,market_id,request_hash,request,idempotency_key) VALUES($1::uuid,$4,$2,$3::jsonb,$1::text)",
    [requestId, requestHash, JSON.stringify(request), marketId],
  );
  await pool.query(
    "INSERT INTO research_job(id,job_type,status,request_payload) VALUES($1,'COVERAGE_VERIFICATION','SUCCEEDED',$2::jsonb)",
    [
      jobId,
      JSON.stringify({
        version: "coverage-verification-v2",
        requestId,
        request,
      }),
    ],
  );
  await pool.query(
    "UPDATE research_coverage_request SET latest_job_id=$2 WHERE id=$1",
    [requestId, jobId],
  );
  await pool.query(
    "INSERT INTO research_coverage_request_result(work_key,request_id,job_id,report_hash,status) VALUES($1,$2,$3,$4,'VERIFIED')",
    [
      contentHash({ requestId, datasetId: dataset.id }),
      requestId,
      jobId,
      reportHash,
    ],
  );
  return requestHash;
}

type PendingCoverageOverrides = {
  marketId?: "CA_TSX" | "US_EQUITIES";
  createdAt?: string;
  recipeMarketId?: unknown;
  recipeInputCutoff?: unknown;
  recipeSessionDates?: unknown;
  purposeMarketId?: unknown;
  purposeInputCutoff?: unknown;
  purposeSessionDates?: unknown;
};

type PendingCoverageFixture = {
  requestHash: string;
  sourceDigest: string;
  cohort: PaperEvidenceCohort;
  rows: PaperEvidenceTrainingRow[];
  cutoff: string;
  manifestHash: string;
  reportHash: string;
  report: ResearchCoverageReport;
};

async function seedPendingPreparationCoverage(
  pool: Pool,
  overrides: PendingCoverageOverrides = {},
): Promise<PendingCoverageFixture> {
  const marketId = overrides.marketId ?? "CA_TSX";
  const preparationId = randomUUID();
  const requestId = randomUUID();
  const jobId = randomUUID();
  const cutoff = "2026-09-10T21:00:00.000Z";
  const cohort: PaperEvidenceCohort = {
    marketId,
    strategy: "ORB_RETEST" as const,
    strategyVersion: "pending-1",
    profileConfigId: randomUUID(),
    configVersion: "1",
    executionModelVersion: "1",
    assumptions: { fixture: "pending" },
    closedQuoteCount: 220,
    positives: 110,
    negatives: 110,
    firstSignalAt: "2026-09-10T15:00:00.000Z",
    lastSignalAt: "2026-09-10T15:00:00.000Z",
    missingFeatureCount: 0,
  };
  const rows: PaperEvidenceTrainingRow[] = [
    {
      marketId,
      sourceKey: randomUUID(),
      executionId: randomUUID(),
      observationId: randomUUID(),
      instrumentId: randomUUID(),
      signalTimestamp: "2026-09-10T15:00:00.000Z",
      labelAvailableAt: "2026-09-10T16:00:00.000Z",
      deterministicScore: 80,
      atrPct: 1,
      rvolAtTime: 2,
      rMultiple: 1,
    },
  ];
  const sourceDigest = contentHash({ pending: randomUUID() });
  const qualification = {
    policyVersion: "paper-research-qualification-v2",
    qualified: true,
    reasons: [],
    sourceRowCount: 220,
    acceptedRowCount: 1,
    distinctSessionCount: 1,
    chronologicalSplitAt: null,
    walkForwardWindows: [],
    excludedCounts: {},
  };
  await pool.query(
    `INSERT INTO statistical_training_dataset_preparation
       (id,market_id,cohort,requested_cutoff,effective_cutoff,source_digest,
        excluded_counts,research_qualification,qualified_rows)
     VALUES($1,$2,$3::jsonb,$4,$4,$5,'{}'::jsonb,$6::jsonb,$7::jsonb)`,
    [
      preparationId,
      marketId,
      JSON.stringify(cohort),
      cutoff,
      sourceDigest,
      JSON.stringify(qualification),
      JSON.stringify(rows),
    ],
  );
  const purpose = {
    kind: "DATASET",
    marketId: overrides.purposeMarketId ?? marketId,
    preparationId,
    inputCutoff: overrides.purposeInputCutoff ?? cutoff,
    sessionDates: overrides.purposeSessionDates ?? ["2026-09-10"],
    scope: { sourceDigest, cohort, rows },
  };
  const manifest = { version: "artifact-coverage-v1", purpose };
  const manifestHash = contentHash(manifest);
  const request = {
    manifest: { hash: manifestHash, marketId, manifest },
    recipe: {
      version: "research-coverage-recipe-v2",
      marketId: overrides.recipeMarketId ?? marketId,
      engineRevision: "e".repeat(40),
      runtimeFingerprint: "f".repeat(64),
      featureVersion: "1.2.0",
      inputCutoff: overrides.recipeInputCutoff ?? cutoff,
      sessionDates: overrides.recipeSessionDates ?? ["2026-09-10"],
      streamRequirements: [
        {
          timeframe: "OneMinute",
          warmupDays: 0,
          requiredWarmupBars: 0,
          includeInSession: true,
        },
      ],
      maxQuoteGapMs: 30_000,
      replayPolicyHash: "1".repeat(64),
      membershipPolicyHash: "2".repeat(64),
      calendarPolicyHash: "3".repeat(64),
    },
  };
  const requestHash = contentHash(request);
  const report: ResearchCoverageReport = {
    version: "research-coverage-v2",
    marketId,
    manifestHash,
    expectedInputsHash: contentHash(request.recipe),
    inputHash: contentHash({ requestHash }),
    sessionPayloadHashes: { "2026-09-10": "5".repeat(64) },
    verifiedAt: "2026-09-10T21:05:00.000Z",
    status: "VERIFIED",
    cells: [],
  };
  const reportHash = coverageReportHash(report);
  await pool.query(
    `INSERT INTO research_coverage_request
       (id,market_id,request_hash,request,idempotency_key,created_at)
     VALUES($1::uuid,$5,$2,$3::jsonb,$1::text,$4)`,
    [
      requestId,
      requestHash,
      JSON.stringify(request),
      overrides.createdAt ?? "2026-01-01T00:00:00.000001Z",
      marketId,
    ],
  );
  await pool.query(
    `INSERT INTO research_job(id,job_type,status,request_payload)
     VALUES($1,'COVERAGE_VERIFICATION','SUCCEEDED',$2::jsonb)`,
    [
      jobId,
      JSON.stringify({
        version: "coverage-verification-v2",
        requestId,
        request,
      }),
    ],
  );
  await pool.query(
    "UPDATE research_coverage_request SET latest_job_id=$2 WHERE id=$1",
    [requestId, jobId],
  );
  await pool.query(
    `INSERT INTO research_coverage_report
       (hash,market_id,input_hash,status,report)
     VALUES($1,$4,$2,'VERIFIED',$3::jsonb)`,
    [reportHash, report.inputHash, JSON.stringify(report), marketId],
  );
  await pool.query(
    `INSERT INTO research_manifest(hash,market_id,manifest)
     VALUES($1,$3,$2::jsonb) ON CONFLICT(hash) DO NOTHING`,
    [manifestHash, JSON.stringify(manifest), marketId],
  );
  await pool.query(
    `INSERT INTO research_coverage_request_result
       (work_key,request_id,job_id,report_hash,status)
     VALUES($1,$2,$3,$4,'VERIFIED')`,
    [contentHash({ pending: requestId }), requestId, jobId, reportHash],
  );
  return {
    requestHash,
    sourceDigest,
    cohort,
    rows,
    cutoff,
    manifestHash,
    reportHash,
    report,
  };
}

describe.skipIf(!url)(
  "immutable dataset asynchronous lineage prerequisites",
  () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = new Pool({ connectionString: url });
      await migrate(pool);
    }, 60000);
    afterAll(async () => pool?.end());
    it("finds the prior immutable dataset when aggregate cohort counters change", async () => {
      const store = new PostgresPaperEvidenceTrainingStore(pool);
      const cutoff = new Date("2026-09-10T21:00:00.000Z");
      const cohort = {
        marketId: "CA_TSX" as const,
        strategy: "ORB_RETEST" as const,
        strategyVersion: "1",
        profileConfigId: randomUUID(),
        configVersion: "1",
        executionModelVersion: "1",
        assumptions: { risk: "fixture" },
        closedQuoteCount: 1,
        positives: 1,
        negatives: 0,
        firstSignalAt: "2026-09-10T15:00:00.000Z",
        lastSignalAt: "2026-09-10T15:00:00.000Z",
        missingFeatureCount: 0,
      };
      const dataset = await store.createDataset({
        policyVersion: "test",
        cohort,
        requestedCutoff: cutoff,
        effectiveCutoff: cutoff,
        sourceDigest: contentHash({ stableLookup: randomUUID() }),
        excludedCounts: {},
        researchQualification: {
          policyVersion: "test",
          qualified: false,
          reasons: ["INSUFFICIENT_ROWS"],
          sourceRowCount: 0,
          acceptedRowCount: 0,
          distinctSessionCount: 0,
          chronologicalSplitAt: null,
          walkForwardWindows: [],
          excludedCounts: {},
        },
        rows: [],
      });

      await expect(
        store.latestDatasetFor({
          ...cohort,
          closedQuoteCount: 2,
          positives: 1,
          negatives: 1,
          lastSignalAt: "2026-09-10T16:00:00.000Z",
        }),
      ).resolves.toMatchObject({ id: dataset.id });
    });

    it("records bounded durable waiting, rejects spoofed membership and never invents feature lineage", async () => {
      // Settle earlier suites' requests before measuring this fixture's two pages.
      const prior = new ResearchDatasetLineageReconciler(pool);
      while (await prior.catchUp("CA_TSX", 100, 10000)) {
        /* bounded pages */
      }
      const store = new PostgresPaperEvidenceTrainingStore(pool);
      const cutoff = new Date("2026-09-10T21:00:00.000Z");
      const cohort = {
        marketId: "CA_TSX" as const,
        strategy: "ORB_RETEST" as const,
        strategyVersion: "1",
        profileConfigId: randomUUID(),
        configVersion: "1",
        executionModelVersion: "1",
        assumptions: {},
        closedQuoteCount: 1,
        positives: 1,
        negatives: 0,
        firstSignalAt: "2026-09-10T15:00:00.000Z",
        lastSignalAt: "2026-09-10T15:00:00.000Z",
        missingFeatureCount: 0,
      };
      const rows = [
        {
          marketId: "CA_TSX" as const,
          sourceKey: randomUUID(),
          executionId: randomUUID(),
          observationId: randomUUID(),
          instrumentId: randomUUID(),
          signalTimestamp: cohort.firstSignalAt,
          labelAvailableAt: "2026-09-10T16:00:00.000Z",
          deterministicScore: 80,
          atrPct: 1,
          rvolAtTime: 2,
          rMultiple: 1,
        },
      ];
      const original = await store.createDataset({
        policyVersion: "test",
        cohort,
        requestedCutoff: cutoff,
        effectiveCutoff: cutoff,
        sourceDigest: contentHash({ nonce: randomUUID() }),
        excludedCounts: {},
        researchQualification: {
          policyVersion: "test",
          qualified: false,
          reasons: ["INSUFFICIENT_ROWS"],
          sourceRowCount: 1,
          acceptedRowCount: 1,
          distinctSessionCount: 1,
          chronologicalSplitAt: null,
          walkForwardWindows: [],
          excludedCounts: {},
        },
        rows,
      });
      const identities: string[] = [];
      for (const spoof of [false, true]) {
        const id = randomUUID(),
          job = randomUUID();
        const purpose = {
          kind: "DATASET",
          marketId: "CA_TSX",
          inputCutoff: cutoff.toISOString(),
          sessionDates: ["2026-09-10"],
          scope: {
            sourceDigest: original.sourceDigest,
            cohort,
            rows: spoof ? [{ ...rows[0], deterministicScore: 81 }] : rows,
          },
        };
        const manifest = { version: "artifact-coverage-v1", purpose };
        const request = {
          manifest: { hash: contentHash(manifest), manifest },
          recipe: { marketId: "CA_TSX" },
        };
        const requestHash = contentHash(request),
          reportHash = contentHash({ requestHash, verified: true });
        identities.push(requestHash);
        await pool.query(
          "INSERT INTO research_coverage_request(id,market_id,request_hash,request,idempotency_key) VALUES($1::uuid,'CA_TSX',$2,$3::jsonb,$1::text)",
          [id, requestHash, JSON.stringify(request)],
        );
        await pool.query(
          "INSERT INTO research_job(id,job_type,status,request_payload) VALUES($1,'COVERAGE_VERIFICATION','SUCCEEDED',$2::jsonb)",
          [
            job,
            JSON.stringify({
              version: "coverage-verification-v2",
              requestId: id,
              request,
            }),
          ],
        );
        await pool.query(
          "UPDATE research_coverage_request SET latest_job_id=$2 WHERE id=$1",
          [id, job],
        );
        await pool.query(
          "INSERT INTO research_coverage_report(hash,market_id,input_hash,status,report) VALUES($1,'CA_TSX',$1,'VERIFIED',$2::jsonb)",
          [
            reportHash,
            JSON.stringify({
              manifestHash: request.manifest.hash,
              status: "VERIFIED",
              marketId: "CA_TSX",
            }),
          ],
        );
        await pool.query(
          "INSERT INTO research_coverage_request_result(work_key,request_id,job_id,report_hash,status) VALUES($1,$2,$3,$4,'VERIFIED')",
          [contentHash({ id }), id, job, reportHash],
        );
      }
      // A dataset materialized with the first-class derivation record: when the
      // record is complete and matches the frozen request, the reconciler must
      // not keep reporting the missing prerequisite.
      const proofSourceDigest = contentHash({ nonce: randomUUID() });
      const derivation = {
        version: "dataset-derivation-v1" as const,
        complete: true,
        featureVersion: "1.2.0",
        engineRevision: "e".repeat(40),
        runtimeFingerprint: "f".repeat(64),
        sourceDigest: proofSourceDigest,
        rowsDigest: contentHash(rows.map((row) => row.sourceKey)),
        rowCount: rows.length,
        sessionPayloadHashes: { "2026-09-10": "a".repeat(64) },
        coverageManifestHash: "b".repeat(64),
        coverageReportHash: "c".repeat(64),
        reasons: [],
        capturedAt: "2026-09-10T21:05:00.000Z",
      };
      await store.createDataset({
        policyVersion: "test",
        cohort,
        requestedCutoff: cutoff,
        effectiveCutoff: cutoff,
        sourceDigest: proofSourceDigest,
        excludedCounts: {},
        researchQualification: {
          policyVersion: "test",
          qualified: false,
          reasons: ["INSUFFICIENT_ROWS"],
          sourceRowCount: 1,
          acceptedRowCount: 1,
          distinctSessionCount: 1,
          chronologicalSplitAt: null,
          walkForwardWindows: [],
          excludedCounts: {},
        },
        researchDerivation: derivation,
        rows,
      });
      const proofId = randomUUID(),
        proofJob = randomUUID();
      const proofPurpose = {
        kind: "DATASET",
        marketId: "CA_TSX",
        inputCutoff: cutoff.toISOString(),
        sessionDates: ["2026-09-10"],
        scope: {
          sourceDigest: proofSourceDigest,
          cohort,
          rows,
        },
      };
      const proofManifest = {
        version: "artifact-coverage-v1",
        purpose: proofPurpose,
      };
      const proofRequest = {
        manifest: { hash: contentHash(proofManifest), manifest: proofManifest },
        recipe: { marketId: "CA_TSX" },
      };
      const proofRequestHash = contentHash(proofRequest),
        proofReportHash = contentHash({ proofRequestHash, verified: true });
      identities.push(proofRequestHash);
      await pool.query(
        "INSERT INTO research_coverage_request(id,market_id,request_hash,request,idempotency_key) VALUES($1::uuid,'CA_TSX',$2,$3::jsonb,$1::text)",
        [proofId, proofRequestHash, JSON.stringify(proofRequest)],
      );
      await pool.query(
        "INSERT INTO research_job(id,job_type,status,request_payload) VALUES($1,'COVERAGE_VERIFICATION','SUCCEEDED',$2::jsonb)",
        [
          proofJob,
          JSON.stringify({
            version: "coverage-verification-v2",
            requestId: proofId,
            request: proofRequest,
          }),
        ],
      );
      await pool.query(
        "UPDATE research_coverage_request SET latest_job_id=$2 WHERE id=$1",
        [proofId, proofJob],
      );
      await pool.query(
        "INSERT INTO research_coverage_report(hash,market_id,input_hash,status,report) VALUES($1,'CA_TSX',$1,'VERIFIED',$2::jsonb)",
        [
          proofReportHash,
          JSON.stringify({
            manifestHash: proofRequest.manifest.hash,
            status: "VERIFIED",
            marketId: "CA_TSX",
          }),
        ],
      );
      await pool.query(
        "INSERT INTO research_coverage_request_result(work_key,request_id,job_id,report_hash,status) VALUES($1,$2,$3,$4,'VERIFIED')",
        [contentHash({ id: proofId }), proofId, proofJob, proofReportHash],
      );
      const reconciler = new ResearchDatasetLineageReconciler(pool);
      expect(await reconciler.catchUp("CA_TSX", 1, 10000)).toBe(1);
      expect(await reconciler.catchUp("CA_TSX", 1, 10000)).toBe(1);
      expect(await reconciler.catchUp("CA_TSX", 1, 10000)).toBe(1);
      expect(await reconciler.catchUp("CA_TSX", 1, 10000)).toBe(0);
      const receipts = await pool.query(
        "SELECT r.receipt FROM research_evidence_work w JOIN research_evidence_work_receipt r USING(work_key) WHERE w.scope_hash=ANY($1::text[]) AND w.processor_version='dataset-lineage-proof-v2' ORDER BY w.created_at",
        [identities],
      );
      expect(receipts.rows.map((r) => r.receipt.reasonCodes)).toEqual([
        ["DATASET_DERIVATION_UNPROVEN"],
        ["DATASET_COVERAGE_SCOPE_MISMATCH"],
        ["DATASET_DERIVATION_UNPROVEN"],
      ]);
      expect(receipts.rows.every((r) => r.receipt.state === "WAITING")).toBe(
        true,
      );
      expect(await store.getDataset(original.id)).toEqual(original);
      expect(await store.listDatasetRows(original.id)).toEqual(rows);
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM statistical_training_dataset WHERE cohort=$1::jsonb",
            [JSON.stringify(cohort)],
          )
        ).rows[0].count,
      ).toBe(2);
    });

    it("fails closed for every immutable derivation identity mismatch", async () => {
      const reconciler = new ResearchDatasetLineageReconciler(pool);
      const cases: Array<[string, Partial<DatasetResearchDerivation>]> = [
        ["source", { sourceDigest: "0".repeat(64) }],
        ["row count", { rowCount: 2 }],
        ["row identity", { rowsDigest: "0".repeat(64) }],
        ["feature", { featureVersion: "1.1.0" }],
        ["engine", { engineRevision: "0".repeat(40) }],
        ["runtime", { runtimeFingerprint: "0".repeat(64) }],
        [
          "session payload",
          { sessionPayloadHashes: { "2026-09-11": "0".repeat(64) } },
        ],
        ["manifest", { coverageManifestHash: "0".repeat(64) }],
        ["report", { coverageReportHash: "0".repeat(64) }],
        ["reasons", { reasons: ["ROW_IDENTITY_UNAVAILABLE"] }],
      ];
      const requestHashes = [];
      for (const [, patch] of cases)
        requestHashes.push(await seedDerivationFixture(pool, patch));
      requestHashes.push(await seedDerivationFixture(pool, {}, "US_EQUITIES"));
      while (await reconciler.catchUp("CA_TSX", 100, 10000)) {
        /* bounded pages */
      }
      const receipts = await pool.query(
        "SELECT w.scope_hash,r.receipt FROM research_evidence_work w JOIN research_evidence_work_receipt r USING(work_key) WHERE w.scope_hash=ANY($1::text[]) AND w.processor_version='dataset-lineage-proof-v2' ORDER BY w.created_at",
        [requestHashes],
      );
      expect(receipts.rows).toHaveLength(cases.length + 1);
      expect(
        receipts.rows
          .slice(0, cases.length)
          .map((row) => row.receipt.reasonCodes),
      ).toEqual(cases.map(() => ["DATASET_DERIVATION_UNPROVEN"]));
      expect(receipts.rows.at(-1)?.receipt.reasonCodes).toEqual([
        "DATASET_COVERAGE_SCOPE_MISMATCH",
      ]);
    });

    it("records a producer-consistent complete derivation as proven", async () => {
      const requestHash = await seedDerivationFixture(pool);
      const reconciler = new ResearchDatasetLineageReconciler(pool);
      while (await reconciler.catchUp("CA_TSX", 100, 10000)) {
        /* bounded pages */
      }
      const receipt = await pool.query(
        "SELECT r.receipt FROM research_evidence_work w JOIN research_evidence_work_receipt r USING(work_key) WHERE w.scope_hash=$1 AND w.processor_version='dataset-lineage-proof-v2'",
        [requestHash],
      );
      expect(receipt.rows[0]?.receipt.reasonCodes).toEqual([]);
    });

    it("does not let an exact pending preparation starve a later proof at limit one", async () => {
      const pendingRequestHash = (await seedPendingPreparationCoverage(pool))
        .requestHash;
      const laterRequestHash = await seedDerivationFixture(pool);
      const reconciler = new ResearchDatasetLineageReconciler(pool);

      expect(await reconciler.catchUp("CA_TSX", 1, 10000)).toBe(1);
      const receipts = await pool.query(
        `SELECT w.scope_hash,r.receipt
           FROM research_evidence_work w
           JOIN research_evidence_work_receipt r USING(work_key)
          WHERE w.scope_hash=ANY($1::text[])
            AND w.processor_version='dataset-lineage-proof-v2'`,
        [[pendingRequestHash, laterRequestHash]],
      );
      expect(receipts.rows).toHaveLength(1);
      expect(receipts.rows[0]?.scope_hash).toBe(laterRequestHash);
      expect(receipts.rows[0]?.receipt.reasonCodes).toEqual([]);
    });

    it("retains microsecond continuation across tiny budgets and wraps after exhaustion", async () => {
      const first = await seedPendingPreparationCoverage(pool, {
        marketId: "US_EQUITIES",
        createdAt: "1900-01-01T00:00:00.000001Z",
      });
      const second = await seedPendingPreparationCoverage(pool, {
        marketId: "US_EQUITIES",
        createdAt: "1900-01-01T00:00:00.000002Z",
      });
      const laterRequestHash = await seedDerivationFixture(
        pool,
        {},
        "US_EQUITIES",
        "US_EQUITIES",
      );
      const reconciler = new ResearchDatasetLineageReconciler(pool);

      expect(await reconciler.catchUp("US_EQUITIES", 1, 0)).toBe(0);
      expect(await reconciler.catchUp("US_EQUITIES", 1, 0)).toBe(0);
      expect(await reconciler.catchUp("US_EQUITIES", 1, 0)).toBe(1);
      const laterReceipt = await pool.query(
        `SELECT r.receipt
           FROM research_evidence_work w
           JOIN research_evidence_work_receipt r USING(work_key)
          WHERE w.scope_hash=$1
            AND w.processor_version='dataset-lineage-proof-v2'`,
        [laterRequestHash],
      );
      expect(laterReceipt.rows).toHaveLength(1);

      // Exhaust the post-later cursor, then materialize the first preparation.
      expect(await reconciler.catchUp("US_EQUITIES", 1, 0)).toBe(0);
      const training = new PostgresPaperEvidenceTrainingStore(pool);
      const binding = {
        manifestHash: first.manifestHash,
        coverageReportHash: first.reportHash,
        inputHash: first.report.inputHash,
        engineRevision: "e".repeat(40),
        runtimeFingerprint: "f".repeat(64),
        verifiedAt: first.report.verifiedAt,
      };
      await training.createDataset({
        policyVersion: "test",
        cohort: first.cohort,
        requestedCutoff: new Date(first.cutoff),
        effectiveCutoff: new Date(first.cutoff),
        sourceDigest: first.sourceDigest,
        excludedCounts: {},
        researchQualification: {
          policyVersion: "paper-research-qualification-v2",
          qualified: true,
          reasons: [],
          sourceRowCount: first.rows.length,
          acceptedRowCount: first.rows.length,
          distinctSessionCount: 1,
          chronologicalSplitAt: null,
          walkForwardWindows: [],
          excludedCounts: {},
        },
        researchEvidence: binding,
        researchDerivation: {
          version: "dataset-derivation-v1",
          complete: true,
          featureVersion: "1.2.0",
          engineRevision: binding.engineRevision,
          runtimeFingerprint: binding.runtimeFingerprint,
          sourceDigest: first.sourceDigest,
          rowsDigest: datasetRowsDigest(first.rows),
          rowCount: first.rows.length,
          sessionPayloadHashes: first.report.sessionPayloadHashes,
          coverageManifestHash: first.manifestHash,
          coverageReportHash: first.reportHash,
          reasons: [],
          capturedAt: first.report.verifiedAt,
        },
        rows: first.rows,
      });
      expect(await reconciler.catchUp("US_EQUITIES", 1, 0)).toBe(1);
      const firstReceipt = await pool.query(
        `SELECT r.receipt
           FROM research_evidence_work w
           JOIN research_evidence_work_receipt r USING(work_key)
          WHERE w.scope_hash=$1
            AND w.processor_version='dataset-lineage-proof-v2'`,
        [first.requestHash],
      );
      expect(firstReceipt.rows[0]?.receipt.reasonCodes).toEqual([]);
      expect(
        await pool.query(
          `SELECT count(*)::int AS count
           FROM research_evidence_work
          WHERE scope_hash=$1
            AND processor_version='dataset-lineage-proof-v2'`,
          [second.requestHash],
        ),
      ).toMatchObject({ rows: [{ count: 0 }] });
    });

    it("does not defer pending preparations with malformed recipe or purpose identity", async () => {
      const malformedCases: PendingCoverageOverrides[] = [
        { recipeMarketId: "US_EQUITIES" },
        { recipeInputCutoff: "not-a-timestamp" },
        { recipeSessionDates: ["2099-01-01"] },
        { purposeSessionDates: ["2099-01-01"] },
        { purposeMarketId: "US_EQUITIES" },
      ];
      const reconciler = new ResearchDatasetLineageReconciler(pool);
      for (const [index, overrides] of malformedCases.entries()) {
        const malformedRequestHash = (
          await seedPendingPreparationCoverage(pool, {
            ...overrides,
            createdAt: `2024-01-01T00:00:00.00000${index + 1}Z`,
          })
        ).requestHash;
        await seedDerivationFixture(pool);
        expect(await reconciler.catchUp("CA_TSX", 1, 10000)).toBe(1);
        const receipt = await pool.query(
          `SELECT r.receipt
             FROM research_evidence_work w
             JOIN research_evidence_work_receipt r USING(work_key)
            WHERE w.scope_hash=$1
              AND w.processor_version='dataset-lineage-proof-v2'`,
          [malformedRequestHash],
        );
        expect(receipt.rows).toHaveLength(1);
        expect(receipt.rows[0]?.receipt.reasonCodes.length).toBeGreaterThan(0);
      }
    });
  },
);
