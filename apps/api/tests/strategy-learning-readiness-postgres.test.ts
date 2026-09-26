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
import { contentHash } from "../src/backtests/research-coverage.js";
import {
  assessStrategyLearningReadiness,
  StrategyLearningReadinessRepository,
  type StrategyLearningScope,
} from "../src/backtests/strategy-learning-readiness.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

describe.skipIf(!databaseUrl)(
  "strategy learning readiness PostgreSQL acceptance",
  () => {
    let pool: Pool;
    let scope: StrategyLearningScope;
    let instrumentId: string;
    let verifiedRunId: string;
    let legacyRunId: string;
    let nullAssumptionsRunId: string;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 4 });
      await migrate(pool);
      instrumentId = randomUUID();
      verifiedRunId = randomUUID();
      legacyRunId = randomUUID();
      nullAssumptionsRunId = randomUUID();
      await pool.query(
        `INSERT INTO instrument(
        id,questrade_symbol_id,symbol,description,exchange,currency,security_type,
        industry_sector,is_quotable,is_tradable,active
      ) VALUES($1,$2,$3,'Readiness fixture','TSX','CAD','Stock','Technology',true,true,true)`,
        [
          instrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
          `RDY_${instrumentId.slice(0, 8)}.TO`,
        ],
      );
      const profile = await pool.query<{
        config_id: string;
        config_version: string;
        strategy_key: string;
        strategy_version: string;
        strategy_definition_id: string;
      }>(
        `SELECT c.id config_id,c.config_version,d.strategy_key,
              d.version strategy_version,d.id strategy_definition_id
         FROM scanner_profile p
         JOIN scanner_profile_config c ON c.id=p.current_config_id
         JOIN strategy_definition d ON d.id=p.strategy_definition_id
        WHERE p.id='10000000-0000-4000-8000-000000000081'`,
      );
      const p = profile.rows[0]!;
      const assumptions = {
        positionSize: 1000,
        slippageBps: 0,
        feePerTrade: 1,
        sessionTimezone: "America/Toronto",
        evidenceScope: `READINESS_FIXTURE_${randomUUID()}`,
      };
      scope = {
        marketId: "CA_TSX",
        strategyKey: p.strategy_key,
        profileConfigId: p.config_id,
        strategyVersion: p.strategy_version,
        configVersion: p.config_version,
        executionModelVersion: "paper-execution-v7",
        executionAssumptions: assumptions,
      };
      const replayInput = {
        version: "replay-input-v1",
        marketId: "CA_TSX",
        resolvedAt: "2026-09-02T00:00:00.000Z",
        requestedSymbols: [],
        candidateInstruments: [{ instrumentId, symbol: "RDY", sector: null }],
        benchmarks: [],
        universeRefreshRunId: null,
        capturedHistoryAvailability: {
          status: "AVAILABLE",
          limitations: [],
        },
        warnings: [],
        candidateProvenance: "HISTORICAL_MEMBERSHIP",
        sessions: [
          {
            sessionDate: "2026-09-01",
            resolution: "RESOLVED",
            membershipRunId: randomUUID(),
            effectiveAt: "2026-08-31T12:00:00.000Z",
            candidates: [{ instrumentId, symbol: "RDY", sector: null }],
            reasonCodes: [],
          },
        ],
        inputHash: "a".repeat(64),
      };

      const insertRun = async (
        id: string,
        executionModelVersion: string | null = "paper-execution-v7",
        executionAssumptions: Record<string, unknown> | null = assumptions,
      ) =>
        pool.query(
          `INSERT INTO backtest_run(
          id,market_id,name,status,start_date,end_date,strategies,symbols,data_source,
          strategy_version,config_version,execution_model_version,execution_assumptions,
          starting_capital,position_size,slippage_bps,fee_per_trade,parameters,replay_input,
          completed_at
        ) VALUES($1,'CA_TSX','Readiness fixture','COMPLETED','2026-09-01','2026-09-01',
          $2::jsonb,$3::jsonb,'CAPTURED_QUOTES',$4,$5,$6,$7::jsonb,100000,1000,0,1,
          '{}'::jsonb,$8::jsonb,'2026-09-02T00:00:00Z')`,
          [
            id,
            JSON.stringify([p.strategy_key]),
            JSON.stringify([`RDY_${instrumentId.slice(0, 8)}.TO`]),
            p.strategy_version,
            p.config_version,
            executionModelVersion,
            executionAssumptions === null
              ? null
              : JSON.stringify(executionAssumptions),
            JSON.stringify(replayInput),
          ],
        );
      await insertRun(verifiedRunId);
      await insertRun(legacyRunId);
      await insertRun(nullAssumptionsRunId, "paper-execution-v7", null);
      for (const runId of [verifiedRunId, legacyRunId]) {
        await pool.query(
          `INSERT INTO profile_config_evidence(
          profile_config_id,strategy_definition_id,strategy_key,strategy_version,
          backtest_run_id,qualification,evidence
        ) VALUES($1,$2,$3,$4,$5,$6,'{}'::jsonb)`,
          [
            p.config_id,
            p.strategy_definition_id,
            p.strategy_key,
            p.strategy_version,
            runId,
            runId === verifiedRunId ? "EXPLORATORY" : "EVIDENCE_QUALIFIED",
          ],
        );
        await pool.query(
          `INSERT INTO backtest_trade(
          id,run_id,instrument_id,symbol,strategy_name,strategy_version,config_version,
          signal_timestamp,score,entry_time,entry_price,stop_price,target_price,
          exit_time,exit_price,shares,exit_reason,gross_pnl,net_pnl,r_multiple,
          hold_minutes,reason_codes,setup_instance_id,atr_pct,rvol_at_time
        ) VALUES($1,$2,$3,'RDY', $4,$5,$6,'2026-09-01T14:00:00Z',80,
          '2026-09-01T14:00:00Z',100,99,102,'2026-09-01T14:05:00Z',101,10,
          'TARGET',10,9,0.9,5,'[]'::jsonb,$7,1.2,2.1)`,
          [
            randomUUID(),
            runId,
            instrumentId,
            p.strategy_key,
            p.strategy_version,
            p.config_version,
            "20000000-0000-4000-8000-000000000001",
          ],
        );
      }
      await pool.query(
        `INSERT INTO profile_config_evidence(
           profile_config_id,strategy_definition_id,strategy_key,strategy_version,
           backtest_run_id,qualification,evidence
         ) VALUES($1,$2,$3,$4,$5,'EXPLORATORY','{}'::jsonb)`,
        [
          p.config_id,
          p.strategy_definition_id,
          p.strategy_key,
          p.strategy_version,
          nullAssumptionsRunId,
        ],
      );
      const evidence = new PostgresResearchEvidenceStore(pool);
      const manifest = {
        version: "artifact-coverage-v1",
        purpose: {
          marketId: "CA_TSX",
          scope: { input: { marketId: "CA_TSX" }, replayInput },
        },
        plan: { expectedSessions: ["2026-09-01"] },
      };
      const manifestHash = contentHash(manifest);
      await evidence.saveManifest({
        hash: manifestHash,
        marketId: "CA_TSX",
        manifest,
      });
      const report: ResearchCoverageReport = {
        version: "research-coverage-v1",
        marketId: "CA_TSX",
        manifestHash,
        expectedInputsHash: "c".repeat(64),
        inputHash: "d".repeat(64),
        sessionPayloadHashes: { "2026-09-01": "e".repeat(64) },
        verifiedAt: "2026-09-03T00:00:00.000Z",
        status: "VERIFIED",
        cells: [
          {
            cellId: "readiness-cell",
            status: "VERIFIED",
            validQuotes: 1,
            validWarmupBars: 1,
            maximumGapMs: 30_000,
            reasons: [],
          },
        ],
      };
      const reportHash = await evidence.saveReport(report);
      const binding: ResearchEvidenceBinding = {
        manifestHash,
        coverageReportHash: reportHash,
        inputHash: report.inputHash,
        engineRevision: "a".repeat(40),
        runtimeFingerprint: "f".repeat(64),
        verifiedAt: report.verifiedAt,
      };
      await evidence.bind(
        { kind: "BACKTEST", id: verifiedRunId, marketId: "CA_TSX" },
        binding,
      );
    });

    afterAll(async () => {
      await pool?.end();
    });

    it("counts repeated setup identity once, excludes unproven coverage, and leaves source rows unchanged", async () => {
      const before = await pool.query(
        `SELECT id,replay_input,research_evidence FROM backtest_run WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [[verifiedRunId, legacyRunId]],
      );
      const readiness = await new StrategyLearningReadinessRepository(pool).get(
        scope,
        "2099-01-01T00:00:00.000Z",
      );
      const after = await pool.query(
        `SELECT id,replay_input,research_evidence FROM backtest_run WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [[verifiedRunId, legacyRunId]],
      );

      expect(readiness.filter((row) => row.lineageVerified)).toHaveLength(1);
      expect(readiness.filter((row) => !row.lineageVerified)).toHaveLength(1);
      expect(readiness.find((row) => row.lineageVerified)?.qualification).toBe(
        "EXPLORATORY",
      );
      expect(before.rows).toEqual(after.rows);
    });

    it("resolves only the exact profile and execution scope linked to a selected run", async () => {
      const resolved = await new StrategyLearningReadinessRepository(
        pool,
      ).resolveBacktestScope(verifiedRunId, scope.strategyKey, "CA_TSX");
      expect(resolved).toEqual(scope);
    });

    it("rejects a selected run when the requested market does not match", async () => {
      await expect(
        new StrategyLearningReadinessRepository(pool).resolveBacktestScope(
          verifiedRunId,
          scope.strategyKey,
          "US_EQUITIES",
        ),
      ).rejects.toMatchObject({ code: "BACKTEST_MARKET_MISMATCH" });
    });

    it("rejects legacy selected runs with null execution assumptions", async () => {
      await expect(
        new StrategyLearningReadinessRepository(pool).resolveBacktestScope(
          nullAssumptionsRunId,
          scope.strategyKey,
          "CA_TSX",
        ),
      ).rejects.toMatchObject({ code: "BACKTEST_SCOPE_UNAVAILABLE" });
    });

    it("rejects multiple exact profile evidence rows for the selected run and strategy", async () => {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO profile_config_evidence(
           profile_config_id,strategy_definition_id,strategy_key,strategy_version,
           backtest_run_id,qualification,evidence
         ) SELECT profile_config_id,strategy_definition_id,strategy_key,
                  strategy_version || '-ambiguous',$1,qualification,evidence
             FROM profile_config_evidence WHERE backtest_run_id=$1
           RETURNING id`,
        [verifiedRunId],
      );
      try {
        await expect(
          new StrategyLearningReadinessRepository(pool).resolveBacktestScope(
            verifiedRunId,
            scope.strategyKey,
            "CA_TSX",
          ),
        ).rejects.toMatchObject({ code: "BACKTEST_SCOPE_AMBIGUOUS" });
      } finally {
        await pool.query(`DELETE FROM profile_config_evidence WHERE id=$1`, [
          inserted.rows[0]!.id,
        ]);
      }
    });

    it("keeps thirty exploratory outcomes at raw sample threshold without marking them review-ready", async () => {
      const inserted = await pool.query<{ id: string }>(
        `INSERT INTO backtest_trade(
           id,run_id,instrument_id,symbol,strategy_name,strategy_version,config_version,
           signal_timestamp,score,entry_time,entry_price,stop_price,target_price,
           exit_time,exit_price,shares,exit_reason,gross_pnl,net_pnl,r_multiple,
           hold_minutes,reason_codes,setup_instance_id,atr_pct,rvol_at_time
         ) SELECT gen_random_uuid(),$1,$2,'RDY',$3,$4,$5,
                  '2026-09-01T14:00:00Z',80,
                  '2026-09-01T14:00:00Z'::timestamptz + i * interval '1 second',100,99,102,
                  '2026-09-01T14:05:00Z'::timestamptz + i * interval '1 second',101,10,
                  'TARGET',10,9,0.9,5,'[]'::jsonb,gen_random_uuid(),1.2,2.1
             FROM generate_series(1,29) i
           RETURNING id`,
        [
          verifiedRunId,
          instrumentId,
          scope.strategyKey,
          scope.strategyVersion,
          scope.configVersion,
        ],
      );
      try {
        const sourceRecords = await new StrategyLearningReadinessRepository(
          pool,
        ).get(scope, "2099-01-01T00:00:00.000Z");
        const verifiedRows = sourceRecords.filter(
          (record) => record.coverageVerified && record.lineageVerified,
        );
        const readiness = assessStrategyLearningReadiness(scope, verifiedRows, {
          targetDistinctTrades: 30,
          recentSessions: 0,
        });

        expect(readiness.state).toBe("SAMPLE_THRESHOLD_MET");
        expect(readiness.distinctClosedTrades).toBe(30);
        expect(readiness.shortfall).toBe(0);
        expect(readiness.qualificationCounts).toEqual({
          EVIDENCE_QUALIFIED: 0,
          EXPLORATORY: 30,
        });
      } finally {
        await pool.query(
          `DELETE FROM backtest_trade WHERE id=ANY($1::uuid[])`,
          [inserted.rows.map((row) => row.id)],
        );
      }
    });
  },
);
