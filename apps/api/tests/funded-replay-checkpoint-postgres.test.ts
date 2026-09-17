import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import {
  FUNDED_SNAPSHOT_EVENT_LIMIT,
  PostgresFundedLedgerStore,
  replayFundedLedgerAt,
  reconstructFundedLedgerAt,
  type FundedReconstructionObservation,
} from "../src/paper-bot/funded-ledger-repository.js";
import {
  applyLedgerEvent,
  createFundedLedger,
  type FundedLedger,
  type LedgerEvent,
} from "../src/paper-bot/funded-ledger.js";
import { fundedAccountStateEvidence } from "../src/paper-bot/funded-decision-evidence.js";
import { FundedReportingService } from "../src/paper-bot/funded-reporting-service.js";
import { FundedReconstructionMetricsRegistry } from "../src/paper-bot/funded-reconstruction-observability.js";
import { FundedOrderService } from "../src/paper-bot/funded-order-service.js";
import { PostgresPaperBotStore } from "../src/paper-bot/paper-bot-repository.js";
import { FundedDecisionEvidenceRepository } from "../src/paper-bot/funded-decision-evidence-repository.js";
import type { AssumptionsSnapshot } from "../src/paper-bot/types.js";

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

const AUTHORITATIVE_EXECUTION_MODEL_VERSION = "paper-execution-v3";

/** One account's durable event stream exactly as the legacy full replay read it. */
async function durableEvents(pool: Pool, accountId: string, at: string) {
  const rows = await pool.query<{ event: LedgerEvent }>(
    `SELECT event FROM paper_funded_event
     WHERE account_id=$1 AND (event->>'at')::timestamptz <= $2::timestamptz
     ORDER BY event_sequence`,
    [accountId, at],
  );
  return rows.rows.map((row) => row.event);
}

async function accountInitialState(
  pool: Pool,
  accountId: string,
): Promise<FundedLedger> {
  const rows = await pool.query<{ initial_state: FundedLedger }>(
    "SELECT initial_state FROM paper_funded_account WHERE id=$1",
    [accountId],
  );
  return rows.rows[0]!.initial_state;
}

