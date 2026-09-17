import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ResearchCoverageReport,
  ResearchEvidenceBinding,
} from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { PostgresResearchEvidenceStore } from "../src/backtests/research-evidence-repository.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

const report: ResearchCoverageReport = {
  version: "research-coverage-v1",
  marketId: "CA_TSX",
  manifestHash: "d".repeat(64),
  expectedInputsHash: "e".repeat(64),
  inputHash: "c".repeat(64),
  sessionPayloadHashes: { "2026-09-09": "f".repeat(64) },
  verifiedAt: "2026-09-10T00:00:00.000Z",
  status: "VERIFIED",
  cells: [
    {
      cellId: "cell",
      status: "VERIFIED",
      validQuotes: 1,
      validWarmupBars: 1,
      maximumGapMs: 30_000,
      reasons: [],
    },
  ],
};

describe.skipIf(!databaseUrl)("research evidence PostgreSQL acceptance", () => {
  let pool: Pool;
  let store: PostgresResearchEvidenceStore;
  let ownerId: string;
  let incompleteOwnerId: string;
  let sourceRunId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl, max: 4 });
    await migrate(pool);
    ownerId = randomUUID();
    incompleteOwnerId = randomUUID();
    sourceRunId = randomUUID();
    await pool.query(
      `INSERT INTO backtest_run(
        id,name,status,start_date,end_date,strategies,symbols,data_source,
        strategy_version,config_version,starting_capital,position_size,slippage_bps,
        fee_per_trade,parameters,execution_model_version,execution_assumptions
      ) VALUES($1,'Evidence source','COMPLETED','2026-09-09','2026-09-09',
        '["ORB_RETEST"]'::jsonb,'[]'::jsonb,'CAPTURED_QUOTES','1.0.0','fixture',
        100000,10000,2,0,'{}'::jsonb,'paper-execution-v7','{}'::jsonb)`,
      [sourceRunId],
    );
    await pool.query(
      `INSERT INTO statistical_model(
        id,market_id,name,status,model_type,model_version,backtest_run_id,
        source_kind,strategy_name,input
      ) VALUES($1,'CA_TSX','Evidence fixture','PENDING','LOGISTIC_SETUP_QUALITY','pending',
        $2,'BACKTEST_RUN','ORB_RETEST','{}'::jsonb)`,
      [ownerId, sourceRunId],
    );
    await pool.query(
      `INSERT INTO statistical_model(
        id,market_id,name,status,model_type,model_version,backtest_run_id,
        source_kind,strategy_name,input
      ) VALUES($1,'CA_TSX','Incomplete evidence fixture','PENDING','LOGISTIC_SETUP_QUALITY','pending',
        $2,'BACKTEST_RUN','ORB_RETEST','{}'::jsonb)`,
      [incompleteOwnerId, sourceRunId],
    );
    store = new PostgresResearchEvidenceStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reuses identical reports and rejects conflicting owner bindings", async () => {
    await store.saveManifest({
      hash: report.manifestHash,
      marketId: report.marketId,
      manifest: {
        version: "fixture",
        plan: { expectedSessions: ["2026-09-09"] },
      },
    });
    const firstHash = await store.saveReport(report);
    const later = await store.saveReport({
      ...report,
      verifiedAt: "2026-09-11T00:00:00.000Z",
    });
    expect(later).toBe(firstHash);
    expect((await store.getReport(firstHash))?.verifiedAt).toBe(
      report.verifiedAt,
    );
    const binding: ResearchEvidenceBinding = {
      manifestHash: report.manifestHash,
      coverageReportHash: firstHash,
      inputHash: report.inputHash,
      engineRevision: "a".repeat(40),
      runtimeFingerprint: "b".repeat(64),
      verifiedAt: report.verifiedAt,
    };
    await store.bind(
      { kind: "MODEL", id: ownerId, marketId: "CA_TSX" },
      binding,
    );
    await expect(
      store.bind({ kind: "MODEL", id: ownerId, marketId: "CA_TSX" }, binding),
    ).resolves.toBeUndefined();
    await expect(
      store.bind(
        { kind: "MODEL", id: ownerId, marketId: "CA_TSX" },
        { ...binding, inputHash: "a".repeat(64) },
      ),
    ).rejects.toThrow("EVIDENCE_BINDING_CONFLICT");
  });

  it("keeps the owner column equal to its immutable binding", async () => {
    const binding = await store.getBinding({
      kind: "MODEL",
      id: ownerId,
      marketId: "CA_TSX",
    });
    expect(
      (
        await pool.query(
          "SELECT research_evidence FROM statistical_model WHERE id=$1",
          [ownerId],
        )
      ).rows[0].research_evidence,
    ).toEqual(binding);
    await expect(
      pool.query(
        "UPDATE statistical_model SET research_evidence=NULL WHERE id=$1",
        [ownerId],
      ),
    ).rejects.toThrow("IMMUTABLE_RESEARCH_OWNER_BINDING");
    await expect(
      pool.query(
        "UPDATE statistical_model SET research_evidence=$2::jsonb WHERE id=$1",
        [incompleteOwnerId, JSON.stringify(binding)],
      ),
    ).rejects.toThrow("EVIDENCE_OWNER_COLUMN_MISMATCH");
  });

  it("does not bind incomplete reports and keeps report bytes immutable", async () => {
    const incomplete = {
      ...report,
      inputHash: "1".repeat(64),
      status: "INCOMPLETE" as const,
    };
    const hash = await store.saveReport(incomplete);
    const binding: ResearchEvidenceBinding = {
      manifestHash: incomplete.manifestHash,
      coverageReportHash: hash,
      inputHash: incomplete.inputHash,
      engineRevision: "a".repeat(40),
      runtimeFingerprint: "b".repeat(64),
      verifiedAt: incomplete.verifiedAt,
    };
    await expect(
      store.bind(
        { kind: "MODEL", id: incompleteOwnerId, marketId: "CA_TSX" },
        binding,
      ),
    ).rejects.toThrow("EVIDENCE_REPORT_NOT_VERIFIED");
    await expect(
      pool.query("DELETE FROM research_coverage_report WHERE hash=$1", [hash]),
    ).rejects.toThrow("IMMUTABLE_RESEARCH_EVIDENCE");
  });
});
