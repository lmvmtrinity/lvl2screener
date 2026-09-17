import { randomUUID } from "node:crypto";
import type {
  CreateBacktest,
  StrategyStateEvent,
} from "@tsx-scanner/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../src/backtests/execution-provenance.js";
import {
  buildFundedHistoricalFacts,
  type FundedHistoricalReplayInput,
} from "../src/paper-bot/funded-historical-adapter.js";
import {
  buildFundedQuoteEnvelope,
  loadFundedObservationEvidence,
} from "../src/paper-bot/funded-live-adapter.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import { PostgresFundedLedgerStore } from "../src/paper-bot/funded-ledger-repository.js";
import { fundedAccountSummary } from "../src/paper-bot/funded-ledger.js";
import { FundedReportingService } from "../src/paper-bot/funded-reporting-service.js";
import {
  replayFundedFacts,
  replayFundedHistoricalSession,
} from "../src/paper-bot/funded-replay-service.js";
import { provisionHistoricalFundedRun } from "../src/paper-bot/funded-historical-provisioning.js";
import { FundedDecisionEvidenceRepository } from "../src/paper-bot/funded-decision-evidence-repository.js";
import { FundedDecisionOutcomeProjector } from "../src/paper-bot/funded-decision-outcome-projector.js";
import {
  buildFundedHistoricalObservations,
  ensureFundedHistoricalProfiles,
  fundedHistoricalConfigVersion,
  fundedHistoricalProfiles,
} from "../src/paper-bot/funded-historical-signal-bridge.js";
import { PostgresPaperBotStore } from "../src/paper-bot/paper-bot-repository.js";
import { stableUuid } from "../src/paper-bot/stable-uuid.js";
import { zonedSessionBoundary } from "../src/paper-bot/session-time.js";
import type { AssumptionsSnapshot, QuoteFact } from "../src/paper-bot/types.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { projectFundedComparisonSessionItems } from "../src/paper-bot/funded-comparison-input-freezer.js";
import { applyComparisonSideSession } from "../src/paper-bot/funded-comparison-side-runner.js";
import type { FundedComparisonSharedInput } from "../src/paper-bot/funded-comparison-shared-input.js";
import { contentHash } from "../src/paper-bot/funded-evidence-digest.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
const sessionDate = "2025-02-03";
const sessionStartAt = zonedSessionBoundary(
  sessionDate,
  "09:30",
  "America/Toronto",
);
const scheduledCloseAt = zonedSessionBoundary(
  sessionDate,
  "16:00",
  "America/Toronto",
);
const initialCash = 5_000;
const dailyLossLimit = 500;
const assumptions: AssumptionsSnapshot = {
  positionSize: 1_000,
  slippageBps: 0,
  feePerTrade: 0,
  riskBudget: 100,
  maxNotional: 1_000,
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
};
const policy = fundedPolicy(0.25, 0);
const parameters = {
  scoreCutoff: 0,
  rvolAtTimeMin: 1.5,
} as CreateBacktest["parameters"];

