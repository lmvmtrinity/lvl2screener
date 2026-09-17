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
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../src/backtests/execution-provenance.js";
import { migrate } from "../src/database/migrate.js";
import { PostgresProfileStore } from "../src/profiles/profile-repository.js";

/**
 * Paper qualification is computed entirely in SQL (`profileSelect`), so the
 * fake-store suites cannot reach it. This fixture exercises the real query
 * against PostgreSQL, the same way persistence-performance.test.ts does:
 * skipped when no database is reachable, required in CI via
 * REQUIRE_POSTGRES_INTEGRATION.
 *
 * It pins the behaviour ADR-009 requires: automated evidence is counted within
 * a single completed execution-model/assumptions cohort.
 */
const DATABASE_URL = isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");

const BULL_FLAG_PROFILE_ID = "10000000-0000-4000-8000-000000000088"; // seeded in 038-remaining-setup-profiles.sql
const BULL_FLAG_CONFIG_ID = "10000000-0000-4000-8000-000000000098";
const ORB_STANDARD_PROFILE_ID = "10000000-0000-4000-8000-000000000081";
// Reserved id space so this fixture's rows are identifiable and removable in a shared dev database.
const RUN_PRIOR = "2f000000-0000-4000-8000-000000000001";
const RUN_CURRENT = "2f000000-0000-4000-8000-000000000002";
const OBS_PRIOR = "3f000000-0000-4000-8000-000000000001";
const OBS_CURRENT = "3f000000-0000-4000-8000-000000000002";
// Dated ahead of any real run so this fixture's cohort is the most recent one.
const SESSION_PRIOR = "2199-01-01";
const SESSION_CURRENT = "2199-01-02";

const assumptions = (slippageBps: number) => ({
  positionSize: 10_000,
  slippageBps,
  feePerTrade: 9.95,
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
  evidenceScope: "FORWARD_LIVE",
});

let pool: Pool | undefined;
let boundaryInstrumentIds: string[] = [];

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
      `[profile-paper-qualification] Skipping: no reachable PostgreSQL at ${DATABASE_URL} (${
        error instanceof Error ? error.message : String(error)
      }). Start it with \`docker compose up -d postgres\` to run this fixture.`,
    );
    await candidate.end().catch(() => {});
  }
}, 15_000);

/**
 * `paper_signal_observation` and `paper_execution` cascade from the run, but
 * completing a run fires `refresh_paper_profile_qualifications`, whose row
 * references the run through `as_of_run_id` with no cascade. Dropping that
 * projection first is what makes this fixture re-runnable against a
 * development database instead of only against a pristine CI service
 * container.
 */
async function cleanup(db: Pool): Promise<void> {
  const runs = [RUN_PRIOR, RUN_CURRENT];
  await db.query(
    "DELETE FROM paper_profile_qualification WHERE as_of_run_id = ANY($1::uuid[])",
    [runs],
  );
  await db.query("DELETE FROM paper_bot_run WHERE id = ANY($1::uuid[])", [
    runs,
  ]);
}

beforeEach(async () => {
  if (pool) await cleanup(pool);
});

afterEach(async () => {
  if (pool) {
    await cleanup(pool);
    await pool.query("DELETE FROM instrument WHERE id=ANY($1::uuid[])", [
      boundaryInstrumentIds,
    ]);
    boundaryInstrumentIds = [];
  }
});

afterAll(async () => {
  if (pool) await pool.end();
});