describe.skipIf(!databaseUrl)(
  "funded ledger reconstruction checkpoints on isolated PostgreSQL",
  () => {
    let pool: Pool;
    let store: PostgresPaperBotStore;

    /**
     * One account with a completed first run (whose snapshot has a provable
     * cursor) and a still-running second session that submits at 14:31:00 and
     * fills at 14:31:01, so the reconstruction boundary can sit between the
     * reservation and its fill.
     */
    async function seedCheckpointAccount(): Promise<{
      accountId: string;
      firstRunId: string;
      secondRunId: string;
    }> {
      const accountId = randomUUID();
      const sessionDate = "2026-09-08";
      const firstRun = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate,
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: `${sessionDate}T21:00:00Z`,
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const ledgerStore = new PostgresFundedLedgerStore(pool);
      // The account is provisioned one day earlier so the first run's bind
      // actually rolls the session and writes a durable SESSION event; a
      // bind to the provisioning session itself is a no-op.
      await ledgerStore.create(accountId, [
        "CAD",
        2_000,
        "2026-09-07",
        "2026-09-07T14:30:00Z",
        500,
      ]);
      const service = new FundedOrderService(
        pool,
        firstRun.id,
        accountId,
        "CAD",
      );
      await service.bind(undefined, {
        session: sessionDate,
        at: `${sessionDate}T14:30:00Z`,
      });
      await store.completeRun(firstRun.id);

      const secondRun = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2026-09-09",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2026-09-09T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const secondService = new FundedOrderService(
        pool,
        secondRun.id,
        accountId,
        "CAD",
      );
      await secondService.bind(undefined, {
        session: "2026-09-09",
        at: "2026-09-09T14:30:00Z",
      });
      const instrumentId = randomUUID();
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
         security_type,industry_sector,is_quotable,is_tradable,active,market_id)
         VALUES($1,$2,$3,'checkpoint fixture','TSX','CAD','Stock','Technology',true,true,true,'CA_TSX')`,
        [
          instrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
          `RCP_${accountId.slice(0, 6)}`,
        ],
      );
      const submittedAt = "2026-09-09T14:31:00Z";
      await secondService.submit(
        instrumentId,
        {
          orderId: randomUUID(),
          signal: {
            entryReference: 10.02,
            stopReference: 9.8,
            targetReference: 10.6,
            atr14: 0.22,
            signalTimestamp: submittedAt,
          },
          assumptions,
          submittedAt,
          expiresAt: "2026-09-09T14:35:00Z",
        },
        1_200,
        100,
      );
      await secondService.quote(
        instrumentId,
        {
          timestamp: "2026-09-09T14:31:01Z",
          bid: 10.01,
          ask: 10.03,
          bidSize: 500,
          askSize: 400,
          sizeUnit: "SHARES",
          sizeMultiplier: 1,
          dataStatus: "REALTIME",
          actionable: true,
        },
        1,
        0,
      );
      return { accountId, firstRunId: firstRun.id, secondRunId: secondRun.id };
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
    }, 120_000);

    afterAll(async () => {
      await pool?.end();
    });

    it("maintains checkpoint and inbox-rate counters for mixed-version writers", async () => {
      const run = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2026-09-06",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2026-09-06T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const accountId = randomUUID();
      await new PostgresFundedLedgerStore(pool).create(accountId, [
        "CAD",
        2_000,
        "2026-09-05",
        "2026-09-05T14:30:00Z",
        500,
      ]);
      await new FundedOrderService(pool, run.id, accountId, "CAD").bind(
        undefined,
        { session: "2026-09-06", at: "2026-09-06T14:30:00Z" },
      );
      await pool.query(
        `INSERT INTO paper_funded_event(
           account_id,event_id,event,event_sequence_verified
         ) VALUES($1,'old-writer-mark',$2::jsonb,TRUE)`,
        [
          accountId,
          JSON.stringify({
            id: "old-writer-mark",
            at: "2026-09-06T14:31:00Z",
            currency: "CAD",
            type: "MARK",
            instrumentId: randomUUID(),
            bid: 10,
          }),
        ],
      );
      const counter = await pool.query<{ events_since_checkpoint: string }>(
        `SELECT events_since_checkpoint
         FROM paper_funded_account WHERE id=$1`,
        [accountId],
      );
      expect(Number(counter.rows[0]?.events_since_checkpoint)).toBe(1);

      await pool.query(
        `INSERT INTO paper_funded_fact(
           run_id,fact_id,fact_at,priority,sort_key,fact
         ) VALUES($1,'old-writer-fact',now(),0,'old-writer-fact',$2::jsonb)`,
        [
          run.id,
          JSON.stringify({ type: "CLOCK", at: new Date().toISOString() }),
        ],
      );
      await pool.query(
        `UPDATE paper_funded_fact
         SET processed_at=now(),outcome='{"status":"PROCESSED"}'::jsonb
         WHERE run_id=$1 AND fact_id='old-writer-fact'`,
        [run.id],
      );
      const rates = await pool.query<{
        enqueued: string;
        processed: string;
      }>(
        `SELECT sum(enqueued_count) AS enqueued,
                sum(processed_count) AS processed
         FROM paper_funded_fact_rate_minute WHERE run_id=$1`,
        [run.id],
      );
      expect(Number(rates.rows[0]?.enqueued)).toBe(1);
      expect(Number(rates.rows[0]?.processed)).toBe(1);
    });

    it("records a provable boundary cursor when the run settles", async () => {
      const { accountId, firstRunId } = await seedCheckpointAccount();
      const snapshot = await pool.query<{
        boundary_event_sequence: number | null;
        boundary_at: Date | string;
      }>(
        "SELECT boundary_event_sequence,boundary_at FROM paper_funded_run_snapshot WHERE run_id=$1",
        [firstRunId],
      );
      const row = snapshot.rows[0]!;
      expect(new Date(row.boundary_at).toISOString()).toBe(
        "2026-09-08T14:30:00.000Z",
      );
      expect(Number(row.boundary_event_sequence)).toBeGreaterThan(0);
      const sequenceRow = await pool.query<{
        event_sequence: number | string;
      }>(
        "SELECT event_sequence FROM paper_funded_event WHERE account_id=$1 AND (event->>'at')::timestamptz <= $2::timestamptz",
        [accountId, new Date(row.boundary_at).toISOString()],
      );
      expect(Number(sequenceRow.rows.at(-1)!.event_sequence)).toBe(
        Number(row.boundary_event_sequence),
      );
    });

    it("reconstructs byte-identical state from the run snapshot as the full replay", async () => {
      const { accountId, firstRunId } = await seedCheckpointAccount();
      // Force the completed-run snapshot source: the live bind also writes
      // generic run-start anchors, and this assertion covers the snapshot
      // selection path specifically.
      await pool.query(
        "DELETE FROM paper_funded_ledger_checkpoint WHERE account_id=$1",
        [accountId],
      );
      const at = "2026-09-09T14:31:01Z";
      const initial = await accountInitialState(pool, accountId);
      const durable = await durableEvents(pool, accountId, at);
      const full = replayFundedLedgerAt(initial, durable, at);
      const observations: FundedReconstructionObservation[] = [];
      const reconstruction = await reconstructFundedLedgerAt(
        pool,
        accountId,
        at,
        { onReconstruction: (observation) => observations.push(observation) },
      );
      expect(reconstruction.checkpoint?.runId).toBe(firstRunId);
      // Only the events after the checkpoint's anchor were replayed.
      expect(reconstruction.replayedEventCount).toBe(durable.length - 1);
      expect(reconstruction.pages).toBe(1);
      expect(observations).toHaveLength(1);
      expect(observations[0]).toMatchObject({
        outcome: "CHECKPOINTED",
        replayedEventCount: durable.length - 1,
        pages: 1,
        checkpointRunId: firstRunId,
        checkpointBoundaryAt: "2026-09-08T14:30:00.000Z",
        checkpointAgeMs: 86_461_000,
      });
      expect(Object.keys(reconstruction.ledger.positions)).toHaveLength(1);
      for (const key of [
        "version",
        "currency",
        "cash",
        "session",
        "openingEquity",
        "dailyLossLimit",
        "realizedPnl",
        "positions",
        "reservations",
        "lastEventAt",
      ] as const)
        expect(reconstruction.ledger[key]).toStrictEqual(full[key]);
      expect(
        fundedAccountStateEvidence(reconstruction.ledger, at, {
          cooldownActive: false,
          consecutiveStops: 0,
        }),
      ).toStrictEqual(
        fundedAccountStateEvidence(full, at, {
          cooldownActive: false,
          consecutiveStops: 0,
        }),
      );
    });

    it("applies same-timestamp events in durable sequence order", async () => {
      // Seeded directly because the durable primitive's contract is to trust
      // the database's sequence order; a reserve and its fill share one
      // timestamp and only their sequences separate them. A timestamp-ordered
      // tie that applied the BUY first would fail with "Fill exceeds funded
      // reservation".
      const accountId = randomUUID();
      const initial = createFundedLedger(
        "CAD",
        2_000,
        "2026-09-10",
        "2026-09-10T14:30:00.000Z",
        500,
      );
      await pool.query(
        `INSERT INTO paper_funded_account(id,initial_state,state)
         VALUES($1,$2::jsonb,$2::jsonb)`,
        [accountId, JSON.stringify(initial)],
      );
      const at = "2026-09-10T14:31:00.000Z";
      const reserve: LedgerEvent = {
        id: "reserve:seed",
        at,
        currency: "CAD",
        type: "RESERVE",
        orderId: "seed-order",
        debit: 600,
        risk: 50,
      };
      const buy: LedgerEvent = {
        id: "buy:seed",
        at,
        currency: "CAD",
        type: "BUY",
        orderId: "seed-order",
        positionId: "seed-order",
        instrumentId: "seed-instrument",
        shares: 50,
        price: 10,
        fee: 0,
        stop: 9,
      };
      for (const event of [reserve, buy])
        await pool.query(
          `INSERT INTO paper_funded_event(account_id,event_id,event,event_sequence_verified)
           VALUES($1,$2,$3::jsonb,TRUE)`,
          [accountId, event.id, JSON.stringify(event)],
        );
      const reconstruction = await reconstructFundedLedgerAt(
        pool,
        accountId,
        at,
      );
      expect(reconstruction.ledger.positions["seed-order"]?.shares).toBe(50);
      expect(reconstruction.ledger.reservations).toStrictEqual({});
      const full = replayFundedLedgerAt(initial, [reserve, buy], at);
      // The BUY debits its own fill value (500), within the 600 reservation.
      expect(full.cash).toBe(1_500);
      expect(reconstruction.ledger.cash).toBe(full.cash);
      await pool.query("DELETE FROM paper_funded_event WHERE account_id=$1", [
        accountId,
      ]);
      await pool.query("DELETE FROM paper_funded_account WHERE id=$1", [
        accountId,
      ]);
    });

    it("writes run-start checkpoints on session binds with proven cursors", async () => {
      const { accountId } = await seedCheckpointAccount();
      // Both session binds (the first run and the still-running second
      // session) are run-start anchors.
      const initial = await pool.query<{
        event_sequence: number | string;
        boundary_at: Date | string;
        kind: string;
      }>(
        "SELECT event_sequence,boundary_at,kind FROM paper_funded_ledger_checkpoint WHERE account_id=$1 ORDER BY event_sequence",
        [accountId],
      );
      expect(initial.rows).toHaveLength(2);
      expect(initial.rows.map((row) => row.kind)).toEqual([
        "RUN_START",
        "RUN_START",
      ]);
      const firstBoundary = new Date(
        initial.rows[0]!.boundary_at,
      ).toISOString();
      const firstSequenceRows = await pool.query<{
        event_sequence: number | string;
      }>(
        "SELECT event_sequence FROM paper_funded_event WHERE account_id=$1 AND (event->>'at')::timestamptz <= $2::timestamptz ORDER BY event_sequence",
        [accountId, firstBoundary],
      );
      expect(Number(firstSequenceRows.rows.at(-1)!.event_sequence)).toBe(
        Number(initial.rows[0]!.event_sequence),
      );
      // The live run-start anchor is newer than the completed run boundary,
      // so reconstruction prefers it without needing the snapshot.
      const reconstruction = await reconstructFundedLedgerAt(
        pool,
        accountId,
        "2026-09-09T14:31:00.000Z",
      );
      expect(reconstruction.checkpoint).toEqual({
        runId: null,
        boundaryAt: "2026-09-09T14:30:00.000Z",
        anchorEventSequence: Number(initial.rows[1]!.event_sequence),
      });
    });

    it("anchors a periodic checkpoint after the interval and reconstructs from it", async () => {
      const accountId = randomUUID();
      const ledgerStore = new PostgresFundedLedgerStore(pool, 3);
      const pristine = createFundedLedger(
        "CAD",
        2_000,
        "2026-09-10",
        "2026-09-10T14:30:00.000Z",
        500,
      );
      await pool.query(
        `INSERT INTO paper_funded_account(id,initial_state,state)
         VALUES($1,$2::jsonb,$2::jsonb)`,
        [accountId, JSON.stringify(pristine)],
      );
      const marks = [
        "2026-09-10T14:31:00.000Z",
        "2026-09-10T14:32:00.000Z",
        "2026-09-10T14:33:00.000Z",
      ];
      await ledgerStore.apply(
        accountId,
        marks.map(
          (at, index) =>
            ({
              id: `periodic-mark-${index}`,
              at,
              currency: "CAD",
              type: "MARK",
              instrumentId: "unheld-instrument",
              bid: 10,
            }) satisfies LedgerEvent,
        ),
      );
      const periodic = await pool.query<{
        event_sequence: number | string;
        boundary_at: Date | string;
        kind: string;
      }>(
        "SELECT event_sequence,boundary_at,kind FROM paper_funded_ledger_checkpoint WHERE account_id=$1 ORDER BY event_sequence DESC LIMIT 1",
        [accountId],
      );
      expect(periodic.rows).toHaveLength(1);
      expect(periodic.rows[0]!.kind).toBe("PERIODIC");
      expect(new Date(periodic.rows[0]!.boundary_at).toISOString()).toBe(
        marks[2],
      );
      const accountRow = await pool.query<{
        checkpoint_sequence: number | string;
      }>("SELECT checkpoint_sequence FROM paper_funded_account WHERE id=$1", [
        accountId,
      ]);
      expect(Number(accountRow.rows[0]!.checkpoint_sequence)).toBe(
        Number(periodic.rows[0]!.event_sequence),
      );

      // Reconstruction picks the generic anchor and matches the full replay.
      const at = marks[2]!;
      const full = replayFundedLedgerAt(
        pristine,
        await durableEvents(pool, accountId, at),
        at,
      );
      const reconstruction = await reconstructFundedLedgerAt(
        pool,
        accountId,
        at,
      );
      expect(reconstruction.checkpoint).toEqual({
        runId: null,
        boundaryAt: marks[2],
        anchorEventSequence: Number(periodic.rows[0]!.event_sequence),
      });
      expect(reconstruction.replayedEventCount).toBe(0);
      expect(reconstruction.ledger.cash).toBe(full.cash);
      expect(reconstruction.ledger.positions).toStrictEqual(full.positions);
    });

    it("rejects a checkpoint containing the excluded reservation and falls back", async () => {
      const { accountId, firstRunId } = await seedCheckpointAccount();
      const orderIdRow = await pool.query<{ order_id: string }>(
        "SELECT order_id FROM paper_entry_order WHERE run_id IN (SELECT run_id FROM paper_funded_run WHERE account_id=$1)",
        [accountId],
      );
      const observationId = orderIdRow.rows[0]!.order_id;
      const reserveRow = await pool.query<{
        event: LedgerEvent;
        event_sequence: number | string;
      }>(
        "SELECT event,event_sequence FROM paper_funded_event WHERE account_id=$1 AND event_id=$2",
        [accountId, `reserve:${observationId}`],
      );
      const reserveSequence = Number(reserveRow.rows[0]!.event_sequence);
      // A checkpoint claiming the state at the submission instant while
      // already containing the reservation: provable boundary time, but its
      // cursor sits at the reservation itself, so it must be refused for a
      // pre-reservation reconstruction.
      const firstSnapshotRow = await pool.query<{ state: FundedLedger }>(
        "SELECT state FROM paper_funded_run_snapshot WHERE run_id=$1",
        [firstRunId],
      );
      const containing = applyLedgerEvent(
        firstSnapshotRow.rows[0]!.state,
        reserveRow.rows[0]!.event,
      );
      const throwaway = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2026-09-14",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2026-09-14T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      await pool.query(
        `INSERT INTO paper_funded_run_snapshot(run_id,account_id,boundary_at,state,orders,boundary_event_sequence)
         VALUES($1,$2,$3,$4::jsonb,'[]'::jsonb,$5)
         ON CONFLICT(run_id) DO NOTHING`,
        [
          throwaway.id,
          accountId,
          containing.lastEventAt,
          JSON.stringify(containing),
          reserveSequence,
        ],
      );
      const reconstruction = await reconstructFundedLedgerAt(
        pool,
        accountId,
        containing.lastEventAt,
        { maxEventSequence: reserveSequence - 1 },
      );
      // The reservation-containing checkpoint is the synthetic snapshot; the
      // selected anchor must be a different, strictly earlier one.
      expect(reconstruction.checkpoint?.runId).not.toBe(throwaway.id);
      expect(reconstruction.checkpoint?.anchorEventSequence).toBeLessThan(
        reserveSequence,
      );
      expect(reconstruction.ledger.reservations).toStrictEqual({});
      expect(reconstruction.ledger.cash).toBe(2_000);
      expect(reconstruction.ledger.positions).toStrictEqual({});
      const initial = await accountInitialState(pool, accountId);
      const full = replayFundedLedgerAt(
        initial,
        (await durableEvents(pool, accountId, containing.lastEventAt)).filter(
          (event) => event.id !== `reserve:${observationId}`,
        ),
        containing.lastEventAt,
      );
      expect(reconstruction.ledger.cash).toBe(full.cash);
      expect(reconstruction.ledger.positions).toStrictEqual(full.positions);
    });

    it("fails closed when legacy sequencing cannot prove equal-time order", async () => {
      const run = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate: "2026-09-10",
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: "2026-09-10T21:00:00Z",
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      const accountId = randomUUID();
      // Provisioned one day earlier so the bind writes a durable SESSION
      // event; without it the account has no events to verify.
      await new PostgresFundedLedgerStore(pool).create(accountId, [
        "CAD",
        2_000,
        "2026-09-09",
        "2026-09-09T14:30:00Z",
        500,
      ]);
      await new FundedOrderService(pool, run.id, accountId, "CAD").bind(
        undefined,
        { session: "2026-09-10", at: "2026-09-10T14:30:00Z" },
      );
      // The bind anchor itself is proven by construction, so the fail-closed
      // case needs an unverified row inside the replay window: it is inserted
      // after the anchor with unproven ordering.
      await pool.query(
        `INSERT INTO paper_funded_event(account_id,event_id,event,event_sequence_verified)
         VALUES($1,'unverified-mark',$2::jsonb,FALSE)`,
        [
          accountId,
          JSON.stringify({
            id: "unverified-mark",
            at: "2026-09-10T14:30:00.500Z",
            currency: "CAD",
            type: "MARK",
            instrumentId: "unheld-instrument",
            bid: 10,
          }),
        ],
      );
      const reconstructionMetrics = new FundedReconstructionMetricsRegistry();
      const reporting = new FundedReportingService(
        pool,
        undefined,
        {},
        reconstructionMetrics,
      );
      await expect(
        reporting.report(run.id, "2026-09-10T14:30:01Z"),
      ).rejects.toThrow("event order predates temporal sequencing");
      expect(reconstructionMetrics.snapshot(accountId)).toMatchObject({
        reconstructionCountTotal: 1,
        reconstructionBudgetFailuresTotal: 0,
      });
      await expect(
        reconstructFundedLedgerAt(pool, accountId, "2026-09-10T14:30:01Z"),
      ).rejects.toThrow("event order predates temporal sequencing");
    });

    it("replays a large mark-heavy history linearly and within the event budget", async () => {
      const accountId = randomUUID();
      const initial = createFundedLedger(
        "CAD",
        2_000,
        "2026-09-11",
        "2026-09-11T14:30:00.000Z",
        500,
      );
      await pool.query(
        `INSERT INTO paper_funded_account(id,initial_state,state)
         VALUES($1,$2::jsonb,$2::jsonb)`,
        [accountId, JSON.stringify(initial)],
      );
      const count = 30_000;
      await pool.query(
        `INSERT INTO paper_funded_event(account_id,event_id,event,event_sequence_verified)
         SELECT $1,'mark-'||g,
           jsonb_build_object('id','mark-'||g,'at','2026-09-11T14:31:00.000Z',
             'currency','CAD','type','MARK','instrumentId','instrument-1','bid',10),
           TRUE
           FROM generate_series(0,$2-1) g`,
        [accountId, count],
      );
      const started = performance.now();
      const reconstruction = await reconstructFundedLedgerAt(
        pool,
        accountId,
        "2026-09-11T14:31:00.000Z",
      );
      const elapsed = performance.now() - started;
      expect(reconstruction.replayedEventCount).toBe(count);
      expect(reconstruction.checkpoint).toBeNull();
      expect(reconstruction.ledger.cash).toBe(2_000);
      expect(reconstruction.ledger.events).toHaveLength(
        FUNDED_SNAPSHOT_EVENT_LIMIT,
      );
      // The quadratic baseline needed ~40s for 8k events; the bounded replay
      // is linear and must stay seconds away from that.
      expect(elapsed).toBeLessThan(15_000);
      await pool.query("DELETE FROM paper_funded_event WHERE account_id=$1", [
        accountId,
      ]);
      await pool.query("DELETE FROM paper_funded_account WHERE id=$1", [
        accountId,
      ]);
    });

    it("repairs a committed SIGNAL decision through the bounded reconstruction", async () => {
      const accountId = randomUUID();
      const sessionDate = "2026-09-12";
      const run = await store.startBacktestRun({
        source: "BACKTEST",
        marketId: "CA_TSX",
        sessionDate,
        sessionTimezone: assumptions.sessionTimezone,
        scheduledCloseAt: `${sessionDate}T21:00:00Z`,
        executionModelVersion: AUTHORITATIVE_EXECUTION_MODEL_VERSION,
        assumptions,
      });
      await new PostgresFundedLedgerStore(pool).create(accountId, [
        "CAD",
        2_000,
        "2026-09-11",
        "2026-09-11T14:30:00Z",
        500,
      ]);
      const service = new FundedOrderService(pool, run.id, accountId, "CAD");
      await service.bind(undefined, {
        session: sessionDate,
        at: `${sessionDate}T14:30:00Z`,
      });
      const instrumentId = randomUUID();
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
         security_type,industry_sector,is_quotable,is_tradable,active,market_id)
         VALUES($1,$2,$3,'repair fixture','TSX','CAD','Stock','Technology',true,true,true,'CA_TSX')`,
        [
          instrumentId,
          Math.floor(Math.random() * 1_000_000_000) + 1_000_000_000,
          `RPR_${accountId.slice(0, 6)}`,
        ],
      );
      const definitionId = randomUUID();
      const profileId = randomUUID();
      const configId = randomUUID();
      await pool.query(
        `INSERT INTO strategy_definition(id,strategy_key,version,name,description)
         VALUES($1,$2,'2026-09-01','ORB Standard','checkpoint fixture')`,
        [definitionId, `ORB_STANDARD_${definitionId.slice(0, 8)}`],
      );
      await pool.query(
        `INSERT INTO scanner_profile(id,name,strategy_definition_id,enabled,display_order)
         VALUES($1,$2,$3,true,0)`,
        [profileId, `rcp-${profileId.slice(0, 8)}`, definitionId],
      );
      await pool.query(
        `INSERT INTO scanner_profile_config(id,profile_id,config_version,parameters)
         VALUES($1,$2,$3,'{}'::jsonb)`,
        [configId, profileId, `rcp-${configId.slice(0, 8)}`],
      );
      const observation = await store.insertObservation({
        runId: run.id,
        sourceEventId: randomUUID(),
        sourceSignalId: null,
        setupInstanceId: null,
        instrumentId,
        symbol: `RCP_${instrumentId.slice(0, 6).toUpperCase()}`,
        profileId,
        profileName: "rcp",
        profileConfigId: configId,
        configVersion: "v1",
        profileParameters: {},
        strategyKey: "ORB_STANDARD",
        strategyVersion: "2026-09-01",
        signalTimestamp: `${sessionDate}T14:31:00Z`,
        score: 82,
        entryReference: 10.02,
        stopReference: 9.8,
        targetReference: 10.6,
        atr14: 0.22,
        featureSnapshot: { featureVersion: "features-v1" },
        reasonCodes: ["BREAKOUT"],
        sourceEventPayload: { signalSemanticsVersion: "signal-semantics-v1" },
        eligibilityStatus: "ELIGIBLE",
        eligibilityReason: null,
      });
      const submittedAt = `${sessionDate}T14:31:00Z`;
      // The committed submission durably reserved funding before its fact was
      // acknowledged; the repair must reconstruct the pre-reservation state.
      await service.submit(
        instrumentId,
        {
          orderId: observation.observation.id,
          signal: {
            entryReference: 10.02,
            stopReference: 9.8,
            targetReference: 10.6,
            atr14: 0.22,
            signalTimestamp: submittedAt,
          },
          assumptions,
          submittedAt,
          expiresAt: `${sessionDate}T14:35:00Z`,
        },
        1_200,
        100,
      );
      await pool.query(
        `INSERT INTO paper_funded_fact(run_id,fact_id,fact_at,priority,sort_key,fact,outcome)
         VALUES($1,$2,$3::timestamptz,2,$4,$5::jsonb,$6::jsonb)`,
        [
          run.id,
          `funded-signal:${observation.observation.id}`,
          submittedAt,
          submittedAt,
          JSON.stringify({
            type: "SIGNAL",
            maximumDebit: 1_200,
            maximumRisk: 100,
            order: {
              orderId: observation.observation.id,
              submittedAt,
              assumptions,
              signal: {
                entryReference: 10.02,
                stopReference: 9.8,
                targetReference: 10.6,
                atr14: 0.22,
                signalTimestamp: submittedAt,
              },
            },
          }),
          JSON.stringify({ status: "ACCEPTED" }),
        ],
      );
      const repository = new FundedDecisionEvidenceRepository(pool);
      const repair = await repository.repairMissingDecisions(run.id);
      expect(repair.repaired).toBe(1);
      expect(repair.remaining).toBe(0);
      const stored = await pool.query<{
        action: string;
        decision_content: { portfolio: { cash?: number; status: string } };
      }>(
        "SELECT action,decision_content FROM funded_decision_evidence WHERE run_id=$1",
        [run.id],
      );
      expect(stored.rows[0]!.action).toBe("SUBMIT");
      const portfolio = stored.rows[0]!.decision_content.portfolio;
      expect(portfolio.status).toBe("AVAILABLE");
      // Pre-reservation cash: the reconstruction excludes the signal's own
      // durable reservation even though it exists at the decision instant.
      expect(portfolio.cash).toBe(2_000);
      const events = await durableEvents(
        pool,
        accountId,
        `${sessionDate}T14:31:00Z`,
      );
      expect(
        events.some(
          (event) => event.id === `reserve:${observation.observation.id}`,
        ),
      ).toBe(true);
    });
  },
);
