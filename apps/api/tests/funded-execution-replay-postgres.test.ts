import { randomUUID } from "node:crypto";
import type {
  CreateBacktest,
  StrategyStateEvent,
} from "@tsx-scanner/contracts";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { provisionHistoricalFundedRun } from "../src/paper-bot/funded-historical-provisioning.js";
import { replayFundedHistoricalSession } from "../src/paper-bot/funded-replay-service.js";
import { FundedDecisionOutcomeProjector } from "../src/paper-bot/funded-decision-outcome-projector.js";
import { FundedDecisionEvidenceRepository } from "../src/paper-bot/funded-decision-evidence-repository.js";
import {
  buildFundedHistoricalObservations,
  ensureFundedHistoricalProfiles,
  fundedHistoricalConfigVersion,
  fundedHistoricalProfiles,
} from "../src/paper-bot/funded-historical-signal-bridge.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import { PostgresPaperBotStore } from "../src/paper-bot/paper-bot-repository.js";
import { zonedSessionBoundary } from "../src/paper-bot/session-time.js";
import { stableUuid } from "../src/paper-bot/stable-uuid.js";
import type { AssumptionsSnapshot } from "../src/paper-bot/types.js";
import { PostgresFundedExecutionTrainingStore } from "../src/statistical-models/funded-execution-training-repository.js";
import { FundedExecutionTrainingService } from "../src/statistical-models/funded-execution-training-service.js";
import type { FundedExecutionTrainingClient } from "../src/statistical-models/funded-execution-training-service.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";

