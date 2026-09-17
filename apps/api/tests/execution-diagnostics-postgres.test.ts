import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrate } from "../src/database/migrate.js";
import { FundedReportingService } from "../src/paper-bot/funded-reporting-service.js";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { ExecutionDiagnosticAutomation } from "../src/paper-bot/execution-diagnostic-automation.js";
import { PostgresEvidenceAutomationRepository } from "../src/statistical-models/evidence-automation-repository.js";
import { ResearchJobRepository } from "../src/research-jobs/research-job-repository.js";

const databaseUrl = isolatedDatabaseUrl("AUDIT_TEST_DATABASE_URL");
const RUN = "10000000-0000-4000-8000-000000000901";
const LATER_RUN = "10000000-0000-4000-8000-000000000902";
const US_RUN = "10000000-0000-4000-8000-000000000903";
const ACCOUNT = "10000000-0000-4000-8000-000000000911";
const US_ACCOUNT = "10000000-0000-4000-8000-000000000912";
const INSTRUMENT = "10000000-0000-4000-8000-000000000921";
const US_INSTRUMENT = "10000000-0000-4000-8000-000000000922";
const ORDER = "10000000-0000-4000-8000-000000000931";
const US_ORDER = "10000000-0000-4000-8000-000000000932";
const T0 = "2026-09-10T14:00:00.000Z";
const T1 = "2026-09-10T14:01:00.000Z";
const BOUNDARY = "2026-09-10T14:02:00.000Z";

const assumptions = {
  positionSize: 600,
  slippageBps: 0,
  feePerTrade: 0,
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
};

function ledger(currency: "CAD" | "USD") {
  return {
    version: "funded-ledger-v1",
    currency,
    cash: 100000,
    session: "2026-09-10",
    openingEquity: 100000,
    dailyLossLimit: 1000,
    realizedPnl: 0,
    positions: {},
    reservations: {},
    events: [],
    lastEventAt: BOUNDARY,
  };
}

async function seedRun(
  pool: Pool,
  input: {
    runId: string;
    accountId: string;
    instrumentId: string;
    marketId: "CA_TSX" | "US_EQUITIES";
    currency: "CAD" | "USD";
    source?: "LIVE" | "BACKTEST";
    orderId?: string;
    unverified?: boolean;
  },
) {
  const { runId, accountId, instrumentId, marketId, currency, orderId } = input;
  await pool.query(
    `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,
       security_type,is_quotable,is_tradable,active,market_id)
     VALUES($1,$2,$3,$4,$5,$6,'Stock',true,true,true,$7)`,
    [
      instrumentId,
      input.runId === RUN ? 990901 : input.runId === US_RUN ? 990902 : 990903,
      input.runId === US_RUN
        ? "DIAG.US"
        : input.runId === RUN
          ? "DIAG.TO"
          : "DIAG2.TO",
      "Diagnostics fixture",
      marketId === "CA_TSX" ? "TSX" : "NYSE",
      currency,
      marketId,
    ],
  );
  await pool.query(
    `INSERT INTO paper_bot_run(id,source,session_date,scheduled_close_at,status,
       execution_model_version,assumptions,completed_at,market_id)
     VALUES($1,$2,'2026-09-10',$3,'COMPLETED','paper-execution-v1',$4::jsonb,$3,$5)`,
    [
      runId,
      input.source ?? "BACKTEST",
      BOUNDARY,
      JSON.stringify(assumptions),
      marketId,
    ],
  );
  await pool.query(
    `INSERT INTO paper_funded_account(id,initial_state,state)
     VALUES($1,$2::jsonb,$2::jsonb)
     ON CONFLICT(id) DO NOTHING`,
    [accountId, JSON.stringify(ledger(currency))],
  );
  await pool.query(
    `INSERT INTO paper_funded_run(run_id,account_id,currency)
     VALUES($1,$2,$3)`,
    [runId, accountId, currency],
  );
  await pool.query(
    `INSERT INTO paper_funded_run_snapshot(run_id,account_id,boundary_at,state,orders)
     VALUES($1,$2,$3,$4::jsonb,'[]'::jsonb)`,
    [runId, accountId, BOUNDARY, JSON.stringify(ledger(currency))],
  );
  if (!orderId) return;
  const pending = {
    version: "pending-entry-v1",
    orderId,
    status: "PENDING",
    submittedAt: T0,
    releaseAt: T0,
    expiresAt: BOUNDARY,
  };
  const filled = {
    ...pending,
    status: "FILLED",
    execution: {
      status: "OPEN",
      position: { shares: 40, entryTime: T1, entryPrice: 10 },
    },
  };
  // Order history is captured only through the production path: insert the
  // pending revision and then apply the fill update, so the database captures
  // both revisions with its own recording clock.
  await pool.query(
    `INSERT INTO paper_entry_order(order_id,run_id,instrument_id,submission,state,revision,last_fact_at)
     VALUES($1,$2,$3,$4::jsonb,$5::jsonb,0,$6)`,
    [
      orderId,
      runId,
      instrumentId,
      JSON.stringify({
        orderId,
        submittedAt: T0,
        releaseAt: T0,
        expiresAt: BOUNDARY,
      }),
      JSON.stringify(pending),
      T0,
    ],
  );
  await pool.query(
    `UPDATE paper_entry_order
        SET state=$2::jsonb,last_fact_at=$3::timestamptz,
            revision=revision+1,updated_at=now()
      WHERE order_id=$1`,
    [orderId, JSON.stringify(filled), T1],
  );
  const quote = (timestamp: string) => ({
    type: "QUOTE",
    instrumentId,
    participation: 1,
    impactBps: 0,
    quote: {
      timestamp,
      bid: 9.99,
      ask: 10,
      bidSize: 100,
      askSize: 100,
      dataStatus: "REALTIME",
      actionable: true,
    },
  });
  await pool.query(
    `INSERT INTO paper_funded_fact(run_id,fact_id,fact_at,priority,sort_key,fact,outcome)
     VALUES($1,'quote-1',$2,2,'quote-1',$3::jsonb,'{"status":"APPLIED"}'::jsonb),
           ($1,'quote-2',$4,2,'quote-2',$5::jsonb,'{"status":"APPLIED"}'::jsonb)`,
    [runId, T0, JSON.stringify(quote(T0)), T1, JSON.stringify(quote(T1))],
  );
  await pool.query(
    `INSERT INTO paper_funded_event(account_id,event_id,event,event_sequence_verified)
     VALUES($1,'buy-1',$2::jsonb,$3)`,
    [
      accountId,
      JSON.stringify({
        id: "buy-1",
        at: T1,
        currency,
        type: "BUY",
        orderId,
        positionId: orderId,
        instrumentId,
        shares: 40,
        price: 10,
        fee: 0,
        stop: 9,
      }),
      !input.unverified,
    ],
  );
}

