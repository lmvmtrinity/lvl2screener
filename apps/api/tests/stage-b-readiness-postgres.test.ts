import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { PostgresPaperBotStore } from "../src/paper-bot/paper-bot-repository.js";
import { PostgresFundedLedgerStore } from "../src/paper-bot/funded-ledger-repository.js";
import { FundedOrderService } from "../src/paper-bot/funded-order-service.js";
import {
  fundedPolicy,
  type FundedPolicy,
} from "../src/paper-bot/funded-policy.js";
import { runStageBReadiness } from "../src/paper-bot/stage-b-readiness.js";
import { isMarketTradingDay } from "../src/universe/market-calendar.js";
import type { AssumptionsSnapshot } from "../src/paper-bot/types.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
const EXECUTION_MODEL = "paper-execution-v7";

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

function tradingDates(
  count: number,
  market: "CA_TSX" | "US_EQUITIES",
  start = "2026-06-01",
): string[] {
  const dates: string[] = [];
  let cursor = new Date(`${start}T00:00:00Z`);
  while (dates.length < count) {
    const iso = cursor.toISOString().slice(0, 10);
    if (isMarketTradingDay(iso, market)) dates.push(iso);
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
}

describe.skipIf(!databaseUrl)(
  "Stage B readiness on isolated PostgreSQL",
  () => {
    let pool: Pool;
    let store: PostgresPaperBotStore;

    async function seedAccount(
      market: "CA_TSX" | "US_EQUITIES",
      accountId = randomUUID(),
    ): Promise<string> {
      const currency = market === "CA_TSX" ? "CAD" : "USD";
      await new PostgresFundedLedgerStore(pool).create(accountId, [
        currency,
        10_000,
        "2026-06-01",
        "2026-06-01T13:30:00Z",
        currency === "CAD" ? 200 : 100,
      ]);
      await pool.query(
        `UPDATE paper_funded_account SET created_at='2026-06-01T07:00:00Z'::timestamptz WHERE id=$1`,
        [accountId],
      );
      return accountId;
    }

    async function seedSession(options: {
      market: "CA_TSX" | "US_EQUITIES";
      accountId: string;
      sessionDate: string;
      netPnl: number;
      policy?: FundedPolicy;
      executionModelVersion?: string;
      startedAt?: string;
      unverifiedEvent?: boolean;
    }): Promise<string> {
      const currency = options.market === "CA_TSX" ? "CAD" : "USD";
      const timezone =
        options.market === "CA_TSX" ? "America/Toronto" : "America/New_York";
      const run = await store.startOrResumeLiveRun({
        source: "LIVE",
        marketId: options.market,
        sessionDate: options.sessionDate,
        sessionTimezone: timezone,
        scheduledCloseAt: `${options.sessionDate}T20:00:00Z`,
        executionModelVersion: options.executionModelVersion ?? EXECUTION_MODEL,
        assumptions,
      });
      if (options.unverifiedEvent) {
        // Inserted before the session rollover so it keeps a lower sequence
        // than the provable boundary while remaining unverified.
        await pool.query(
          `INSERT INTO paper_funded_event(account_id,event_id,event,event_sequence_verified)
           VALUES($1,$2,$3::jsonb,FALSE)`,
          [
            options.accountId,
            `stageb-unverified-${run.id}`,
            JSON.stringify({
              id: `stageb-unverified-${run.id}`,
              at: `${options.sessionDate}T06:00:00Z`,
              currency,
              type: "MARK",
              instrumentId: randomUUID(),
              bid: 10,
            }),
          ],
        );
      }
      await new FundedOrderService(
        pool,
        run.id,
        options.accountId,
        currency,
      ).bind(options.policy ?? fundedPolicy(), {
        session: options.sessionDate,
        at: `${options.sessionDate}T13:30:00Z`,
      });
      // A verified mark exactly at the ledger boundary makes the run-end
      // snapshot cursor provable even for a zero-activity session.
      await new PostgresFundedLedgerStore(pool).apply(options.accountId, [
        {
          id: `stageb-boundary-${run.id}`,
          at: `${options.sessionDate}T13:30:00Z`,
          currency,
          type: "MARK",
          instrumentId: randomUUID(),
          bid: 10,
        },
      ]);
      await pool.query(
        `UPDATE paper_funded_account
         SET state = jsonb_set(jsonb_set(state,'{cash}',to_jsonb($2::numeric)),'{realizedPnl}',to_jsonb($3::numeric))
         WHERE id=$1`,
        [options.accountId, 10_000 + options.netPnl, options.netPnl],
      );
      await store.completeRun(run.id);
      await pool.query(
        `UPDATE paper_bot_run SET started_at=$2::timestamptz, completed_at=$3::timestamptz WHERE id=$1`,
        [
          run.id,
          options.startedAt ?? `${options.sessionDate}T07:00:00Z`,
          `${options.sessionDate}T20:30:00Z`,
        ],
      );
      await pool.query(
        `UPDATE paper_funded_run SET created_at=$2::timestamptz WHERE run_id=$1`,
        [run.id, `${options.sessionDate}T07:00:00Z`],
      );
      await pool.query(
        `UPDATE paper_funded_run_snapshot SET captured_at=$2::timestamptz WHERE run_id=$1`,
        [run.id, `${options.sessionDate}T20:30:00Z`],
      );
      await pool.query(
        `UPDATE paper_funded_event SET recorded_at=$3::timestamptz
         WHERE account_id=$1 AND event->>'type'='SESSION' AND event->>'session'=$2`,
        [
          options.accountId,
          options.sessionDate,
          `${options.sessionDate}T07:00:00Z`,
        ],
      );
      return run.id;
    }

    async function addPendingFact(runId: string, sessionDate: string) {
      await pool.query(
        `INSERT INTO paper_funded_fact(run_id,fact_id,fact_at,priority,sort_key,fact)
         VALUES($1,$2,$3::timestamptz,0,$2,'{"type":"CLOCK"}'::jsonb)`,
        [runId, `stageb-fact-${runId}`, `${sessionDate}T18:00:00Z`],
      );
    }

    async function addOpenOrder(runId: string, sessionDate: string) {
      const instrumentId = randomUUID();
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
         security_type,industry_sector,is_quotable,is_tradable,active,market_id)
         VALUES($1,$2,$3,'stage-b fixture','TSX','CAD','Stock','Technology',true,true,true,'CA_TSX')`,
        [
          instrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
          `STGB_${instrumentId.slice(0, 6)}`,
        ],
      );
      await pool.query(
        `INSERT INTO paper_entry_order(order_id,run_id,instrument_id,submission,state,revision,last_fact_at)
         VALUES($1,$2,$3,'{}'::jsonb,'{"status":"PENDING"}'::jsonb,1,$4::timestamptz)`,
        [
          `stageb-order-${runId}`,
          runId,
          instrumentId,
          `${sessionDate}T18:00:00Z`,
        ],
      );
    }

    const truncateSql = `TRUNCATE
           funded_shadow_label,
           funded_shadow_report,
           funded_shadow_batch_projection,
           funded_shadow_attempt_result,
           funded_shadow_attempt,
           funded_shadow_batch_member,
           funded_shadow_batch,
           funded_shadow_enrollment_transition,
           funded_shadow_enrollment,
           funded_shadow_gate_policy,
           funded_shadow_observer_event,
           funded_execution_prediction,
           funded_execution_challenger,
           funded_execution_dataset_member,
           funded_execution_dataset,
           funded_decision_outcome,
           funded_decision_evidence,
           funded_decision_refusal,
           funded_decision_intent,
           paper_funded_fact,
           paper_funded_event,
           paper_funded_run_snapshot,
           paper_funded_ledger_checkpoint,
           paper_funded_fact_rate_minute,
           paper_entry_order,
           paper_funded_run,
           paper_funded_account,
           paper_signal_observation,
           paper_bot_run,
           scanner_profile_config,
           scanner_profile,
           strategy_definition,
           instrument
         CASCADE`;

    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 8 });
      await migrate(pool);
      await pool.query(truncateSql);
      store = new PostgresPaperBotStore(pool);
    }, 180_000);

    beforeEach(async () => {
      await pool.query(truncateSql);
    });

    afterAll(async () => {
      await pool?.end();
    });

    it("reports applied migrations when the foundation registry trails the schema", async () => {
      const versions = await pool.query<{
        applied: number;
        foundation: number;
      }>(
        `SELECT
           (SELECT max(substring(filename FROM '^([0-9]+)-')::integer)
            FROM schema_migration) AS applied,
           (SELECT max(version) FROM foundation_schema_version) AS foundation`,
      );
      expect(versions.rows[0]!.applied).toBeGreaterThan(
        versions.rows[0]!.foundation,
      );
      const receipt = await runStageBReadiness(pool, { market: "CA_TSX" });
      expect(receipt.schemaVersion).toBe(versions.rows[0]!.applied);
    });

    it("fails closed below 40 eligible sessions without publishing an M_market", async () => {
      const accountId = await seedAccount("CA_TSX");
      const dates = tradingDates(2, "CA_TSX");
      for (const [index, date] of dates.entries())
        await seedSession({
          market: "CA_TSX",
          accountId,
          sessionDate: date,
          netPnl: index === 0 ? 12 : -8,
        });
      const receipt = await runStageBReadiness(pool, {
        market: "CA_TSX",
        asOf: "2026-09-21T00:00:00Z",
      });
      expect(receipt.report.rawSessionCount).toBe(2);
      expect(receipt.report.eligibleSessionCount).toBe(2);
      expect(receipt.report.verdict).toBe("INSUFFICIENT_SESSIONS");
      expect(receipt.report.remainingRequired).toBe(38);
      expect(receipt.report.sdReference).toBeNull();
      expect(receipt.report.mMarketCandidate).toBeNull();
      expect(receipt.report.champion?.accountId).toBe(accountId);
      expect(receipt.report.authorityState).toEqual({
        gatePolicies: 0,
        enrollments: 0,
        attempts: 0,
        reports: 0,
        activeOrEligibleChallengers: 0,
      });
    }, 120_000);

    it("qualifies exactly 40 eligible sessions for review and reproduces the digest", async () => {
      const accountId = await seedAccount("CA_TSX");
      const dates = tradingDates(40, "CA_TSX", "2026-07-02");
      for (const [index, date] of dates.entries())
        await seedSession({
          market: "CA_TSX",
          accountId,
          sessionDate: date,
          netPnl: index % 2 === 0 ? 15 : -9,
        });
      const first = await runStageBReadiness(pool, {
        market: "CA_TSX",
        asOf: "2026-09-21T00:00:00Z",
      });
      const second = await runStageBReadiness(pool, {
        market: "CA_TSX",
        asOf: "2026-09-21T00:00:00Z",
      });
      expect(first.report.eligibleSessionCount).toBe(40);
      expect(first.report.verdict).toBe("READY_FOR_STAGE_B_REVIEW");
      expect(first.report.sdReference).not.toBeNull();
      expect(first.report.mMarketCandidate).toBeCloseTo(
        (first.report.sdReference ?? 0) * 0.25,
        12,
      );
      expect(second.report.manifestDigest).toBe(first.report.manifestDigest);
      expect(second.report.includedSessions).toEqual(
        first.report.includedSessions,
      );
      expect(second.report).toEqual(first.report);
    }, 300_000);

    it("excludes overlap, unresolved backlog, unresolved orders and unverified ordering", async () => {
      const accountId = await seedAccount("CA_TSX");
      const dates = tradingDates(5, "CA_TSX", "2026-08-04");
      const backlogRun = await seedSession({
        market: "CA_TSX",
        accountId,
        sessionDate: dates[0]!,
        netPnl: 5,
      });
      const orderRun = await seedSession({
        market: "CA_TSX",
        accountId,
        sessionDate: dates[1]!,
        netPnl: 5,
      });
      await seedSession({
        market: "CA_TSX",
        accountId,
        sessionDate: dates[2]!,
        netPnl: 5,
      });
      await seedSession({
        market: "CA_TSX",
        accountId,
        sessionDate: dates[3]!,
        netPnl: 5,
        startedAt: `${dates[3]}T06:59:00Z`,
      });
      await seedSession({
        market: "CA_TSX",
        accountId,
        sessionDate: dates[3]!,
        netPnl: 5,
        executionModelVersion: "paper-execution-v6",
      });
      // The unverified event is seeded last: an unverified durable event
      // invalidates every boundary at or after its sequence, exactly as the
      // fail-closed reconstruction rule requires.
      await seedSession({
        market: "CA_TSX",
        accountId,
        sessionDate: dates[4]!,
        netPnl: 5,
        unverifiedEvent: true,
      });
      // Unresolved state is added after every bind: a funded bind refuses a
      // prior run with an open order or pending fact.
      await addPendingFact(backlogRun, dates[0]!);
      await addOpenOrder(orderRun, dates[1]!);
      const receipt = await runStageBReadiness(pool, {
        market: "CA_TSX",
        asOf: "2026-09-21T00:00:00Z",
      });
      expect(receipt.report.rawSessionCount).toBe(6);
      expect(receipt.report.eligibleSessionCount).toBe(2);
      expect(receipt.report.exclusionsByReason.UNRESOLVED_BACKLOG).toBe(1);
      expect(receipt.report.exclusionsByReason.UNRESOLVED_ORDER).toBe(1);
      expect(receipt.report.exclusionsByReason.LEDGER_ORDERING_UNVERIFIED).toBe(
        1,
      );
      expect(receipt.report.exclusionsByReason.OVERLAPPING_SESSION).toBe(1);
      expect(receipt.report.exclusionsByReason.IDENTITY_MISMATCH).toBe(1);
    }, 180_000);

    it("splits the cohort when the execution identity drifts", async () => {
      const accountId = await seedAccount("CA_TSX");
      const dates = tradingDates(3, "CA_TSX", "2026-08-04");
      await seedSession({
        market: "CA_TSX",
        accountId,
        sessionDate: dates[0]!,
        netPnl: 4,
        executionModelVersion: "paper-execution-v6",
      });
      await seedSession({
        market: "CA_TSX",
        accountId,
        sessionDate: dates[1]!,
        netPnl: 4,
      });
      await seedSession({
        market: "CA_TSX",
        accountId,
        sessionDate: dates[2]!,
        netPnl: 4,
      });
      const receipt = await runStageBReadiness(pool, {
        market: "CA_TSX",
        asOf: "2026-09-21T00:00:00Z",
      });
      expect(receipt.report.eligibleSessionCount).toBe(2);
      expect(receipt.report.exclusionsByReason.IDENTITY_MISMATCH).toBe(1);
      expect(
        receipt.report.excludedSessions.find(
          (session) => session.sessionDate === dates[0],
        )?.reasons,
      ).toEqual(["IDENTITY_MISMATCH"]);
    }, 120_000);

    it("isolates markets and currencies and keeps US sessions structurally valid only", async () => {
      const caAccount = await seedAccount("CA_TSX");
      const usAccount = await seedAccount("US_EQUITIES");
      const caDates = tradingDates(1, "CA_TSX", "2026-08-04");
      const usDates = tradingDates(1, "US_EQUITIES", "2026-08-04");
      await seedSession({
        market: "CA_TSX",
        accountId: caAccount,
        sessionDate: caDates[0]!,
        netPnl: 3,
      });
      await seedSession({
        market: "US_EQUITIES",
        accountId: usAccount,
        sessionDate: usDates[0]!,
        netPnl: 3,
      });
      const ca = await runStageBReadiness(pool, {
        market: "CA_TSX",
        asOf: "2026-09-21T00:00:00Z",
      });
      expect(ca.report.currency).toBe("CAD");
      expect(ca.report.rawSessionCount).toBe(1);
      expect(ca.report.eligibleSessionCount).toBe(1);
      const us = await runStageBReadiness(pool, {
        market: "US_EQUITIES",
        asOf: "2026-09-21T00:00:00Z",
      });
      expect(us.report.currency).toBe("USD");
      expect(us.report.rawSessionCount).toBe(1);
      expect(us.report.structuralSessionCount).toBe(1);
      expect(us.report.eligibleSessionCount).toBe(0);
      expect(us.report.verdict).toBe("EVIDENCE_UNAVAILABLE");
      expect(
        us.report.exclusionsByReason.COMMISSIONING_PROVENANCE_UNPROVEN,
      ).toBe(1);
    }, 120_000);

    it("does not let later data change an earlier as-of report", async () => {
      const accountId = await seedAccount("CA_TSX");
      const dates = tradingDates(2, "CA_TSX", "2026-08-04");
      await seedSession({
        market: "CA_TSX",
        accountId,
        sessionDate: dates[0]!,
        netPnl: 6,
      });
      const cutoff = `${dates[1]}T00:00:00Z`;
      const before = await runStageBReadiness(pool, {
        market: "CA_TSX",
        asOf: cutoff,
      });
      await seedSession({
        market: "CA_TSX",
        accountId,
        sessionDate: dates[1]!,
        netPnl: -20,
      });
      const after = await runStageBReadiness(pool, {
        market: "CA_TSX",
        asOf: cutoff,
      });
      expect(after.report).toEqual(before.report);
      expect(after.report.rawSessionCount).toBe(1);
      expect(after.report.eligibleSessionCount).toBe(1);
      const current = await runStageBReadiness(pool, {
        market: "CA_TSX",
        asOf: "2026-09-21T00:00:00Z",
      });
      expect(current.report.rawSessionCount).toBe(2);
      expect(current.report.eligibleSessionCount).toBe(2);
    }, 120_000);

    it("writes nothing, including no Stage B, gate-policy, enrollment, prediction or authority row", async () => {
      const accountId = await seedAccount("CA_TSX");
      const dates = tradingDates(1, "CA_TSX", "2026-10-01");
      await seedSession({
        market: "CA_TSX",
        accountId,
        sessionDate: dates[0]!,
        netPnl: 7,
      });
      const tables = [
        "paper_bot_run",
        "paper_funded_run",
        "paper_funded_account",
        "paper_funded_event",
        "paper_funded_run_snapshot",
        "paper_funded_fact",
        "paper_entry_order",
        "funded_decision_evidence",
        "funded_decision_outcome",
        "funded_shadow_gate_policy",
        "funded_shadow_enrollment",
        "funded_shadow_attempt",
        "funded_shadow_report",
        "funded_execution_prediction",
        "funded_execution_challenger",
      ];
      const counts = async () => {
        const result: Record<string, number> = {};
        for (const table of tables) {
          const row = await pool.query<{ count: string }>(
            `SELECT count(*) AS count FROM ${table}`,
          );
          result[table] = Number(row.rows[0]!.count);
        }
        return result;
      };
      const before = await counts();
      const receipt = await runStageBReadiness(pool, {
        market: "CA_TSX",
        asOf: "2026-09-21T00:00:00Z",
      });
      const after = await counts();
      expect(after).toEqual(before);
      expect(receipt.report.mMarketAuthoritative).toBe(false);
      expect(receipt.report.authorityState.gatePolicies).toBe(0);
      expect(receipt.report.authorityState.enrollments).toBe(0);
      expect(receipt.report.authorityState.attempts).toBe(0);
      expect(receipt.report.authorityState.reports).toBe(0);
      expect(receipt.report.authorityState.activeOrEligibleChallengers).toBe(0);
    }, 120_000);
  },
);
