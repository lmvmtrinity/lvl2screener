import { Pool } from "pg";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { migrate } from "../src/database/migrate.js";
import { PostgresPaperCoordinationStore } from "../src/paper-bot/paper-coordination-repository.js";
import { PostgresPaperEvidenceStore } from "../src/paper-bot/paper-reporting-repository.js";

/**
 * The economics gate, the sizing audit trail, and the coordinated projection
 * all live partly in SQL and partly in database constraints, so the
 * fake-store suites cannot reach them: a query that names a column the schema
 * does not have type-checks perfectly and fails only in production. This
 * fixture runs the real migrations and the real queries against PostgreSQL,
 * the same way profile-paper-qualification.test.ts does — skipped when no
 * database is reachable, required in CI via REQUIRE_POSTGRES_INTEGRATION.
 *
 * It pins the Phase 2 and Phase 4 invariants from
 * docs/paper-bot-performance-improvement-plan.md: an economics rejection is a
 * decision with a reason (never a bare status), a deferred coordination
 * decision selects nothing, and sector exposure is measured from the column
 * the instrument table actually has.
 */
const DATABASE_URL = isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");

// Reserved id space so these rows are identifiable and removable in a shared
// development database.
const INSTRUMENT = "4f000000-0000-4000-8000-000000000001";
const RUN = "4f000000-0000-4000-8000-000000000002";
const OBSERVATION = "4f000000-0000-4000-8000-000000000003";
const OTHER_OBSERVATION = "4f000000-0000-4000-8000-000000000004";
const THIRD_OBSERVATION = "4f000000-0000-4000-8000-000000000005";
const SESSION_DATE = "2099-02-01";
const DECISION_AT = "2099-02-01T15:00:00.000Z";

const assumptions = {
  positionSize: 10_000,
  slippageBps: 2,
  feePerTrade: 0,
  costs: {
    entryCommission: 0,
    exitCommission: 0,
    estimatedRegulatoryFees: 0,
    slippageBps: 2,
    currency: "CAD",
    brokerPricingVersion: "questrade-ca-equities-2026-09-01",
  },
  riskBudget: 100,
  maxNotional: 10_000,
  economics: {
    minNetRewardRisk: 1,
    minStopFrictionMultiple: 2,
    minTargetFrictionMultiple: 3,
    maxSpreadPct: 0.5,
  },
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
};

let pool: Pool | undefined;

beforeAll(async () => {
  if (!DATABASE_URL) return;
  const candidate = new Pool({ connectionString: DATABASE_URL, max: 2 });
  try {
    const client = await Promise.race([
      candidate.connect(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("connect timeout")), 3_000),
      ),
    ]);
    client.release();
    await migrate(candidate);
    pool = candidate;
  } catch (error) {
    if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true") throw error;
    console.warn(
      `[paper-economics-persistence] Skipping: no reachable PostgreSQL at ${DATABASE_URL} (${
        error instanceof Error ? error.message : String(error)
      }). Start it with \`docker compose up -d postgres\` to run this fixture.`,
    );
    await candidate.end().catch(() => {});
  }
}, 30_000);

/**
 * Order matters: a coordinated position holds its observation with
 * ON DELETE RESTRICT (migration 046) so evidence cannot be dropped out from
 * under a recorded decision. Remove the coordinated rows first, then let the
 * run cascade take the observations and executions. Runs before each test as
 * well as after, so a previous crashed run cannot wedge the whole fixture in a
 * shared development database.
 */
async function cleanup(db: Pool): Promise<void> {
  await db.query(
    `DELETE FROM paper_coordination_position p
     USING paper_coordination_decision d
     WHERE p.decision_id=d.id AND d.run_id=$1`,
    [RUN],
  );
  await db.query("DELETE FROM paper_coordination_decision WHERE run_id=$1", [
    RUN,
  ]);
  // Closing a coordinated trade can fire `refresh_paper_profile_qualifications`,
  // whose row holds the run through `as_of_run_id` with no cascade.
  await db.query(
    "DELETE FROM paper_profile_qualification WHERE as_of_run_id=$1",
    [RUN],
  );
  await db.query("DELETE FROM paper_bot_run WHERE id=$1", [RUN]);
  await db.query("DELETE FROM instrument WHERE id=$1", [INSTRUMENT]);
}

