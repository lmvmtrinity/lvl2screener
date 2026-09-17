import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { PostgresFundedLedgerStore } from "../src/paper-bot/funded-ledger-repository.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import { FundedOrderService } from "../src/paper-bot/funded-order-service.js";
import { PostgresPaperBotStore } from "../src/paper-bot/paper-bot-repository.js";
import type {
  AssumptionsSnapshot,
  QuoteFact,
  SignalFact,
} from "../src/paper-bot/types.js";
import {
  FundedDecisionEvidenceRepository,
  type FundedDecisionDraft,
  type OutcomeVersionDraft,
} from "../src/paper-bot/funded-decision-evidence-repository.js";
import type { FundedEvidenceQueryable } from "../src/paper-bot/funded-decision-evidence.js";
import {
  decisionContentDigest,
  fundedCohortDigest,
} from "../src/paper-bot/funded-evidence-digest.js";
import type { FundedCohortComponents } from "@tsx-scanner/contracts";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");

const assumptions: AssumptionsSnapshot = {
  positionSize: 1_000,
  slippageBps: 2,
  feePerTrade: 0,
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

const signal: SignalFact = {
  entryReference: 10.02,
  stopReference: 9.8,
  targetReference: 10.6,
  atr14: 0.22,
  signalTimestamp: "2026-09-15T14:28:00.000Z",
};

const quote: QuoteFact = {
  timestamp: "2026-09-15T14:29:59.000Z",
  bid: 10.01,
  ask: 10.03,
  bidSize: 500,
  askSize: 400,
  sizeUnit: "SHARES",
  sizeMultiplier: 1,
  dataStatus: "REALTIME",
  actionable: true,
};

interface Context {
  runId: string;
  accountId: string;
  observationId: string;
  marketId: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
}

function decision(
  context: Context,
  overrides: Partial<{
    decisionAt: string;
    quoteAt: string;
    action: "SUBMIT" | "DECLINE" | "DEFER";
    score: number;
    withQuote: boolean;
  }> = {},
) {
  const decisionAt = overrides.decisionAt ?? "2026-09-15T14:30:00.000Z";
  return {
    marketId: context.marketId,
    currency: context.currency,
    accountId: context.accountId,
    runId: context.runId,
    observationId: context.observationId,
    evidenceSchemaVersion: 2 as const,
    fundedPolicyVersion: "funded-policy-v1",
    executionModelVersion: "paper-execution-v3",
    featureVersion: "features-v1",
    sourceKind: "LIVE_PAPER" as const,
    action: overrides.action ?? ("SUBMIT" as const),
    policyReason: null,
    decisionAt,
    strategyKey: "ORB_STANDARD",
    strategyVersion: "2026-09-01",
    score: overrides.score ?? 82,
    reasonCodes: ["BREAKOUT"],
    requestedCapital: {
      status: "AVAILABLE" as const,
      maximumDebit: 1_500,
      maximumRisk: 250,
    },
    quote:
      overrides.withQuote === false
        ? {
            status: "UNAVAILABLE" as const,
            reason: "No funded quote was retained at decision time",
          }
        : {
            status: "AVAILABLE" as const,
            snapshot: {
              timestamp: overrides.quoteAt ?? quote.timestamp,
              bid: quote.bid,
              ask: quote.ask,
              bidSize: quote.bidSize,
              askSize: quote.askSize,
              sizeUnit: quote.sizeUnit ?? null,
              sizeMultiplier: quote.sizeMultiplier ?? null,
              dataStatus: quote.dataStatus,
              actionable: quote.actionable,
            },
          },
    model: {
      status: "UNAVAILABLE" as const,
      reason: "No signal-model prediction was retained at decision time",
    },
    portfolio: {
      status: "AVAILABLE" as const,
      cash: 10_000,
      reservedCash: 0,
      openRisk: 0,
      reservedRisk: 0,
      positionCount: 0,
      sectorExposure: {},
      dailyPnl: 0,
      entriesAllowed: true,
      cooldownActive: false,
      consecutiveStops: 0,
    },
    context: {
      status: "UNAVAILABLE" as const,
      reason: "No funded context was retained at decision time",
    },
    execution: {
      positionSize: 1_000,
      slippageBps: 2,
      feePerTrade: 0,
      costs: null,
      riskBudget: 250,
      maxNotional: 1_500,
      economics: null,
      stopMethod: "STRUCTURAL" as const,
      atrStopMultiple: 1,
      rewardRiskRatio: null,
      maxQuoteAgeSeconds: 30,
      sessionTimezone: "America/Toronto",
      noonCloseTime: "16:00",
      executionMode: "CAPACITY_CONSTRAINED" as const,
      latencyMs: 0,
      evidenceScope: null,
    },
    sizingContext: null,
    policy: {
      projectionVersion: "funded-cash-v1" as const,
      participation: 0.25,
      impactBps: 0,
      latencyPolicy: "CAPTURED_PER_ORDER" as const,
      portfolio: null,
    },
    signal,
  };
}

const cohort = (context: Context) => ({
  marketId: context.marketId,
  currency: context.currency,
  evidenceSchemaVersion: 2 as const,
  fundedPolicyVersion: "funded-policy-v1",
  portfolioPolicyVersion: "funded-portfolio-v2",
  executionModelVersion: "paper-execution-v3",
  costPolicyVersion: "paper-cost-policy-2026-09-04",
  participationVersion: "participation-v1",
  sourceKind: "LIVE_PAPER" as const,
  featureVersion: "features-v1",
  runtimeVersion: "runtime-v1",
  accountAssumptionDigest: "a".repeat(64),
  signalModelId: null,
  signalModelVersion: null,
});

const draftFor = (
  context: Context,
  overrides: Parameters<typeof decision>[1] = {},
): FundedDecisionDraft => ({
  decision: decision(context, overrides),
  cohort: cohort(context),
});

const outcomeDraft = (
  context: Context,
  overrides: Partial<OutcomeVersionDraft> = {},
): OutcomeVersionDraft => ({
  runId: context.runId,
  observationId: context.observationId,
  status: "FILLED",
  availableAt: "2026-09-15T14:31:00.000Z",
  sourceKind: "LIVE_PAPER",
  sourceId: `buy:${context.observationId}`,
  reason: null,
  detail: {
    filledFraction: 1,
    filledShares: 100,
    requestedShares: 100,
    averagePrice: 10.02,
    fees: 0,
    slippage: 0.01,
  },
  supersedesSequence: null,
  ...overrides,
});

describe.skipIf(!databaseUrl)(
  "funded decision evidence on isolated PostgreSQL",
  () => {
    let pool: Pool;
    let store: PostgresPaperBotStore;
    let ledger: PostgresFundedLedgerStore;
    const repository = () => new FundedDecisionEvidenceRepository(pool);
    const ctx = {} as {
      CA_A: Context;
      CA_B: Context;
      CA_C: Context;
      US_D: Context;
      SQL_G: Context;
      CONC_E: Context;
      CONC_F: Context;
      COHORT_H: Context;
      STRIP_I: Context;
      CAP_J: Context;
      DUP_L: Context;
      NEG_M: Context;
      WORK_N: Context;
    };

    async function seedContext(input: {
      role: string;
      market?: "CA_TSX" | "US_EQUITIES";
      currency?: "CAD" | "USD";
      sessionDate?: string;
    }): Promise<Context> {
      const market = input.market ?? "CA_TSX";
      const currency = input.currency ?? "CAD";
      const accountId = randomUUID();
      const sessionDate = input.sessionDate ?? "2099-06-01";
      const run = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: market,
        sessionDate,
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: `${sessionDate}T21:00:00.000Z`,
        executionModelVersion: "paper-execution-v3",
        assumptions,
      });
      await ledger.ensure(accountId, [
        currency,
        10_000,
        sessionDate,
        `${sessionDate}T14:30:00.000Z`,
        200,
      ]);
      await new PostgresFundedLedgerStore(pool).ensure(accountId, [
        currency,
        10_000,
        sessionDate,
        `${sessionDate}T14:30:00.000Z`,
        200,
      ]);
      const service = new FundedOrderService(pool, run.id, accountId, currency);
      await service.bind(fundedPolicy(0.25, 0, {}), {
        session: sessionDate,
        at: `${sessionDate}T14:30:00.000Z`,
      });
      const instrumentId = randomUUID();
      const symbol = `FP01_${input.role}`;
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
         security_type,industry_sector,is_quotable,is_tradable,active,market_id)
         VALUES($1,$2,$3,'FP01 fixture','TSX',$4,'Stock','Technology',true,true,true,$5)`,
        [
          instrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
          symbol,
          currency,
          market,
        ],
      );
      const definitionId = randomUUID();
      const profileId = randomUUID();
      const configId = randomUUID();
      await pool.query(
        `INSERT INTO strategy_definition(id,strategy_key,version,name,description)
         VALUES($1,$2,'2026-09-01','ORB Standard','FP01 fixture')`,
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
        runId: run.id,
        sourceEventId: randomUUID(),
        sourceSignalId: null,
        setupInstanceId: null,
        instrumentId,
        symbol,
        profileId,
        profileName: "fp01",
        profileConfigId: configId,
        configVersion: "v1",
        profileParameters: {},
        strategyKey: "ORB_STANDARD",
        strategyVersion: "2026-09-01",
        signalTimestamp: "2026-09-15T14:28:00.000Z",
        score: 82,
        entryReference: 10.02,
        stopReference: 9.8,
        targetReference: 10.6,
        atr14: 0.22,
        featureSnapshot: { featureVersion: "1.2.0", configVersion: "v1" },
        reasonCodes: ["BREAKOUT"],
        sourceEventPayload: { signalSemanticsVersion: "setup-semantics-v2" },
        eligibilityStatus: "ELIGIBLE",
        eligibilityReason: null,
      });
      return {
        runId: run.id,
        accountId,
        observationId: inserted.observation.id,
        marketId: market,
        currency,
      };
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
      ctx.CA_A = await seedContext({ role: "CA_A" });
      ctx.CA_B = await seedContext({ role: "CA_B" });
      ctx.CA_C = await seedContext({ role: "CA_C" });
      ctx.US_D = await seedContext({
        role: "US_D",
        market: "US_EQUITIES",
        currency: "USD",
      });
      ctx.SQL_G = await seedContext({ role: "SQL_G" });
      ctx.CONC_E = await seedContext({ role: "CONC_E" });
      ctx.CONC_F = await seedContext({ role: "CONC_F" });
      ctx.COHORT_H = await seedContext({ role: "COHORT_H" });
      ctx.STRIP_I = await seedContext({ role: "STRIP_I" });
      ctx.CAP_J = await seedContext({
        role: "CAP_J",
        sessionDate: "2025-06-01",
      });
      ctx.DUP_L = await seedContext({ role: "DUP_L" });
      ctx.NEG_M = await seedContext({
        role: "NEG_M",
        sessionDate: "2025-06-02",
      });
      ctx.WORK_N = await seedContext({
        role: "WORK_N",
        sessionDate: "2026-09-15",
      });
    }, 120_000);

    afterAll(async () => {
      await pool?.end();
    });

    async function insertSecondObservation(
      context: Context,
      signalTimestamp: string,
    ): Promise<string> {
      const source = await pool.query<{
        instrument_id: string;
        profile_id: string;
        profile_config_id: string;
        symbol: string;
      }>(
        "SELECT instrument_id,profile_id,profile_config_id,symbol FROM paper_signal_observation WHERE id=$1",
        [context.observationId],
      );
      const row = source.rows[0]!;
      const inserted = await store.insertObservation({
        runId: context.runId,
        sourceEventId: randomUUID(),
        sourceSignalId: null,
        setupInstanceId: null,
        instrumentId: row.instrument_id,
        symbol: row.symbol,
        profileId: row.profile_id,
        profileName: "fp01",
        profileConfigId: row.profile_config_id,
        configVersion: "v1",
        profileParameters: {},
        strategyKey: "ORB_STANDARD",
        strategyVersion: "2026-09-01",
        signalTimestamp,
        score: 81,
        entryReference: 10.02,
        stopReference: 9.8,
        targetReference: 10.6,
        atr14: 0.22,
        featureSnapshot: { featureVersion: "1.2.0", configVersion: "v1" },
        reasonCodes: ["BREAKOUT"],
        sourceEventPayload: { signalSemanticsVersion: "setup-semantics-v2" },
        eligibilityStatus: "ELIGIBLE",
        eligibilityReason: null,
      });
      return inserted.observation.id;
    }

    async function insertSignalFact(
      context: Context,
      observationId: string,
      submittedAt: string,
      maximumDebit: number,
      maximumRisk: number,
      outcome: string | null = null,
    ): Promise<void> {
      await pool.query(
        `INSERT INTO paper_funded_fact(
           run_id,fact_id,fact_at,priority,sort_key,fact,economic_key,outcome,processed_at)
         VALUES($1,$2,$3::timestamptz,2,$4,$5::jsonb,$6,$7::jsonb,
                CASE WHEN $7::jsonb IS NULL THEN NULL ELSE now() END)`,
        [
          context.runId,
          `funded-signal:${observationId}`,
          submittedAt,
          observationId,
          JSON.stringify({
            type: "SIGNAL",
            instrumentId: "00000000-0000-4000-8000-000000000003",
            maximumDebit,
            maximumRisk,
            order: {
              orderId: observationId,
              submittedAt,
              expiresAt: new Date(
                Date.parse(submittedAt) + 30 * 60_000,
              ).toISOString(),
              assumptions,
              signal: {
                ...signal,
                signalTimestamp: new Date(
                  Date.parse(submittedAt) - 120_000,
                ).toISOString(),
              },
            },
          }),
          `SIGNAL|${observationId}`,
          outcome === null ? null : JSON.stringify({ status: outcome }),
        ],
      );
    }

    it("retains the exact supplied capital on otherwise identical signals", async () => {
      const secondObservationId = await insertSecondObservation(
        ctx.CAP_J,
        "2026-09-15T14:28:30.000Z",
      );
      await insertSignalFact(
        ctx.CAP_J,
        ctx.CAP_J.observationId,
        "2026-09-15T14:30:00.000Z",
        1_000,
        100,
      );
      await insertSignalFact(
        ctx.CAP_J,
        secondObservationId,
        "2026-09-15T14:30:00.000Z",
        1_200,
        200,
      );
      const first = await repository().captureSignalDecisionInTransaction(
        pool as unknown as FundedEvidenceQueryable,
        ctx.CAP_J.runId,
        ctx.CAP_J.observationId,
      );
      const second = await repository().captureSignalDecisionInTransaction(
        pool as unknown as FundedEvidenceQueryable,
        ctx.CAP_J.runId,
        secondObservationId,
      );
      expect(first.contentDigest).not.toBe(second.contentDigest);
      const stored = await pool.query<{
        observation_id: string;
        decision_content: {
          requestedCapital: unknown;
          evidenceSchemaVersion: number;
        };
      }>(
        "SELECT observation_id,decision_content FROM funded_decision_evidence WHERE run_id=$1 ORDER BY sequence",
        [ctx.CAP_J.runId],
      );
      expect(stored.rows[0]!.decision_content.requestedCapital).toEqual({
        status: "AVAILABLE",
        maximumDebit: 1_000,
        maximumRisk: 100,
      });
      expect(stored.rows[1]!.decision_content.requestedCapital).toEqual({
        status: "AVAILABLE",
        maximumDebit: 1_200,
        maximumRisk: 200,
      });
      for (const row of stored.rows)
        expect(row.decision_content.evidenceSchemaVersion).toBe(2);
    });

    it("rejects a duplicate run-local decision sequence in PostgreSQL", async () => {
      const secondObservationId = await insertSecondObservation(
        ctx.DUP_L,
        "2026-09-15T14:28:30.000Z",
      );
      const digest = "a".repeat(64);
      const insertDecision = (
        observationId: string,
        sequence: number,
      ): Promise<unknown> =>
        pool.query(
          `INSERT INTO funded_decision_evidence(
             run_id,observation_id,sequence,market_id,currency,account_id,
             funded_policy_version,execution_model_version,feature_version,
             source_kind,action,decision_at,content_digest,decision_content,
             cohort_digest,cohort_components,evidence_schema_version)
           VALUES($1,$2,$3,$4,$5,$6,'funded-policy-v1','paper-execution-v3',
                  'features-v1','LIVE_PAPER','SUBMIT',
                  '2026-09-15T14:30:00.000Z',$7,'{}'::jsonb,$7,'{}'::jsonb,2)`,
          [
            ctx.DUP_L.runId,
            observationId,
            sequence,
            ctx.DUP_L.marketId,
            ctx.DUP_L.currency,
            ctx.DUP_L.accountId,
            digest,
          ],
        );
      await insertDecision(ctx.DUP_L.observationId, 7);
      await expect(insertDecision(secondObservationId, 7)).rejects.toThrow(
        /funded_decision_evidence_run_sequence_uq/,
      );
    });

    it("reuses one identity and digest on duplicate retry", async () => {
      const first = await repository().recordDecision(draftFor(ctx.CA_A));
      const retry = await repository().recordDecision(draftFor(ctx.CA_A));
      expect(retry).toEqual(first);
      expect(first.identity.decisionSequence).toBe(1);
      const rows = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM funded_decision_evidence WHERE run_id=$1",
        [ctx.CA_A.runId],
      );
      expect(rows.rows[0]?.count).toBe("1");
    });

    it("recomputes the content digest at the boundary", async () => {
      const draft = draftFor(ctx.CA_A);
      await repository().recordDecision({
        ...draft,
        expectedContentDigest: decisionContentDigest(draft.decision),
      });
      await expect(
        repository().recordDecision({
          ...draft,
          expectedContentDigest: "b".repeat(64),
        }),
      ).rejects.toThrow(/digest/i);
    });

    it("stores cohort components without an embedded digest and proves the digest matches them", async () => {
      const draft = draftFor(ctx.COHORT_H);
      const captured = await repository().recordDecision(draft);
      const stored = await pool.query<{
        cohort_digest: string;
        cohort_components: FundedCohortComponents;
      }>(
        "SELECT cohort_digest,cohort_components FROM funded_decision_evidence WHERE run_id=$1 AND observation_id=$2",
        [ctx.COHORT_H.runId, ctx.COHORT_H.observationId],
      );
      const row = stored.rows[0]!;
      expect(row.cohort_components).not.toHaveProperty("cohortDigest");
      expect(fundedCohortDigest(row.cohort_components)).toBe(row.cohort_digest);
      expect(captured.cohortDigest).toBe(row.cohort_digest);
      // A caller-supplied runtime digest never enters the trusted hash: the
      // stored digest is the digest of the stored components, not of a digest.
      expect(row.cohort_digest).not.toBe(
        fundedCohortDigest({
          ...draft.cohort,
          cohortDigest: row.cohort_digest,
        }),
      );
    });

    it("strips a matching runtime cohort digest and rejects a conflicting one", async () => {
      const draft = draftFor(ctx.STRIP_I);
      const canonical = fundedCohortDigest(draft.cohort);
      const withDigest = {
        ...draft,
        cohort: {
          ...draft.cohort,
          cohortDigest: "b".repeat(64),
        },
      } as unknown as FundedDecisionDraft;
      await expect(repository().recordDecision(withDigest)).rejects.toThrow(
        /cohort digest/i,
      );
      const matched = {
        ...draft,
        cohort: {
          ...draft.cohort,
          cohortDigest: canonical,
        },
      } as unknown as FundedDecisionDraft;
      const captured = await repository().recordDecision(matched);
      expect(captured.cohortDigest).toBe(canonical);
      const stored = await pool.query<{
        cohort_components: FundedCohortComponents;
      }>(
        "SELECT cohort_components FROM funded_decision_evidence WHERE run_id=$1 AND observation_id=$2",
        [ctx.STRIP_I.runId, ctx.STRIP_I.observationId],
      );
      expect(stored.rows[0]?.cohort_components).not.toHaveProperty(
        "cohortDigest",
      );
      expect(fundedCohortDigest(stored.rows[0]!.cohort_components)).toBe(
        canonical,
      );
    });

    it("rejects a conflicting retry for the same observation", async () => {
      // The retry is a valid v2 decision, but its content differs from the
      // already-captured decision for this observation.
      await expect(
        repository().recordDecision(draftFor(ctx.CA_A, { score: 10 })),
      ).rejects.toThrow(/conflicting/i);
    });

    it("allocates monotonic run-local sequences", async () => {
      const first = await repository().recordDecision(draftFor(ctx.CA_B));
      expect(first.identity.decisionSequence).toBe(1);
      const second = await repository().recordDecision(
        draftFor(ctx.US_D, {
          decisionAt: "2026-09-15T14:31:00.000Z",
        }),
      );
      expect(second.identity.decisionSequence).toBe(1);
      const third = await repository().recordDecision(
        draftFor(ctx.CA_C, { decisionAt: "2026-09-15T14:32:00.000Z" }),
      );
      expect(third.identity.decisionSequence).toBe(1);
    });

    it("rejects a decision whose ownership does not match the funded run", async () => {
      const wrongMarket = draftFor(ctx.US_D);
      await expect(
        repository().recordDecision({
          ...wrongMarket,
          decision: {
            ...wrongMarket.decision,
            marketId: "CA_TSX",
            currency: "CAD",
          },
        }),
      ).rejects.toThrow(/ownership|market|currency/i);
      await expect(
        repository().recordDecision(
          draftFor(ctx.CA_A, { decisionAt: "2026-09-15T14:40:00.000Z" }),
        ),
      ).rejects.toThrow(/conflicting/i);
    });

    it("proves ownership with direct SQL foreign keys", async () => {
      const insert = (
        values: [string, string, string, string, string, string],
      ) =>
        pool.query(
          `INSERT INTO funded_decision_evidence(
             run_id,observation_id,sequence,market_id,currency,account_id,
             funded_policy_version,execution_model_version,feature_version,
             source_kind,action,decision_at,content_digest,decision_content,
             cohort_digest,cohort_components)
           VALUES($1,$2,99,$3,$4,$5,'funded-policy-v1','paper-execution-v3',
                  'features-v1','LIVE_PAPER','SUBMIT',
                  '2026-09-15T14:30:00.000Z',$6,'{}'::jsonb,$6,'{}'::jsonb)`,
          values,
        );
      const digest = "a".repeat(64);
      await expect(
        insert([
          ctx.SQL_G.runId,
          ctx.SQL_G.observationId,
          "US_EQUITIES",
          "USD",
          ctx.SQL_G.accountId,
          digest,
        ]),
      ).rejects.toThrow(/funded_decision_evidence_run_id_market_id_fkey/);
      await expect(
        insert([
          ctx.SQL_G.runId,
          ctx.SQL_G.observationId,
          "CA_TSX",
          "USD",
          ctx.SQL_G.accountId,
          digest,
        ]),
      ).rejects.toThrow(/funded_decision_evidence_market_currency_check/);
      await expect(
        insert([
          ctx.SQL_G.runId,
          ctx.SQL_G.observationId,
          "CA_TSX",
          "CAD",
          ctx.US_D.accountId,
          digest,
        ]),
      ).rejects.toThrow(
        /funded_decision_evidence_run_id_account_id_currency_fkey/,
      );
      await expect(
        insert([
          ctx.SQL_G.runId,
          ctx.US_D.observationId,
          "CA_TSX",
          "CAD",
          ctx.SQL_G.accountId,
          digest,
        ]),
      ).rejects.toThrow(/funded_decision_evidence_run_id_observation_id_fkey/);
    });

    it("does not fabricate absence: outcomes require a reason", async () => {
      await expect(
        repository().appendOutcomeVersion(
          outcomeDraft(ctx.CA_A, {
            status: "UNRESOLVED",
            sourceId: `unresolved:${ctx.CA_A.observationId}`,
            reason: null,
            detail: null,
          }),
        ),
      ).rejects.toThrow(/UNRESOLVED|reason/);
    });

    it("appends corrections with provenance and keeps history", async () => {
      const first = await repository().appendOutcomeVersion(
        outcomeDraft(ctx.CA_A),
      );
      expect(first.sequence).toBe(1);
      expect(first.identity.decisionSequence).toBe(1);
      const retry = await repository().appendOutcomeVersion(
        outcomeDraft(ctx.CA_A),
      );
      expect(retry).toEqual(first);
      const correction = await repository().appendOutcomeVersion(
        outcomeDraft(ctx.CA_A, {
          sourceId: `sell:${ctx.CA_A.observationId}`,
          status: "CLOSED",
          availableAt: "2026-09-15T15:00:00.000Z",
          detail: {
            filledFraction: 1,
            realizedNetPnl: 12.5,
            realizedR: 0.05,
          },
          supersedesSequence: 1,
          reason: "CORRECTED_EXIT",
        }),
      );
      expect(correction.sequence).toBe(2);
      expect(correction.supersedesSequence).toBe(1);
      const versions = await repository().listOutcomeVersions({
        runId: ctx.CA_A.runId,
        observationId: ctx.CA_A.observationId,
      });
      expect(versions).toHaveLength(2);
      expect(versions.map((version) => version.sequence)).toEqual([1, 2]);
    });

    it("rejects conflicting outcome source retries", async () => {
      await expect(
        repository().appendOutcomeVersion(
          outcomeDraft(ctx.CA_A, {
            detail: {
              filledFraction: 1,
              filledShares: 50,
              requestedShares: 100,
              averagePrice: 10.02,
              fees: 0,
              slippage: 0.01,
            },
          }),
        ),
      ).rejects.toThrow(/conflicting/i);
    });

    it("runs concurrent decision capture exactly once", async () => {
      const results = await Promise.all([
        repository().recordDecision(draftFor(ctx.CONC_E)),
        repository().recordDecision(draftFor(ctx.CONC_E)),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(results[0]?.identity.decisionSequence).toBe(1);
      const rows = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM funded_decision_evidence WHERE run_id=$1",
        [ctx.CONC_E.runId],
      );
      expect(rows.rows[0]?.count).toBe("1");
    });

    it("runs concurrent distinct decisions with ordered sequences", async () => {
      const secondObservation = await store.insertObservation({
        runId: ctx.CONC_F.runId,
        sourceEventId: randomUUID(),
        sourceSignalId: null,
        setupInstanceId: null,
        instrumentId: (
          await pool.query<{ instrument_id: string }>(
            "SELECT instrument_id FROM paper_signal_observation WHERE id=$1",
            [ctx.CONC_F.observationId],
          )
        ).rows[0]!.instrument_id,
        symbol: `FP01_F2_${ctx.CONC_F.observationId.slice(0, 8)}`,
        profileId: (
          await pool.query<{ profile_id: string }>(
            "SELECT profile_id FROM paper_signal_observation WHERE id=$1",
            [ctx.CONC_F.observationId],
          )
        ).rows[0]!.profile_id,
        profileName: "fp01",
        profileConfigId: (
          await pool.query<{ profile_config_id: string }>(
            "SELECT profile_config_id FROM paper_signal_observation WHERE id=$1",
            [ctx.CONC_F.observationId],
          )
        ).rows[0]!.profile_config_id,
        configVersion: "v1",
        profileParameters: {},
        strategyKey: "ORB_STANDARD",
        strategyVersion: "2026-09-01",
        signalTimestamp: "2026-09-15T14:31:00.000Z",
        score: 80,
        entryReference: 10.02,
        stopReference: 9.8,
        targetReference: 10.6,
        atr14: 0.22,
        featureSnapshot: {},
        reasonCodes: ["BREAKOUT"],
        sourceEventPayload: {},
        eligibilityStatus: "ELIGIBLE",
        eligibilityReason: null,
      });
      const secondContext: Context = {
        ...ctx.CONC_F,
        observationId: secondObservation.observation.id,
      };
      const [first, second] = await Promise.all([
        repository().recordDecision(
          draftFor(ctx.CONC_F, {
            decisionAt: "2026-09-15T14:30:30.000Z",
            quoteAt: "2026-09-15T14:30:29.000Z",
          }),
        ),
        repository().recordDecision(
          draftFor(secondContext, {
            decisionAt: "2026-09-15T14:31:30.000Z",
            quoteAt: "2026-09-15T14:31:29.000Z",
          }),
        ),
      ]);
      expect(
        [
          first.identity.decisionSequence,
          second.identity.decisionSequence,
        ].sort(),
      ).toEqual([1, 2]);
    });

    it("runs concurrent duplicate outcome appends exactly once", async () => {
      const [first, second] = await Promise.all([
        repository().appendOutcomeVersion(
          outcomeDraft(ctx.CA_B, {
            sourceId: `concurrent:${ctx.CA_B.observationId}`,
          }),
        ),
        repository().appendOutcomeVersion(
          outcomeDraft(ctx.CA_B, {
            sourceId: `concurrent:${ctx.CA_B.observationId}`,
          }),
        ),
      ]);
      expect(first).toEqual(second);
      const rows = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM funded_decision_outcome WHERE run_id=$1 AND observation_id=$2",
        [ctx.CA_B.runId, ctx.CA_B.observationId],
      );
      expect(rows.rows[0]?.count).toBe("1");
    });

    it("fails concurrent conflicting retries visibly", async () => {
      const outcome = await Promise.allSettled([
        repository().appendOutcomeVersion(
          outcomeDraft(ctx.CA_B, {
            sourceId: `conflict:${ctx.CA_B.observationId}`,
          }),
        ),
        repository().appendOutcomeVersion(
          outcomeDraft(ctx.CA_B, {
            sourceId: `conflict:${ctx.CA_B.observationId}`,
            status: "PARTIAL_FILL",
            detail: {
              filledFraction: 0.5,
              filledShares: 50,
              requestedShares: 100,
              averagePrice: 10.02,
              fees: 0,
              slippage: 0.01,
            },
          }),
        ),
      ]);
      const rejected = outcome.filter((result) => result.status === "rejected");
      const fulfilled = outcome.filter(
        (result) => result.status === "fulfilled",
      );
      expect(rejected).toHaveLength(1);
      expect(fulfilled).toHaveLength(1);
    });

    it("rejects updates and deletes on both tables", async () => {
      const before = await pool.query<{ decisions: string; outcomes: string }>(
        `SELECT
           (SELECT count(*)::text FROM funded_decision_evidence WHERE run_id=$1) AS decisions,
           (SELECT count(*)::text FROM funded_decision_outcome WHERE run_id=$1) AS outcomes`,
        [ctx.CA_A.runId],
      );
      expect(Number(before.rows[0]?.decisions)).toBeGreaterThan(0);
      expect(Number(before.rows[0]?.outcomes)).toBeGreaterThan(0);
      await expect(
        pool.query(
          "UPDATE funded_decision_evidence SET action='DECLINE' WHERE run_id=$1",
          [ctx.CA_A.runId],
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query(
          "UPDATE funded_decision_outcome SET reason='tampered' WHERE run_id=$1",
          [ctx.CA_A.runId],
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query("DELETE FROM funded_decision_outcome WHERE run_id=$1", [
          ctx.CA_A.runId,
        ]),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query("DELETE FROM funded_decision_evidence WHERE run_id=$1", [
          ctx.CA_A.runId,
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it("refuses to persist an invalid v2 action, reason or capital pairing", async () => {
      const base = draftFor(ctx.NEG_M);
      const invalidDrafts = [
        {
          ...base,
          decision: {
            ...base.decision,
            policyReason: "PRE_SUBMISSION_INVALIDATION",
          },
        },
        {
          ...base,
          decision: {
            ...base.decision,
            requestedCapital: {
              status: "UNAVAILABLE" as const,
              reason: "not supplied",
            },
          },
        },
        {
          ...base,
          decision: { ...base.decision, action: "DECLINE" as const },
        },
        {
          ...base,
          decision: {
            ...base.decision,
            action: "DECLINE" as const,
            policyReason: "PRE_SUBMISSION_INVALIDATION",
          },
        },
        {
          ...base,
          decision: { ...base.decision, action: "DEFER" as const },
        },
        {
          ...base,
          decision: {
            ...base.decision,
            action: "DEFER" as const,
            policyReason: "SIGNAL_VALIDITY_EXPIRED",
          },
        },
      ];
      for (const draft of invalidDrafts) {
        await expect(repository().recordDecision(draft)).rejects.toThrow();
        expect(
          await repository().findDecision(
            ctx.NEG_M.runId,
            ctx.NEG_M.observationId,
          ),
        ).toBeUndefined();
      }
      // The durable intent boundary rejects the same invalid pairings.
      await expect(
        repository().recordDecisionIntent({
          runId: ctx.NEG_M.runId,
          observationId: ctx.NEG_M.observationId,
          action: "DECLINE",
          policyReason: null,
          decisionAt: "2025-06-02T14:30:00.000Z",
        }),
      ).rejects.toThrow(/reason does not match/i);
      await expect(
        repository().recordDecisionIntent({
          runId: ctx.NEG_M.runId,
          observationId: ctx.NEG_M.observationId,
          action: "SUBMIT",
          policyReason: "PRE_SUBMISSION_INVALIDATION",
          decisionAt: "2025-06-02T14:30:00.000Z",
        }),
      ).rejects.toThrow(/reason does not match/i);
      const stored = await pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM funded_decision_evidence WHERE run_id=$1",
        [ctx.NEG_M.runId],
      );
      expect(stored.rows[0]?.count).toBe("0");
    });

    it("keeps the durable refusal source retry-idempotent and immutable", async () => {
      const input = {
        runId: ctx.NEG_M.runId,
        observationId: ctx.NEG_M.observationId,
        action: "DEFER" as const,
        policyReason: "SIGNAL_VALIDITY_EXPIRED",
        decisionAt: "2025-06-02T14:30:00.000Z",
      };
      const first = await repository().ensureDecisionRefusal(input);
      const retry = await repository().ensureDecisionRefusal(input);
      expect(retry).toEqual(first);
      await expect(
        repository().ensureDecisionRefusal({
          ...input,
          policyReason: "SIGNAL_WINDOW_UNPROVABLE",
        }),
      ).rejects.toThrow(/conflicting/i);
      await expect(
        pool.query(
          "UPDATE funded_decision_refusal SET policy_reason='tampered' WHERE run_id=$1",
          [ctx.NEG_M.runId],
        ),
      ).rejects.toThrow(/append-only/);
      await expect(
        pool.query("DELETE FROM funded_decision_refusal WHERE run_id=$1", [
          ctx.NEG_M.runId,
        ]),
      ).rejects.toThrow(/append-only/);
    });

    it("deduplicates and bounds the missing-decision candidate set", async () => {
      const secondObservationId = await insertSecondObservation(
        ctx.WORK_N,
        "2026-09-15T14:28:30.000Z",
      );
      const thirdObservationId = await insertSecondObservation(
        ctx.WORK_N,
        "2026-09-15T14:29:00.000Z",
      );
      // A durable refusal source (also an eligible observation).
      await repository().ensureDecisionRefusal({
        runId: ctx.WORK_N.runId,
        observationId: ctx.WORK_N.observationId,
        action: "DECLINE",
        policyReason: "PRE_SUBMISSION_INVALIDATION",
        decisionAt: "2026-09-15T14:30:00.000Z",
      });
      // A durable intent (also an eligible observation).
      await repository().recordDecisionIntent({
        runId: ctx.WORK_N.runId,
        observationId: secondObservationId,
        action: "DECLINE",
        policyReason: "PRE_SUBMISSION_INVALIDATION",
        decisionAt: "2026-09-15T14:30:30.000Z",
      });
      // A processed SIGNAL fact with a proven reservation.
      const instrument = await pool.query<{ instrument_id: string }>(
        "SELECT instrument_id FROM paper_signal_observation WHERE id=$1",
        [thirdObservationId],
      );
      await new FundedOrderService(
        pool,
        ctx.WORK_N.runId,
        ctx.WORK_N.accountId,
        ctx.WORK_N.currency,
      ).submit(
        instrument.rows[0]!.instrument_id,
        {
          orderId: thirdObservationId,
          signal: {
            ...signal,
            signalTimestamp: "2026-09-15T14:29:00.000Z",
          },
          assumptions,
          submittedAt: "2026-09-15T14:31:00.000Z",
          expiresAt: "2026-09-15T15:00:00.000Z",
        },
        1_000,
        100,
      );
      await insertSignalFact(
        ctx.WORK_N,
        thirdObservationId,
        "2026-09-15T14:31:00.000Z",
        1_000,
        100,
        "APPLIED",
      );

      // One gap per missing decision, not one per backing source.
      expect(await repository().decisionGapCount(ctx.WORK_N.runId)).toBe(3);
      const firstBatch = await repository().repairMissingDecisions(
        ctx.WORK_N.runId,
        1,
      );
      expect(firstBatch).toEqual({ repaired: 1, failed: 0, remaining: 2 });
      expect(
        await repository().findDecision(
          ctx.WORK_N.runId,
          ctx.WORK_N.observationId,
        ),
      ).toBeDefined();
      expect(
        await repository().findDecision(ctx.WORK_N.runId, secondObservationId),
      ).toBeUndefined();
      const secondBatch = await repository().repairMissingDecisions(
        ctx.WORK_N.runId,
        2,
      );
      expect(secondBatch).toEqual({ repaired: 2, failed: 0, remaining: 0 });
      expect(
        await repository().findDecision(ctx.WORK_N.runId, secondObservationId),
      ).toBeDefined();
      expect(
        await repository().findDecision(ctx.WORK_N.runId, thirdObservationId),
      ).toBeDefined();
      expect(await repository().decisionGapCount(ctx.WORK_N.runId)).toBe(0);
    });
  },
);
