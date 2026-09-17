import { Pool } from "pg";
import { replayFundedHistoricalSession } from "./paper-bot/funded-replay-service.js";

const [runId, flag, extra] = process.argv.slice(2);
if (
  !runId ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    runId,
  ) ||
  (flag && flag !== "--apply") ||
  extra
)
  throw new Error(
    "Usage: funded-historical-replay <bound BACKTEST run UUID> [--apply]",
  );
if (!process.env.DATABASE_URL)
  throw new Error(
    "Set DATABASE_URL explicitly; this command never migrates the database",
  );
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
try {
  console.log(
    JSON.stringify(
      await replayFundedHistoricalSession(pool, runId, flag === "--apply"),
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