beforeEach(async () => {
  if (pool) await cleanup(pool);
});

afterEach(async () => {
  if (pool) await cleanup(pool);
});

afterAll(async () => {
  if (pool) await pool.end();
});

async function seedRun(
  db: Pool,
): Promise<{ profileId: string; configId: string }> {
  await db.query(
    `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
       security_type,industry_sector,is_quotable,is_tradable,active)
     VALUES($1,999101,'ECON_FIXTURE.TO','Economics fixture','TSX','CAD','Stock',
       'Financial Services',true,true,true)
     ON CONFLICT (market_id,symbol) DO UPDATE SET active=true`,
    [INSTRUMENT],
  );
  await db.query(
    `INSERT INTO paper_bot_run(id,source,session_date,scheduled_close_at,status,
       execution_model_version,assumptions)
     VALUES($1,'LIVE',$2::date,now(),'RUNNING','paper-execution-v3',$3::jsonb)`,
    [RUN, SESSION_DATE, JSON.stringify(assumptions)],
  );
  const profile = await db.query<{ id: string; config: string }>(
    `SELECT p.id,c.id AS config FROM scanner_profile p
     JOIN scanner_profile_config c ON c.profile_id=p.id
     ORDER BY p.display_order, c.created_at LIMIT 1`,
  );
  const row = profile.rows[0];
  if (!row) throw new Error("no seeded scanner profile to attach evidence to");
  return { profileId: row.id, configId: row.config };
}

async function seedObservation(
  db: Pool,
  id: string,
  profileId: string,
  configId: string,
  strategyKey = "ORB_RETEST",
): Promise<void> {
  await db.query(
    `INSERT INTO paper_signal_observation(id,run_id,source_event_id,instrument_id,symbol,
       profile_id,profile_name,profile_config_id,config_version,profile_parameters,
       strategy_key,strategy_version,signal_timestamp,score,entry_reference,stop_reference,
       target_reference,reason_codes,source_event_payload,eligibility_status)
     VALUES($1,$2,gen_random_uuid(),$3,'ECON_FIXTURE.TO',$4,'Fixture',$5,'profile-v1','{}'::jsonb,
       $6,'1.0.0',$7,80,10,9.5,11,'[]'::jsonb,'{}'::jsonb,'ELIGIBLE')`,
    [id, RUN, INSTRUMENT, profileId, configId, strategyKey, DECISION_AT],
  );
}

/**
 * One approved coordinated decision and the position it owns. `state` is the
 * quote execution state the live processor persists, which is where the
 * coordinated ledger reads its prices and financials from.
 */
async function seedCoordinatedTrade(
  db: Pool,
  observationId: string,
  decisionAt: string,
  position: Record<string, unknown>,
): Promise<void> {
  const decision = await db.query<{ id: string }>(
    `INSERT INTO paper_coordination_decision(portfolio_id,run_id,symbol,decision_timestamp,
       trigger_observation_ids,candidate_snapshot,selected_observation_id,
       selected_strategy_key,confirmation_observation_ids,outcome,reason,
       policy_version,state_snapshot,context_snapshot)
       VALUES((SELECT id FROM paper_portfolio WHERE key='COORDINATED_SHADOW'),$1,'ECON_FIXTURE.TO',$2,$4::jsonb,'[]'::jsonb,$3,'ORB_RETEST','[]'::jsonb,
       'APPROVED','SELECTED_PRIMARY','paper-coordination-v2','{}'::jsonb,'[]'::jsonb)
     RETURNING id`,
    [RUN, decisionAt, observationId, JSON.stringify([observationId])],
  );
  const exit = position.exit as
    { exitReason?: string; exitTime?: string } | undefined;
  await db.query(
    `INSERT INTO paper_coordination_position(decision_id,observation_id,portfolio_id,symbol,session_date,status,state,
       exit_reason,exit_time)
     SELECT $1,$2,d.portfolio_id,d.symbol,r.session_date,$3,$4::jsonb,$5,$6
     FROM paper_coordination_decision d JOIN paper_bot_run r ON r.id=d.run_id WHERE d.id=$1`,
    [
      decision.rows[0]?.id,
      observationId,
      position.status,
      JSON.stringify(position),
      exit?.exitReason ?? null,
      exit?.exitTime ?? null,
    ],
  );
}

