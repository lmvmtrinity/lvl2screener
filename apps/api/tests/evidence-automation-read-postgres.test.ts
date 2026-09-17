import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { migrate } from "../src/database/migrate.js";
import { PostgresEvidenceAutomationReadRepository } from "../src/statistical-models/evidence-automation-read-repository.js";
import { PostgresEvidenceAutomationRepository } from "../src/statistical-models/evidence-automation-repository.js";
import { EvidenceAutomationService } from "../src/statistical-models/evidence-automation-service.js";
import { ResearchJobRepository } from "../src/research-jobs/research-job-repository.js";
import { buildApp } from "../src/app.js";
import { FoundationStatusService } from "../src/foundation/status-service.js";
const url = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
const requestId = "e1000000-0000-4000-8000-000000000001",
  oldJob = "e1000000-0000-4000-8000-000000000002",
  newJob = "e1000000-0000-4000-8000-000000000003",
  auditId = "e1000000-0000-4000-8000-000000000004",
  progressJob = "e1000000-0000-4000-8000-000000000005",
  cohortAuditId = "e1000000-0000-4000-8000-000000000007";
const hash = "c".repeat(64);
describe.skipIf(!url)("Learning evidence read model PostgreSQL", () => {
  let pool: Pool;
  let reader: PostgresEvidenceAutomationReadRepository;
  let service: EvidenceAutomationService;
  beforeAll(async () => {
    pool = new Pool({ connectionString: url });
    await migrate(pool);
    reader = new PostgresEvidenceAutomationReadRepository(pool);
    service = new EvidenceAutomationService(
      new PostgresEvidenceAutomationRepository(pool),
      new ResearchJobRepository(pool),
      () => new Date("2026-09-10T20:00:00.000Z"),
      reader,
    );
    await pool.query(
      `INSERT INTO research_coverage_request(id,market_id,request_hash,request,idempotency_key) VALUES($1,'CA_TSX',$2,'{"manifest":{"hash":"${hash}"},"recipe":{"marketId":"CA_TSX"}}','learning-read-test')`,
      [requestId, hash],
    );
    await pool.query(
      `INSERT INTO research_job(id,job_type,status,request_payload,created_at,started_at,completed_at,error,error_category) VALUES
  ($1,'COVERAGE_VERIFICATION','SUCCEEDED',$3::jsonb,'2026-09-09T17:00Z','2026-09-09T17:00Z','2026-09-09T17:01Z',NULL,NULL),
  ($2,'COVERAGE_VERIFICATION','FAILED',$3::jsonb,'2026-09-10T17:00Z','2026-09-10T17:00Z','2026-09-10T17:01Z','Later verification failed','VALIDATION')`,
      [
        oldJob,
        newJob,
        JSON.stringify({
          version: "coverage-verification-v2",
          requestId,
          request: { manifest: { hash }, recipe: { marketId: "CA_TSX" } },
        }),
      ],
    );
    await pool.query(
      "INSERT INTO research_coverage_report(hash,market_id,input_hash,status,report) VALUES($1,'CA_TSX',$1,'VERIFIED',$2::jsonb)",
      [
        hash,
        JSON.stringify({
          status: "VERIFIED",
          marketId: "CA_TSX",
          manifestHash: hash,
        }),
      ],
    );
    await pool.query(
      "UPDATE research_coverage_request SET latest_job_id=$2 WHERE id=$1",
      [requestId, oldJob],
    );
    await pool.query(
      "INSERT INTO research_coverage_request_result(work_key,request_id,job_id,report_hash,status) VALUES('learning-result',$1,$2,$3,'VERIFIED')",
      [requestId, oldJob, hash],
    );
    await pool.query(
      `INSERT INTO research_job(job_type,status,request_payload) SELECT 'BACKTEST','SUCCEEDED','{"marketId":"US_EQUITIES"}'::jsonb FROM generate_series(1,250)`,
    );
    await pool.query(
      `INSERT INTO learning_automation_run(id,scheduler_version,policy_version,started_at,completed_at,state,cohorts_examined,noop_reason) VALUES($1,'test','test','2026-09-10T18:00Z','2026-09-10T18:01Z','NOOP',$2::jsonb,'insufficient evidence')`,
      [
        auditId,
        JSON.stringify([
          {
            marketId: "CA_TSX",
            cohort: { marketId: "CA_TSX" },
            status: "DISQUALIFIED",
            reason: "INSUFFICIENT_CLOSED_QUOTES",
          },
          {
            marketId: "US_EQUITIES",
            cohort: { marketId: "US_EQUITIES" },
            status: "DISQUALIFIED",
            reason: "US_INSUFFICIENT_EVIDENCE",
          },
        ]),
      ],
    );
    await pool.query(
      `INSERT INTO research_job(id,job_type,status,request_payload,created_at,started_at,progress) VALUES
  ($1,'COVERAGE_VERIFICATION','RUNNING',$2::jsonb,'2026-09-14T19:30Z','2026-09-14T19:31Z',$3::jsonb)`,
      [
        progressJob,
        JSON.stringify({
          version: "coverage-verification-v2",
          requestId: "e1000000-0000-4000-8000-000000000006",
          request: {
            manifest: { hash: "d".repeat(64) },
            recipe: { marketId: "US_EQUITIES" },
          },
        }),
        JSON.stringify({ completedSessions: 3, totalSessions: 10 }),
      ],
    );
  }, 60000);
  afterAll(async () => pool?.end());
  it("propagates persisted coverage job progress through the read model and service", async () => {
    const fact = (await reader.listStageFacts("US_EQUITIES")).find(
      (value) => value.jobId === progressJob,
    );
    expect(fact).toMatchObject({
      key: "COVERAGE",
      state: "RUNNING",
      progress: { completed: 3, total: 10, unit: "sessions" },
    });
    expect(fact?.succeededAt).toBeNull();

    const stage = (await service.stages("US_EQUITIES")).find(
      (value) => value.key === "COVERAGE",
    );
    const candidate = [stage, ...(stage?.relatedScopes ?? [])].find(
      (value) => value?.jobId === progressJob,
    );
    expect(candidate).toBeDefined();
    expect(candidate).toMatchObject({
      state: "RUNNING",
      progress: { completed: 3, total: 10, unit: "sessions" },
    });
  });
  it("retains earlier success independently of the later failed attempt beyond 200 unrelated jobs", async () => {
    const stages = await service.stages("CA_TSX");
    expect(stages.find((s) => s.key === "COVERAGE")).toMatchObject({
      state: "FAILED",
      jobId: newJob,
      lastAttemptAt: "2026-09-10T17:00:00.000Z",
      reasonCodes: ["VALIDATION"],
    });
    // The market-wide stage also aggregates successes from other suites sharing this
    // database, so assert retention of the seeded earlier success on its own scope.
    const retained = (await reader.listStageFacts("CA_TSX")).find(
      (fact) => fact.key === "COVERAGE" && fact.jobId === oldJob,
    );
    expect(retained).toMatchObject({
      state: "SUCCEEDED",
      succeededAt: "2026-09-09T17:01:00.000Z",
    });
  });
  it("shows attributable qualification checks before a dataset exists", async () => {
    const ca = (await service.stages("CA_TSX")).find(
      (s) => s.key === "QUALIFICATION",
    );
    const us = (await service.stages("US_EQUITIES")).find(
      (s) => s.key === "QUALIFICATION",
    );
    expect(
      [ca, ...(ca?.relatedScopes ?? [])].find(
        (value) => value?.reportId === auditId,
      ),
    ).toMatchObject({
      state: "WAITING",
      reportId: auditId,
      reasonCodes: ["INSUFFICIENT_CLOSED_QUOTES"],
    });
    // Other suites may have successful cohorts. The stage retains that history;
    // this exact pre-dataset audit must still have no successful qualification.
    const fact = (await reader.listStageFacts("CA_TSX")).find(
      (value) => value.reportId === auditId,
    );
    expect(fact?.succeededAt).toBeNull();
    expect(
      [us, ...(us?.relatedScopes ?? [])].find(
        (value) => value?.reportId === auditId,
      )?.reasonCodes,
    ).toEqual(["US_INSUFFICIENT_EVIDENCE"]);
  });
  it("orders the leading cohort first and exposes its accumulation progress", async () => {
    const leadingReason =
      "INSUFFICIENT_CLOSED_QUOTES (47 < 200) · leading US_EQUITIES/PRIOR_DAY_HIGH_BREAKOUT · 2 cohorts examined";
    await pool.query(
      `INSERT INTO learning_automation_run(id,scheduler_version,policy_version,started_at,completed_at,state,cohorts_examined,noop_reason) VALUES($1,'test','test','2026-09-15T21:00Z','2026-09-15T21:01Z','NOOP',$2::jsonb,$3)`,
      [
        cohortAuditId,
        JSON.stringify([
          {
            marketId: "US_EQUITIES",
            strategy: "VWAP_HOLD",
            closedQuoteCount: 5,
            cohort: { marketId: "US_EQUITIES" },
            status: "DISQUALIFIED",
            reason: "INSUFFICIENT_CLOSED_QUOTES (5 < 200)",
          },
          {
            marketId: "US_EQUITIES",
            strategy: "PRIOR_DAY_HIGH_BREAKOUT",
            closedQuoteCount: 47,
            cohort: { marketId: "US_EQUITIES" },
            status: "DISQUALIFIED",
            reason: leadingReason,
          },
        ]),
        leadingReason,
      ],
    );
    const facts = (await reader.listStageFacts("US_EQUITIES")).filter(
      (fact) => fact.key === "QUALIFICATION" && fact.reportId === cohortAuditId,
    );
    // The highest closed-quote count is ordered first, so the stage card
    // shows the cohort that is actually accumulating.
    expect(facts.map((fact) => fact.progress?.completed)).toEqual([47, 5]);
    expect(facts[0]?.progress).toMatchObject({
      total: 200,
      unit: "closed quotes",
    });
    expect(facts[0]?.reasonCodes[0]).toContain("(47 < 200)");
  });
  it("serves exact saved artifacts through the real read route without crossing markets", async () => {
    const probe = { check: async () => ({ status: "ok" as const }) };
    const app = await buildApp({
      statusService: new FoundationStatusService({
        database: probe,
        scanner: probe,
        marketData: probe,
      }),
      learningDashboardService: {
        overview: async () => {
          throw new Error("unused");
        },
        automationRuns: async () => [],
        evidenceAutomation: (market) => service.stages(market),
        evidenceArtifact: (kind, id, market) =>
          service.artifact(kind, id, market),
      },
    });
    try {
      expect(
        (
          await app.inject(
            `/api/learning/evidence-artifacts/COVERAGE/${hash}?marketId=CA_TSX`,
          )
        ).json(),
      ).toMatchObject({ status: "VERIFIED", marketId: "CA_TSX" });
      expect(
        (
          await app.inject(
            `/api/learning/evidence-artifacts/COVERAGE/${hash}?marketId=US_EQUITIES`,
          )
        ).statusCode,
      ).toBe(404);
      const audit = (
        await app.inject(
          `/api/learning/evidence-artifacts/QUALIFICATION/${auditId}?marketId=US_EQUITIES`,
        )
      ).json();
      expect(audit.cohorts).toHaveLength(1);
      expect(audit.cohorts[0].marketId).toBe("US_EQUITIES");
      expect(
        (
          await app.inject("/api/learning/evidence-automation?marketId=CA_TSX")
        ).json().stages,
      ).toHaveLength(6);
    } finally {
      await app.close();
    }
  });
});
