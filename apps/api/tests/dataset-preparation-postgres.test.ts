import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  PaperEvidenceCohort,
  PaperEvidenceTrainingRow,
  PaperEvidenceResearchQualification,
} from "@tsx-scanner/contracts";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { migrate } from "../src/database/migrate.js";
import { PostgresPaperEvidenceTrainingStore } from "../src/statistical-models/paper-evidence-training-repository.js";
import { PostgresDatasetPreparationStore } from "../src/statistical-models/dataset-preparation-repository.js";
import { PaperEvidenceTrainingService } from "../src/statistical-models/paper-evidence-training-service.js";

const url = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

describe.skipIf(!url)("immutable dataset preparations", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await migrate(pool);
  }, 60000);
  afterAll(async () => pool?.end());

  it("retains exact frozen inputs until the matching dataset exists", async () => {
    const preparations = new PostgresDatasetPreparationStore(pool);
    const cohort: PaperEvidenceCohort = {
      marketId: "CA_TSX",
      strategy: "ORB_RETEST",
      strategyVersion: "1",
      profileConfigId: randomUUID(),
      configVersion: "1",
      executionModelVersion: "1",
      assumptions: { fixture: "preparation" },
      closedQuoteCount: 220,
      positives: 110,
      negatives: 110,
      firstSignalAt: "2026-09-10T15:00:00.000Z",
      lastSignalAt: "2026-09-10T15:00:00.000Z",
      missingFeatureCount: 0,
      signalSemanticsVersion: "setup-semantics-v2",
      replayScope: "FORWARD_LIVE",
    };
    const rows: PaperEvidenceTrainingRow[] = [];
    const qualification: PaperEvidenceResearchQualification = {
      policyVersion: "paper-research-qualification-v2",
      qualified: true,
      reasons: [],
      sourceRowCount: 220,
      acceptedRowCount: 220,
      distinctSessionCount: 4,
      chronologicalSplitAt: "2026-09-10T15:00:00.000Z",
      walkForwardWindows: [],
      excludedCounts: { Z_REASON: 2, A_REASON: 1 },
    };
    const input = {
      marketId: "CA_TSX" as const,
      cohort,
      requestedCutoff: new Date("2026-09-10T21:00:00.000Z"),
      effectiveCutoff: new Date("2026-09-10T15:00:00.000Z"),
      sourceDigest: `${"a".repeat(32)}${randomUUID().replaceAll("-", "")}`,
      excludedCounts: { Z_REASON: 2, A_REASON: 1 },
      researchQualification: qualification,
      rows,
    };
    const created = await preparations.create(input);
    const retried = await preparations.create({
      ...input,
      excludedCounts: { A_REASON: 1, Z_REASON: 2 },
      researchQualification: {
        ...qualification,
        excludedCounts: { A_REASON: 1, Z_REASON: 2 },
      },
    });
    expect(retried.id).toBe(created.id);
    await expect(
      preparations.create({
        ...input,
        effectiveCutoff: new Date("2026-09-10T20:00:00.000Z"),
      }),
    ).rejects.toThrow("DATASET_PREPARATION_CONFLICT");
    const currentCohort = {
      ...cohort,
      closedQuoteCount: 260,
      positives: 130,
      negatives: 130,
      lastSignalAt: "2026-09-11T15:00:00.000Z",
    };
    expect(await preparations.findPending(currentCohort)).toMatchObject({
      id: created.id,
      sourceDigest: input.sourceDigest,
      requestedCutoff: input.requestedCutoff.toISOString(),
      rows,
    });
    expect((await preparations.listPending()).map((row) => row.id)).toContain(
      created.id,
    );

    const dataset = await new PostgresPaperEvidenceTrainingStore(
      pool,
    ).createDataset({
      policyVersion: "paper-evidence-v1",
      cohort,
      requestedCutoff: input.requestedCutoff,
      effectiveCutoff: input.effectiveCutoff,
      sourceDigest: input.sourceDigest,
      excludedCounts: input.excludedCounts,
      researchQualification: qualification,
      rows,
    });
    expect(await preparations.findPending(currentCohort)).toMatchObject({
      id: created.id,
      sourceDigest: input.sourceDigest,
    });
    expect((await preparations.listPending()).map((row) => row.id)).toContain(
      created.id,
    );
    await pool.query(
      `INSERT INTO research_job(job_type,idempotency_key,request_payload)
       VALUES ('STATISTICAL_TRAINING',$1,'{}'::jsonb)`,
      [`paper-evidence:${input.sourceDigest}`],
    );
    await expect(preparations.findPending(currentCohort)).rejects.toThrow(
      "DATASET_PREPARATION_JOB_CONFLICT",
    );
    await pool.query(
      `UPDATE research_job SET request_payload=$2::jsonb
       WHERE job_type='STATISTICAL_TRAINING' AND idempotency_key=$1`,
      [
        `paper-evidence:${input.sourceDigest}`,
        JSON.stringify({
          sourceKind: "PAPER_EVIDENCE",
          trainingDatasetId: dataset.id,
          sourceDigest: input.sourceDigest,
          marketId: input.marketId,
          strategy: input.cohort.strategy,
          cohort: input.cohort,
        }),
      ],
    );
    expect(await preparations.findPending(currentCohort)).toBeUndefined();
    expect(
      (await preparations.listPending()).map((row) => row.id),
    ).not.toContain(created.id);
    expect(await preparations.get(created.id)).toMatchObject({ rows });
  });

  it("rejects a preparation whose rows or cohort cross its market", async () => {
    const preparations = new PostgresDatasetPreparationStore(pool);
    const cohort = {
      marketId: "CA_TSX" as const,
      strategy: "ORB_RETEST" as const,
      strategyVersion: "1",
      profileConfigId: randomUUID(),
      configVersion: "1",
      executionModelVersion: "1",
      assumptions: {},
      closedQuoteCount: 0,
      positives: 0,
      negatives: 0,
      firstSignalAt: null,
      lastSignalAt: null,
      missingFeatureCount: 0,
    };
    await expect(
      preparations.create({
        marketId: "US_EQUITIES",
        cohort,
        requestedCutoff: new Date("2026-09-10T21:00:00.000Z"),
        effectiveCutoff: new Date("2026-09-10T21:00:00.000Z"),
        sourceDigest: `${"b".repeat(32)}${randomUUID().replaceAll("-", "")}`,
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
      }),
    ).rejects.toThrow();
  });

  it("serializes concurrent preparations to one immutable first input", async () => {
    const preparations = new PostgresDatasetPreparationStore(pool);
    const cohort: PaperEvidenceCohort = {
      marketId: "CA_TSX",
      strategy: "ORB_RETEST",
      strategyVersion: "concurrent-1",
      profileConfigId: randomUUID(),
      configVersion: "1",
      executionModelVersion: "1",
      assumptions: { z: { b: 2, a: 1 } },
      closedQuoteCount: 220,
      positives: 110,
      negatives: 110,
      firstSignalAt: "2026-09-10T15:00:00.000Z",
      lastSignalAt: "2026-09-10T15:00:00.000Z",
      missingFeatureCount: 0,
    };
    const qualification: PaperEvidenceResearchQualification = {
      policyVersion: "paper-research-qualification-v2",
      qualified: true,
      reasons: [],
      sourceRowCount: 0,
      acceptedRowCount: 0,
      distinctSessionCount: 0,
      chronologicalSplitAt: null,
      walkForwardWindows: [],
      excludedCounts: {},
    };
    const makeInput = (cutoff: string, digestPrefix: string) => ({
      marketId: "CA_TSX" as const,
      cohort,
      requestedCutoff: new Date(cutoff),
      effectiveCutoff: new Date(cutoff),
      sourceDigest: `${digestPrefix.repeat(32)}${randomUUID().replaceAll("-", "")}`,
      excludedCounts: {},
      researchQualification: qualification,
      rows: [],
    });
    const [first, second] = await Promise.all([
      preparations.create(makeInput("2026-09-10T21:00:00.000Z", "d")),
      preparations.create(makeInput("2026-09-11T21:00:00.000Z", "e")),
    ]);
    expect(first.id).toBe(second.id);
    expect(["2026-09-10T21:00:00.000Z", "2026-09-11T21:00:00.000Z"]).toContain(
      first.requestedCutoff,
    );
    const count = await pool.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM statistical_training_dataset_preparation
        WHERE market_id='CA_TSX' AND cohort->>'profileConfigId'=$1`,
      [cohort.profileConfigId],
    );
    expect(count.rows[0]?.count).toBe(1);
  });

  it("starts a new preparation after the stable owner is complete", async () => {
    const preparations = new PostgresDatasetPreparationStore(pool);
    const training = new PostgresPaperEvidenceTrainingStore(pool);
    const cohort: PaperEvidenceCohort = {
      marketId: "CA_TSX",
      strategy: "ORB_RETEST",
      strategyVersion: "successor-1",
      profileConfigId: randomUUID(),
      configVersion: "1",
      executionModelVersion: "1",
      assumptions: { fixture: "successor" },
      closedQuoteCount: 220,
      positives: 110,
      negatives: 110,
      firstSignalAt: "2026-09-10T15:00:00.000Z",
      lastSignalAt: "2026-09-10T15:00:00.000Z",
      missingFeatureCount: 0,
      signalSemanticsVersion: "setup-semantics-v2",
      replayScope: "FORWARD_LIVE",
    };
    const qualification: PaperEvidenceResearchQualification = {
      policyVersion: "paper-research-qualification-v2",
      qualified: true,
      reasons: [],
      sourceRowCount: 220,
      acceptedRowCount: 220,
      distinctSessionCount: 4,
      chronologicalSplitAt: "2026-09-10T15:00:00.000Z",
      walkForwardWindows: [],
      excludedCounts: {},
    };
    const firstInput = {
      marketId: "CA_TSX" as const,
      cohort,
      requestedCutoff: new Date("2026-09-10T21:00:00.000Z"),
      effectiveCutoff: new Date("2026-09-10T15:00:00.000Z"),
      sourceDigest: `${"f".repeat(32)}${randomUUID().replaceAll("-", "")}`,
      excludedCounts: {},
      researchQualification: qualification,
      rows: [],
    };
    const first = await preparations.create(firstInput);
    const dataset = await training.createDataset({
      policyVersion: "paper-evidence-v1",
      cohort,
      requestedCutoff: firstInput.requestedCutoff,
      effectiveCutoff: firstInput.effectiveCutoff,
      sourceDigest: firstInput.sourceDigest,
      excludedCounts: firstInput.excludedCounts,
      researchQualification: qualification,
      rows: [],
    });
    await pool.query(
      `INSERT INTO research_job(job_type,idempotency_key,request_payload)
       VALUES ('STATISTICAL_TRAINING',$1,$2::jsonb)`,
      [
        `paper-evidence:${firstInput.sourceDigest}`,
        JSON.stringify({
          sourceKind: "PAPER_EVIDENCE",
          trainingDatasetId: dataset.id,
          sourceDigest: firstInput.sourceDigest,
          marketId: firstInput.marketId,
          strategy: cohort.strategy,
          cohort,
        }),
      ],
    );
    expect((await preparations.create(firstInput)).id).toBe(first.id);

    const successorCohort = {
      ...cohort,
      closedQuoteCount: 270,
      positives: 135,
      negatives: 135,
      lastSignalAt: "2026-09-11T15:00:00.000Z",
    };
    const successor = await preparations.create({
      ...firstInput,
      cohort: successorCohort,
      requestedCutoff: new Date("2026-09-11T21:00:00.000Z"),
      effectiveCutoff: new Date("2026-09-11T15:00:00.000Z"),
      sourceDigest: `${"e".repeat(32)}${randomUUID().replaceAll("-", "")}`,
    });
    expect(successor.id).not.toBe(first.id);
    expect(successor.cohort).toEqual(successorCohort);
  });

  it("fails closed when the persisted cohort market is JSON null", async () => {
    await expect(
      pool.query(
        `INSERT INTO statistical_training_dataset_preparation
          (market_id,cohort,requested_cutoff,effective_cutoff,source_digest,
           excluded_counts,research_qualification,qualified_rows)
         VALUES ('CA_TSX','{"marketId":null}'::jsonb,
                 '2026-09-10T21:00:00Z','2026-09-10T21:00:00Z',$1,'{}','{}','[]')`,
        [`${"c".repeat(32)}${randomUUID().replaceAll("-", "")}`],
      ),
    ).rejects.toThrow();
  });

  it("resumes the same preparation across a service restart and finalizes once", async () => {
    const preparations = new PostgresDatasetPreparationStore(pool);
    const training = new PostgresPaperEvidenceTrainingStore(pool);
    const cohort: PaperEvidenceCohort = {
      marketId: "US_EQUITIES",
      strategy: "ORB_RETEST",
      strategyVersion: "restart-1",
      profileConfigId: randomUUID(),
      configVersion: "1",
      executionModelVersion: "1",
      assumptions: { fixture: "restart" },
      closedQuoteCount: 220,
      positives: 110,
      negatives: 110,
      firstSignalAt: "2026-09-10T15:00:00.000Z",
      lastSignalAt: "2026-09-10T15:00:00.000Z",
      missingFeatureCount: 0,
      signalSemanticsVersion: "setup-semantics-v2",
      replayScope: "FORWARD_LIVE",
    };
    const qualification: PaperEvidenceResearchQualification = {
      policyVersion: "paper-research-qualification-v2",
      qualified: true,
      reasons: [],
      sourceRowCount: 0,
      acceptedRowCount: 0,
      distinctSessionCount: 0,
      chronologicalSplitAt: null,
      walkForwardWindows: [],
      excludedCounts: {},
    };
    let calls = 0;
    const lineage = {
      resolveArtifact: async () => {
        calls += 1;
        if (calls === 1) return { derivation: null };
        return {
          binding: undefined,
          coverageStatus: "VERIFIED" as const,
          derivation: {
            version: "dataset-derivation-v1" as const,
            complete: true,
            featureVersion: "1",
            engineRevision: "engine",
            runtimeFingerprint: "runtime",
            sourceDigest: preparedSourceDigest ?? "placeholder",
            rowsDigest: null,
            rowCount: 0,
            sessionPayloadHashes: {},
            coverageManifestHash: "manifest",
            coverageReportHash: "report",
            reasons: [],
            capturedAt: "2026-09-10T21:00:00.000Z",
          },
        };
      },
    };
    const first = new PaperEvidenceTrainingService(
      training,
      lineage as never,
      preparations,
    );
    const firstPass = await first.prepareAndMaterialize(
      cohort,
      new Date("2026-09-10T21:00:00.000Z"),
      { qualification, acceptedRows: [], qualifiedRows: [] },
    );
    expect(firstPass).toEqual({ dataset: undefined, pending: true });
    const preparation = await preparations.findPending(cohort);
    expect(preparation).toBeDefined();
    const preparedSourceDigest = preparation!.sourceDigest;

    const second = new PaperEvidenceTrainingService(
      training,
      lineage as never,
      preparations,
    );
    const secondPass = await second.prepareAndMaterialize(
      {
        ...cohort,
        closedQuoteCount: 260,
        positives: 130,
        negatives: 130,
        lastSignalAt: "2026-09-11T15:00:00.000Z",
      },
      new Date("2026-09-11T21:00:00.000Z"),
    );
    expect(secondPass.pending).toBe(false);
    expect(secondPass.dataset?.sourceDigest).toBe(preparation!.sourceDigest);
    expect(secondPass.dataset?.requestedCutoff).toBe(
      preparation!.requestedCutoff,
    );
    expect(secondPass.dataset?.cohort).toEqual(preparation!.cohort);
    expect(await preparations.findPending(cohort)).toMatchObject({
      id: preparation!.id,
    });
    await pool.query(
      `INSERT INTO research_job(job_type,idempotency_key,request_payload)
       VALUES ('STATISTICAL_TRAINING',$1,$2::jsonb)`,
      [
        `paper-evidence:${preparation!.sourceDigest}`,
        JSON.stringify({
          sourceKind: "PAPER_EVIDENCE",
          trainingDatasetId: secondPass.dataset!.id,
          sourceDigest: preparation!.sourceDigest,
          marketId: preparation!.marketId,
          strategy: preparation!.cohort.strategy,
          cohort: preparation!.cohort,
        }),
      ],
    );
    expect(await preparations.findPending(cohort)).toBeUndefined();
  });
});