describe.skipIf(!databaseUrl)(
  "execution diagnostics PostgreSQL acceptance",
  () => {
    let pool: Pool;
    beforeAll(async () => {
      pool = new Pool({ connectionString: databaseUrl, max: 5 });
      await migrate(pool);
      await seedRun(pool, {
        runId: RUN,
        accountId: ACCOUNT,
        instrumentId: INSTRUMENT,
        marketId: "CA_TSX",
        currency: "CAD",
        orderId: ORDER,
        source: "LIVE",
      });
      await seedRun(pool, {
        runId: LATER_RUN,
        accountId: ACCOUNT,
        instrumentId: "10000000-0000-4000-8000-000000000923",
        marketId: "CA_TSX",
        currency: "CAD",
        source: "BACKTEST",
      });
      await seedRun(pool, {
        runId: US_RUN,
        accountId: US_ACCOUNT,
        instrumentId: US_INSTRUMENT,
        marketId: "US_EQUITIES",
        currency: "USD",
        orderId: US_ORDER,
        source: "BACKTEST",
        unverified: true,
      });
    }, 60_000);
    afterAll(async () => {
      await pool?.end();
    });

    it("retains an immutable run-end report and excludes later activity", async () => {
      const service = new FundedReportingService(
        pool,
        () => new Date("2026-09-10T21:00:00.000Z"),
      );
      const first = await service.saveExecutionDiagnostics(RUN, {
        mode: "RUN_END",
        marketId: "CA_TSX",
      });
      expect(first.identity.reportVersion).toBe("execution-diagnostics-v2");
      const atFill = first.report.contention.rows.filter(
        (row) => row.quoteEvidenceId === "quote-2",
      );
      expect(atFill.find((row) => row.orderId === ORDER)?.filledShares).toBe(
        40,
      );
      expect(atFill.every((row) => row.canonicalRank === null)).toBe(true);
      await pool.query(
        `INSERT INTO paper_funded_fact(run_id,fact_id,fact_at,priority,sort_key,fact,outcome)
       VALUES($1,'late',$2,2,'late',$3::jsonb,'{"status":"APPLIED"}'::jsonb)`,
        [
          RUN,
          "2026-09-10T14:10:00.000Z",
          JSON.stringify({
            type: "QUOTE",
            instrumentId: INSTRUMENT,
            participation: 1,
            impactBps: 0,
            quote: {
              timestamp: "2026-09-10T14:10:00.000Z",
              bid: 8,
              ask: 8.01,
              bidSize: 1,
              askSize: 1,
              dataStatus: "REALTIME",
              actionable: true,
            },
          }),
        ],
      );
      const response = await service.getExecutionDiagnostics(RUN, {
        mode: "RUN_END",
        marketId: "CA_TSX",
      });
      expect(response.status).toBe("READY");
      expect(response.report?.sourceDigest).toBe(first.identity.sourceDigest);
      expect(response.report?.scope.asOf).toBe(BOUNDARY);
      expect(
        (
          await service.saveExecutionDiagnostics(RUN, {
            mode: "RUN_END",
            marketId: "CA_TSX",
          })
        ).id,
      ).toBe(first.id);
      await expect(
        pool.query(
          "UPDATE execution_diagnostic_report SET report=report WHERE id=$1",
          [first.id],
        ),
      ).rejects.toThrow("IMMUTABLE_EXECUTION_DIAGNOSTIC_REPORT");
      await expect(
        pool.query("DELETE FROM execution_diagnostic_report WHERE id=$1", [
          first.id,
        ]),
      ).rejects.toThrow("IMMUTABLE_EXECUTION_DIAGNOSTIC_REPORT");
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM execution_diagnostic_report",
          )
        ).rows[0].count,
      ).toBe(1);
    });

    it("prepares 205 completed sources across pages and preserves receipt linkage", async () => {
      const pageAccount = "90000000-0000-4000-8000-999999999999";
      await pool.query(
        "INSERT INTO paper_funded_account(id,initial_state,state) VALUES($1,$2::jsonb,$2::jsonb)",
        [pageAccount, JSON.stringify(ledger("CAD"))],
      );
      await pool.query(
        `INSERT INTO paper_bot_run(id,source,session_date,scheduled_close_at,status,execution_model_version,assumptions,completed_at,market_id)
        SELECT ('90000000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'BACKTEST','2026-09-10',$1,'COMPLETED','paper-execution-v1',$2::jsonb,$1,'CA_TSX' FROM generate_series(1,205) n`,
        [BOUNDARY, JSON.stringify(assumptions)],
      );
      await pool.query(
        `INSERT INTO paper_funded_run(run_id,account_id,currency) SELECT id,$1,'CAD' FROM paper_bot_run WHERE id::text LIKE '90000000-%'`,
        [pageAccount],
      );
      await pool.query(
        `INSERT INTO paper_funded_run_snapshot(run_id,account_id,boundary_at,state,orders) SELECT id,$1,$2,$3::jsonb,'[]'::jsonb FROM paper_bot_run WHERE id::text LIKE '90000000-%'`,
        [pageAccount, BOUNDARY, JSON.stringify(ledger("CAD"))],
      );
      const automation = new ExecutionDiagnosticAutomation(
        pool,
        new PostgresEvidenceAutomationRepository(pool),
        new ResearchJobRepository(pool),
      );
      const receipt = vi
        .spyOn(
          PostgresEvidenceAutomationRepository.prototype,
          "recordWithClient",
        )
        .mockRejectedValueOnce(new Error("receipt write failed"));
      await expect(automation.catchUp("CA_TSX", 1)).rejects.toThrow(
        "receipt write failed",
      );
      receipt.mockRestore();
      expect(
        (
          await pool.query(
            "SELECT count(*)::int AS count FROM research_job WHERE job_type='EXECUTION_DIAGNOSTICS'",
          )
        ).rows[0].count,
      ).toBe(0);
      for (let n = 0; n < 12; n++) await automation.catchUp("CA_TSX", 100);
      const counted = await pool.query(
        `SELECT count(*)::int AS count FROM research_job j JOIN research_evidence_work w ON w.job_id=j.id WHERE j.job_type='EXECUTION_DIAGNOSTICS' AND j.request_payload->>'runId' LIKE '90000000-%'`,
      );
      expect(counted.rows[0].count).toBe(205);
      expect(await automation.catchUp("CA_TSX")).toBe(0);
    }, 60_000);

    it("keeps current-account and market scopes separate and fails closed for legacy order", async () => {
      const service = new FundedReportingService(pool);
      const current = await service.buildExecutionDiagnostics(RUN, {
        mode: "CURRENT_ACCOUNT",
        marketId: "CA_TSX",
      });
      expect(current.scope.runIds).toEqual([LATER_RUN, RUN].sort());
      await expect(
        service.buildExecutionDiagnostics(RUN, {
          mode: "AS_OF",
          at: "2026-09-10T14:03:00.000Z",
          marketId: "CA_TSX",
        }),
      ).rejects.toThrow("after the completed run boundary");
      const legacy = await service.buildExecutionDiagnostics(US_RUN, {
        mode: "RUN_END",
        marketId: "US_EQUITIES",
      });
      expect(legacy.scope.marketId).toBe("US_EQUITIES");
      expect(legacy.replenishment.unavailable).toContain(
        "UNVERIFIED_EVENT_SEQUENCE",
      );
      await expect(
        service.buildExecutionDiagnostics(RUN, {
          mode: "RUN_END",
          marketId: "US_EQUITIES",
        }),
      ).rejects.toThrow("EXECUTION_DIAGNOSTIC_MARKET_MISMATCH");
    });

    it("dispatches an oversized retained history without a full jsonb aggregate", async () => {
      const oversizedRun = "10000000-0000-4000-8000-000000000904";
      const oversizedAccount = "10000000-0000-4000-8000-000000000914";
      const oversizedInstrument = "10000000-0000-4000-8000-000000000924";
      await pool.query(
        `INSERT INTO instrument(id,questrade_symbol_id,symbol,description,exchange,currency,security_type,is_quotable,is_tradable,active,market_id)
         VALUES($1,990904,'OVERSIZE.TO','Oversized diagnostics fixture','TSX','CAD','Stock',true,true,true,'CA_TSX')`,
        [oversizedInstrument],
      );
      await pool.query(
        `INSERT INTO paper_bot_run(id,source,session_date,scheduled_close_at,status,execution_model_version,assumptions,completed_at,market_id)
         VALUES($1,'BACKTEST','2026-09-10',$2,'COMPLETED','paper-execution-v1',$3::jsonb,$2,'CA_TSX')`,
        [oversizedRun, BOUNDARY, JSON.stringify(assumptions)],
      );
      await pool.query(
        "INSERT INTO paper_funded_account(id,initial_state,state) VALUES($1,$2::jsonb,$2::jsonb)",
        [oversizedAccount, JSON.stringify(ledger("CAD"))],
      );
      await pool.query(
        "INSERT INTO paper_funded_run(run_id,account_id,currency) VALUES($1,$2,'CAD')",
        [oversizedRun, oversizedAccount],
      );
      await pool.query(
        `INSERT INTO paper_funded_run_snapshot(run_id,account_id,boundary_at,state,orders)
         VALUES($1,$2,$3,$4::jsonb,'[]'::jsonb)`,
        [
          oversizedRun,
          oversizedAccount,
          BOUNDARY,
          JSON.stringify(ledger("CAD")),
        ],
      );
      // Deliberately exceeds PostgreSQL's 256 MB jsonb array-element limit when every row
      // is aggregated into one array, which must no longer break catch-up.
      await pool.query(
        `INSERT INTO paper_funded_fact(run_id,fact_id,fact_at,priority,sort_key,fact,outcome)
         SELECT $1,'bulk:'||lpad(n::text,6,'0'),$2::timestamptz - interval '1 second',2,'',
                jsonb_build_object('type','QUOTE','pad',repeat('x',4000)),'{"status":"APPLIED"}'::jsonb
           FROM generate_series(1,75000) n`,
        [oversizedRun, BOUNDARY],
      );
      const automation = new ExecutionDiagnosticAutomation(
        pool,
        new PostgresEvidenceAutomationRepository(pool),
        new ResearchJobRepository(pool),
      );
      const oversizedJobs = async () =>
        (
          await pool.query<{ count: number }>(
            `SELECT count(*)::int AS count FROM research_job j
              WHERE j.job_type='EXECUTION_DIAGNOSTICS'
                AND j.request_payload->>'runId'=$1`,
            [oversizedRun],
          )
        ).rows[0]!.count;
      // Other suites sharing this database may leave their own eligible completed
      // runs ahead of this one in the catch-up ordering.
      for (let page = 0; page < 30 && (await oversizedJobs()) === 0; page += 1)
        await automation.catchUp("CA_TSX", 100);
      expect(await oversizedJobs()).toBe(1);
    }, 180_000);
  },
);
