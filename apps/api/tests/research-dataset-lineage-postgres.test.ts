import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { migrate } from "../src/database/migrate.js";
import { contentHash } from "../src/backtests/research-coverage.js";
import { PostgresPaperEvidenceTrainingStore } from "../src/statistical-models/paper-evidence-training-repository.js";
import { ResearchDatasetLineageReconciler } from "../src/statistical-models/research-dataset-lineage-reconciler.js";

const url = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
describe.skipIf(!url)(
  "immutable dataset asynchronous lineage prerequisites",
  () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = new Pool({ connectionString: url });
      await migrate(pool);
    }, 60000);
    afterAll(async () => pool?.end());
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
        [],
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
  },
);
