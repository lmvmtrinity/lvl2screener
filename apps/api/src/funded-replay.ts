import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { replayFundedFacts } from "./paper-bot/funded-replay-service.js";

const [runId, filename, flag, extra] = process.argv.slice(2);
if (
  !runId ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    runId,
  ) ||
  !filename ||
  (flag && flag !== "--apply") ||
  extra
)
  throw new Error(
    "Usage: funded-replay <bound BACKTEST run UUID> <facts.json> [--apply]",
  );
if (!process.env.DATABASE_URL)
  throw new Error(
    "Set DATABASE_URL explicitly; this command never migrates the database",
  );
const input: unknown = JSON.parse(await readFile(filename, "utf8"));
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
try {
  console.log(
    JSON.stringify(
      await replayFundedFacts(pool, runId, input, flag === "--apply"),
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
