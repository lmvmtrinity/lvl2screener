import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import {
  comparisonSignalSortKey,
  FundedFactAdapter,
} from "../src/paper-bot/funded-fact-adapter.js";
import { FundedDecisionEvidenceRepository } from "../src/paper-bot/funded-decision-evidence-repository.js";
import { PostgresPaperBotStore } from "../src/paper-bot/paper-bot-repository.js";
import { PostgresFundedLedgerStore } from "../src/paper-bot/funded-ledger-repository.js";
import { FundedOrderService } from "../src/paper-bot/funded-order-service.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";

const databaseUrl =
  isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL") ??
  isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");

const assumptions = {
  positionSize: 1_000,
  slippageBps: 2,
  feePerTrade: 1,
  costs: {
    entryCommission: 1,
    exitCommission: 1,
    estimatedRegulatoryFees: 0,
    slippageBps: 2,
    currency: "CAD",
    brokerPricingVersion: "test-cost-policy-v1",
  },
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
  riskBudget: 250,
  maxNotional: 1_500,
  executionMode: "CAPACITY_CONSTRAINED",
  latencyMs: 0,
} as const;

describe.skipIf(!databaseUrl)(
  "funded inbox comparison SIGNAL sort keys on isolated PostgreSQL",
  () => {
    let pool: Pool;
    let instrumentId: string;
    let profileId: string;
    let profileConfigId: string;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 8 });
      await migrate(pool);
      await pool.query(
        `TRUNCATE
           funded_comparison_failure, funded_comparison_result,
           funded_comparison_session_metric, funded_comparison_policy_evaluation,
           funded_comparison_run_binding, funded_comparison_input_chunk,
           funded_comparison_spec_opportunity, funded_comparison_spec_session,
           funded_comparison_spec, funded_execution_prediction,
           funded_execution_challenger, funded_execution_dataset_member,
           funded_execution_dataset, funded_decision_outcome,
           funded_decision_intent, funded_decision_refusal,
           funded_decision_evidence, paper_funded_fact, paper_funded_event,
           paper_entry_order, paper_funded_run, paper_funded_account,
           paper_signal_observation, paper_bot_run, scanner_profile_config,
           scanner_profile, strategy_definition, instrument
         CASCADE`,
      );
      instrumentId = randomUUID();
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
           security_type,industry_sector,is_quotable,is_tradable,active,market_id)
         VALUES($1,$2,$3,'comparison order','TSX','CAD','Stock','Technology',true,true,true,'CA_TSX')`,
        [
          instrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
          `CMP_${instrumentId.slice(0, 8)}`,
        ],
      );
      const definitionId = randomUUID();
      await pool.query(
        `INSERT INTO strategy_definition(id,strategy_key,version,name,description)
         VALUES($1,$2,'2026-09-01','CMP','comparison order')`,
        [definitionId, `CMP_${definitionId.slice(0, 8)}`],
      );
      profileId = randomUUID();
      profileConfigId = randomUUID();
      await pool.query(
        `INSERT INTO scanner_profile(id,name,strategy_definition_id,enabled,display_order,market_id)
         VALUES($1,$2,$3,false,0,'CA_TSX')`,
        [profileId, `cmp-${profileId.slice(0, 8)}`, definitionId],
      );
      await pool.query(
        `INSERT INTO scanner_profile_config(id,profile_id,config_version,parameters,market_id)
         VALUES($1,$2,$3,'{}'::jsonb,'CA_TSX')`,
        [profileConfigId, profileId, `cmp-${profileConfigId.slice(0, 8)}`],
      );
    }, 180_000);

    afterAll(async () => {
      await pool?.end();
    });

    async function setupRun(): Promise<string> {
      const accountId = randomUUID();
      await new PostgresFundedLedgerStore(pool).ensure(accountId, [
        "CAD",
        50_000,
        "2026-09-15",
        "2026-09-15T13:30:00.000Z",
        3_000,
      ]);
      const run = await new PostgresPaperBotStore(pool).startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2026-09-15",
        sessionTimezone: "America/Toronto",
        scheduledCloseAt: "2026-09-15T20:00:00.000Z",
        executionModelVersion: "execution-v1",
        assumptions,
      });
      await new FundedOrderService(pool, run.id, accountId, "CAD").bind(
        fundedPolicy(1, 0),
        { session: "2026-09-15", at: "2026-09-15T13:30:00.000Z" },
      );
      return run.id;
    }

    async function signalEnvelope(
      runId: string,
      at: string,
      setupInstanceId: string,
    ) {
      const observation = await new PostgresPaperBotStore(
        pool,
      ).insertObservation({
        runId,
        sourceEventId: randomUUID(),
        sourceSignalId: null,
        setupInstanceId,
        instrumentId,
        symbol: "CMP",
        profileId,
        profileName: "cmp",
        profileConfigId,
        configVersion: "v1",
        profileParameters: { scoreCutoff: 0 },
        strategyKey: "CMP",
        strategyVersion: "2026-09-01",
        signalTimestamp: at,
        score: 70,
        entryReference: 10,
        stopReference: 9,
        targetReference: 12,
        atr14: 1,
        featureSnapshot: { featureVersion: "features-v1", atr14: 1 },
        reasonCodes: ["BREAKOUT"],
        sourceEventPayload: { signalSemanticsVersion: "setup-semantics-v2" },
        eligibilityStatus: "ELIGIBLE",
        eligibilityReason: null,
      });
      return {
        observationId: observation.observation.id,
        envelope: {
          id: `funded-signal:${observation.observation.id}`,
          fact: {
            type: "SIGNAL" as const,
            instrumentId,
            maximumDebit: 1_000,
            maximumRisk: 250,
            order: {
              orderId: observation.observation.id,
              submittedAt: at,
              expiresAt: "2026-09-15T20:00:00.000Z",
              assumptions,
              signal: {
                entryReference: 10,
                stopReference: 9,
                targetReference: 12,
                atr14: 1,
                signalTimestamp: at,
              },
            },
          },
        },
      };
    }

    it("drains same-timestamp signals in the applied comparison rank order", async () => {
      const runId = await setupRun();
      const adapter = new FundedFactAdapter(pool, runId);
      const evidence = new FundedDecisionEvidenceRepository(pool);
      const first = await signalEnvelope(
        runId,
        "2026-09-15T14:30:00.000Z",
        randomUUID(),
      );
      const second = await signalEnvelope(
        runId,
        "2026-09-15T14:30:00.000Z",
        randomUUID(),
      );
      await adapter.enqueue([first.envelope, second.envelope], {
        repository: evidence,
        signalSortKeys: new Map([
          [
            first.observationId,
            comparisonSignalSortKey(2, first.observationId),
          ],
          [
            second.observationId,
            comparisonSignalSortKey(1, second.observationId),
          ],
        ]),
      });
      await adapter.drain(undefined, { repository: evidence });
      const order = await pool.query<{ fact_id: string; sort_key: string }>(
        `SELECT fact_id,sort_key FROM paper_funded_fact
          WHERE run_id=$1 AND fact->>'type'='SIGNAL'
          ORDER BY applied_sequence`,
        [runId],
      );
      expect(order.rows.map((row) => row.fact_id)).toEqual([
        `funded-signal:${second.observationId}`,
        `funded-signal:${first.observationId}`,
      ]);
      expect(order.rows[0]!.sort_key).toBe(
        comparisonSignalSortKey(1, second.observationId),
      );
      // Exact retry with the same keys is a no-op.
      await adapter.enqueue([first.envelope, second.envelope], {
        repository: evidence,
        signalSortKeys: new Map([
          [
            first.observationId,
            comparisonSignalSortKey(2, first.observationId),
          ],
          [
            second.observationId,
            comparisonSignalSortKey(1, second.observationId),
          ],
        ]),
      });
      // A changed key under the same fact identity conflicts.
      await expect(
        adapter.enqueue([first.envelope], {
          repository: evidence,
          signalSortKeys: new Map([
            [
              first.observationId,
              comparisonSignalSortKey(3, first.observationId),
            ],
          ]),
        }),
      ).rejects.toThrow(/Conflicting funded fact retry/i);
    });

    it("conflicts when a retry omits a comparison sort key already persisted", async () => {
      const runId = await setupRun();
      const adapter = new FundedFactAdapter(pool, runId);
      const evidence = new FundedDecisionEvidenceRepository(pool);
      const signal = await signalEnvelope(
        runId,
        "2026-09-15T14:30:00.000Z",
        randomUUID(),
      );
      await adapter.enqueue([signal.envelope], {
        repository: evidence,
        signalSortKeys: new Map([
          [
            signal.observationId,
            comparisonSignalSortKey(1, signal.observationId),
          ],
        ]),
      });
      // The stored comparison key is always compared, even when this retry
      // supplies no custom key: it must not silently fall back to the default.
      await expect(
        adapter.enqueue([signal.envelope], { repository: evidence }),
      ).rejects.toThrow(/Conflicting funded fact retry/i);
      const retried = await adapter.enqueue([signal.envelope], {
        repository: evidence,
        signalSortKeys: new Map([
          [
            signal.observationId,
            comparisonSignalSortKey(1, signal.observationId),
          ],
        ]),
      });
      expect(retried).toBeUndefined();
    });

    it("rejects an invalid comparison sort key before any write", async () => {
      const runId = await setupRun();
      const adapter = new FundedFactAdapter(pool, runId);
      const signal = await signalEnvelope(
        runId,
        "2026-09-15T14:30:00.000Z",
        randomUUID(),
      );
      await expect(
        adapter.enqueue([signal.envelope], {
          signalSortKeys: new Map([[signal.observationId, "not a sort key"]]),
        }),
      ).rejects.toThrow(/Invalid comparison funded SIGNAL sort key/i);
      const rows = await pool.query(
        "SELECT 1 FROM paper_funded_fact WHERE run_id=$1",
        [runId],
      );
      expect(rows.rows).toHaveLength(0);
    });

    it("leaves non-comparison sort keys derived from the fact identity", async () => {
      const runId = await setupRun();
      const adapter = new FundedFactAdapter(pool, runId);
      const signal = await signalEnvelope(
        runId,
        "2026-09-15T14:30:00.000Z",
        randomUUID(),
      );
      await adapter.enqueue([signal.envelope]);
      const row = await pool.query<{ sort_key: string }>(
        "SELECT sort_key FROM paper_funded_fact WHERE run_id=$1",
        [runId],
      );
      expect(row.rows[0]!.sort_key).toBe(signal.observationId);
    });
  },
);