async function seedCohort(
  db: Pool,
  runId: string,
  sessionDate: string,
  slippageBps: number,
  observationId: string,
): Promise<void> {
  const inst = await db.query<{ id: string }>(
    `INSERT INTO instrument(questrade_symbol_id,symbol,description,exchange,currency,
       security_type,industry_sector,is_quotable,is_tradable,active)
     VALUES(999002,'QUALIFY.TO','Qualification fixture','TSX','CAD','Stock',
       'Financial Services',true,true,true)
     ON CONFLICT (questrade_symbol_id) DO UPDATE SET active=true
     RETURNING id`,
  );
  const instrumentId = inst.rows[0]?.id;
  await db.query(
    `INSERT INTO paper_bot_run(id,source,session_date,scheduled_close_at,status,execution_model_version,assumptions)
     VALUES($1,'LIVE',$2::date,now(),'RUNNING',$4,$3::jsonb)`,
    [
      runId,
      sessionDate,
      JSON.stringify(assumptions(slippageBps)),
      // Bound to the constant, not to a literal: qualification only counts
      // evidence from the authoritative model, so a version bump must move
      // this fixture with it rather than silently emptying its cohort.
      AUTHORITATIVE_EXECUTION_MODEL_VERSION,
    ],
  );
  await db.query(
    `INSERT INTO paper_signal_observation(id,run_id,source_event_id,instrument_id,symbol,profile_id,profile_name,
       profile_config_id,config_version,profile_parameters,strategy_key,strategy_version,signal_timestamp,score,
       reason_codes,source_event_payload,eligibility_status)
     VALUES($1,$2,gen_random_uuid(),$5,'QUALIFY.TO',$3,'Bull Flag',$4,
       'profile-bull-flag-v1','{}'::jsonb,'BULL_FLAG','1.0.0',now(),80,'[]'::jsonb,
       '{"signalSemanticsVersion":"setup-semantics-v2"}'::jsonb,'ELIGIBLE')`,
    [
      observationId,
      runId,
      BULL_FLAG_PROFILE_ID,
      BULL_FLAG_CONFIG_ID,
      instrumentId,
    ],
  );
  // Every observation carries both models; only the canonical QUOTE one may count.
  await db.query(
    `INSERT INTO paper_execution(observation_id,model,status,entry_price,entry_time,stop_price,target_price,
       shares,initial_risk,exit_price,exit_time,exit_reason,fee,gross_pnl,net_pnl,r_multiple)
     SELECT $1,m,'CLOSED',10,now(),9,12,100,100,11,now(),'TARGET',9.95,100,90.05,0.9005
     FROM unnest(ARRAY['QUOTE','CANDLE']) m`,
    [observationId],
  );
  await db.query(
    "UPDATE paper_bot_run SET status='COMPLETED', completed_at=now() WHERE id=$1",
    [runId],
  );
}

const bullFlag = async (db: Pool) => {
  const profiles = await new PostgresProfileStore(db).listProfiles();
  const found = profiles.find((v) => v.id === BULL_FLAG_PROFILE_ID);
  if (!found) throw new Error("Bull Flag profile is not seeded");
  return found;
};

describe("paper qualification from paper-bot evidence", () => {
  it("counts one closed trade per observation, not one per execution model", async () => {
    if (!pool) return;
    await seedCohort(pool, RUN_CURRENT, SESSION_CURRENT, 2, OBS_CURRENT);

    // Both a QUOTE and a CANDLE execution exist; counting both would report 2.
    expect(await bullFlag(pool)).toMatchObject({
      qualification: "EXPLORATORY",
      qualificationReason: expect.stringContaining("1 closed paper trade"),
    });
  });

  it("excludes trades executed under a different assumptions snapshot", async () => {
    if (!pool) return;
    await seedCohort(pool, RUN_PRIOR, SESSION_PRIOR, 5, OBS_PRIOR);
    await seedCohort(pool, RUN_CURRENT, SESSION_CURRENT, 2, OBS_CURRENT);

    // The slippageBps=5 run is a separate cohort and must not inflate the sample.
    expect((await bullFlag(pool)).qualificationReason).toContain(
      "1 closed paper trade",
    );
  });

  it("attributes evidence only to the profile configuration that produced it", async () => {
    if (!pool) return;
    await seedCohort(pool, RUN_CURRENT, SESSION_CURRENT, 2, OBS_CURRENT);

    const profiles = await new PostgresProfileStore(pool).listProfiles();
    expect(
      profiles.find((v) => v.id === ORB_STANDARD_PROFILE_ID),
    ).toMatchObject({
      qualification: "EXPLORATORY",
      qualificationReason:
        "No qualifying paper or holdout evidence is linked to this profile configuration.",
    });
  });

  it("reports no qualifying evidence when no bot cohort exists", async () => {
    if (!pool) return;
    expect((await bullFlag(pool)).qualificationReason).toBe(
      "No qualifying paper or holdout evidence is linked to this profile configuration.",
    );
  });
});