/**
 * FP02-R3 replay chronology integration. The four chronological replay sessions
 * are produced only through the production replay path: retained observations
 * and quotes are bridged into funded facts, the inbox applies them, the capture
 * records decisions and the projector appends outcomes. The test never inserts
 * `recorded_at` and never updates `paper_entry_order_history`; the replay must
 * qualify its dataset from the facts it actually applied.
 */

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
const SESSION_DATES = ["2025-09-08", "2025-09-09", "2025-09-10", "2025-09-11"];
// 26 fills and 26 no-fills per session keep both fill classes and cost labels
// above the frozen 200-row/100-train/40-test floors.
const PER_SESSION = 52;
const SESSION_TIMEZONE = "America/Toronto";
const assumptions: AssumptionsSnapshot = {
  positionSize: 1_000,
  slippageBps: 2,
  feePerTrade: 1,
  costs: {
    entryCommission: 1,
    exitCommission: 1,
    estimatedRegulatoryFees: 0,
    slippageBps: 2,
    currency: "CAD",
    brokerPricingVersion: "fp02-r3-cost-policy",
  },
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: SESSION_TIMEZONE,
  noonCloseTime: "16:00",
  riskBudget: 100,
  maxNotional: 1_000,
  executionMode: "CAPACITY_CONSTRAINED",
  latencyMs: 0,
};
const policy = fundedPolicy(1, 0, {
  // The fixture keeps many zero-fill orders pending until the session close, so
  // the default three-open-order portfolio cap would veto later independent
  // decisions. The elevated caps only bound this isolated replay fixture.
  maxOpenPositions: 200,
  maxTotalOpenRisk: 10_000_000,
});
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
    profileName: "FP02R3",
    strategy: "ORB_RETEST",
    strategyVersion: "1.0.0",
    configVersion: "fp02-r3",
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
    reasonCodes: ["FP02_R3"],
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
      featureVersion: "fp02-r3-feature-v1",
      configVersion: "fp02-r3",
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
  "funded execution replay chronology against isolated PostgreSQL",
  () => {
    let pool: Pool;
    let store: PostgresFundedExecutionTrainingStore;
    const trainingClient: FundedExecutionTrainingClient = {
      async trainFundedExecution() {
        throw new Error("Replay chronology test never trains a challenger");
      },
    };

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 6 });
      await migrate(pool);
      store = new PostgresFundedExecutionTrainingStore(pool);
      await pool.query(
        `INSERT INTO strategy_definition(id,strategy_key,version,name,description,analysis_kind)
         VALUES($1,'ORB_RETEST','1.0.0','ORB Retest','FP02-R3 fixture','SETUP')
         ON CONFLICT(strategy_key,version) DO NOTHING`,
        [randomUUID()],
      );
      await ensureFundedHistoricalProfiles(
        pool,
        fundedHistoricalProfiles(
          "CA_TSX",
          ["ORB_RETEST"],
          fundedHistoricalConfigVersion(parameters),
        ),
        "CA_TSX",
        parameters,
      );
    }, 180_000);

    afterAll(async () => {
      await pool?.end();
    });

    async function insertInstrument(): Promise<{
      instrumentId: string;
      symbol: string;
    }> {
      const instrumentId = randomUUID();
      const symbol = `FP02R3_${instrumentId.slice(0, 8)}.TO`;
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
         security_type,industry_sector,is_quotable,is_tradable,active,market_id)
         VALUES($1,$2,$3,'FP02-R3 replay fixture','TSX','CAD','Stock','Technology',true,true,true,'CA_TSX')`,
        [
          instrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 5_000_000_000,
          symbol,
        ],
      );
      return { instrumentId, symbol };
    }

    async function insertQuote(
      instrumentId: string,
      timestamp: string,
      quote: { bid: number; ask: number; bidSize: number; askSize: number },
    ): Promise<void> {
      await pool.query(
        `INSERT INTO quote_snapshot(instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,day_volume,day_open,day_high,day_low,
           spread_absolute,spread_pct,is_delayed,is_halted,source,size_unit,size_multiplier)
         VALUES($1,$2,$3,$4,$5,$6,$3,$5,1000,10,11,9,0.01,0.1,false,false,'FP02R3','SHARES',1)
         ON CONFLICT DO NOTHING`,
        [
          instrumentId,
          timestamp,
          quote.bid,
          quote.ask,
          quote.bidSize,
          quote.askSize,
        ],
      );
    }

    async function insertObservations(input: {
      runId: string;
      events: readonly StrategyStateEvent[];
    }): Promise<void> {
      const profiles = fundedHistoricalProfiles(
        "CA_TSX",
        ["ORB_RETEST"],
        fundedHistoricalConfigVersion(parameters),
      );
      const observations = buildFundedHistoricalObservations({
        runId: input.runId,
        profiles,
        events: input.events,
        parameters,
        scoreCutoff: 0,
      });
      const botStore = new PostgresPaperBotStore(pool);
      for (const observation of observations)
        await botStore.insertObservation(observation);
    }

    async function replaySession(input: {
      sessionDate: string;
      seed: string;
      scheduledCloseAt?: string;
      sessionStartAt?: string;
      decisions: readonly ("FILL" | "NO_FILL")[];
    }): Promise<string> {
      const sessionStartAt =
        input.sessionStartAt ??
        zonedSessionBoundary(input.sessionDate, "09:30", SESSION_TIMEZONE);
      const scheduledCloseAt =
        input.scheduledCloseAt ??
        zonedSessionBoundary(input.sessionDate, "16:00", SESSION_TIMEZONE);
      const provisioned = await provisionHistoricalFundedRun(pool, {
        marketId: "CA_TSX",
        sessionDate: input.sessionDate,
        sessionTimezone: SESSION_TIMEZONE,
        scheduledCloseAt,
        sessionStartAt,
        assumptions,
        policy,
        accountId: stableUuid(`fp02-r3-account:${input.seed}`),
        currency: "CAD",
        initialCash: 5_000_000,
        dailyLossLimit: 1_000_000,
      });
      const events: StrategyStateEvent[] = [];
      const base = Date.parse(`${input.sessionDate}T14:00:00.000Z`);
      for (const [index, decision] of input.decisions.entries()) {
        const signalAt = new Date(base + index * 60_000).toISOString();
        const { instrumentId, symbol } = await insertInstrument();
        if (decision === "FILL") {
          // The decision-time quote fills at the ask, and the later quote
          // reaches the target and closes the position before the next signal,
          // so no held position blocks the following entry with a stale mark.
          await insertQuote(instrumentId, signalAt, {
            bid: 9.99,
            ask: 10,
            bidSize: 1_000,
            askSize: 1_000,
          });
          await insertQuote(
            instrumentId,
            new Date(Date.parse(signalAt) + 20_000).toISOString(),
            {
              bid: 11.05,
              ask: 11.06,
              bidSize: 1_000,
              askSize: 1_000,
            },
          );
        } else {
          // A zero displayed size is a retained, executable quote that cannot
          // fill, so the order stays pending and expires at the close with a
          // proven zero-fill outcome.
          await insertQuote(instrumentId, signalAt, {
            bid: 9.99,
            ask: 10,
            bidSize: 1_000,
            askSize: 0,
          });
        }
        events.push(readyEvent(instrumentId, symbol, signalAt));
      }
      await insertObservations({ runId: provisioned.runId, events });
      const applied = await replayFundedHistoricalSession(
        pool,
        provisioned.runId,
        true,
      );
      expect(applied.captureRepair.remaining).toBe(0);
      // The projection pass is bounded; drain it fully through the production
      // repair entry point before completing the run.
      const projector = new FundedDecisionOutcomeProjector(pool);
      let projection = applied.outcomeProjection;
      for (let pass = 0; pass < 10 && projection.remaining > 0; pass += 1)
        projection = await projector.projectPending(provisioned.runId);
      expect(projection.remaining).toBe(0);
      await new PostgresPaperBotStore(pool).completeRun(provisioned.runId);
      return provisioned.runId;
    }

    it("materializes a qualifying replay dataset from its own applied-fact chronology", async () => {
      const decisions: ("FILL" | "NO_FILL")[] = Array.from(
        { length: PER_SESSION },
        (_, index) => (index % 2 === 0 ? "FILL" : "NO_FILL"),
      );
      const runByDate = new Map<string, string>();
      for (const sessionDate of SESSION_DATES)
        runByDate.set(
          sessionDate,
          await replaySession({
            sessionDate,
            seed: `session-${sessionDate}`,
            decisions,
          }),
        );

      // One day-3 run delays its close into the day-4 holdout period, so its
      // zero-fill label is only learned after the holdout boundary and must be
      // excluded from the training partition even though its economic quote is
      // in the training session.
      const day4 = SESSION_DATES[3]!;
      const delayedCloseAt = zonedSessionBoundary(
        day4,
        "16:00",
        SESSION_TIMEZONE,
      );
      const delayedRunId = await replaySession({
        sessionDate: SESSION_DATES[2]!,
        seed: "delayed-close",
        scheduledCloseAt: delayedCloseAt,
        decisions: ["NO_FILL"],
      });
      const delayedEvidence = await pool.query<{ observation_id: string }>(
        "SELECT observation_id FROM funded_decision_evidence WHERE run_id=$1",
        [delayedRunId],
      );
      expect(delayedEvidence.rows).toHaveLength(1);
      const delayedObservationId = delayedEvidence.rows[0]!.observation_id;

      // A second day-3 run with a proven fill and a close delayed into the
      // day-4 holdout period. Its economic fill is inside the training session
      // and its label does not depend on point-in-time terminality, yet the
      // only time the version was knowable on the replay timeline is after the
      // holdout boundary: the persisted applied-fact boundary must exclude it.
      const delayedFillRunId = await replaySession({
        sessionDate: SESSION_DATES[2]!,
        seed: "delayed-fill",
        scheduledCloseAt: delayedCloseAt,
        decisions: ["FILL"],
      });
      const delayedFillEvidence = await pool.query<{ observation_id: string }>(
        "SELECT observation_id FROM funded_decision_evidence WHERE run_id=$1",
        [delayedFillRunId],
      );
      expect(delayedFillEvidence.rows).toHaveLength(1);
      const delayedFillObservationId =
        delayedFillEvidence.rows[0]!.observation_id;

      // The first TEST decision is the day-4 holdout boundary.
      const day4RunId = runByDate.get(day4)!;
      const boundary = await pool.query<{ decision_at: Date }>(
        `SELECT min(decision_at) AS decision_at
           FROM funded_decision_evidence WHERE run_id=$1`,
        [day4RunId],
      );
      const boundaryAt = boundary.rows[0]!.decision_at.toISOString();

      const expectedDecisionCount = SESSION_DATES.length * PER_SESSION + 2;
      const foundCohort = (await store.listCohorts()).find(
        (summary) =>
          summary.sourceKind === "HISTORICAL_REPLAY" &&
          summary.decisionCount === expectedDecisionCount,
      );
      expect(foundCohort).toBeDefined();
      if (!foundCohort) throw new Error("Replay cohort was not materialized");
      const cohort = foundCohort;
      expect(cohort.decisionCount).toBe(expectedDecisionCount);
      const cutoff = new Date();
      const service = new FundedExecutionTrainingService(store, trainingClient);
      const first = await service.materialize(cohort.cohort, cutoff);
      expect(first.dataset).not.toBeNull();
      const dataset = first.dataset!;
      expect(dataset.activationEligible).toBe(false);
      expect(dataset.qualificationReceipt.liveRunRequired).toBe(false);
      expect(
        dataset.qualificationReceipt.counts.includedRowCount,
      ).toBeGreaterThanOrEqual(200);
      expect(dataset.qualificationReceipt.counts.trainRowCount).toBeGreaterThan(
        0,
      );
      expect(dataset.qualificationReceipt.counts.testRowCount).toBeGreaterThan(
        0,
      );
      // Only the delayed zero-fill (whose terminality is proven by the day-4
      // close) is purged. The delayed fill binds its exact entry-quote fact.
      expect(
        dataset.qualificationReceipt.counts.excludedCounts
          .LABEL_AFTER_CHRONOLOGICAL_BOUNDARY,
      ).toBe(1);

      const members = await store.listDatasetMembers(dataset.id);
      const sessions = [
        ...new Set(members.map((member) => member.sessionDate)),
      ];
      expect(sessions.sort()).toEqual([...SESSION_DATES].sort());

      // The delayed-close label is genuinely after the holdout boundary and is
      // excluded; the same row's economic quote was inside the training session.
      expect(
        members.some(
          (member) => member.identity.observationId === delayedObservationId,
        ),
      ).toBe(false);
      const assembled = await store.assembledRowsFor(
        cohort.cohort.cohortDigest,
        cutoff,
      );
      const delayedRow = assembled.find(
        (row) => row.observationId === delayedObservationId,
      );
      // The label itself is provable (it is INCLUDED by the assembler); the
      // chronological split is what removes it from the training partition.
      expect(delayedRow?.verdict).toBe("INCLUDED");
      expect(delayedRow?.labels?.knowledge.provenance).toBe(
        "HISTORICAL_REPLAY_FACT_SEQUENCE",
      );
      expect(delayedRow?.labels?.knowledge.runId).toBe(delayedRunId);
      expect(
        Date.parse(delayedRow!.labels!.knowledge.at),
      ).toBeGreaterThanOrEqual(Date.parse(boundaryAt));

      // Every retained row binds its replay applied-fact sequence and its run,
      // and every TRAIN row's coordinate precedes the holdout boundary.
      for (const member of members) {
        expect(member.labels.knowledge.provenance).toBe(
          "HISTORICAL_REPLAY_FACT_SEQUENCE",
        );
        expect(member.labels.knowledge.sequence).toBeGreaterThan(0);
        expect(member.labels.knowledge.runId).toBe(member.identity.runId);
        if (member.partition === "TRAIN")
          expect(Date.parse(member.labels.knowledge.at)).toBeLessThan(
            Date.parse(boundaryAt),
          );
      }

      // The delayed fill's exact causal fact is its entry quote inside the
      // training session, so the FILLED label is knowable before the holdout
      // and legitimately stays in TRAIN even though the replay ran into day 4.
      // The terminality-dependent zero-fill above is the row that must not.
      const delayedFillRow = assembled.find(
        (row) => row.observationId === delayedFillObservationId,
      );
      expect(delayedFillRow?.verdict).toBe("INCLUDED");
      expect(delayedFillRow?.labels?.terminalOutcomeStatus).toBe("FILLED");
      expect(delayedFillRow?.labels?.knowledge).toEqual({
        provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
        runId: delayedFillRunId,
        sequence: 3,
        at: "2025-09-10T14:00:00.000Z",
      });
      const delayedFillMember = members.find(
        (member) => member.identity.observationId === delayedFillObservationId,
      );
      expect(delayedFillMember?.partition).toBe("TRAIN");
      expect(Date.parse(delayedFillRow!.labels!.knowledge.at)).toBeLessThan(
        Date.parse(boundaryAt),
      );

      // A later exact fact is applied after the replay. The correction keeps
      // its earlier economic time but is only knowable at that exact fact's
      // boundary, so it can never reuse the earlier outcome version boundary.
      const laterFactId = `fp02r5-later:${delayedFillRunId}`;
      await pool.query(
        `INSERT INTO paper_funded_fact(
           run_id,fact_id,fact_at,priority,sort_key,fact,economic_key,outcome)
         VALUES($1,$2,$3,1,$2,'{}'::jsonb,$2,'{"status":"APPLIED"}'::jsonb)`,
        [delayedFillRunId, laterFactId, "2025-09-11T21:30:00.000Z"],
      );
      const fillOutcome = await pool.query<{
        sequence: number;
        available_at: Date;
      }>(
        `SELECT sequence,available_at FROM funded_decision_outcome
          WHERE run_id=$1 AND observation_id=$2
            AND status IN ('FILLED','PARTIAL_FILL')
          ORDER BY sequence DESC LIMIT 1`,
        [delayedFillRunId, delayedFillObservationId],
      );
      expect(fillOutcome.rows).toHaveLength(1);
      const fillSequence = Number(fillOutcome.rows[0]!.sequence);
      const correction = await new FundedDecisionEvidenceRepository(
        pool,
      ).appendOutcomeVersion({
        runId: delayedFillRunId,
        observationId: delayedFillObservationId,
        status: "FILLED",
        availableAt: fillOutcome.rows[0]!.available_at.toISOString(),
        sourceKind: "HISTORICAL_REPLAY",
        sourceId: `ledger:${delayedFillObservationId}:corrected`,
        reason: null,
        detail: {
          filledFraction: 1,
          filledShares: 100,
          requestedShares: 100,
          averagePrice: 10.02,
          fees: 2,
          slippage: 0.04,
        },
        supersedesSequence: fillSequence,
        sourceFactId: laterFactId,
      });
      expect(correction.sequence).toBeGreaterThan(fillSequence);
      expect(correction.sourceFactId).toBe(laterFactId);
      const correctionBoundary = await pool.query<{
        knowledge_applied_sequence: string;
        knowledge_at: Date;
      }>(
        `SELECT knowledge_applied_sequence,knowledge_at FROM funded_decision_outcome
          WHERE run_id=$1 AND observation_id=$2 AND sequence=$3`,
        [delayedFillRunId, delayedFillObservationId, correction.sequence],
      );
      expect(correctionBoundary.rows[0]!.knowledge_at.toISOString()).toBe(
        "2025-09-11T21:30:00.000Z",
      );
      expect(
        correctionBoundary.rows[0]!.knowledge_at.getTime(),
      ).toBeGreaterThanOrEqual(Date.parse(boundaryAt));

      // The earlier cutoff is byte-identical after the correction: the
      // correction is not selectable there.
      const frozen = await service.materialize(cohort.cohort, cutoff);
      expect(frozen.dataset!.id).toBe(dataset.id);
      expect(frozen.dataset!.datasetDigest).toBe(dataset.datasetDigest);
      expect(frozen.dataset!.membershipDigest).toBe(dataset.membershipDigest);

      // After the correction is recorded, the label binds the correction's
      // own later boundary instead of its earlier economic timestamp.
      const corrected = (
        await store.assembledRowsFor(cohort.cohort.cohortDigest, new Date())
      ).find((row) => row.observationId === delayedFillObservationId);
      expect(corrected?.labels?.terminalOutcomeSequence).toBe(
        correction.sequence,
      );
      expect(corrected?.labels?.economicOutcomeAt).toBe(
        fillOutcome.rows[0]!.available_at.toISOString(),
      );
      expect(corrected?.labels?.knowledge).toEqual({
        provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
        runId: delayedFillRunId,
        sequence: Number(
          correctionBoundary.rows[0]!.knowledge_applied_sequence,
        ),
        at: correctionBoundary.rows[0]!.knowledge_at.toISOString(),
      });

      // Rematerializing the same cutoff reproduces the identical dataset.
      const retry = await service.materialize(cohort.cohort, cutoff);
      expect(retry.dataset!.id).toBe(dataset.id);
      expect(retry.dataset!.datasetDigest).toBe(dataset.datasetDigest);
      expect(retry.dataset!.membershipDigest).toBe(dataset.membershipDigest);
    }, 1_800_000);
  },
);
