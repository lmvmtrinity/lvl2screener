import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { PostgresProfileStore } from "../src/profiles/profile-repository.js";
import { ProfileService } from "../src/profiles/profile-service.js";
import { PostgresResearchEvidenceStore } from "../src/backtests/research-evidence-repository.js";

const databaseUrl = isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");

describe.skipIf(!databaseUrl)(
  "profile comparison PostgreSQL acceptance",
  () => {
    let pool: Pool;
    let instrumentId: string;
    let runId: string;
    let evidenceId: string;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 4 });
      await migrate(pool);
      instrumentId = randomUUID();
      runId = randomUUID();
      evidenceId = randomUUID();
      await pool.query(
        `INSERT INTO instrument(
        id,questrade_symbol_id,symbol,description,exchange,currency,security_type,
        industry_sector,is_quotable,is_tradable,active
      ) VALUES($1,$2,$3,'Comparison fixture','TSX','CAD','Stock','Technology',true,true,true)`,
        [
          instrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
          `CMP_${instrumentId.slice(0, 8)}.TO`,
        ],
      );
      const profile = await pool.query<{
        id: string;
        config_id: string;
        config_version: string;
        strategy_key: string;
        strategy_version: string;
        strategy_definition_id: string;
      }>(
        `SELECT p.id,c.id config_id,c.config_version,d.strategy_key,d.version strategy_version,
              d.id strategy_definition_id
       FROM scanner_profile p
       JOIN scanner_profile_config c ON c.id=p.current_config_id
       JOIN strategy_definition d ON d.id=p.strategy_definition_id
       WHERE p.id='10000000-0000-4000-8000-000000000081'`,
      );
      const value = profile.rows[0]!;
      await pool.query(
        `INSERT INTO backtest_run(
        id,market_id,name,status,start_date,end_date,strategies,symbols,data_source,
        strategy_version,config_version,execution_model_version,execution_assumptions,
        starting_capital,position_size,slippage_bps,fee_per_trade,parameters,replay_input
      ) VALUES($1,'CA_TSX','Comparison fixture','COMPLETED','2026-09-01','2026-09-01',
        $2::jsonb,$3::jsonb,'CAPTURED_QUOTES',$4,$5,'paper-execution-v7',$6::jsonb,
        100000,1000,0,1,$7::jsonb,$8::jsonb)`,
        [
          runId,
          JSON.stringify([value.strategy_key]),
          JSON.stringify([`CMP_${instrumentId.slice(0, 8)}.TO`]),
          value.strategy_version,
          value.config_version,
          JSON.stringify({
            positionSize: 1000,
            slippageBps: 0,
            feePerTrade: 1,
            sessionTimezone: "America/Toronto",
            evidenceScope: "COMPARISON_FIXTURE",
          }),
          JSON.stringify({
            version: "replay-input-v1",
            inputHash: "a".repeat(64),
            marketId: "CA_TSX",
          }),
          JSON.stringify({
            rvolAtTimeMin: 1.5,
            spreadHardMaxPct: 0.25,
            breakoutVolumeRatioMin: 1.5,
            retestTolerancePct: 0.15,
            scoreCutoff: 0,
          }),
        ],
      );
      await pool.query(
        `INSERT INTO profile_config_evidence(
        id,profile_config_id,strategy_definition_id,strategy_key,strategy_version,
        backtest_run_id,qualification,evidence
      ) VALUES($1,$2,$3,$4,$5,$6,'EXPLORATORY','{}'::jsonb)`,
        [
          evidenceId,
          value.config_id,
          value.strategy_definition_id,
          value.strategy_key,
          value.strategy_version,
          runId,
        ],
      );
      const outcomes = [100, -80, -80, 100];
      for (const [index, pnl] of [...outcomes.entries()].reverse()) {
        const exit = `2026-09-01T14:0${index}:00.000Z`;
        await pool.query(
          `INSERT INTO backtest_trade(
          id,run_id,instrument_id,symbol,strategy_name,strategy_version,config_version,
          signal_timestamp,score,entry_time,entry_price,stop_price,target_price,
          exit_time,exit_price,shares,exit_reason,gross_pnl,net_pnl,r_multiple,hold_minutes,reason_codes,setup_instance_id
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,80,$8,100,99,102,$9,100,$10,'STOP',$11,$11,$12,1,'[]'::jsonb,$13)`,
          [
            randomUUID(),
            runId,
            instrumentId,
            `CMP_${instrumentId.slice(0, 8)}.TO`,
            value.strategy_key,
            value.strategy_version,
            value.config_version,
            exit,
            exit,
            10,
            pnl,
            pnl / 100,
            randomUUID(),
          ],
        );
      }
    });

    afterAll(async () => {
      await pool?.end();
    });

    it("maps realized exits by identity and computes drawdown independent of insert order", async () => {
      const profiles = await pool.query<{ id: string }>(
        `SELECT id FROM scanner_profile
       WHERE id IN ('10000000-0000-4000-8000-000000000081','10000000-0000-4000-8000-000000000083')
       ORDER BY id`,
      );
      const result = await new ProfileService(
        new PostgresProfileStore(pool),
      ).compare(
        profiles.rows.map((value) => value.id),
        "BACKTEST",
        "2026-09-01",
        "2026-09-01",
      );
      const metric = result.metrics.find(
        (value) => value.profileId === "10000000-0000-4000-8000-000000000081",
      );
      expect(result.status).toBe("UNVERIFIED");
      expect(metric?.maximumDrawdown).toBe(160);
      expect(metric?.drawdownStatus).toBe("AVAILABLE");
    });
    it("projects an exact verified BACKTEST owner binding without filling unknown universe provenance", async () => {
      const evidence = new PostgresResearchEvidenceStore(pool);
      const inputHash = "d".repeat(64),
        manifestHash = "e".repeat(64);
      await evidence.saveManifest({
        hash: manifestHash,
        marketId: "CA_TSX",
        manifest: { plan: { featureVersion: "1.2.0" } },
      });
      const report = {
        version: "research-coverage-v2" as const,
        marketId: "CA_TSX" as const,
        manifestHash,
        expectedInputsHash: "f".repeat(64),
        inputHash,
        sessionPayloadHashes: { "2026-09-01": "b".repeat(64) },
        verifiedAt: "2026-09-02T00:00:00.000Z",
        status: "VERIFIED" as const,
        cells: [],
      };
      const coverageReportHash = await evidence.saveReport(report);
      const binding = {
        manifestHash,
        coverageReportHash,
        inputHash,
        verifiedAt: report.verifiedAt,
        engineRevision: "a".repeat(40),
        runtimeFingerprint: "b".repeat(64),
      };
      await evidence.withTransaction(async (client) => {
        await evidence.bindWithClient(
          client,
          { kind: "BACKTEST", id: runId, marketId: "CA_TSX" },
          binding,
        );
        await client.query(
          "UPDATE backtest_run SET research_evidence=$2::jsonb,replay_input=$3::jsonb WHERE id=$1",
          [runId, JSON.stringify(binding), JSON.stringify({ inputHash })],
        );
      });
      const store = new PostgresProfileStore(pool);
      const rows = await store.comparisonCohorts(
        ["10000000-0000-4000-8000-000000000081"],
        "BACKTEST",
        "2026-09-01",
        "2026-09-01",
        "09:30",
        "16:00",
        "CA_TSX",
      );
      expect(rows[0]).toMatchObject({
        coverageReportHash,
        coverageComplete: true,
        inputHash,
        featureVersion: "1.2.0",
        universeHash: null,
      });
      const us = await store.comparisonCohorts(
        ["10000000-0000-4000-8000-000000000081"],
        "BACKTEST",
        "2026-09-01",
        "2026-09-01",
        "09:30",
        "16:00",
        "US_EQUITIES",
      );
      expect(us).toEqual([]);
    });
  },
);
