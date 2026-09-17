import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CreateCoverageRequest } from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { coverageFixture } from "./research-coverage-fixtures.js";
import { PostgresCoverageRequestRepository } from "../src/backtests/coverage-request-repository.js";
import { PostgresResearchEvidenceStore } from "../src/backtests/research-evidence-repository.js";
import { ResearchCoverageService } from "../src/backtests/research-coverage-service.js";
import { CoverageVerificationJobHandler } from "../src/worker/handlers/coverage-verification-job-handler.js";
import { ResearchJobRepository } from "../src/research-jobs/research-job-repository.js";
import { PostgresEvidenceAutomationRepository } from "../src/statistical-models/evidence-automation-repository.js";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";
import { contentHash } from "../src/backtests/research-coverage.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
describe.skipIf(!databaseUrl)(
  "coverage remediation PostgreSQL workflow",
  () => {
    let pool: Pool;
    let requests: PostgresCoverageRequestRepository;
    let jobs: ResearchJobRepository;
    let evidence: PostgresResearchEvidenceStore;
    const input: CreateCoverageRequest = {
      manifest: {
        hash: contentHash({ review: "coverage" }),
        marketId: "CA_TSX",
        manifest: { review: "coverage" },
      },
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
    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl });
      await migrate(pool);
      requests = new PostgresCoverageRequestRepository(pool);
      jobs = new ResearchJobRepository(pool);
      evidence = new PostgresResearchEvidenceStore(pool);
    });
    afterAll(async () => {
      await pool?.end();
    });

    it("reuses content under different keys and atomically links automatic work", async () => {
      await expect(
        requests.create(
          { ...input, manifest: { ...input.manifest, hash: "0".repeat(64) } },
          randomUUID(),
        ),
      ).rejects.toThrow("COVERAGE_MANIFEST_HASH_MISMATCH");
      const key = randomUUID();
      const first = await requests.create(input, key);
      expect(await requests.create(input, randomUUID())).toEqual(first);
      await expect(
        requests.create(
          { ...input, recipe: { ...input.recipe, featureVersion: "changed" } },
          key,
        ),
      ).rejects.toThrow("IDEMPOTENCY_CONFLICT");
      const work = await new PostgresEvidenceAutomationRepository(pool).list(
        "CA_TSX",
      );
      expect(
        work.some(
          (row) =>
            row.jobId === first.latestJobId &&
            row.receipt?.state === "DISPATCHED",
        ),
      ).toBe(true);
    });

    it("rejects result links to a different job or report scope", async () => {
      const request = await requests.create(input, randomUUID());
      const alien = await jobs.createStrictJob(
        "COVERAGE_VERIFICATION",
        {
          version: "coverage-verification-v2",
          requestId: randomUUID(),
          request: input,
        },
        randomUUID(),
      );
      const { cell, receipt } = coverageFixture();
      const coverage = new ResearchCoverageService(
        {
          readFrozenInputs: async () => ({
            expected: [cell],
            receipts: [receipt],
            sessionPayloadHashes: { [cell.sessionDate]: "f".repeat(64) },
          }),
        },
        () => new Date("2026-09-10T00:00:00Z"),
      );
      const report = await coverage.verify({
        marketId: "CA_TSX",
        manifestHash: input.manifest.hash,
        inputCutoff: input.recipe.inputCutoff,
        sessionDates: input.recipe.sessionDates,
      });
      const hash = await evidence.saveReport(report);
      await expect(
        requests.recordResult(request.id, alien.id, hash, report.status),
      ).rejects.toThrow("COVERAGE_RESULT_OWNERSHIP_MISMATCH");
      await expect(
        requests.recordResult(
          request.id,
          request.latestJobId!,
          hash,
          "UNKNOWN",
        ),
      ).rejects.toThrow("COVERAGE_RESULT_OWNERSHIP_MISMATCH");
    });

    it("reuses the original report clock after a crash before binding", async () => {
      const { cell, receipt } = coverageFixture();
      let clock = new Date("2026-09-10T00:00:00.000Z");
      const payload = {
        session: { market: "CA_TSX" },
        quotes: [],
        candles: [],
      };
      const payloadHash = contentHash({ date: cell.sessionDate, payload });
      const coverage = new ResearchCoverageService(
        {
          readFrozenInputs: async () => ({
            expected: [cell],
            receipts: [receipt],
            sessionPayloadHashes: { [cell.sessionDate]: payloadHash },
            sessionPayloads: { [cell.sessionDate]: payload },
          }),
        },
        () => clock,
      );
      const request = await requests.create(input, randomUUID());
      // Give this fixture deterministic queue order without altering other suites' jobs.
      await pool.query(
        "UPDATE research_job SET created_at=(SELECT min(created_at)-interval '1 second' FROM research_job) WHERE id=$1",
        [request.latestJobId],
      );
      const job = await jobs.claimNext(
        ["COVERAGE_VERIFICATION"],
        randomUUID(),
        60000,
      );
      expect(job?.id).toBe(request.latestJobId);
      await evidence.saveManifest(input.manifest);
      const report = await coverage.verify({
        marketId: "CA_TSX",
        manifestHash: input.manifest.hash,
        inputCutoff: input.recipe.inputCutoff,
        sessionDates: input.recipe.sessionDates,
      });
      await evidence.saveReport(report);
      clock = new Date("2026-09-11T00:00:00.000Z");
      const handler = new CoverageVerificationJobHandler(
        coverage,
        evidence,
        jobs,
        requests,
      );
      const context = {
        jobId: job!.id,
        heartbeat: async () => ({ cancellationRequested: false }),
      };
      await expect(handler.execute(job!, context)).resolves.toEqual({
        resultRefId: request.id,
      });
      const binding = await evidence.getBinding({
        kind: "JOB",
        id: job!.id,
        marketId: "CA_TSX",
      });
      expect(binding?.verifiedAt).toBe(report.verifiedAt);
      expect(
        await new PostgresBacktestStore(pool).loadVerifiedReplaySession(
          binding!.coverageReportHash,
          cell.sessionDate,
        ),
      ).toEqual(payload);
      expect((await jobs.get(job!.id))?.researchEvidence).toEqual(binding);
      await expect(
        pool.query(
          "UPDATE research_job SET request_payload=jsonb_set(request_payload,'{request,recipe,marketId}','\"US_EQUITIES\"'::jsonb) WHERE id=$1",
          [job!.id],
        ),
      ).rejects.toThrow("IMMUTABLE_RESEARCH_OWNER_MARKET");
      await pool.query(
        "UPDATE research_job SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
        [job!.id],
      );
      await expect(handler.execute(job!, context)).rejects.toThrow(/lease/i);
    });
  },
);
