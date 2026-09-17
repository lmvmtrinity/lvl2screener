import { PostgresResearchEvidenceStore } from "../src/backtests/research-evidence-repository.js";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBacktestSchema,
  type FrozenStudyPlan,
} from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { PostgresStrategyStudyStore } from "../src/backtests/strategy-study-repository.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
const binding = {
  manifestHash: "a".repeat(64),
  coverageReportHash: "b".repeat(64),
  inputHash: "c".repeat(64),
  engineRevision: "d".repeat(40),
  runtimeFingerprint: "e".repeat(64),
  verifiedAt: "2026-09-10T12:00:00.000Z",
};
const makeBacktest = (name: string, date: string) =>
  createBacktestSchema.parse({
    name,
    marketId: "CA_TSX",
    startDate: date,
    endDate: date,
    strategies: ["ORB_RETEST"],
    symbols: [],
  });
const plan: FrozenStudyPlan = {
  experimentId: "10000000-0000-4000-8000-000000000100",
  binding,
  variant: "RETEST_CONTRACTION",
  baselineProfileConfigId: "10000000-0000-4000-8000-000000000101",
  challengerProfileConfigId: "10000000-0000-4000-8000-000000000102",
  inputs: {
    TRAIN: {
      baseline: makeBacktest("train baseline", "2026-09-01"),
      challenger: makeBacktest("train challenger", "2026-09-01"),
      binding,
    },
    VALIDATION: {
      baseline: makeBacktest("validation baseline", "2026-09-02"),
      challenger: makeBacktest("validation challenger", "2026-09-02"),
      binding,
    },
    TEST: {
      baseline: makeBacktest("test baseline", "2026-09-03"),
      challenger: makeBacktest("test challenger", "2026-09-03"),
      binding,
    },
  },
  comparison: {
    marketId: "CA_TSX",
    unit: "R",
    expectedSessions: ["2026-09-03"],
    minimumSessions: 1,
    blockLength: 1,
    bootstrapSamples: 1_000,
    seed: 7,
  },
  minimumClosedTradesPerDevelopmentSegment: 1,
  minimumValidationAverageR: 0,
};
const notSelectedPlan: FrozenStudyPlan = {
  ...plan,
  experimentId: "10000000-0000-4000-8000-000000000110",
};

describe.skipIf(!databaseUrl)("strategy study PostgreSQL acceptance", () => {
  let pool: Pool;
  let store: PostgresStrategyStudyStore;
  const jobId = randomUUID();
  const baselineRunId = randomUUID();
  const challengerRunId = randomUUID();

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    await migrate(pool);
    await pool.query(
      `INSERT INTO research_job(
        id,job_type,status,request_payload,attempt_count,max_attempts,
        lease_owner,lease_expires_at,heartbeat_at,started_at
      ) VALUES($1,'STRATEGY_STUDY','RUNNING','{}'::jsonb,1,3,$2,NOW()+INTERVAL '1 hour',NOW(),NOW())`,
      [jobId, "study-worker"],
    );
    const evidence = new PostgresResearchEvidenceStore(pool);
    await evidence.saveManifest({
      hash: binding.manifestHash,
      marketId: "CA_TSX",
      manifest: {
        version: "study-fixture",
        plan: { expectedSessions: ["2026-09-01", "2026-09-02", "2026-09-03"] },
      },
    });
    binding.coverageReportHash = await evidence.saveReport({
      version: "research-coverage-v1",
      marketId: "CA_TSX",
      manifestHash: binding.manifestHash,
      expectedInputsHash: "f".repeat(64),
      inputHash: binding.inputHash,
      sessionPayloadHashes: {
        "2026-09-01": "a".repeat(64),
        "2026-09-02": "b".repeat(64),
        "2026-09-03": "c".repeat(64),
      },
      verifiedAt: binding.verifiedAt,
      status: "VERIFIED",
      cells: [],
    });
    for (const id of [baselineRunId, challengerRunId]) {
      await pool.query(
        `INSERT INTO backtest_run(
          id,market_id,name,status,start_date,end_date,strategies,symbols,data_source,
          strategy_version,config_version,starting_capital,position_size,slippage_bps,
          fee_per_trade,parameters,research_evidence
        ) VALUES($1,'CA_TSX',$2,'COMPLETED','2026-09-01','2026-09-01',
          '["ORB_RETEST"]'::jsonb,'[]'::jsonb,'CAPTURED_QUOTES','1.0.0','study',
          100000,10000,2,0,'{}'::jsonb,NULL)`,
        [id, id === baselineRunId ? "baseline" : "challenger"],
      );
      await evidence.bind(
        { kind: "BACKTEST", id, marketId: "CA_TSX" },
        binding,
      );
    }
    store = new PostgresStrategyStudyStore(pool, {
      jobId,
      leaseOwner: "study-worker",
      attemptCount: 1,
    });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("enforces claim-before-result and never repeats a stage claim", async () => {
    await store.register(plan);
    expect(await store.claim(plan.experimentId, "TRAIN")).toBe(true);
    expect(await store.claim(plan.experimentId, "TRAIN")).toBe(false);
    await expect(
      store.saveResult(plan.experimentId, {
        stage: "TRAIN",
        binding,
        baselineRunId,
        challengerRunId,
        baselineClosedTrades: 1,
        challengerClosedTrades: 1,
        challengerAverageR: 0.1,
        sessions: [],
      }),
    ).resolves.toBeUndefined();
  });

  it("requires development selection before TEST and rejects conflicting specs", async () => {
    await expect(store.claim(plan.experimentId, "TEST")).rejects.toThrow(
      "STRATEGY_STUDY_TEST_PREREQUISITE_MISSING",
    );
    await expect(
      store.register({ ...plan, minimumValidationAverageR: 0.2 }),
    ).rejects.toThrow("STRATEGY_STUDY_SPEC_CONFLICT");
  });

  it("records a NOT_SELECTED report after a frozen development selection", async () => {
    await store.register(notSelectedPlan);
    for (const stage of ["TRAIN", "VALIDATION"] as const) {
      await store.claim(notSelectedPlan.experimentId, stage);
      await store.saveResult(notSelectedPlan.experimentId, {
        stage,
        binding,
        baselineRunId,
        challengerRunId,
        baselineClosedTrades: 1,
        challengerClosedTrades: 1,
        challengerAverageR: 0,
        sessions: [],
      });
    }
    await store.select(notSelectedPlan.experimentId, {
      selected: false,
      baselineProfileConfigId: notSelectedPlan.baselineProfileConfigId,
      challengerProfileConfigId: notSelectedPlan.challengerProfileConfigId,
      developmentResultHashes: ["a".repeat(64), "b".repeat(64)],
    });
    await store.saveReport({
      experimentId: notSelectedPlan.experimentId,
      binding,
      status: "NOT_SELECTED",
      results: [],
      comparison: null,
      reasonCodes: ["DEVELOPMENT_SELECTION_FAILED"],
    });
    expect(await store.report(notSelectedPlan.experimentId)).toMatchObject({
      status: "NOT_SELECTED",
    });
  });
});