function readyEvent(
  instrumentId: string,
  symbol: string,
  timestamp: string,
): StrategyStateEvent {
  return {
    kind: "SETUP",
    marketId: "CA_TSX",
    eventId: randomUUID(),
    eventType: "STRATEGY_STATE_CHANGED",
    previousState: "FORMING",
    state: "READY",
    instrumentId,
    symbol,
    timestamp,
    profileId: randomUUID(),
    profileName: "FR6",
    strategy: "ORB_RETEST",
    strategyVersion: "1.0.0",
    configVersion: "fr6",
    score: 90,
    setupScore: 90,
    scoreVersion: "v2",
    scoreComponents: {
      pattern: 1,
      confirmation: 1,
      structure: 1,
      liquidity: 1,
      timing: 1,
      penalties: 0,
    },
    scoreExplanation: [],
    setupInstanceId: randomUUID(),
    reasonCodes: ["FR6_ACCEPTANCE"],
    entryReference: 10,
    stopReference: 9.5,
    targetReference: 11,
    estimatedRr: 2,
    featureSnapshot: {
      marketId: "CA_TSX",
      instrumentId,
      symbol,
      timestamp,
      timeframe: "OneMinute",
      featureVersion: "fr6-feature-v1",
      configVersion: "fr6",
      dataStatus: "REALTIME",
      actionable: true,
      price: 10,
      bid: 9.99,
      ask: 10,
      mid: 9.995,
      spreadAbsolute: 0.01,
      spreadPct: 0.1,
      changeFromOpenPct: 0.1,
      rollingReturn5mPct: null,
      vwap: 9.99,
      distanceFromVwapPct: 0.1,
      closeAboveVwap: true,
      last3ClosesAboveVwap: 3,
      vwapSlopePct: 0.01,
      touchVwap: true,
      vwapReclaim: true,
      vwapRejection: false,
      atr14: 0.5,
      atrPct: 0.5,
      rvolAtTime: 2,
      currentCumulativeVolume: 100_000,
      historicalMeanCumulativeVolume: 50_000,
      openingRange: null,
      swingHighs: [],
      swingLows: [],
      nearestSupport: null,
      nearestResistance: null,
      distanceFromVwapAtr: 0.1,
      distanceFromOrhAtr: 0.2,
      changeFromOpenAtr: 0.2,
      consecutiveGreenCandles: 2,
      recentMoveVelocityAtr: 0.1,
      warmingUp: [],
    },
    signalSemanticsVersion: "setup-semantics-v2",
  } as unknown as StrategyStateEvent;
}

