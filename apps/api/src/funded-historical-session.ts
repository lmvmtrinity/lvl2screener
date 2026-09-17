import { Pool } from "pg";
import { PostgresBacktestStore } from "./backtests/backtest-repository.js";
import { loadConfig } from "./config.js";
import { ScannerFeatureClient } from "./market-data/scanner-client.js";
import {
  historicalFundedAccountId,
  historicalMarketRisk,
} from "./paper-bot/funded-historical-config.js";
import { runFundedHistoricalRange } from "./paper-bot/funded-historical-runner.js";
import { FundedReportingService } from "./paper-bot/funded-reporting-service.js";

const [backtestRunId, flag, extra] = process.argv.slice(2);
if (
  !backtestRunId ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    backtestRunId,
  ) ||
  flag !== "--apply" ||
  extra
)
  throw new Error(
    "Usage: funded-historical-session <completed backtest run UUID> --apply\n" +
      "Preview was removed: it provisioned a funded run, account binding and observations " +
      "before computing results, so it was not effect-free. Read an existing replay through " +
      "GET /api/funded-replays, or use a policy-approved automation replay.",
  );
if (!process.env.DATABASE_URL)
  throw new Error(
    "Set DATABASE_URL explicitly; this command never migrates the database",
  );
const config = loadConfig();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

try {
  const store = new PostgresBacktestStore(pool);
  const backtest = await store.get(backtestRunId);
  if (!backtest)
    throw new Error(
      "Funded historical replay requires a COMPLETED backtest run",
    );
  const risk = historicalMarketRisk(config, backtest.marketId);
  const accountId = historicalFundedAccountId(
    backtest.marketId,
    risk.initialCash,
    risk.dailyLossLimit,
  );
  const result = await runFundedHistoricalRange(
    { backtestRunId, accountId, apply: true },
    {
      pool,
      config,
      engine: new ScannerFeatureClient(
        new URL(config.SCANNER_URL),
        10_000,
        config.SCANNER_SERVICE_TOKEN || undefined,
      ),
      store,
      reporting: new FundedReportingService(pool),
    },
  );

  if (result.sessionCount === 1) {
    const session = result.sessions[0]!;
    console.log(
      JSON.stringify(
        {
          backtestRunId,
          fundedRunId: session.fundedRunId,
          accountId,
          reusedRun: session.reusedRun,
          applied: true,
          sessionDate: session.sessionDate,
          sessionStartAt: session.sessionStartAt,
          scheduledCloseAt: session.scheduledCloseAt,
          bridge: session.bridge,
          replay: session.replay,
          runStatus: session.runStatus,
          projection: session.projection ?? null,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(
      JSON.stringify(
        {
          backtestRunId,
          marketId: result.marketId,
          accountId,
          currency: result.currency,
          sessionCount: result.sessionCount,
          sessions: result.sessions,
          accountSummary: result.accountSummary,
        },
        null,
        2,
      ),
    );
  }
} finally {
  await pool.end();
}
