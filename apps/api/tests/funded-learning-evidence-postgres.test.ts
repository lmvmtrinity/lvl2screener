import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { PostgresFundedLedgerStore } from "../src/paper-bot/funded-ledger-repository.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import { FundedOrderService } from "../src/paper-bot/funded-order-service.js";
import { FundedLiveAdapter } from "../src/paper-bot/funded-live-adapter.js";
import { buildFundedInvalidationEnvelope } from "../src/paper-bot/funded-live-adapter.js";
import { FundedFactAdapter } from "../src/paper-bot/funded-fact-adapter.js";
import { reconstructFundedLedgerAt } from "../src/paper-bot/funded-ledger-repository.js";
import { FundedDecisionEvidenceRepository } from "../src/paper-bot/funded-decision-evidence-repository.js";
import { FundedDecisionOutcomeProjector } from "../src/paper-bot/funded-decision-outcome-projector.js";
import {
  PostgresPaperBotStore,
  type PaperSignalObservation,
} from "../src/paper-bot/paper-bot-repository.js";
import type { AssumptionsSnapshot, QuoteFact } from "../src/paper-bot/types.js";
import {
  fundedDecisionTimeInputSchema,
  type FundedDecisionTimeInput,
} from "@tsx-scanner/contracts";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

const assumptions: AssumptionsSnapshot = {
  positionSize: 1_000,
  slippageBps: 0,
  feePerTrade: 0,
  costs: {
    entryCommission: 0,
    exitCommission: 0,
    estimatedRegulatoryFees: 0,
    slippageBps: 0,
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
};

const scheduledCloseTime = "21:00:00.000Z";

interface Seeded {
  runId: string;
  accountId: string;
  observation: PaperSignalObservation;
  sessionDate: string;
  instrumentId: string;
  startAt: string;
}

interface SeedRunOptions {
  sessionDate: string;
  source?: "LIVE" | "BACKTEST";
}

interface SeedOptions extends SeedRunOptions {
  signalTimestamp?: string;
  profileParameters?: Record<string, unknown>;
  entryReference?: number | null;
  stopReference?: number | null;
  targetReference?: number | null;
  instrumentId?: string;
}

describe.skipIf(!databaseUrl)(
  "funded learning evidence integration on isolated PostgreSQL",
  () => {
    let pool: Pool;
    let store: PostgresPaperBotStore;
    let ledger: PostgresFundedLedgerStore;
    const evidence = () => new FundedDecisionEvidenceRepository(pool);

    async function insertInstrument(): Promise<string> {
      const instrumentId = randomUUID();
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
         security_type,industry_sector,is_quotable,is_tradable,active,market_id)
         VALUES($1,$2,$3,'FP01 integration','TSX','CAD','Stock','Technology',true,true,true,'CA_TSX')`,
        [
          instrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
          `FP01_${instrumentId.slice(0, 8)}`,
        ],
      );
      return instrumentId;
    }

    async function seedRun(options: SeedRunOptions): Promise<{
      runId: string;
      accountId: string;
      sessionDate: string;
      startAt: string;
    }> {
      const { sessionDate } = options;
      const startAt = `${sessionDate}T13:55:00.000Z`;
      const accountId = randomUUID();
      const run = await store.startOrResumeLiveRun({
        source: options.source ?? "LIVE",
        marketId: "CA_TSX",
        sessionDate,
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        executionModelVersion: "paper-execution-v3",
        assumptions,
      });
      await ledger.ensure(accountId, [
        "CAD",
        50_000,
        sessionDate,
        startAt,
        3_000,
      ]);
      await new FundedOrderService(pool, run.id, accountId, "CAD").bind(
        fundedPolicy(0.25, 0, {}),
        { session: sessionDate, at: startAt },
      );
      return { runId: run.id, accountId, sessionDate, startAt };
    }

    async function insertObservation(
      seed: { runId: string; sessionDate: string },
      instrumentId: string,
      options: SeedOptions,
    ): Promise<PaperSignalObservation> {
      const definitionId = randomUUID();
      const profileId = randomUUID();
      const configId = randomUUID();
      await pool.query(
        `INSERT INTO strategy_definition(id,strategy_key,version,name,description)
         VALUES($1,$2,'2026-09-01','ORB Standard','FP01 integration')`,
        [definitionId, `ORB_STANDARD_${definitionId.slice(0, 8)}`],
      );
      await pool.query(
        `INSERT INTO scanner_profile(id,name,strategy_definition_id,enabled,display_order)
         VALUES($1,$2,$3,true,0)`,
        [profileId, `fp01-${profileId.slice(0, 8)}`, definitionId],
      );
      await pool.query(
        `INSERT INTO scanner_profile_config(id,profile_id,config_version,parameters)
         VALUES($1,$2,$3,'{}'::jsonb)`,
        [configId, profileId, `fp01-${configId.slice(0, 8)}`],
      );
      const inserted = await store.insertObservation({
        runId: seed.runId,
        sourceEventId: randomUUID(),
        sourceSignalId: null,
        setupInstanceId: null,
        instrumentId,
        symbol: `FP01_${instrumentId.slice(0, 8)}`,
        profileId,
        profileName: "fp01",
        profileConfigId: configId,
        configVersion: "v1",
        profileParameters: options.profileParameters ?? {
          signalValidityMinutes: 60,
        },
        strategyKey: "ORB_STANDARD",
        strategyVersion: "2026-09-01",
        signalTimestamp:
          options.signalTimestamp ?? `${seed.sessionDate}T14:28:00.000Z`,
        score: 82,
        entryReference:
          options.entryReference === undefined ? 10.02 : options.entryReference,
        stopReference:
          options.stopReference === undefined ? 9.8 : options.stopReference,
        targetReference:
          options.targetReference === undefined
            ? 10.6
            : options.targetReference,
        atr14: 0.22,
        featureSnapshot: { featureVersion: "1.2.0", configVersion: "v1" },
        reasonCodes: ["BREAKOUT"],
        sourceEventPayload: { signalSemanticsVersion: "setup-semantics-v2" },
        eligibilityStatus: "ELIGIBLE",
        eligibilityReason: null,
      });
      return inserted.observation;
    }

    async function seed(options: SeedOptions): Promise<Seeded> {
      const run = await seedRun(options);
      const instrumentId = options.instrumentId ?? (await insertInstrument());
      const observation = await insertObservation(
        { runId: run.runId, sessionDate: options.sessionDate },
        instrumentId,
        options,
      );
      return {
        ...run,
        instrumentId,
        observation,
      };
    }

    async function insertQuoteSnapshot(
      instrumentId: string,
      timestamp: string,
      quote: { bid: number; ask: number; bidSize?: number; askSize?: number },
    ): Promise<void> {
      await pool.query(
        `INSERT INTO quote_snapshot(
           instrument_id,timestamp,bid,ask,bid_size,ask_size,last,last_size,
           day_volume,day_open,day_high,day_low,spread_absolute,spread_pct,
           delay_seconds,is_delayed,is_halted,source)
         VALUES($1,$2,$3,$4,$5,$6,$4,1,0,$3,100,0,$7,0,NULL,false,false,'TEST')`,
        [
          instrumentId,
          timestamp,
          quote.bid,
          quote.ask,
          quote.bidSize ?? 10_000,
          quote.askSize ?? 10_000,
          quote.ask - quote.bid,
        ],
      );
    }

    const quoteFact = (
      instrumentId: string,
      timestamp: string,
      bid: number,
      ask: number,
      sizes: { bidSize?: number; askSize?: number } = {},
    ): QuoteFact & { instrumentId: string } => ({
      instrumentId,
      timestamp,
      bid,
      ask,
      bidSize: sizes.bidSize ?? 10_000,
      askSize: sizes.askSize ?? 10_000,
      sizeUnit: "SHARES",
      sizeMultiplier: 1,
      dataStatus: "REALTIME",
      actionable: true,
    });

    async function decisionContent(
      runId: string,
      observationId: string,
    ): Promise<FundedDecisionTimeInput> {
      const decision = await evidence().findDecision(runId, observationId);
      expect(decision).toBeDefined();
      return fundedDecisionTimeInputSchema.parse(decision!.decision_content);
    }

    async function versions(runId: string, observationId: string) {
      return evidence().listOutcomeVersions({ runId, observationId });
    }

    async function createAdapter(
      seeded: {
        runId: string;
        accountId: string;
        sessionDate: string;
        startAt: string;
      },
      adapterAssumptions: AssumptionsSnapshot = assumptions,
    ): Promise<FundedLiveAdapter> {
      const adapter = new FundedLiveAdapter({
        pool,
        runId: seeded.runId,
        accountId: seeded.accountId,
        currency: "CAD",
        marketId: "CA_TSX",
        assumptions: adapterAssumptions,
        policy: fundedPolicy(0.25, 0, {}),
      });
      await adapter.bind(seeded.sessionDate, seeded.startAt, 50_000, 3_000);
      return adapter;
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 8 });
      await migrate(pool);
      await pool.query(
        `TRUNCATE
           funded_decision_outcome,
           funded_decision_evidence,
           paper_funded_fact,
           paper_funded_event,
           paper_entry_order,
           paper_funded_run,
           paper_funded_account,
           paper_model_prediction_snapshot,
           paper_signal_observation,
           paper_bot_run,
           scanner_profile_config,
           scanner_profile,
           strategy_definition,
           instrument
         CASCADE`,
      );
      store = new PostgresPaperBotStore(pool);
      ledger = new PostgresFundedLedgerStore(pool);
    }, 120_000);

    afterAll(async () => {
      await pool?.end();
    });

    it("captures a submitted signal from durable sources and projects accepted then filled", async () => {
      const sessionDate = "2025-06-01";
      const seeded = await seed({ sessionDate });
      const adapter = await createAdapter(seeded);
      const fillAt = `${sessionDate}T14:31:00.000Z`;
      await insertQuoteSnapshot(seeded.instrumentId, fillAt, {
        bid: 10.01,
        ask: 10.03,
      });
      await adapter.process({
        at: fillAt,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [seeded.observation],
        invalidations: [],
        quotes: [quoteFact(seeded.instrumentId, fillAt, 10.01, 10.03)],
      });
      const content = await decisionContent(
        seeded.runId,
        seeded.observation.id,
      );
      expect(content.action).toBe("SUBMIT");
      expect(content.sourceKind).toBe("LIVE_PAPER");
      expect(content.quote.status).toBe("AVAILABLE");
      const versionsAfter = await versions(seeded.runId, seeded.observation.id);
      expect(versionsAfter.map((version) => version.status)).toEqual([
        "DECISION_ACCEPTED",
        "FILLED",
      ]);
      expect(
        new Set(
          versionsAfter.map(
            (version) => `${version.sourceKind}:${version.sourceId}`,
          ),
        ).size,
      ).toBe(versionsAfter.length);
      // Reprojection is idempotent: no source version is duplicated.
      const projector = new FundedDecisionOutcomeProjector(pool);
      await projector.projectPending(seeded.runId);
      expect(
        (await versions(seeded.runId, seeded.observation.id)).map(
          (version) => version.status,
        ),
      ).toEqual(["DECISION_ACCEPTED", "FILLED"]);
    });

    it("revisits a decision through accepted, pending, filled and closed cycles exactly once", async () => {
      const sessionDate = "2025-06-02";
      const seeded = await seed({ sessionDate });
      const adapter = await createAdapter(seeded);
      const closeAt = `${sessionDate}T${scheduledCloseTime}`;
      await adapter.process({
        at: `${sessionDate}T14:29:00.000Z`,
        sessionDate,
        scheduledCloseAt: closeAt,
        observations: [seeded.observation],
        invalidations: [],
        quotes: [],
      });
      expect(
        (await versions(seeded.runId, seeded.observation.id)).map(
          (version) => version.status,
        ),
      ).toEqual(["DECISION_ACCEPTED"]);
      const orders = () =>
        pool.query<{ status: string }>(
          "SELECT state->>'status' AS status FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
          [seeded.runId, seeded.observation.id],
        );
      expect((await orders()).rows[0]?.status).toBe("PENDING");

      const fillAt = `${sessionDate}T14:31:00.000Z`;
      await insertQuoteSnapshot(seeded.instrumentId, fillAt, {
        bid: 10.01,
        ask: 10.03,
      });
      await adapter.process({
        at: fillAt,
        sessionDate,
        scheduledCloseAt: closeAt,
        observations: [],
        invalidations: [],
        quotes: [quoteFact(seeded.instrumentId, fillAt, 10.01, 10.03)],
      });
      expect((await orders()).rows[0]?.status).toBe("FILLED");
      expect(
        (await versions(seeded.runId, seeded.observation.id)).map(
          (version) => version.status,
        ),
      ).toEqual(["DECISION_ACCEPTED", "FILLED"]);

      const exitAt = `${sessionDate}T14:45:00.000Z`;
      await insertQuoteSnapshot(seeded.instrumentId, exitAt, {
        bid: 10.65,
        ask: 10.66,
      });
      await adapter.process({
        at: exitAt,
        sessionDate,
        scheduledCloseAt: closeAt,
        observations: [],
        invalidations: [],
        quotes: [quoteFact(seeded.instrumentId, exitAt, 10.65, 10.66)],
      });
      const execution = await pool.query<{ status: string }>(
        "SELECT state->'execution'->>'status' AS status FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
        [seeded.runId, seeded.observation.id],
      );
      expect(execution.rows[0]?.status).toBe("CLOSED");
      expect(
        (await versions(seeded.runId, seeded.observation.id)).map(
          (version) => version.status,
        ),
      ).toEqual(["DECISION_ACCEPTED", "FILLED", "CLOSED"]);

      // One more cycle must add nothing.
      await adapter.process({
        at: `${sessionDate}T14:50:00.000Z`,
        sessionDate,
        scheduledCloseAt: closeAt,
        observations: [],
        invalidations: [],
        quotes: [],
      });
      const finalVersions = await versions(seeded.runId, seeded.observation.id);
      expect(finalVersions.map((version) => version.status)).toEqual([
        "DECISION_ACCEPTED",
        "FILLED",
        "CLOSED",
      ]);
      expect(
        finalVersions.filter((version) => version.status === "UNRESOLVED"),
      ).toHaveLength(0);
    });

    it("sees the earlier signal's reservation in a later same-batch decision", async () => {
      const sessionDate = "2025-06-03";
      const first = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:29:31.000Z`,
      });
      const secondInstrument = await insertInstrument();
      const secondObservation = await insertObservation(
        { runId: first.runId, sessionDate },
        secondInstrument,
        {
          sessionDate,
          signalTimestamp: `${sessionDate}T14:29:32.000Z`,
        },
      );
      const adapter = await createAdapter(first);
      await adapter.process({
        at: `${sessionDate}T14:29:30.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [first.observation, secondObservation],
        invalidations: [],
        quotes: [],
      });
      const firstContent = await decisionContent(
        first.runId,
        first.observation.id,
      );
      const secondContent = await decisionContent(
        first.runId,
        secondObservation.id,
      );
      if (
        firstContent.portfolio.status !== "AVAILABLE" ||
        secondContent.portfolio.status !== "AVAILABLE"
      )
        throw new Error("portfolio must be available");
      expect(firstContent.portfolio.reservedCash).toBe(0);
      expect(secondContent.portfolio.reservedCash).toBeGreaterThan(0);
      // Both opportunities have their own decision identity in one run.
      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM funded_decision_evidence WHERE run_id=$1",
        [first.runId],
      );
      expect(count.rows[0]?.count).toBe("2");
    });

    it("captures deferred expired and declined invalidated opportunities", async () => {
      const deferredDate = "2025-07-01";
      const deferred = await seed({
        sessionDate: deferredDate,
        signalTimestamp: `${deferredDate}T14:00:00.000Z`,
        profileParameters: { signalValidityMinutes: 5 },
      });
      const deferredAdapter = await createAdapter(deferred);
      await deferredAdapter.process({
        at: `${deferredDate}T14:30:00.000Z`,
        sessionDate: deferredDate,
        scheduledCloseAt: `${deferredDate}T${scheduledCloseTime}`,
        observations: [deferred.observation],
        invalidations: [],
        quotes: [],
      });
      const deferredContent = await decisionContent(
        deferred.runId,
        deferred.observation.id,
      );
      expect(deferredContent.action).toBe("DEFER");
      expect(deferredContent.policyReason).toBe("SIGNAL_VALIDITY_EXPIRED");
      expect(
        await evidence().findDecisionIntent(
          deferred.runId,
          deferred.observation.id,
        ),
      ).toMatchObject({
        action: "DEFER",
        policyReason: "SIGNAL_VALIDITY_EXPIRED",
      });
      expect(
        (await versions(deferred.runId, deferred.observation.id)).map(
          (version) => version.status,
        ),
      ).toEqual(["POLICY_DEFERRED"]);

      const declinedDate = "2025-07-02";
      const declined = await seed({
        sessionDate: declinedDate,
        signalTimestamp: `${declinedDate}T14:28:00.000Z`,
      });
      const declinedAdapter = await createAdapter(declined);
      await declinedAdapter.process({
        at: `${declinedDate}T14:30:00.000Z`,
        sessionDate: declinedDate,
        scheduledCloseAt: `${declinedDate}T${scheduledCloseTime}`,
        observations: [declined.observation],
        invalidations: [
          {
            eventId: randomUUID(),
            orderId: declined.observation.id,
            at: `${declinedDate}T14:29:30.000Z`,
          },
        ],
        quotes: [],
      });
      const declinedContent = await decisionContent(
        declined.runId,
        declined.observation.id,
      );
      expect(declinedContent.action).toBe("DECLINE");
      expect(declinedContent.policyReason).toBe("PRE_SUBMISSION_INVALIDATION");
      expect(
        await evidence().findDecisionIntent(
          declined.runId,
          declined.observation.id,
        ),
      ).toMatchObject({
        action: "DECLINE",
        policyReason: "PRE_SUBMISSION_INVALIDATION",
      });
      expect(
        (await versions(declined.runId, declined.observation.id)).map(
          (version) => version.status,
        ),
      ).toEqual(["POLICY_DECLINED"]);
      const orders = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM paper_entry_order WHERE run_id=$1",
        [declined.runId],
      );
      expect(orders.rows[0]?.count).toBe("0");
    });

    it("captures retained decision-time quote and model evidence and ignores later values", async () => {
      const sessionDate = "2025-08-01";
      const seeded = await seed({ sessionDate });
      const decisionAt = `${sessionDate}T14:30:00.000Z`;
      await insertQuoteSnapshot(
        seeded.instrumentId,
        `${sessionDate}T14:29:59.000Z`,
        { bid: 10.01, ask: 10.03 },
      );
      // A later quote must not be substituted into the immutable input.
      await insertQuoteSnapshot(
        seeded.instrumentId,
        `${sessionDate}T14:35:00.000Z`,
        { bid: 10.1, ask: 10.12 },
      );
      const modelId = randomUUID();
      await pool.query(
        `INSERT INTO paper_model_prediction_snapshot(
           observation_id,model_id,model_version,strategy_name,input_snapshot,prediction,created_at)
         VALUES($1,$2,'v1','ORB_STANDARD','{"a":1}'::jsonb,
           '{"setupProbability":0.61}'::jsonb,$3)`,
        [seeded.observation.id, modelId, `${sessionDate}T14:29:00.000Z`],
      );
      await pool.query(
        `INSERT INTO paper_model_prediction_snapshot(
           observation_id,model_id,model_version,strategy_name,input_snapshot,prediction,created_at)
         VALUES($1,$2,'v2','ORB_STANDARD','{"a":2}'::jsonb,
           '{"setupProbability":0.99}'::jsonb,$3)`,
        [seeded.observation.id, modelId, `${sessionDate}T14:31:00.000Z`],
      );
      const adapter = await createAdapter(seeded);
      await adapter.process({
        at: decisionAt,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [seeded.observation],
        invalidations: [],
        quotes: [],
      });
      const content = await decisionContent(
        seeded.runId,
        seeded.observation.id,
      );
      expect(content.quote).toMatchObject({
        status: "AVAILABLE",
        snapshot: { timestamp: `${sessionDate}T14:29:59.000Z` },
      });
      expect(content.model).toMatchObject({
        status: "AVAILABLE",
        modelVersion: "v1",
        predictionAt: `${sessionDate}T14:29:00.000Z`,
      });
      const decision = await evidence().findDecision(
        seeded.runId,
        seeded.observation.id,
      );
      expect(decision?.cohort_digest).toMatch(/^[a-f0-9]{64}$/);
    });

    it("projects a signal that expired without any quote as no executable quote", async () => {
      const sessionDate = "2025-09-01";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
        profileParameters: { signalValidityMinutes: 2 },
      });
      const adapter = await createAdapter(seeded);
      await adapter.process({
        at: `${sessionDate}T14:29:30.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [seeded.observation],
        invalidations: [],
        quotes: [],
      });
      await adapter.process({
        at: `${sessionDate}T14:33:00.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [],
        invalidations: [],
        quotes: [],
      });
      expect(
        (await versions(seeded.runId, seeded.observation.id)).map(
          (version) => version.status,
        ),
      ).toEqual(["DECISION_ACCEPTED", "NO_EXECUTABLE_QUOTE"]);
    });

    it("projects a market that stayed open but never filled as expired", async () => {
      const sessionDate = "2025-09-02";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
        profileParameters: { signalValidityMinutes: 8 },
      });
      const adapter = await createAdapter(seeded);
      await adapter.process({
        at: `${sessionDate}T14:29:30.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [seeded.observation],
        invalidations: [],
        quotes: [],
      });
      const quoteAt = `${sessionDate}T14:30:00.000Z`;
      await insertQuoteSnapshot(seeded.instrumentId, quoteAt, {
        bid: 10.01,
        ask: 10.03,
        askSize: 0,
      });
      await adapter.process({
        at: quoteAt,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [],
        invalidations: [],
        quotes: [
          quoteFact(seeded.instrumentId, quoteAt, 10.01, 10.03, { askSize: 0 }),
        ],
      });
      await adapter.process({
        at: `${sessionDate}T14:40:00.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [],
        invalidations: [],
        quotes: [],
      });
      expect(
        (await versions(seeded.runId, seeded.observation.id)).map(
          (version) => version.status,
        ),
      ).toEqual(["DECISION_ACCEPTED", "EXPIRED"]);
    });

    it("keeps a capture fault visible without blocking a quote-driven exit", async () => {
      const sessionDate = "2025-10-01";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
      });
      const adapter = await createAdapter(seeded);
      const fillAt = `${sessionDate}T14:31:00.000Z`;
      await insertQuoteSnapshot(seeded.instrumentId, fillAt, {
        bid: 10.01,
        ask: 10.03,
      });
      await adapter.process({
        at: fillAt,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [seeded.observation],
        invalidations: [],
        quotes: [quoteFact(seeded.instrumentId, fillAt, 10.01, 10.03)],
      });
      // A second opportunity loses its durable observation before the funded
      // drain can capture its decision. Its economics still commit.
      const brokenInstrument = await insertInstrument();
      const broken = await insertObservation(
        { runId: seeded.runId, sessionDate },
        brokenInstrument,
        {
          sessionDate,
          signalTimestamp: `${sessionDate}T14:28:00.000Z`,
        },
      );
      await pool.query("DELETE FROM paper_signal_observation WHERE id=$1", [
        broken.id,
      ]);
      const exitAt = `${sessionDate}T14:45:00.000Z`;
      await insertQuoteSnapshot(seeded.instrumentId, exitAt, {
        bid: 9.7,
        ask: 9.71,
      });
      const result = await adapter.process({
        at: exitAt,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [broken],
        invalidations: [],
        quotes: [quoteFact(seeded.instrumentId, exitAt, 9.7, 9.71)],
      });
      expect(result.captureFailures + result.decisionGaps).toBeGreaterThan(0);
      const execution = await pool.query<{ status: string }>(
        "SELECT state->'execution'->>'status' AS status FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
        [seeded.runId, seeded.observation.id],
      );
      expect(execution.rows[0]?.status).toBe("CLOSED");
      const facts = await pool.query<{ status: string }>(
        `SELECT outcome->>'status' AS status FROM paper_funded_fact
         WHERE run_id=$1 AND fact_id=$2`,
        [seeded.runId, `funded-signal:${broken.id}`],
      );
      // The broken signal is acknowledged exactly once (never replayed into a
      // second economic effect) and its decision gap stays durable/repairable.
      expect(["APPLIED", "RISK_VETO"]).toContain(facts.rows[0]?.status);
      expect(
        await evidence().findDecision(seeded.runId, broken.id),
      ).toBeUndefined();
      expect(await evidence().decisionGapCount(seeded.runId)).toBeGreaterThan(
        0,
      );
    });

    it("repairs a missing decision from durable sources once the observation returns", async () => {
      const sessionDate = "2025-11-01";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
      });
      const adapter = await createAdapter(seeded);
      const brokenInstrument = await insertInstrument();
      const broken = await insertObservation(
        { runId: seeded.runId, sessionDate },
        brokenInstrument,
        {
          sessionDate,
          signalTimestamp: `${sessionDate}T14:28:00.000Z`,
        },
      );
      const brokenRow = await pool.query<{
        profile_id: string;
        profile_config_id: string;
        symbol: string;
      }>(
        "SELECT profile_id,profile_config_id,symbol FROM paper_signal_observation WHERE id=$1",
        [broken.id],
      );
      await pool.query("DELETE FROM paper_signal_observation WHERE id=$1", [
        broken.id,
      ]);
      await adapter.process({
        at: `${sessionDate}T14:30:00.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [seeded.observation, broken],
        invalidations: [],
        quotes: [],
      });
      expect(
        await evidence().findDecision(seeded.runId, broken.id),
      ).toBeUndefined();
      // The durable source returns (as it would after a repaired restore) and
      // the production repair pass reconstructs the decision without
      // repeating any economic effect.
      await pool.query(
        `INSERT INTO paper_signal_observation(
           id,run_id,source_event_id,source_signal_id,setup_instance_id,instrument_id,
           symbol,profile_id,profile_name,profile_config_id,config_version,
           profile_parameters,strategy_key,strategy_version,signal_timestamp,score,
           entry_reference,stop_reference,target_reference,atr_14,feature_snapshot,
           reason_codes,source_event_payload,eligibility_status,eligibility_reason)
         VALUES($1,$2,$3,NULL,NULL,$4,$5,$6,'fp01',$7,'v1','{"signalValidityMinutes":60}'::jsonb,
           'ORB_STANDARD','2026-09-01',$8,82,10.02,9.8,10.6,0.22,
           '{"featureVersion":"1.2.0","configVersion":"v1"}'::jsonb,
           '["BREAKOUT"]'::jsonb,'{"signalSemanticsVersion":"setup-semantics-v2"}'::jsonb,
           'ELIGIBLE',NULL)`,
        [
          broken.id,
          seeded.runId,
          randomUUID(),
          brokenInstrument,
          brokenRow.rows[0]!.symbol,
          brokenRow.rows[0]!.profile_id,
          brokenRow.rows[0]!.profile_config_id,
          `${sessionDate}T14:28:00.000Z`,
        ],
      );
      await adapter.process({
        at: `${sessionDate}T14:35:00.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [],
        invalidations: [],
        quotes: [],
      });
      expect(
        await evidence().findDecision(seeded.runId, broken.id),
      ).toBeDefined();
      expect(await evidence().decisionGapCount(seeded.runId)).toBe(0);
      const snapshot = await adapter.operationalSnapshot(
        `${sessionDate}T14:36:00.000Z`,
      );
      expect(snapshot.evidenceDecisionGapsTotal).toBe(0);
      expect(snapshot.evidenceCaptureFailuresTotal).toBeGreaterThan(0);
    });

    it("projects a deterministic funded risk veto", async () => {
      const sessionDate = "2025-04-01";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
      });
      const adapter = await createAdapter(seeded);
      const fillAt = `${sessionDate}T14:31:00.000Z`;
      await insertQuoteSnapshot(seeded.instrumentId, fillAt, {
        bid: 10.01,
        ask: 10.03,
      });
      await adapter.process({
        at: fillAt,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [seeded.observation],
        invalidations: [],
        quotes: [quoteFact(seeded.instrumentId, fillAt, 10.01, 10.03)],
      });
      // The entry mark ages past the funded mark-age bound; a later signal is
      // refused transactionally and that refusal is retained as an outcome.
      const vetoInstrument = await insertInstrument();
      const vetoed = await insertObservation(
        { runId: seeded.runId, sessionDate },
        vetoInstrument,
        {
          sessionDate,
          signalTimestamp: `${sessionDate}T14:45:00.000Z`,
        },
      );
      await adapter.process({
        at: `${sessionDate}T14:45:00.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [vetoed],
        invalidations: [],
        quotes: [],
      });
      const versionsForVetoed = await versions(seeded.runId, vetoed.id);
      expect(versionsForVetoed.map((version) => version.status)).toEqual([
        "RISK_VETOED",
      ]);
      expect(
        await evidence().findDecision(seeded.runId, vetoed.id),
      ).toBeDefined();
    });

    it("projects a structurally unexecutable entry as no fill", async () => {
      const sessionDate = "2025-04-02";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
        stopReference: null,
      });
      const adapter = await createAdapter(seeded);
      const fillAt = `${sessionDate}T14:31:00.000Z`;
      await insertQuoteSnapshot(seeded.instrumentId, fillAt, {
        bid: 10.01,
        ask: 10.03,
      });
      await adapter.process({
        at: fillAt,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [seeded.observation],
        invalidations: [],
        quotes: [quoteFact(seeded.instrumentId, fillAt, 10.01, 10.03)],
      });
      const order = await pool.query<{ status: string }>(
        "SELECT state->>'status' AS status FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
        [seeded.runId, seeded.observation.id],
      );
      expect(order.rows[0]?.status).toBe("REJECTED");
      expect(
        (await versions(seeded.runId, seeded.observation.id)).map(
          (version) => version.status,
        ),
      ).toEqual(["DECISION_ACCEPTED", "NO_FILL"]);
    });

    it("projects a partial fill from durable order and ledger state", async () => {
      const sessionDate = "2025-04-03";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
      });
      const adapter = await createAdapter(seeded);
      await adapter.process({
        at: `${sessionDate}T14:29:30.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [seeded.observation],
        invalidations: [],
        quotes: [],
      });
      const orderRow = await pool.query<{ state: Record<string, unknown> }>(
        "SELECT state FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
        [seeded.runId, seeded.observation.id],
      );
      const state = orderRow.rows[0]!.state;
      const at = `${sessionDate}T14:31:00.000Z`;
      const filled = 50;
      const partialState = {
        ...state,
        status: "FILLED",
        lastQuoteAt: at,
        execution: {
          status: "OPEN",
          entrySizeCoverage: 0.5,
          lastFactTimestamp: at,
          position: {
            entryPrice: 10.02,
            entryTime: at,
            stop: 9.8,
            target: 10.6,
            shares: filled,
            initialRisk: 11,
            quoteTime: at,
            signalTime: `${sessionDate}T14:28:00.000Z`,
            decisionTime: `${sessionDate}T14:29:30.000Z`,
            fillTime: at,
            latencyMs: 0,
            executionMode: "CAPACITY_CONSTRAINED",
          },
        },
      };
      await pool.query(
        `UPDATE paper_entry_order SET state=$2::jsonb,last_fact_at=$3::timestamptz,
           revision=revision+1,updated_at=now()
         WHERE run_id=$1 AND order_id=$4`,
        [seeded.runId, JSON.stringify(partialState), at, seeded.observation.id],
      );
      await pool.query(
        `INSERT INTO paper_funded_event(account_id,event_id,event,event_sequence_verified)
         VALUES($1,$2,$3::jsonb,TRUE)`,
        [
          seeded.accountId,
          `buy:${seeded.observation.id}`,
          JSON.stringify({
            id: `buy:${seeded.observation.id}`,
            at,
            currency: "CAD",
            type: "BUY",
            orderId: seeded.observation.id,
            positionId: seeded.observation.id,
            instrumentId: seeded.instrumentId,
            shares: filled,
            price: 10.02,
            stop: 9.8,
            fee: 0,
          }),
        ],
      );
      await new FundedDecisionOutcomeProjector(pool).projectPending(
        seeded.runId,
      );
      const partial = (
        await versions(seeded.runId, seeded.observation.id)
      ).find((version) => version.status === "PARTIAL_FILL");
      expect(partial).toBeDefined();
      expect(partial?.detail).toMatchObject({
        filledFraction: 0.5,
        filledShares: 50,
        requestedShares: 100,
      });
    });

    it("keeps an outstanding evidence gap visible while a prior-run recovery drain closes exposure", async () => {
      const sessionDate = "2025-03-01";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
      });
      const adapter = await createAdapter(seeded);
      const fillAt = `${sessionDate}T14:31:00.000Z`;
      await insertQuoteSnapshot(seeded.instrumentId, fillAt, {
        bid: 10.01,
        ask: 10.03,
      });
      await adapter.process({
        at: fillAt,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [seeded.observation],
        invalidations: [],
        quotes: [quoteFact(seeded.instrumentId, fillAt, 10.01, 10.03)],
      });
      const brokenInstrument = await insertInstrument();
      const broken = await insertObservation(
        { runId: seeded.runId, sessionDate },
        brokenInstrument,
        {
          sessionDate,
          signalTimestamp: `${sessionDate}T14:32:00.000Z`,
        },
      );
      await pool.query("DELETE FROM paper_signal_observation WHERE id=$1", [
        broken.id,
      ]);
      await adapter.process({
        at: `${sessionDate}T14:40:00.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [broken],
        invalidations: [],
        quotes: [],
      });
      expect(await evidence().decisionGapCount(seeded.runId)).toBeGreaterThan(
        0,
      );
      // Wall-clock settlement marks the earlier run close-pending before its
      // inbox catches up; the recovery drain must still close the exposure.
      await pool.query(
        "UPDATE paper_bot_run SET status='CLOSE_PENDING' WHERE id=$1",
        [seeded.runId],
      );
      const closeAt = `${sessionDate}T${scheduledCloseTime}`;
      await insertQuoteSnapshot(seeded.instrumentId, closeAt, {
        bid: 10.65,
        ask: 10.66,
      });
      await adapter.process({
        at: closeAt,
        sessionDate,
        scheduledCloseAt: closeAt,
        observations: [],
        invalidations: [],
        quotes: [quoteFact(seeded.instrumentId, closeAt, 10.65, 10.66)],
      });
      const execution = await pool.query<{ status: string }>(
        "SELECT state->'execution'->>'status' AS status FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
        [seeded.runId, seeded.observation.id],
      );
      expect(execution.rows[0]?.status).toBe("CLOSED");
      const snapshot = await adapter.operationalSnapshot(
        `${sessionDate}T21:01:00.000Z`,
      );
      expect(snapshot.evidenceDecisionGapsTotal).toBeGreaterThan(0);
    });

    it("does not let an evidence fault block scheduled-close settlement", async () => {
      const sessionDate = "2025-12-01";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
        profileParameters: { signalValidityMinutes: 520 },
      });
      const adapter = await createAdapter(seeded);
      await adapter.process({
        at: `${sessionDate}T14:29:30.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [seeded.observation],
        invalidations: [],
        quotes: [],
      });
      const brokenInstrument = await insertInstrument();
      const broken = await insertObservation(
        { runId: seeded.runId, sessionDate },
        brokenInstrument,
        {
          sessionDate,
          signalTimestamp: `${sessionDate}T14:30:00.000Z`,
        },
      );
      await pool.query("DELETE FROM paper_signal_observation WHERE id=$1", [
        broken.id,
      ]);
      await adapter.process({
        at: `${sessionDate}T14:35:00.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [broken],
        invalidations: [],
        quotes: [],
      });
      const before = await pool.query<{ status: string }>(
        "SELECT state->>'status' AS status FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
        [seeded.runId, seeded.observation.id],
      );
      expect(before.rows[0]?.status).toBe("PENDING");
      // The close-cycle clock settles the pending order even though the
      // evidence gap is still outstanding.
      await adapter.process({
        at: `${sessionDate}T${scheduledCloseTime}`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [],
        invalidations: [],
        quotes: [],
      });
      const after = await pool.query<{ status: string; reason: string }>(
        "SELECT state->>'status' AS status,state->>'reason' AS reason FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
        [seeded.runId, seeded.observation.id],
      );
      expect(after.rows[0]).toMatchObject({
        status: "CANCELLED",
        reason: "SESSION_CLOSED",
      });
      const snapshot = await adapter.operationalSnapshot(
        `${sessionDate}T14:40:00.000Z`,
      );
      expect(snapshot.evidenceDecisionGapsTotal).toBeGreaterThan(0);
    });

    async function seedSameTimestampPair(
      sessionDate: string,
      submittedAt: string,
      secondSignalTimestamp: string,
    ): Promise<Seeded & { secondObservation: PaperSignalObservation }> {
      const first = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
      });
      const secondInstrument = await insertInstrument();
      const second = await insertObservation(
        { runId: first.runId, sessionDate },
        secondInstrument,
        { sessionDate, signalTimestamp: secondSignalTimestamp },
      );
      // Both submissions share the decision timestamp. Their observations are
      // temporarily unavailable, so neither decision can be captured while the
      // reservations and durable facts still commit; the gaps stay visible and
      // repairable.
      await pool.query(
        "DELETE FROM paper_signal_observation WHERE id=ANY($1::uuid[])",
        [[first.observation.id, second.id]],
      );
      const adapter = await createAdapter(first);
      await adapter.process({
        at: submittedAt,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [first.observation, second],
        invalidations: [],
        quotes: [],
      });
      // Observations are immutable: the durable rows return as new inserts with
      // the same identities (as after a restored database).
      await restoreObservation(first.observation);
      await restoreObservation(second);
      return { ...first, secondObservation: second };
    }

    async function restoreObservation(
      observation: PaperSignalObservation,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO paper_signal_observation(
           id,run_id,source_event_id,source_signal_id,setup_instance_id,instrument_id,
           symbol,profile_id,profile_name,profile_config_id,config_version,
           profile_parameters,strategy_key,strategy_version,signal_timestamp,score,
           entry_reference,stop_reference,target_reference,atr_14,feature_snapshot,
           reason_codes,source_event_payload,eligibility_status,eligibility_reason)
         VALUES($1,$2,$3,NULL,NULL,$4,$5,$6,$7,$8,'v1',$9::jsonb,$10,$11,$12,$13,
                $14,$15,$16,$17,$18::jsonb,$19::jsonb,$20::jsonb,$21,$22)`,
        [
          observation.id,
          observation.runId,
          observation.sourceEventId,
          observation.instrumentId,
          observation.symbol,
          observation.profileId,
          observation.profileName,
          observation.profileConfigId,
          JSON.stringify(observation.profileParameters),
          observation.strategyKey,
          observation.strategyVersion,
          observation.signalTimestamp,
          observation.score,
          observation.entryReference,
          observation.stopReference,
          observation.targetReference,
          observation.atr14,
          JSON.stringify(observation.featureSnapshot),
          JSON.stringify(observation.reasonCodes),
          JSON.stringify(observation.sourceEventPayload),
          observation.eligibilityStatus,
          observation.eligibilityReason,
        ],
      );
    }

    interface SameTimestampDecisions {
      firstObservationId: string;
      secondObservationId: string;
      firstContent: FundedDecisionTimeInput;
      secondContent: FundedDecisionTimeInput;
    }

    async function repairSameTimestampPair(
      seeded: Seeded & { secondObservation: PaperSignalObservation },
    ): Promise<SameTimestampDecisions> {
      const observationIds = [
        seeded.observation.id,
        seeded.secondObservation.id,
      ];
      const repaired = await evidence().repairMissingDecisions(seeded.runId);
      expect(repaired.repaired).toBe(2);
      expect(repaired.remaining).toBe(0);
      const reserves = await pool.query<{
        observationId: string;
        event_sequence: string;
      }>(
        `SELECT substring(event_id from 9) AS "observationId",event_sequence
           FROM paper_funded_event
          WHERE account_id=$1 AND event_id=ANY($2::text[])
          ORDER BY event_sequence`,
        [seeded.accountId, observationIds.map((id) => `reserve:${id}`)],
      );
      expect(reserves.rows).toHaveLength(2);
      const [firstReserve, secondReserve] = reserves.rows;
      const firstContent = await decisionContent(
        seeded.runId,
        firstReserve!.observationId,
      );
      const secondContent = await decisionContent(
        seeded.runId,
        secondReserve!.observationId,
      );
      expect(firstContent.evidenceSchemaVersion).toBe(2);
      expect(firstContent.requestedCapital).toEqual({
        status: "AVAILABLE",
        maximumDebit: 1_000,
        maximumRisk: 250,
      });
      if (
        firstContent.portfolio.status !== "AVAILABLE" ||
        secondContent.portfolio.status !== "AVAILABLE"
      )
        throw new Error("portfolio must be available");
      // The earlier reservation is strictly before the later same-timestamp
      // one: its snapshot excludes the later reservation, while the later
      // decision sees the earlier committed one.
      expect(firstContent.portfolio.reservedCash).toBe(0);
      expect(secondContent.portfolio.reservedCash).toBeGreaterThan(0);
      return {
        firstObservationId: firstReserve!.observationId,
        secondObservationId: secondReserve!.observationId,
        firstContent,
        secondContent,
      };
    }

    it("repairs a failed same-timestamp capture strictly before the later reservation", async () => {
      const sessionDate = "2025-05-02";
      const submittedAt = `${sessionDate}T14:30:00.000Z`;
      const seeded = await seedSameTimestampPair(
        sessionDate,
        submittedAt,
        `${sessionDate}T14:28:30.000Z`,
      );
      // The capture fault is visible and no decision exists yet; the facts and
      // orders committed regardless.
      expect(
        await evidence().findDecision(seeded.runId, seeded.observation.id),
      ).toBeUndefined();
      expect(await evidence().decisionGapCount(seeded.runId)).toBeGreaterThan(
        0,
      );
      const repaired = await repairSameTimestampPair(seeded);
      // The repair proves the boundary from the earlier reservation, so the
      // durable gap closes without a pre-existing intent cursor.
      // One decision per observation, each with the exact supplied capital.
      const count = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM funded_decision_evidence WHERE run_id=$1",
        [seeded.runId],
      );
      expect(count.rows[0]?.count).toBe("2");
      expect(await evidence().decisionGapCount(seeded.runId)).toBe(0);
      expect(repaired.firstObservationId).not.toBe(
        repaired.secondObservationId,
      );
    });

    it("keeps the strict boundary through a usable ledger checkpoint", async () => {
      const sessionDate = "2025-05-03";
      const submittedAt = `${sessionDate}T14:30:00.000Z`;
      const seeded = await seedSameTimestampPair(
        sessionDate,
        submittedAt,
        `${sessionDate}T14:28:30.000Z`,
      );
      const reserves = await pool.query<{
        observationId: string;
        event_sequence: string;
      }>(
        `SELECT substring(event_id from 9) AS "observationId",event_sequence
           FROM paper_funded_event
          WHERE account_id=$1 AND event_id=ANY($2::text[])
          ORDER BY event_sequence`,
        [
          seeded.accountId,
          [
            `reserve:${seeded.observation.id}`,
            `reserve:${seeded.secondObservation.id}`,
          ],
        ],
      );
      const firstReserve = reserves.rows[0]!;
      const firstSequence = Number(firstReserve.event_sequence);
      // A real periodic checkpoint anchored at the earlier proven boundary is
      // selected by the repair reconstruction; the same bound must still hold.
      const anchor = await reconstructFundedLedgerAt(
        pool,
        seeded.accountId,
        submittedAt,
        { maxEventSequence: firstSequence - 1 },
      );
      await pool.query(
        `INSERT INTO paper_funded_ledger_checkpoint(
           account_id,event_sequence,boundary_at,kind,state)
         VALUES($1,$2,$3,'PERIODIC',$4::jsonb)
         ON CONFLICT (account_id,event_sequence) DO NOTHING`,
        [
          seeded.accountId,
          firstSequence - 1,
          anchor.ledger.lastEventAt,
          JSON.stringify(anchor.ledger),
        ],
      );
      const repaired = await repairSameTimestampPair(seeded);
      expect(repaired.firstObservationId).toBe(firstReserve.observationId);
      await new FundedDecisionOutcomeProjector(pool).projectPending(
        seeded.runId,
      );
      expect(await evidence().projectionGapCount(seeded.runId)).toBe(0);
    });

    it("repairs a failed live refusal from its durable intent after restart", async () => {
      const sessionDate = "2025-05-05";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
      });
      const decisionAt = `${sessionDate}T14:29:30.000Z`;
      // The live capture writes this durable intent before its best-effort
      // projection. The projection is lost (process restart) and the repair
      // must reproduce the exact action, reason, timestamp and content.
      const intent = await evidence().recordDecisionIntent({
        runId: seeded.runId,
        observationId: seeded.observation.id,
        action: "DEFER",
        policyReason: "SIGNAL_VALIDITY_EXPIRED",
        decisionAt,
      });
      expect(intent).toMatchObject({
        action: "DEFER",
        policyReason: "SIGNAL_VALIDITY_EXPIRED",
      });
      expect(
        await evidence().findDecision(seeded.runId, seeded.observation.id),
      ).toBeUndefined();
      expect(await evidence().decisionGapCount(seeded.runId)).toBeGreaterThan(
        0,
      );
      const restarted = await createAdapter(seeded);
      await restarted.process({
        at: `${sessionDate}T14:30:00.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [],
        invalidations: [],
        quotes: [],
      });
      const content = await decisionContent(
        seeded.runId,
        seeded.observation.id,
      );
      expect(content.action).toBe("DEFER");
      expect(content.policyReason).toBe("SIGNAL_VALIDITY_EXPIRED");
      expect(Date.parse(content.decisionAt)).toBe(
        Date.parse(intent.decisionAt),
      );
      const captured = await evidence().findDecision(
        seeded.runId,
        seeded.observation.id,
      );
      await evidence().repairMissingDecisions(seeded.runId);
      const afterRetry = await evidence().findDecision(
        seeded.runId,
        seeded.observation.id,
      );
      expect(afterRetry!.content_digest).toBe(captured!.content_digest);
      expect(afterRetry!.sequence).toBe(captured!.sequence);
      expect(await evidence().decisionGapCount(seeded.runId)).toBe(0);

      // The same restart guarantee holds for a live DECLINE refusal.
      const declinedDate = "2025-05-07";
      const declined = await seed({
        sessionDate: declinedDate,
        signalTimestamp: `${declinedDate}T14:28:00.000Z`,
      });
      const declineAt = `${declinedDate}T14:29:30.000Z`;
      const declineIntent = await evidence().recordDecisionIntent({
        runId: declined.runId,
        observationId: declined.observation.id,
        action: "DECLINE",
        policyReason: "PRE_SUBMISSION_INVALIDATION",
        decisionAt: declineAt,
      });
      expect(
        await evidence().findDecision(declined.runId, declined.observation.id),
      ).toBeUndefined();
      const declinedRestart = await createAdapter(declined);
      await declinedRestart.process({
        at: `${declinedDate}T14:30:00.000Z`,
        sessionDate: declinedDate,
        scheduledCloseAt: `${declinedDate}T${scheduledCloseTime}`,
        observations: [],
        invalidations: [],
        quotes: [],
      });
      const declinedContent = await decisionContent(
        declined.runId,
        declined.observation.id,
      );
      expect(declinedContent.action).toBe("DECLINE");
      expect(declinedContent.policyReason).toBe("PRE_SUBMISSION_INVALIDATION");
      expect(Date.parse(declinedContent.decisionAt)).toBe(
        Date.parse(declineIntent.decisionAt),
      );
      expect(
        (await versions(declined.runId, declined.observation.id)).map(
          (version) => version.status,
        ),
      ).toEqual(["POLICY_DECLINED"]);
      expect(await evidence().projectionGapCount(declined.runId)).toBe(0);
    });

    it("keeps the durable decision intent immutable and retry-idempotent", async () => {
      const sessionDate = "2025-05-08";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
      });
      const input = {
        runId: seeded.runId,
        observationId: seeded.observation.id,
        action: "DEFER" as const,
        policyReason: "SIGNAL_VALIDITY_EXPIRED",
        decisionAt: `${sessionDate}T14:29:00.000Z`,
      };
      const first = await evidence().recordDecisionIntent(input);
      const retry = await evidence().recordDecisionIntent(input);
      expect(retry).toEqual(first);
      await expect(
        evidence().recordDecisionIntent({
          ...input,
          policyReason: "SIGNAL_WINDOW_UNPROVABLE",
        }),
      ).rejects.toThrow(/conflicting/i);
      await expect(
        evidence().recordDecisionIntent({
          ...input,
          action: "SUBMIT",
          policyReason: null,
        }),
      ).rejects.toThrow(/conflicting/i);
      await expect(
        pool.query(
          "UPDATE funded_decision_intent SET policy_reason='tampered' WHERE run_id=$1",
          [seeded.runId],
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query("DELETE FROM funded_decision_intent WHERE run_id=$1", [
          seeded.runId,
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it("projects partial exits without a gap and exactly one terminal close", async () => {
      const sessionDate = "2025-05-06";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
      });
      const adapter = await createAdapter(seeded);
      await adapter.process({
        at: `${sessionDate}T14:29:30.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [seeded.observation],
        invalidations: [],
        quotes: [],
      });
      const entryAt = `${sessionDate}T14:31:00.000Z`;
      const orderRow = await pool.query<{ state: Record<string, unknown> }>(
        "SELECT state FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
        [seeded.runId, seeded.observation.id],
      );
      const filled = 100;
      const position = {
        entryPrice: 10.02,
        entryTime: entryAt,
        stop: 9.8,
        target: 10.6,
        shares: filled,
        initialRisk: 22,
        quoteTime: entryAt,
        signalTime: `${sessionDate}T14:28:00.000Z`,
        decisionTime: `${sessionDate}T14:29:30.000Z`,
        fillTime: entryAt,
        latencyMs: 0,
        executionMode: "CAPACITY_CONSTRAINED",
      };
      const writeOrder = async (
        executionStatus: "OPEN" | "CLOSE_PENDING" | "CLOSED",
        shares: number,
      ) => {
        await pool.query(
          `UPDATE paper_entry_order SET state=$2::jsonb,last_fact_at=$3::timestamptz,
             revision=revision+1,updated_at=now()
           WHERE run_id=$1 AND order_id=$4`,
          [
            seeded.runId,
            JSON.stringify({
              ...orderRow.rows[0]!.state,
              status: "FILLED",
              lastQuoteAt: entryAt,
              execution: {
                status: executionStatus,
                entrySizeCoverage: 1,
                lastFactTimestamp: entryAt,
                position: { ...position, shares },
              },
            }),
            entryAt,
            seeded.observation.id,
          ],
        );
      };
      const insertLedgerEvent = async (
        id: string,
        at: string,
        event: Record<string, unknown>,
      ) =>
        pool.query(
          `INSERT INTO paper_funded_event(account_id,event_id,event,event_sequence_verified)
           VALUES($1,$2,$3::jsonb,TRUE)`,
          [seeded.accountId, id, JSON.stringify(event)],
        );
      await insertLedgerEvent(`buy:${seeded.observation.id}`, entryAt, {
        id: `buy:${seeded.observation.id}`,
        at: entryAt,
        currency: "CAD",
        type: "BUY",
        orderId: seeded.observation.id,
        positionId: seeded.observation.id,
        instrumentId: seeded.instrumentId,
        shares: filled,
        price: 10.02,
        stop: 9.8,
        fee: 0,
      });
      const firstExitAt = `${sessionDate}T14:32:00.000Z`;
      await insertLedgerEvent("sell:partial-1", firstExitAt, {
        id: "sell:partial-1",
        at: firstExitAt,
        currency: "CAD",
        type: "SELL",
        positionId: seeded.observation.id,
        shares: 40,
        price: 10.3,
        fee: 0,
      });
      await writeOrder("CLOSE_PENDING", 60);
      const projector = new FundedDecisionOutcomeProjector(pool);
      await projector.projectPending(seeded.runId);
      expect(await evidence().projectionGapCount(seeded.runId)).toBe(0);
      expect(
        (await versions(seeded.runId, seeded.observation.id)).map(
          (version) => version.status,
        ),
      ).toEqual(["DECISION_ACCEPTED", "FILLED"]);
      const finalExitAt = `${sessionDate}T14:33:00.000Z`;
      await insertLedgerEvent("sell:final-1", finalExitAt, {
        id: "sell:final-1",
        at: finalExitAt,
        currency: "CAD",
        type: "SELL",
        positionId: seeded.observation.id,
        shares: 60,
        price: 10.4,
        fee: 0,
      });
      await writeOrder("CLOSED", 0);
      await projector.projectPending(seeded.runId);
      const closed = (
        await versions(seeded.runId, seeded.observation.id)
      ).filter((version) => version.status === "CLOSED");
      expect(closed).toHaveLength(1);
      expect(closed[0]!.sourceId).toBe("ledger:sell:final-1");
      expect(closed[0]!.detail).toMatchObject({
        realizedNetPnl:
          Math.round(((10.3 - 10.02) * 40 + (10.4 - 10.02) * 60) * 10_000) /
          10_000,
      });
      expect(await evidence().projectionGapCount(seeded.runId)).toBe(0);
      // Reprojection is idempotent: no second terminal version.
      await projector.projectPending(seeded.runId);
      expect(
        (await versions(seeded.runId, seeded.observation.id)).filter(
          (version) => version.status === "CLOSED",
        ),
      ).toHaveLength(1);
      expect(await evidence().projectionGapCount(seeded.runId)).toBe(0);
    });

    async function denyIntentInserts(): Promise<void> {
      await pool.query(
        "ALTER TABLE funded_decision_intent RENAME TO funded_decision_intent_r4_offline",
      );
    }

    async function restoreIntentInserts(): Promise<void> {
      await pool.query(
        "ALTER TABLE funded_decision_intent_r4_offline RENAME TO funded_decision_intent",
      );
    }

    interface RefusalFailureScenario {
      sessionDate: string;
      signalTimestamp: string;
      profileParameters?: Record<string, unknown>;
      at: string;
      invalidations?: readonly {
        eventId: string;
        orderId: string;
        at: string;
      }[];
      adapterAssumptions?: AssumptionsSnapshot;
      expected: {
        action: "DECLINE" | "DEFER";
        policyReason: string;
        decisionAt: string;
      };
    }

    async function expectRefusalRestartRepair(
      scenario: RefusalFailureScenario,
    ): Promise<void> {
      const seeded = await seed({
        sessionDate: scenario.sessionDate,
        signalTimestamp: scenario.signalTimestamp,
        profileParameters: scenario.profileParameters,
      });
      const adapter = await createAdapter(seeded, scenario.adapterAssumptions);
      await denyIntentInserts();
      let failureResult: Awaited<ReturnType<FundedLiveAdapter["process"]>>;
      try {
        failureResult = await adapter.process({
          at: scenario.at,
          sessionDate: scenario.sessionDate,
          scheduledCloseAt: `${scenario.sessionDate}T${scheduledCloseTime}`,
          observations: [seeded.observation],
          invalidations: [...(scenario.invalidations ?? [])],
          quotes: [],
        });
      } finally {
        await restoreIntentInserts();
      }
      expect(
        failureResult.captureFailures + failureResult.decisionGaps,
      ).toBeGreaterThan(0);
      // The cycle's durable input committed atomically with the refusal source.
      const clock = await pool.query<{ status: string }>(
        "SELECT outcome->>'status' AS status FROM paper_funded_fact WHERE run_id=$1 AND fact_id=$2",
        [seeded.runId, `funded-clock:${scenario.at}`],
      );
      expect(clock.rows[0]?.status).toBe("APPLIED");
      const refusal = await pool.query<{
        sequence_cursor: string;
        action: string;
        policy_reason: string;
        decision_at: Date | string;
      }>(
        "SELECT sequence_cursor,action,policy_reason,decision_at FROM funded_decision_refusal WHERE run_id=$1 AND observation_id=$2",
        [seeded.runId, seeded.observation.id],
      );
      expect(refusal.rows).toHaveLength(1);
      expect(refusal.rows[0]).toMatchObject({
        action: scenario.expected.action,
        policy_reason: scenario.expected.policyReason,
      });
      expect(Date.parse(String(refusal.rows[0]!.decision_at))).toBe(
        Date.parse(scenario.expected.decisionAt),
      );
      const expectedSuppressionFactId = scenario.invalidations?.length
        ? `funded-invalidation:${scenario.invalidations[0]!.eventId}`
        : `funded-invalidation:stale-signal:${seeded.observation.id}`;
      if (scenario.expected.policyReason !== "SIGNAL_NOT_EXECUTABLE") {
        const suppression = await pool.query<{ status: string }>(
          "SELECT outcome->>'status' AS status FROM paper_funded_fact WHERE run_id=$1 AND fact_id=$2",
          [seeded.runId, expectedSuppressionFactId],
        );
        expect(suppression.rows[0]?.status).toBe("PRE_SUBMISSION_SUPPRESSED");
      }
      expect(
        await evidence().findDecision(seeded.runId, seeded.observation.id),
      ).toBeUndefined();
      expect(await evidence().decisionGapCount(seeded.runId)).toBeGreaterThan(
        0,
      );
      // Restart: repair discovers the durable refusal source without the
      // observation being supplied again in the cycle input.
      const restarted = await createAdapter(
        seeded,
        scenario.adapterAssumptions,
      );
      await restarted.process({
        at: `${scenario.sessionDate}T15:00:00.000Z`,
        sessionDate: scenario.sessionDate,
        scheduledCloseAt: `${scenario.sessionDate}T${scheduledCloseTime}`,
        observations: [],
        invalidations: [],
        quotes: [],
      });
      const content = await decisionContent(
        seeded.runId,
        seeded.observation.id,
      );
      expect(content.action).toBe(scenario.expected.action);
      expect(content.policyReason).toBe(scenario.expected.policyReason);
      expect(Date.parse(content.decisionAt)).toBe(
        Date.parse(scenario.expected.decisionAt),
      );
      expect(content.requestedCapital.status).toBe("UNAVAILABLE");
      const decision = await evidence().findDecision(
        seeded.runId,
        seeded.observation.id,
      );
      expect(decision?.sequence).toBe(1);
      const intent = await pool.query<{ sequence_cursor: string }>(
        "SELECT sequence_cursor FROM funded_decision_intent WHERE run_id=$1 AND observation_id=$2",
        [seeded.runId, seeded.observation.id],
      );
      expect(intent.rows).toHaveLength(1);
      expect(Number(intent.rows[0]!.sequence_cursor)).toBe(
        Number(refusal.rows[0]!.sequence_cursor),
      );
      expect(
        (await versions(seeded.runId, seeded.observation.id)).map(
          (version) => version.status,
        ),
      ).toEqual([
        scenario.expected.action === "DECLINE"
          ? "POLICY_DECLINED"
          : "POLICY_DEFERRED",
      ]);
      expect(await evidence().decisionGapCount(seeded.runId)).toBe(0);
    }

    it("repairs a DEFER refusal whose intent insert failed before restart", async () => {
      const sessionDate = "2025-11-03";
      await expectRefusalRestartRepair({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:00:00.000Z`,
        profileParameters: { signalValidityMinutes: 5 },
        at: `${sessionDate}T14:30:00.000Z`,
        expected: {
          action: "DEFER",
          policyReason: "SIGNAL_VALIDITY_EXPIRED",
          decisionAt: `${sessionDate}T14:05:00.000Z`,
        },
      });
    });

    it("repairs a SIGNAL_NOT_EXECUTABLE refusal whose intent insert failed before restart", async () => {
      const sessionDate = "2025-11-04";
      await expectRefusalRestartRepair({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
        at: `${sessionDate}T14:30:00.000Z`,
        // Modeled latency cannot release the submission before expiry.
        adapterAssumptions: { ...assumptions, latencyMs: 7_200_000 },
        expected: {
          action: "DECLINE",
          policyReason: "SIGNAL_NOT_EXECUTABLE",
          decisionAt: `${sessionDate}T14:30:00.000Z`,
        },
      });
    });

    it("commits cancellation and an unrelated exit while a refusal awaits repair", async () => {
      const sessionDate = "2025-11-05";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
      });
      const bInstrument = await insertInstrument();
      const b = await insertObservation(
        { runId: seeded.runId, sessionDate },
        bInstrument,
        { sessionDate, signalTimestamp: `${sessionDate}T14:28:30.000Z` },
      );
      const adapter = await createAdapter(seeded);
      const fillAt = `${sessionDate}T14:29:00.000Z`;
      await insertQuoteSnapshot(seeded.instrumentId, fillAt, {
        bid: 10.01,
        ask: 10.03,
      });
      await adapter.process({
        at: fillAt,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [seeded.observation],
        invalidations: [],
        quotes: [quoteFact(seeded.instrumentId, fillAt, 10.01, 10.03)],
      });
      const filled = await pool.query<{ status: string }>(
        "SELECT state->>'status' AS status FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
        [seeded.runId, seeded.observation.id],
      );
      expect(filled.rows[0]?.status).toBe("FILLED");

      const invalidation = {
        eventId: randomUUID(),
        orderId: b.id,
        at: `${sessionDate}T14:29:30.000Z`,
      };
      const exitAt = `${sessionDate}T14:30:00.000Z`;
      await insertQuoteSnapshot(seeded.instrumentId, exitAt, {
        bid: 9.7,
        ask: 9.71,
      });
      await denyIntentInserts();
      let failureResult: Awaited<ReturnType<FundedLiveAdapter["process"]>>;
      try {
        failureResult = await adapter.process({
          at: exitAt,
          sessionDate,
          scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
          observations: [b],
          invalidations: [invalidation],
          quotes: [quoteFact(seeded.instrumentId, exitAt, 9.7, 9.71)],
        });
      } finally {
        await restoreIntentInserts();
      }
      expect(
        failureResult.captureFailures + failureResult.decisionGaps,
      ).toBeGreaterThan(0);
      // The suppression and the unrelated exit both committed.
      const suppression = await pool.query<{ status: string }>(
        "SELECT outcome->>'status' AS status FROM paper_funded_fact WHERE run_id=$1 AND fact_id=$2",
        [seeded.runId, `funded-invalidation:${invalidation.eventId}`],
      );
      expect(suppression.rows[0]?.status).toBe("PRE_SUBMISSION_SUPPRESSED");
      const closed = await pool.query<{ status: string }>(
        "SELECT state->'execution'->>'status' AS status FROM paper_entry_order WHERE run_id=$1 AND order_id=$2",
        [seeded.runId, seeded.observation.id],
      );
      expect(closed.rows[0]?.status).toBe("CLOSED");
      expect(await evidence().findDecision(seeded.runId, b.id)).toBeUndefined();
      const refusal = await pool.query<{
        sequence_cursor: string;
        action: string;
        policy_reason: string;
        decision_at: Date | string;
      }>(
        "SELECT sequence_cursor,action,policy_reason,decision_at FROM funded_decision_refusal WHERE run_id=$1 AND observation_id=$2",
        [seeded.runId, b.id],
      );
      expect(refusal.rows).toHaveLength(1);
      expect(refusal.rows[0]).toMatchObject({
        action: "DECLINE",
        policy_reason: "PRE_SUBMISSION_INVALIDATION",
      });

      const restarted = await createAdapter(seeded);
      await restarted.process({
        at: `${sessionDate}T15:00:00.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [],
        invalidations: [],
        quotes: [],
      });
      const content = await decisionContent(seeded.runId, b.id);
      expect(content.action).toBe("DECLINE");
      expect(content.policyReason).toBe("PRE_SUBMISSION_INVALIDATION");
      expect(Date.parse(content.decisionAt)).toBe(Date.parse(invalidation.at));
      const intent = await pool.query<{ sequence_cursor: string }>(
        "SELECT sequence_cursor FROM funded_decision_intent WHERE run_id=$1 AND observation_id=$2",
        [seeded.runId, b.id],
      );
      expect(Number(intent.rows[0]!.sequence_cursor)).toBe(
        Number(refusal.rows[0]!.sequence_cursor),
      );
      expect(
        (await versions(seeded.runId, b.id)).map((version) => version.status),
      ).toEqual(["POLICY_DECLINED"]);
      expect(await evidence().decisionGapCount(seeded.runId)).toBe(0);
    });

    it("does not fabricate a refusal for a pre-submission cancel without a durable request", async () => {
      const sessionDate = "2025-11-07";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
      });
      const invalidation = {
        eventId: randomUUID(),
        orderId: seeded.observation.id,
        at: `${sessionDate}T14:29:00.000Z`,
      };
      const envelope = buildFundedInvalidationEnvelope(invalidation, true);
      expect(envelope).toBeDefined();
      const inbox = new FundedFactAdapter(pool, seeded.runId);
      await inbox.enqueue([envelope!]);
      await inbox.drain(undefined, { repository: evidence() });
      const suppression = await pool.query<{ status: string }>(
        "SELECT outcome->>'status' AS status FROM paper_funded_fact WHERE run_id=$1 AND fact_id=$2",
        [seeded.runId, `funded-invalidation:${invalidation.eventId}`],
      );
      expect(suppression.rows[0]?.status).toBe("PRE_SUBMISSION_SUPPRESSED");
      // The drain must not translate a suppression CANCEL into an invented
      // refusal when no durable request exists.
      const refusals = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM funded_decision_refusal WHERE run_id=$1",
        [seeded.runId],
      );
      expect(refusals.rows[0]?.count).toBe("0");
      expect(
        await evidence().findDecision(seeded.runId, seeded.observation.id),
      ).toBeUndefined();
    });

    it("commits the durable refusal source atomically with the cycle input", async () => {
      const sessionDate = "2025-11-08";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:28:00.000Z`,
      });
      await evidence().ensureDecisionRefusal({
        runId: seeded.runId,
        observationId: seeded.observation.id,
        action: "DEFER",
        policyReason: "SIGNAL_VALIDITY_EXPIRED",
        decisionAt: `${sessionDate}T14:05:00.000Z`,
      });
      const invalidation = {
        eventId: randomUUID(),
        orderId: seeded.observation.id,
        at: `${sessionDate}T14:29:00.000Z`,
      };
      const clock = {
        id: `funded-clock:${sessionDate}T14:30:00.000Z`,
        fact: {
          type: "CLOCK" as const,
          at: `${sessionDate}T14:30:00.000Z`,
        },
      };
      const inbox = new FundedFactAdapter(pool, seeded.runId);
      // A conflicting refusal request fails the whole cycle transaction, so
      // the refusal source and the durable cycle input cannot diverge.
      await expect(
        inbox.enqueue(
          [clock, buildFundedInvalidationEnvelope(invalidation, true)!],
          {
            repository: evidence(),
            refusalRequests: [
              {
                observationId: seeded.observation.id,
                action: "DECLINE",
                policyReason: "PRE_SUBMISSION_INVALIDATION",
                decisionAt: `${sessionDate}T14:29:00.000Z`,
              },
            ],
          },
        ),
      ).rejects.toThrow(/conflicting/i);
      const facts = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM paper_funded_fact WHERE run_id=$1",
        [seeded.runId],
      );
      expect(facts.rows[0]?.count).toBe("0");
      expect(
        await evidence().findDecisionRefusal(
          seeded.runId,
          seeded.observation.id,
        ),
      ).toMatchObject({
        action: "DEFER",
        policyReason: "SIGNAL_VALIDITY_EXPIRED",
      });
    });

    it("projects a live DEFER source with its exact reason and rejects conflicts", async () => {
      const sessionDate = "2025-11-09";
      const seeded = await seed({
        sessionDate,
        signalTimestamp: `${sessionDate}T14:00:00.000Z`,
        profileParameters: { signalValidityMinutes: 5 },
      });
      const adapter = await createAdapter(seeded);
      await adapter.process({
        at: `${sessionDate}T14:30:00.000Z`,
        sessionDate,
        scheduledCloseAt: `${sessionDate}T${scheduledCloseTime}`,
        observations: [seeded.observation],
        invalidations: [],
        quotes: [],
      });
      const content = await decisionContent(
        seeded.runId,
        seeded.observation.id,
      );
      expect(content.action).toBe("DEFER");
      expect(content.policyReason).toBe("SIGNAL_VALIDITY_EXPIRED");
      // The suppression CANCEL was projected from the durable DEFER source,
      // never from the pre-submission decline constant.
      const declines = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM funded_decision_refusal WHERE run_id=$1 AND action='DECLINE'",
        [seeded.runId],
      );
      expect(declines.rows[0]?.count).toBe("0");
      const suppression = await pool.query<{ status: string }>(
        "SELECT outcome->>'status' AS status FROM paper_funded_fact WHERE run_id=$1 AND fact_id=$2",
        [
          seeded.runId,
          `funded-invalidation:stale-signal:${seeded.observation.id}`,
        ],
      );
      expect(suppression.rows[0]?.status).toBe("PRE_SUBMISSION_SUPPRESSED");
      const decision = await evidence().findDecision(
        seeded.runId,
        seeded.observation.id,
      );
      expect(decision?.sequence).toBe(1);
      // A conflicting retry is visible and cannot create a second sequence.
      await expect(
        evidence().ensureDecisionRefusal({
          runId: seeded.runId,
          observationId: seeded.observation.id,
          action: "DECLINE",
          policyReason: "PRE_SUBMISSION_INVALIDATION",
          decisionAt: content.decisionAt,
        }),
      ).rejects.toThrow(/conflicting/i);
      const decisions = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM funded_decision_evidence WHERE run_id=$1",
        [seeded.runId],
      );
      expect(decisions.rows[0]?.count).toBe("1");
      expect(await evidence().decisionGapCount(seeded.runId)).toBe(0);
    });
  },
);