describe.skipIf(!databaseUrl)(
  "funded historical replay against isolated PostgreSQL",
  () => {
    let pool: Pool;
    let instrumentId: string;
    let symbol: string;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 4 });
      await migrate(pool);
      instrumentId = randomUUID();
      symbol = `FR6_${instrumentId.slice(0, 8)}.TO`;
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
         security_type,industry_sector,is_quotable,is_tradable,active)
         VALUES($1,$2,$3,'FR6 fixture','TSX','CAD','Stock','Financial Services',true,true,true)`,
        [
          instrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
          symbol,
        ],
      );
      await pool.query(
        `INSERT INTO strategy_definition(id,strategy_key,version,name,description,analysis_kind)
         VALUES($1,'ORB_RETEST','1.0.0','ORB Retest','FR6 fixture','SETUP')
         ON CONFLICT(strategy_key,version) DO NOTHING`,
        [randomUUID()],
      );
    });

    afterAll(async () => {
      await pool?.end();
    });

    async function provision(accountSeed: string): Promise<{
      runId: string;
      accountId: string;
    }> {
      const accountId = stableUuid(`fr6-account:${accountSeed}`);
      const provisioned = await provisionHistoricalFundedRun(pool, {
        marketId: "CA_TSX",
        sessionDate,
        sessionTimezone: "America/Toronto",
        scheduledCloseAt,
        sessionStartAt,
        assumptions,
        policy,
        accountId,
        currency: "CAD",
        initialCash,
        dailyLossLimit,
      });
      return { runId: provisioned.runId, accountId };
    }

    async function insertQuotes(
      instrument: string,
      rows: readonly [string, number, number, number][],
    ): Promise<void> {
      for (const [timestamp, bid, ask, size] of rows)
        await pool.query(
          `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
           spread_absolute,spread_pct,is_delayed,is_halted,source)
           VALUES($1,$2,$3,$4,$5,$5,$3,$5,1000,10,11,9,0.01,0.1,false,false,'FR6')
           ON CONFLICT DO NOTHING`,
          [instrument, timestamp, bid, ask, size],
        );
    }

    async function insertObservation(
      runId: string,
      timestamp = `${sessionDate}T14:30:00.000Z`,
      instrument: string = instrumentId,
      instrumentSymbol: string = symbol,
    ): Promise<string> {
      const baseVersion = fundedHistoricalConfigVersion(parameters);
      const profiles = fundedHistoricalProfiles(
        "CA_TSX",
        ["ORB_RETEST"],
        baseVersion,
      );
      await ensureFundedHistoricalProfiles(
        pool,
        profiles,
        "CA_TSX",
        parameters,
      );
      const observations = buildFundedHistoricalObservations({
        runId,
        profiles,
        events: [readyEvent(instrument, instrumentSymbol, timestamp)],
        parameters,
        scoreCutoff: 0,
      });
      const store = new PostgresPaperBotStore(pool);
      for (const observation of observations)
        await store.insertObservation(observation);
      return observations[0]!.sourceEventId;
    }

    it("creates frozen replay profiles before the first comparison observation", async () => {
      const { runId, accountId } = await provision("comparison-first-run");
      const configVersion = fundedHistoricalConfigVersion(parameters);
      const profiles = fundedHistoricalProfiles(
        "CA_TSX",
        ["ORB_RETEST"],
        configVersion,
      );
      const generated = buildFundedHistoricalObservations({
        runId,
        profiles,
        events: [
          readyEvent(instrumentId, symbol, `${sessionDate}T14:30:00.000Z`),
        ],
        parameters,
        scoreCutoff: 0,
      });
      const projection = projectFundedComparisonSessionItems({
        baselineRunId: "comparison-baseline",
        sessionDate,
        sessionStartAt,
        scheduledCloseAt,
        sessionTimezone: "America/Toronto",
        observations: generated.map((observation) => ({
          ...observation,
          sourceEventId: observation.sourceEventId,
        })),
        quotes: [
          {
            instrumentId,
            timestamp: `${sessionDate}T14:30:00.000Z`,
            bid: 9.99,
            ask: 10,
            bidSize: 1_000,
            askSize: 1_000,
            sizeUnit: "SHARES",
            sizeMultiplier: 1,
            isDelayed: false,
            isHalted: false,
            source: "QUESTRADE",
          },
          {
            instrumentId,
            timestamp: `${sessionDate}T14:45:00.000Z`,
            bid: 11.05,
            ask: 11.06,
            bidSize: 1_000,
            askSize: 1_000,
            sizeUnit: "SHARES",
            sizeMultiplier: 1,
            isDelayed: false,
            isHalted: false,
            source: "QUESTRADE",
          },
        ],
        invalidations: [],
        contextsFor: () => [],
      });
      const opportunity = projection.opportunities[0]!;
      const opportunityItem = projection.items.find(
        (item) => item.kind === "OPPORTUNITY",
      )!;
      const shared: FundedComparisonSharedInput = {
        sessionDate,
        sessionStartAt,
        scheduledCloseAt,
        sessionTimezone: assumptions.sessionTimezone,
        items: projection.items,
        opportunities: projection.opportunities,
        opportunityItems: new Map([
          [opportunity.sourceOpportunityId, opportunityItem],
        ]),
        quotes: projection.items.filter((item) => item.kind === "QUOTE"),
        invalidations: [],
        sessionInputDigest: contentHash(projection.items),
      };
      const before = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM scanner_profile_config
          WHERE id=$1`,
        [profiles[0]!.profileConfigId],
      );
      expect(before.rows[0]!.count).toBe("0");
      const result = await applyComparisonSideSession(
        {
          specId: randomUUID(),
          side: "CHAMPION",
          runId,
          accountId,
          currency: "CAD",
          marketId: "CA_TSX",
          shared,
          profiles,
          parameters,
          assumptions,
          policy,
          ordering: [
            {
              sourceOpportunityId: opportunity.sourceOpportunityId,
              appliedRank: 1,
            },
          ],
          evidenceSource: {
            quote: async () => ({
              timestamp: `${sessionDate}T14:30:00.000Z`,
              bid: 9.99,
              ask: 10,
              bidSize: 1_000,
              askSize: 1_000,
              sizeUnit: "SHARES",
              sizeMultiplier: 1,
              dataStatus: "REALTIME",
              actionable: true,
            }),
            contexts: async () => [],
            model: async () => null,
          },
        },
        { pool, reporting: new FundedReportingService(pool) },
      );
      expect(result.observations.get(opportunity.sourceOpportunityId)).toMatch(
        /^[0-9a-f-]{36}$/,
      );
      const persisted = await pool.query<{
        profile_count: string;
        observation_count: string;
      }>(
        `SELECT
           (SELECT count(*)::text FROM scanner_profile_config WHERE id=$1) AS profile_count,
           (SELECT count(*)::text FROM paper_signal_observation WHERE run_id=$2) AS observation_count`,
        [profiles[0]!.profileConfigId, runId],
      );
      expect(persisted.rows[0]).toEqual({
        profile_count: "1",
        observation_count: "1",
      });
    });

    it("replays a retained session with reconciled account economics", async () => {
      const { runId, accountId } = await provision("primary");
      await insertObservation(runId);
      await insertQuotes(instrumentId, [
        [`${sessionDate}T14:30:00.000Z`, 9.99, 10, 1_000],
        [`${sessionDate}T14:45:00.000Z`, 11.05, 11.06, 1_000],
      ]);

      const preview = await replayFundedHistoricalSession(pool, runId, false);
      expect(preview.rawCoverageVerified).toBe(true);
      expect(preview.factCount).toBeGreaterThanOrEqual(4);

      const applied = await replayFundedHistoricalSession(pool, runId, true);
      expect(applied.processed).toBe(preview.factCount);
      await new PostgresPaperBotStore(pool).completeRun(runId);

      const report = await new FundedReportingService(pool).report(runId);
      expect(report.runStatus).toBe("COMPLETED");
      expect(report.qualifiedForCapitalAllocation).toBe(false);
      expect(report.orders).toHaveLength(1);
      expect(report.orders[0]).toMatchObject({
        status: "FILLED",
        execution: { status: "CLOSED", exit: { exitReason: "TARGET" } },
      });
      expect(report.positions).toEqual({});
      expect(report.reservations).toEqual({});
      expect(report.summary.cash).toBeCloseTo(
        initialCash + report.summary.realizedPnl,
        4,
      );
      expect(report.summary.realizedPnl).toBeCloseTo(100, 4);

      const unresolved = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM paper_funded_fact WHERE run_id=$1 AND outcome IS NULL",
        [runId],
      );
      expect(unresolved.rows[0]!.count).toBe("0");

      // FP01: replay writes the same immutable decision contract through the
      // production capture path under the distinct replay cohort identity.
      const decisions = await pool.query<{
        source_kind: string;
        action: string;
        cohort_digest: string;
      }>(
        "SELECT source_kind,action,cohort_digest FROM funded_decision_evidence WHERE run_id=$1",
        [runId],
      );
      expect(decisions.rows).toHaveLength(1);
      expect(decisions.rows[0]).toMatchObject({
        source_kind: "HISTORICAL_REPLAY",
        action: "SUBMIT",
      });
      expect(decisions.rows[0]!.cohort_digest).toMatch(/^[a-f0-9]{64}$/);
      const projected = await pool.query<{ status: string }>(
        "SELECT status FROM funded_decision_outcome WHERE run_id=$1 ORDER BY sequence",
        [runId],
      );
      expect(projected.rows.map((row) => row.status)).toEqual([
        "DECISION_ACCEPTED",
        "FILLED",
        "CLOSED",
      ]);
      const appliedAgain = await replayFundedHistoricalSession(
        pool,
        runId,
        true,
      );
      const decisionCount = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM funded_decision_evidence WHERE run_id=$1",
        [runId],
      );
      expect(decisionCount.rows[0]!.count).toBe("1");
      expect(appliedAgain.decisions).toBe(1);
      expect(appliedAgain.outcomeProjection.remaining).toBe(0);

      const events = () =>
        pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM paper_funded_event WHERE account_id=$1",
          [accountId],
        );
      const before = await events();
      await replayFundedHistoricalSession(pool, runId, true);
      const after = await events();
      expect(after.rows[0]!.count).toBe(before.rows[0]!.count);
    });

    it("reconciles retained-raw facts with the forward builders and supplied-fact replay", async () => {
      const { runId: sourceRunId } = await provision("reconcile-source");
      await insertObservation(sourceRunId);
      const quoteTimestamp = `${sessionDate}T14:30:00.000Z`;
      await insertQuotes(instrumentId, [
        [quoteTimestamp, 9.99, 10, 1_000],
        [`${sessionDate}T14:45:00.000Z`, 11.05, 11.06, 1_000],
      ]);
      await replayFundedHistoricalSession(pool, sourceRunId, true);
      await new PostgresPaperBotStore(pool).completeRun(sourceRunId);

      const persistedQuote = await pool.query<{ fact: unknown }>(
        "SELECT fact FROM paper_funded_fact WHERE run_id=$1 AND fact_id=$2",
        [sourceRunId, `funded-quote:${instrumentId}:${quoteTimestamp}`],
      );
      const quoteFact: QuoteFact & { instrumentId: string } = {
        instrumentId,
        timestamp: quoteTimestamp,
        bid: 9.99,
        ask: 10,
        bidSize: 1_000,
        askSize: 1_000,
        dataStatus: "REALTIME",
        actionable: true,
      };
      expect(persistedQuote.rows[0]?.fact).toEqual(
        buildFundedQuoteEnvelope(quoteFact, policy)!.fact,
      );

      const { runId: suppliedRunId } = await provision("reconcile-supplied");
      await insertObservation(suppliedRunId);
      const store = new PostgresPaperBotStore(pool);
      const observations =
        await store.findEligibleObservationsForFunding!(suppliedRunId);
      const withContexts = await Promise.all(
        observations.map((observation) =>
          loadFundedObservationEvidence(pool, "CA_TSX", observation),
        ),
      );
      const quoteRows = await pool.query<{
        instrumentId: string;
        timestamp: Date | string;
        bid: number;
        ask: number;
        bidSize: number;
        askSize: number;
      }>(
        `SELECT q.instrument_id AS "instrumentId",q.timestamp,q.bid::float8 AS bid,q.ask::float8 AS ask,
           q.bid_size::float8 AS "bidSize",q.ask_size::float8 AS "askSize"
         FROM quote_snapshot q WHERE q.instrument_id=$1 AND q.timestamp >= $2::timestamptz AND q.timestamp <= $3::timestamptz
         ORDER BY q.timestamp`,
        [instrumentId, sessionStartAt, scheduledCloseAt],
      );
      const prepared = buildFundedHistoricalFacts({
        runId: suppliedRunId,
        marketId: "CA_TSX",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        sessionDate,
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt,
        assumptions,
        policy,
        observations: withContexts,
        invalidations: [],
        quotes: quoteRows.rows.map((row) => ({
          instrumentId: row.instrumentId,
          timestamp: new Date(row.timestamp).toISOString(),
          bid: row.bid,
          ask: row.ask,
          bidSize: row.bidSize,
          askSize: row.askSize,
          dataStatus: "REALTIME" as const,
          actionable: true,
        })),
      } satisfies FundedHistoricalReplayInput);
      await replayFundedFacts(pool, suppliedRunId, prepared.envelopes, true);
      await new PostgresPaperBotStore(pool).completeRun(suppliedRunId);

      const orders = (runId: string) =>
        pool.query<{
          status: string;
          execution: string;
          reason: string;
          netPnl: string;
        }>(
          `SELECT state->>'status' AS status,state->'execution'->>'status' AS execution,
             state->'execution'->'exit'->>'exitReason' AS reason,
             state->'execution'->'exit'->'financials'->>'netPnl' AS "netPnl"
           FROM paper_entry_order WHERE run_id=$1`,
          [runId],
        );
      const sourceOrders = await orders(sourceRunId);
      const suppliedOrders = await orders(suppliedRunId);
      expect(suppliedOrders.rows).toEqual(sourceOrders.rows);

      const ledger = new PostgresFundedLedgerStore(pool);
      const sourceAccount = (
        await pool.query<{ accountId: string }>(
          'SELECT account_id AS "accountId" FROM paper_funded_run WHERE run_id=$1',
          [sourceRunId],
        )
      ).rows[0]!.accountId;
      const suppliedAccount = (
        await pool.query<{ accountId: string }>(
          'SELECT account_id AS "accountId" FROM paper_funded_run WHERE run_id=$1',
          [suppliedRunId],
        )
      ).rows[0]!.accountId;
      const sourceSummary = fundedAccountSummary(
        await ledger.read(sourceAccount),
        scheduledCloseAt,
        30_000,
      );
      const suppliedSummary = fundedAccountSummary(
        await ledger.read(suppliedAccount),
        scheduledCloseAt,
        30_000,
      );
      expect(suppliedSummary.cash).toBeCloseTo(sourceSummary.cash, 6);
      expect(suppliedSummary.realizedPnl).toBeCloseTo(
        sourceSummary.realizedPnl,
        6,
      );
    });

    it("captures a pre-submission invalidation as one DECLINE decision and outcome", async () => {
      const { runId } = await provision("pre-submission");
      const signalAt = `${sessionDate}T14:30:00.000Z`;
      await insertObservation(runId, signalAt);
      await insertQuotes(instrumentId, [
        [`${sessionDate}T14:31:00.000Z`, 9.99, 10, 1_000],
      ]);
      const observation = (
        await pool.query<{
          id: string;
          instrument_id: string;
          setup_instance_id: string | null;
          profile_id: string;
          config_version: string;
        }>(
          `SELECT o.id,o.instrument_id,o.setup_instance_id,c.profile_id,c.config_version
             FROM paper_signal_observation o
             JOIN scanner_profile_config c ON c.id=o.profile_config_id
            WHERE o.run_id=$1`,
          [runId],
        )
      ).rows[0]!;
      const signalId = randomUUID();
      await pool.query(
        `INSERT INTO strategy_signal(
           id,instrument_id,strategy_name,strategy_version,config_version,
           timestamp,previous_state,state,score,feature_snapshot_json,reason_codes)
         VALUES($1,$2,'ORB_RETEST','1.0.0',$3,$4::timestamptz,'FORMING','READY',90,
                '{}'::jsonb,'[]'::jsonb)`,
        [
          signalId,
          observation.instrument_id,
          observation.config_version,
          signalAt,
        ],
      );
      // The retained invalidation shares the signal timestamp, which is the
      // only pre-submission boundary the production query can prove.
      await pool.query(
        `INSERT INTO strategy_state_event(
           id,signal_id,instrument_id,strategy_name,strategy_version,timestamp,
           previous_state,new_state,score,reason_codes,payload,profile_id,setup_instance_id)
         VALUES($1,$2,$3,'ORB_RETEST','1.0.0',$4::timestamptz,'READY','INVALIDATED',90,
                '[]'::jsonb,'{}'::jsonb,$5,$6)`,
        [
          randomUUID(),
          signalId,
          observation.instrument_id,
          signalAt,
          observation.profile_id,
          observation.setup_instance_id,
        ],
      );

      const preview = await replayFundedHistoricalSession(pool, runId, false);
      expect(preview.rawCoverageVerified).toBe(true);
      const applied = await replayFundedHistoricalSession(pool, runId, true);
      expect(applied.captureRepair.remaining).toBe(0);
      expect(applied.outcomeProjection.remaining).toBe(0);

      const decisions = await pool.query<{
        action: string;
        decision_content: { policyReason: string; decisionAt: string };
      }>(
        "SELECT action,decision_content FROM funded_decision_evidence WHERE run_id=$1",
        [runId],
      );
      expect(decisions.rows).toHaveLength(1);
      expect(decisions.rows[0]!.action).toBe("DECLINE");
      expect(decisions.rows[0]!.decision_content.policyReason).toBe(
        "PRE_SUBMISSION_INVALIDATION",
      );
      expect(Date.parse(decisions.rows[0]!.decision_content.decisionAt)).toBe(
        Date.parse(signalAt),
      );
      const outcomes = await pool.query<{ status: string }>(
        "SELECT status FROM funded_decision_outcome WHERE run_id=$1 ORDER BY sequence",
        [runId],
      );
      expect(outcomes.rows.map((row) => row.status)).toEqual([
        "POLICY_DECLINED",
      ]);
      const evidence = new FundedDecisionEvidenceRepository(pool);
      expect(await evidence.decisionGapCount(runId)).toBe(0);
      expect(await evidence.projectionGapCount(runId)).toBe(0);
      const orders = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM paper_entry_order WHERE run_id=$1",
        [runId],
      );
      expect(orders.rows[0]!.count).toBe("0");

      // An idempotent re-run reuses the stored intent and its original
      // boundary instead of re-deriving them from the replayed state.
      const reapplied = await replayFundedHistoricalSession(pool, runId, true);
      expect(reapplied.captureRepair.repaired).toBe(0);
      const decisionsAgain = await pool.query<{
        action: string;
        decision_content: { decisionAt: string };
        content_digest: string;
      }>(
        "SELECT action,decision_content,content_digest FROM funded_decision_evidence WHERE run_id=$1",
        [runId],
      );
      expect(decisionsAgain.rows).toHaveLength(1);
      expect(decisionsAgain.rows[0]!.action).toBe("DECLINE");
      expect(
        Date.parse(decisionsAgain.rows[0]!.decision_content.decisionAt),
      ).toBe(Date.parse(signalAt));
      expect(await evidence.projectionGapCount(runId)).toBe(0);
    });

    it("fails closed without post-signal quote coverage and for unknown runs", async () => {
      const gapInstrumentId = randomUUID();
      const gapSymbol = `FR6GAP_${gapInstrumentId.slice(0, 8)}.TO`;
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
         security_type,industry_sector,is_quotable,is_tradable,active)
         VALUES($1,$2,$3,'FR6 gap fixture','TSX','CAD','Stock','Financial Services',true,true,true)`,
        [
          gapInstrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 2_000_000_000,
          gapSymbol,
        ],
      );
      const { runId } = await provision("coverage-gap");
      await insertObservation(
        runId,
        `${sessionDate}T14:35:00.000Z`,
        gapInstrumentId,
        gapSymbol,
      );
      await insertQuotes(gapInstrumentId, [
        [`${sessionDate}T14:31:00.000Z`, 9.99, 10, 1_000],
      ]);
      await expect(
        replayFundedHistoricalSession(pool, runId, false),
      ).rejects.toThrow(/missing retained quote coverage/);

      await expect(
        replayFundedHistoricalSession(pool, randomUUID(), false),
      ).rejects.toThrow(/requires an existing BACKTEST run/);
    });

    it("captures a historical refusal at its chronological boundary", async () => {
      const { runId, accountId } = await provision(
        `refusal-chronology-${randomUUID()}`,
      );
      const aAt = `${sessionDate}T14:30:00.000Z`;
      const bAt = `${sessionDate}T14:35:00.000Z`;
      // A dedicated instrument keeps this run's retained quotes isolated from
      // every other fixture in the suite.
      const chronologyInstrumentId = randomUUID();
      const chronologySymbol = `FR6CHR_${chronologyInstrumentId.slice(0, 8)}.TO`;
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
         security_type,industry_sector,is_quotable,is_tradable,active)
         VALUES($1,$2,$3,'FR6 chronology fixture','TSX','CAD','Stock','Financial Services',true,true,true)`,
        [
          chronologyInstrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 3_000_000_000,
          chronologySymbol,
        ],
      );
      await insertObservation(
        runId,
        aAt,
        chronologyInstrumentId,
        chronologySymbol,
      );
      await insertObservation(
        runId,
        bAt,
        chronologyInstrumentId,
        chronologySymbol,
      );
      await insertQuotes(chronologyInstrumentId, [
        // A's only retained quote cannot fill: the reservation stays
        // outstanding through the later refusal.
        [`${sessionDate}T14:30:30.000Z`, 9.99, 10, 0],
        [`${sessionDate}T14:35:30.000Z`, 9.99, 10, 1_000],
      ]);
      const observations = await pool.query<{
        id: string;
        instrument_id: string;
        setup_instance_id: string | null;
        profile_id: string;
        config_version: string;
        signal_timestamp: Date | string;
      }>(
        `SELECT o.id,o.instrument_id,o.setup_instance_id,c.profile_id,
                c.config_version,o.signal_timestamp
           FROM paper_signal_observation o
           JOIN scanner_profile_config c ON c.id=o.profile_config_id
          WHERE o.run_id=$1
          ORDER BY o.signal_timestamp`,
        [runId],
      );
      expect(observations.rows).toHaveLength(2);
      const aObservation = observations.rows[0]!;
      const bObservation = observations.rows[1]!;
      const signalId = randomUUID();
      await pool.query(
        `INSERT INTO strategy_signal(
           id,instrument_id,strategy_name,strategy_version,config_version,
           timestamp,previous_state,state,score,feature_snapshot_json,reason_codes)
         VALUES($1,$2,'ORB_RETEST','1.0.0',$3,$4::timestamptz,'FORMING','READY',90,
                '{}'::jsonb,'[]'::jsonb)`,
        [
          signalId,
          bObservation.instrument_id,
          bObservation.config_version,
          bAt,
        ],
      );
      await pool.query(
        `INSERT INTO strategy_state_event(
           id,signal_id,instrument_id,strategy_name,strategy_version,timestamp,
           previous_state,new_state,score,reason_codes,payload,profile_id,setup_instance_id)
         VALUES($1,$2,$3,'ORB_RETEST','1.0.0',$4::timestamptz,'READY','INVALIDATED',90,
                '[]'::jsonb,'{}'::jsonb,$5,$6)`,
        [
          randomUUID(),
          signalId,
          bObservation.instrument_id,
          bAt,
          bObservation.profile_id,
          bObservation.setup_instance_id,
        ],
      );

      const applied = await replayFundedHistoricalSession(pool, runId, true);
      expect(applied.captureRepair.remaining).toBe(0);
      expect(applied.outcomeProjection.remaining).toBe(0);

      const decisions = await pool.query<{
        observation_id: string;
        sequence: number;
        action: string;
        content_digest: string;
        decision_content: {
          decisionAt: string;
          policyReason: string | null;
          portfolio: { status: string; reservedCash: number };
        };
      }>(
        `SELECT observation_id,sequence,action,content_digest,decision_content
           FROM funded_decision_evidence
          WHERE run_id=$1
          ORDER BY sequence`,
        [runId],
      );
      expect(decisions.rows).toHaveLength(2);
      const submit = decisions.rows.find((row) => row.action === "SUBMIT")!;
      const decline = decisions.rows.find((row) => row.action === "DECLINE")!;
      expect(submit.observation_id).toBe(aObservation.id);
      expect(decline.observation_id).toBe(bObservation.id);
      expect(decline.decision_content.policyReason).toBe(
        "PRE_SUBMISSION_INVALIDATION",
      );
      expect(Date.parse(decline.decision_content.decisionAt)).toBe(
        Date.parse(bAt),
      );
      // The refusal's chronological boundary includes every earlier funded
      // effect and no later fact: A's outstanding reservation is represented.
      expect(decline.decision_content.portfolio.status).toBe("AVAILABLE");
      const reserve = await pool.query<{ debit: number }>(
        `SELECT (event->>'debit')::float8 AS debit
           FROM paper_funded_event
          WHERE account_id=$1 AND event_id=$2`,
        [accountId, `reserve:${aObservation.id}`],
      );
      expect(reserve.rows).toHaveLength(1);
      expect(decline.decision_content.portfolio.reservedCash).toBe(
        reserve.rows[0]!.debit,
      );

      const evidence = new FundedDecisionEvidenceRepository(pool);
      await new FundedDecisionOutcomeProjector(pool).projectPending(runId);
      expect(await evidence.decisionGapCount(runId)).toBe(0);
      expect(await evidence.projectionGapCount(runId)).toBe(0);

      const intentBefore = await pool.query<{ sequence_cursor: string }>(
        "SELECT sequence_cursor FROM funded_decision_intent WHERE run_id=$1 AND observation_id=$2",
        [runId, bObservation.id],
      );
      expect(intentBefore.rows).toHaveLength(1);
      const reapplied = await replayFundedHistoricalSession(pool, runId, true);
      expect(reapplied.captureRepair.repaired).toBe(0);
      const declineAgain = await pool.query<{
        sequence: number;
        content_digest: string;
        decision_content: { decisionAt: string };
      }>(
        "SELECT sequence,content_digest,decision_content FROM funded_decision_evidence WHERE run_id=$1 AND observation_id=$2",
        [runId, bObservation.id],
      );
      expect(declineAgain.rows[0]!.content_digest).toBe(decline.content_digest);
      expect(declineAgain.rows[0]!.sequence).toBe(decline.sequence);
      expect(
        Date.parse(declineAgain.rows[0]!.decision_content.decisionAt),
      ).toBe(Date.parse(bAt));
      const intentAfter = await pool.query<{ sequence_cursor: string }>(
        "SELECT sequence_cursor FROM funded_decision_intent WHERE run_id=$1 AND observation_id=$2",
        [runId, bObservation.id],
      );
      expect(intentAfter.rows[0]!.sequence_cursor).toBe(
        intentBefore.rows[0]!.sequence_cursor,
      );
      expect(await evidence.decisionGapCount(runId)).toBe(0);
    });
  },
);