function closedPosition(
  entryPrice: number,
  exitPrice: number,
  shares: number,
  financials: { grossPnl: number; netPnl: number; rMultiple: number },
  exitReason: string,
  exitTime: string,
): Record<string, unknown> {
  return {
    status: "CLOSED",
    position: {
      entryPrice,
      entryTime: DECISION_AT,
      stop: 9.5,
      target: 11,
      shares,
      initialRisk: 50,
    },
    exit: {
      triggered: true,
      exitReason,
      exitTime,
      financials: { exitPrice, ...financials },
      sessionCloseDelayMs: null,
    },
  };
}

const describeIfDatabase = describe;

describeIfDatabase("paper economics and coordination persistence", () => {
  it("records an economics rejection with its reason, snapshot, and journal entry", async () => {
    if (!pool) return;
    const { profileId, configId } = await seedRun(pool);
    await seedObservation(pool, OBSERVATION, profileId, configId);
    await pool.query(
      `INSERT INTO paper_execution(observation_id,model,status,economics_reason,economics,sizing)
       VALUES($1,'QUOTE','REJECTED_ECONOMICS','NET_REWARD_RISK_TOO_LOW',
         $2::jsonb,$3::jsonb)`,
      [
        OBSERVATION,
        JSON.stringify({ netRewardRisk: 0.4, gates: assumptions.economics }),
        JSON.stringify({
          requestedRisk: 100,
          shares: 10,
          appliedCaps: ["RISK_BUDGET"],
        }),
      ],
    );

    const stored = await pool.query<{
      status: string;
      economicsReason: string;
      economics: { netRewardRisk: number };
      sizing: { appliedCaps: string[] };
    }>(
      `SELECT status,economics_reason AS "economicsReason",economics,sizing
       FROM paper_execution WHERE observation_id=$1`,
      [OBSERVATION],
    );
    expect(stored.rows[0]).toMatchObject({
      status: "REJECTED_ECONOMICS",
      economicsReason: "NET_REWARD_RISK_TOO_LOW",
    });
    expect(stored.rows[0]?.economics.netRewardRisk).toBe(0.4);
    expect(stored.rows[0]?.sizing.appliedCaps).toEqual(["RISK_BUDGET"]);

    // An operator must see a declined trade as plainly as a filled one.
    const journal = await pool.query<{ message: string }>(
      `SELECT message FROM paper_bot_activity
       WHERE observation_id=$1 AND event_type='EXECUTION_REJECTED_ECONOMICS'`,
      [OBSERVATION],
    );
    expect(journal.rowCount).toBe(1);
    expect(journal.rows[0]?.message).toContain("declined on economics");
  });

  it("refuses an economics rejection that carries no reason or snapshot", async () => {
    if (!pool) return;
    const { profileId, configId } = await seedRun(pool);
    await seedObservation(pool, OBSERVATION, profileId, configId);
    await expect(
      pool.query(
        `INSERT INTO paper_execution(observation_id,model,status)
         VALUES($1,'CANDLE','REJECTED_ECONOMICS')`,
        [OBSERVATION],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("accepts a deferred coordination decision and refuses an approval that selects nothing", async () => {
    if (!pool) return;
    const { profileId, configId } = await seedRun(pool);
    await seedObservation(pool, OBSERVATION, profileId, configId);
    await pool.query(
      `INSERT INTO paper_coordination_decision(portfolio_id,run_id,symbol,decision_timestamp,
         trigger_observation_ids,candidate_snapshot,confirmation_observation_ids,
         outcome,reason,policy_version,state_snapshot,context_snapshot)
       VALUES((SELECT id FROM paper_portfolio WHERE key='COORDINATED_SHADOW'),$1,'ECON_FIXTURE.TO',$2,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
         'DEFERRED','SECTOR_EXPOSURE_LIMIT','paper-coordination-v2','{}'::jsonb,
         $3::jsonb)`,
      [
        RUN,
        DECISION_AT,
        JSON.stringify([
          {
            signalKey: "MARKET_RELATIVE_STRENGTH",
            status: "STRONG",
            score: 80,
            timestamp: DECISION_AT,
          },
        ]),
      ],
    );

    await expect(
      pool.query(
        `INSERT INTO paper_coordination_decision(portfolio_id,run_id,symbol,decision_timestamp,
           trigger_observation_ids,candidate_snapshot,confirmation_observation_ids,
           outcome,reason,policy_version,state_snapshot,context_snapshot)
         VALUES((SELECT id FROM paper_portfolio WHERE key='COORDINATED_SHADOW'),$1,'OTHER.TO',$2,'[]'::jsonb,'[]'::jsonb,'[]'::jsonb,
           'APPROVED','SELECTED_PRIMARY','paper-coordination-v2','{}'::jsonb,'[]'::jsonb)`,
        [RUN, DECISION_AT],
      ),
    ).rejects.toMatchObject({ code: "23514" });

    const store = new PostgresPaperEvidenceStore(pool);
    const decisions = await store.coordinationDecisions({ source: "LIVE" });
    const decision = decisions.find(
      (value) => value.symbol === "ECON_FIXTURE.TO",
    );
    expect(decision).toMatchObject({
      outcome: "DEFERRED",
      reason: "SECTOR_EXPOSURE_LIMIT",
      selectedObservationId: null,
      positionStatus: null,
    });
    expect(decision?.contexts[0]).toMatchObject({
      signalKey: "MARKET_RELATIVE_STRENGTH",
    });

    const summary = await store.coordinationSummary({ source: "LIVE" });
    expect(summary.deferred).toBeGreaterThanOrEqual(1);
    expect(summary.reasons.SECTOR_EXPOSURE_LIMIT).toBeGreaterThanOrEqual(1);
  });

  it("measures symbol and sector exposure from an open coordinated position", async () => {
    if (!pool) return;
    const { profileId, configId } = await seedRun(pool);
    await seedObservation(pool, OBSERVATION, profileId, configId);
    await seedObservation(
      pool,
      OTHER_OBSERVATION,
      profileId,
      configId,
      "VWAP_HOLD",
    );
    const decision = await pool.query<{ id: string }>(
      `INSERT INTO paper_coordination_decision(portfolio_id,run_id,symbol,decision_timestamp,
         trigger_observation_ids,candidate_snapshot,selected_observation_id,
         selected_strategy_key,confirmation_observation_ids,outcome,reason,
         policy_version,state_snapshot,context_snapshot)
       VALUES((SELECT id FROM paper_portfolio WHERE key='COORDINATED_SHADOW'),$1,'ECON_FIXTURE.TO',$2,'[]'::jsonb,'[]'::jsonb,$3,'ORB_RETEST','[]'::jsonb,
         'APPROVED','SELECTED_PRIMARY','paper-coordination-v2','{}'::jsonb,'[]'::jsonb)
       RETURNING id`,
      [RUN, DECISION_AT, OBSERVATION],
    );
    await pool.query(
      `INSERT INTO paper_coordination_position(decision_id,observation_id,portfolio_id,symbol,session_date,status,state)
       SELECT $1,$2,d.portfolio_id,d.symbol,r.session_date,'OPEN',$3::jsonb
       FROM paper_coordination_decision d JOIN paper_bot_run r ON r.id=d.run_id WHERE d.id=$1`,
      [
        decision.rows[0]?.id,
        OBSERVATION,
        JSON.stringify({
          status: "OPEN",
          position: {
            entryPrice: 10,
            entryTime: DECISION_AT,
            stop: 9.5,
            target: 11,
            shares: 40,
            initialRisk: 20,
          },
          lastFactTimestamp: DECISION_AT,
        }),
      ],
    );

    const store = new PostgresPaperCoordinationStore(pool);
    const state = await store.stateForSymbol(
      RUN,
      "ECON_FIXTURE.TO",
      "2099-02-01T16:00:00.000Z",
      INSTRUMENT,
    );
    expect(state).toMatchObject({
      hasOpenSymbolPosition: true,
      openPositionCount: 1,
      totalOpenRisk: 20,
      // 40 shares at $10 — the same notional the exposure caps are measured in.
      openSymbolNotional: 400,
      openSectorNotional: 400,
      sector: "Financial Services",
    });
  });

  it("re-prices closed trades under alternative commissions without touching the stored row", async () => {
    if (!pool) return;
    const { profileId, configId } = await seedRun(pool);
    await seedObservation(pool, OBSERVATION, profileId, configId);
    await pool.query(
      `INSERT INTO paper_execution(observation_id,model,status,entry_price,entry_time,
         stop_price,target_price,shares,initial_risk,exit_price,exit_time,exit_reason,
         fee,gross_pnl,net_pnl,r_multiple)
       VALUES($1,'QUOTE','CLOSED',10,$2,9.5,11,100,50,11,$2,'TARGET',0,100,100,2)`,
      [OBSERVATION, DECISION_AT],
    );

    const store = new PostgresPaperEvidenceStore(pool);
    const sensitivities = await store.commissionSensitivity(
      { source: "LIVE", startDate: SESSION_DATE, endDate: SESSION_DATE },
      [0, 1, 9.95],
    );
    const cohort = sensitivities.find((value) => value.model === "QUOTE");
    expect(cohort?.scenarios.map((value) => value.roundTripCommission)).toEqual(
      [0, 1, 9.95],
    );
    // $100 gross on $50 of initial risk, less each scenario's round trip.
    expect(cohort?.scenarios[0]).toMatchObject({ netPnl: 100, cumulativeR: 2 });
    expect(cohort?.scenarios[1]?.netPnl).toBeCloseTo(99, 6);
    expect(cohort?.scenarios[2]?.netPnl).toBeCloseTo(90.05, 6);
    expect(cohort?.scenarios[2]?.cumulativeR).toBeCloseTo(1.801, 6);

    const stored = await pool.query<{ netPnl: string }>(
      `SELECT net_pnl AS "netPnl" FROM paper_execution WHERE observation_id=$1`,
      [OBSERVATION],
    );
    expect(Number(stored.rows[0]?.netPnl)).toBe(100);
  });

  /**
   * ADR-010 in SQL. The coordinated ledger reads prices and financials out of
   * a JSONB execution state and carries a running balance; the independent one
   * reads columns and must carry none. Both are unreachable from the
   * fake-store suites, and both would fail only in production.
   */
  it("builds the coordinated P&L ledger with a running balance over closed trades", async () => {
    if (!pool) return;
    const { profileId, configId } = await seedRun(pool);
    await seedObservation(pool, OBSERVATION, profileId, configId);
    await seedObservation(
      pool,
      OTHER_OBSERVATION,
      profileId,
      configId,
      "VWAP_HOLD",
    );
    await seedObservation(
      pool,
      THIRD_OBSERVATION,
      profileId,
      configId,
      "GAP_GO",
    );
    await seedCoordinatedTrade(
      pool,
      OBSERVATION,
      DECISION_AT,
      closedPosition(
        10,
        9.81,
        100,
        { grossPnl: -19, netPnl: -20, rMultiple: -0.4 },
        "STOP",
        "2099-02-01T15:30:00.000Z",
      ),
    );
    await seedCoordinatedTrade(
      pool,
      OTHER_OBSERVATION,
      "2099-02-01T15:05:00.000Z",
      closedPosition(
        10,
        10.51,
        100,
        { grossPnl: 51, netPnl: 50, rMultiple: 1 },
        "TARGET",
        "2099-02-01T16:00:00.000Z",
      ),
    );
    await seedCoordinatedTrade(
      pool,
      THIRD_OBSERVATION,
      "2099-02-01T15:10:00.000Z",
      {
        status: "OPEN",
        position: {
          entryPrice: 12,
          entryTime: DECISION_AT,
          stop: 11.5,
          target: 13,
          shares: 40,
          initialRisk: 20,
        },
        lastFactTimestamp: DECISION_AT,
      },
    );

    const store = new PostgresPaperEvidenceStore(pool);
    const journal = await store.journal(
      { source: "LIVE", startDate: SESSION_DATE, endDate: SESSION_DATE },
      "COORDINATED",
    );

    expect(journal.projection).toBe("COORDINATED");
    // Newest exit first; the still-open position sorts last on its entry.
    expect(
      journal.entries.map((entry) => [
        entry.status,
        entry.netPnl,
        entry.runningNetPnl,
      ]),
    ).toEqual([
      ["CLOSED", 50, 30],
      ["CLOSED", -20, -20],
      ["OPEN", null, null],
    ]);
    expect(journal.entries[0]).toMatchObject({
      symbol: "ECON_FIXTURE.TO",
      strategyKey: "VWAP_HOLD",
      sessionDate: SESSION_DATE,
      entryPrice: 10,
      stopPrice: 9.5,
      targetPrice: 11,
      shares: 100,
      initialRisk: 50,
      exitPrice: 10.51,
      exitReason: "TARGET",
      grossPnl: 51,
      // Gross less net is the round trip's commissions and fees.
      costs: 1,
      rMultiple: 1,
    });
    expect(journal.totals).toMatchObject({
      closedTrades: 2,
      openPositions: 1,
      wins: 1,
      losses: 1,
      scratches: 0,
      winRate: { numerator: 1, denominator: 2, value: 0.5 },
      grossPnl: 32,
      costs: 2,
      netPnl: 30,
      profitFactor: 2.5,
      largestWin: 50,
      largestLoss: -20,
    });
    expect(journal.totals.cumulativeR).toBeCloseTo(0.6, 6);
    expect(journal.totals.averageR).toBeCloseTo(0.3, 6);
  });

  /**
   * The Bot performance graph reads this curve instead of the 500-row journal
   * page, so it must stay market-bound, exclude unresolved positions and
   * bucket every point by the session that realized it.
   */
  it("draws the coordinated performance curve by realized session", async () => {
    if (!pool) return;
    const { profileId, configId } = await seedRun(pool);
    await seedObservation(pool, OBSERVATION, profileId, configId);
    await seedObservation(
      pool,
      OTHER_OBSERVATION,
      profileId,
      configId,
      "VWAP_HOLD",
    );
    await seedObservation(
      pool,
      THIRD_OBSERVATION,
      profileId,
      configId,
      "GAP_GO",
    );
    await seedCoordinatedTrade(
      pool,
      OBSERVATION,
      DECISION_AT,
      closedPosition(
        10,
        9.81,
        100,
        { grossPnl: -19, netPnl: -20, rMultiple: -0.4 },
        "STOP",
        "2099-02-01T15:30:00.000Z",
      ),
    );
    await seedCoordinatedTrade(
      pool,
      OTHER_OBSERVATION,
      "2099-02-01T15:05:00.000Z",
      closedPosition(
        10,
        10.51,
        100,
        { grossPnl: 51, netPnl: 50, rMultiple: 1 },
        "TARGET",
        "2099-02-01T16:00:00.000Z",
      ),
    );
    await seedCoordinatedTrade(
      pool,
      THIRD_OBSERVATION,
      "2099-02-01T15:10:00.000Z",
      {
        status: "OPEN",
        position: {
          entryPrice: 12,
          entryTime: DECISION_AT,
          stop: 11.5,
          target: 13,
          shares: 40,
          initialRisk: 20,
        },
        lastFactTimestamp: DECISION_AT,
      },
    );

    const store = new PostgresPaperEvidenceStore(pool);
    const range = { startDate: SESSION_DATE, endDate: SESSION_DATE };
    const trade = await store.performanceCurve(
      { source: "LIVE", marketId: "CA_TSX" },
      range,
      "TRADE",
    );
    expect(trade).toMatchObject({
      account: "COORDINATED",
      marketId: "CA_TSX",
      currency: "CAD",
      granularity: "TRADE",
    });
    // Chronological by exit; the still-open position contributes no point.
    expect(
      trade.points.map((point) => [
        point.sessionDate,
        point.netPnl,
        point.cumulativeNetPnl,
        point.trades,
      ]),
    ).toEqual([
      [SESSION_DATE, -20, -20, 1],
      [SESSION_DATE, 50, 30, 1],
    ]);

    const day = await store.performanceCurve(
      { source: "LIVE", marketId: "CA_TSX" },
      range,
      "DAY",
    );
    expect(day.points).toEqual([
      {
        sessionDate: SESSION_DATE,
        closedAt: "2099-02-01T16:00:00.000Z",
        netPnl: 30,
        cumulativeNetPnl: 30,
        trades: 2,
      },
    ]);

    // Another market and another range are explicit empty reads, not a
    // fallback to whatever sessions exist.
    const usMarket = await store.performanceCurve(
      { source: "LIVE", marketId: "US_EQUITIES" },
      range,
      "DAY",
    );
    expect(usMarket.points).toEqual([]);
    const outside = await store.performanceCurve(
      { source: "LIVE", marketId: "CA_TSX" },
      { startDate: "2099-01-01", endDate: "2099-01-31" },
      "DAY",
    );
    expect(outside.points).toEqual([]);
  });

  it("keeps the independent P&L ledger free of a running balance and of declined candidates", async () => {
    if (!pool) return;
    const { profileId, configId } = await seedRun(pool);
    await seedObservation(pool, OBSERVATION, profileId, configId);
    await seedObservation(
      pool,
      OTHER_OBSERVATION,
      profileId,
      configId,
      "VWAP_HOLD",
    );
    await pool.query(
      `INSERT INTO paper_execution(observation_id,model,status,entry_price,entry_time,
         stop_price,target_price,shares,initial_risk,exit_price,exit_time,exit_reason,
         fee,gross_pnl,net_pnl,r_multiple)
       VALUES($1,'QUOTE','CLOSED',10,$2,9.5,11,100,50,11,$2,'TARGET',1,100,99,1.98)`,
      [OBSERVATION, DECISION_AT],
    );
    // A declined candidate is a decision, not a trade: it has no P&L line.
    await pool.query(
      `INSERT INTO paper_execution(observation_id,model,status,economics_reason,economics)
       VALUES($1,'QUOTE','REJECTED_ECONOMICS','SPREAD_COST_TOO_HIGH','{}'::jsonb)`,
      [OTHER_OBSERVATION],
    );

    const store = new PostgresPaperEvidenceStore(pool);
    const journal = await store.journal(
      {
        source: "LIVE",
        model: "QUOTE",
        startDate: SESSION_DATE,
        endDate: SESSION_DATE,
      },
      "INDEPENDENT",
    );

    expect(journal.projection).toBe("INDEPENDENT");
    expect(journal.entries).toHaveLength(1);
    expect(journal.entries[0]).toMatchObject({
      symbol: "ECON_FIXTURE.TO",
      strategyKey: "ORB_RETEST",
      status: "CLOSED",
      netPnl: 99,
      costs: 1,
      runningNetPnl: null,
    });
    expect(journal.totals).toMatchObject({
      closedTrades: 1,
      openPositions: 0,
      wins: 1,
      losses: 0,
      netPnl: 99,
      // Undefined rather than infinite while nothing has lost yet.
      profitFactor: null,
      largestLoss: null,
    });
  });

  it("separates economics rejections from no-fills in the aggregate funnel", async () => {
    if (!pool) return;
    const { profileId, configId } = await seedRun(pool);
    await seedObservation(pool, OBSERVATION, profileId, configId);
    await seedObservation(
      pool,
      OTHER_OBSERVATION,
      profileId,
      configId,
      "VWAP_HOLD",
    );
    await pool.query(
      `INSERT INTO paper_execution(observation_id,model,status,economics_reason,economics)
       VALUES($1,'QUOTE','REJECTED_ECONOMICS','SPREAD_COST_TOO_HIGH','{}'::jsonb)`,
      [OBSERVATION],
    );
    await pool.query(
      `INSERT INTO paper_execution(observation_id,model,status,no_fill_reason)
       VALUES($1,'QUOTE','NO_FILL','MISSING_QUOTE')`,
      [OTHER_OBSERVATION],
    );

    const store = new PostgresPaperEvidenceStore(pool);
    const aggregates = await store.aggregates({
      source: "LIVE",
      model: "QUOTE",
      startDate: SESSION_DATE,
      endDate: SESSION_DATE,
    });
    const totals = aggregates.reduce(
      (carry, value) => ({
        noFills: carry.noFills + value.noFills,
        rejectedEconomics: carry.rejectedEconomics + value.rejectedEconomics,
        fills: carry.fills + value.fills,
      }),
      { noFills: 0, rejectedEconomics: 0, fills: 0 },
    );
    expect(totals).toEqual({ noFills: 1, rejectedEconomics: 1, fills: 0 });
    expect(
      aggregates.some(
        (value) => value.economicsReasons.SPREAD_COST_TOO_HIGH === 1,
      ),
    ).toBe(true);
  });
});