async function seedBoundaryCohort(
  db: Pool,
  lateLabels: boolean,
): Promise<void> {
  await db.query(
    `INSERT INTO paper_bot_run(id,source,session_date,scheduled_close_at,status,execution_model_version,assumptions)
     VALUES($1,'LIVE','2199-01-07','2199-01-07T21:00:00Z','RUNNING',$2,$3::jsonb)`,
    [
      RUN_CURRENT,
      AUTHORITATIVE_EXECUTION_MODEL_VERSION,
      JSON.stringify(assumptions(37)),
    ],
  );
  const seeded = await db.query<{ id: string }>(
    `INSERT INTO instrument(questrade_symbol_id,symbol,description,exchange,currency,
       security_type,industry_sector,is_quotable,is_tradable,active)
     SELECT 1999002000+n,'QUAL_BOUND_'||n||'.TO','Label boundary fixture','TSX','CAD',
       'Stock','Financial Services',true,true,true FROM generate_series(0,199) n
     RETURNING id`,
  );
  boundaryInstrumentIds = seeded.rows.map((row) => row.id);
  await db.query(
    `INSERT INTO paper_signal_observation(run_id,source_event_id,instrument_id,symbol,profile_id,profile_name,
       profile_config_id,config_version,profile_parameters,strategy_key,strategy_version,signal_timestamp,score,
       reason_codes,source_event_payload,eligibility_status)
     SELECT $1,gen_random_uuid(),id,'BOUNDARY.TO',$2,'Bull Flag',$3,
       'profile-bull-flag-v1','{}'::jsonb,'BULL_FLAG','1.0.0',
       '2199-01-04T14:00:00Z'::timestamptz + ((ordinal-1)/50)*interval '1 day'
         + ((ordinal-1)%50)*interval '2 minutes',80,'[]'::jsonb,
       '{"signalSemanticsVersion":"setup-semantics-v2"}'::jsonb,'ELIGIBLE'
     FROM unnest($4::uuid[]) WITH ORDINALITY AS inputs(id,ordinal)`,
    [
      RUN_CURRENT,
      BULL_FLAG_PROFILE_ID,
      BULL_FLAG_CONFIG_ID,
      boundaryInstrumentIds,
    ],
  );
  await db.query(
    `INSERT INTO paper_execution(observation_id,model,status,entry_price,entry_time,stop_price,target_price,
       shares,initial_risk,exit_price,exit_time,exit_reason,fee,gross_pnl,net_pnl,r_multiple)
     SELECT id,'QUOTE','CLOSED',10,signal_timestamp,9,12,100,100,11,
       CASE WHEN $2 THEN '2199-01-07T20:00:00Z'::timestamptz ELSE signal_timestamp+interval '1 minute' END,
       'TARGET',0,CASE WHEN extract(minute FROM signal_timestamp)::int%8=0 THEN -100 ELSE 100 END,
       CASE WHEN extract(minute FROM signal_timestamp)::int%8=0 THEN -100 ELSE 100 END,
       CASE WHEN extract(minute FROM signal_timestamp)::int%8=0 THEN -1 ELSE 1 END
     FROM paper_signal_observation WHERE run_id=$1`,
    [RUN_CURRENT, lateLabels],
  );
  await db.query(
    "UPDATE paper_bot_run SET status='COMPLETED',completed_at=now() WHERE id=$1",
    [RUN_CURRENT],
  );
}

describe("profile research label boundaries", () => {
  it("rejects cross-instrument future labels despite positive four-session results", async () => {
    if (!pool) return;
    await seedBoundaryCohort(pool, true);
    expect((await bullFlag(pool)).qualification).toBe("EXPLORATORY");
    const projection = await pool.query(
      "SELECT qualification,closed_trades FROM paper_profile_qualification WHERE as_of_run_id=$1 AND policy_version='paper-qualification-v4'",
      [RUN_CURRENT],
    );
    expect(projection.rows[0]).toMatchObject({
      qualification: "EXPLORATORY",
      closed_trades: 200,
    });
  });

  it("qualifies available labels and refreshes the same cohort idempotently", async () => {
    if (!pool) return;
    await seedBoundaryCohort(pool, false);
    await pool.query("SELECT refresh_paper_profile_qualifications($1)", [
      RUN_CURRENT,
    ]);
    expect((await bullFlag(pool)).qualification).toBe("PAPER_QUALIFIED");
    const projection = await pool.query(
      "SELECT net_pnl FROM paper_profile_qualification WHERE as_of_run_id=$1 AND policy_version='paper-qualification-v4'",
      [RUN_CURRENT],
    );
    expect(projection.rows).toHaveLength(1);
    expect(Number(projection.rows[0].net_pnl)).toBeGreaterThan(1000);
  });
});
