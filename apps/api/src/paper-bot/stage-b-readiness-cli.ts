import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Pool } from "pg";
import {
  runStageBReadiness,
  stageBReadinessSummary,
  type StageBMarket,
  STAGE_B_MARKET_CURRENCY,
} from "./stage-b-readiness.js";

/**
 * Read-only Stage B readiness CLI.
 *
 * Usage:
 *   pnpm --filter @tsx-scanner/api funded-stage-b-readiness --market=<CA_TSX|US_EQUITIES> \
 *     [--as-of=<ISO timestamp>] [--output=<path>] [--summary] [--code-revision=<sha>]
 *
 * The command performs only SELECTs inside a REPEATABLE READ READ ONLY
 * transaction. It never creates a Stage B approval, gate policy, enrollment,
 * prediction or authority row.
 */

const usage =
  "Usage: funded-stage-b-readiness --market=<CA_TSX|US_EQUITIES> [--as-of=<ISO timestamp>] [--output=<path>] [--summary] [--code-revision=<sha>]";

async function main(): Promise<void> {
  const flags = process.argv.slice(2);

  function flagValue(name: string): string | undefined {
    const prefix = `--${name}=`;
    const matches = flags.filter((flag) => flag.startsWith(prefix));
    if (matches.length > 1) throw new Error(`Duplicate ${prefix} flag`);
    return matches[0]?.slice(prefix.length);
  }

  const knownFlags = flags.every(
    (flag) =>
      flag === "--summary" ||
      flag.startsWith("--market=") ||
      flag.startsWith("--as-of=") ||
      flag.startsWith("--output=") ||
      flag.startsWith("--code-revision="),
  );
  if (!knownFlags) throw new Error(usage);

  const market = flagValue("market");
  if (market !== "CA_TSX" && market !== "US_EQUITIES") throw new Error(usage);
  const asOfValue = flagValue("as-of");
  if (asOfValue !== undefined && !Number.isFinite(Date.parse(asOfValue)))
    throw new Error("--as-of must be an ISO timestamp");
  const output = flagValue("output");
  const codeRevision = flagValue("code-revision");
  const summary = flags.includes("--summary");

  if (!process.env.DATABASE_URL)
    throw new Error(
      "Set DATABASE_URL explicitly; this command never migrates the database",
    );

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  try {
    const receipt = await runStageBReadiness(pool, {
      market: market as StageBMarket,
      asOf: asOfValue ? new Date(asOfValue).toISOString() : undefined,
      codeRevision,
    });
    const currency = STAGE_B_MARKET_CURRENCY[receipt.report.market];
    if (receipt.report.currency !== currency)
      throw new Error("Stage B readiness market/currency isolation violation");
    if (output) {
      mkdirSync(dirname(output), { recursive: true });
      writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      console.log(stageBReadinessSummary(receipt.report));
      console.log(`receipt written: ${output}`);
    } else if (summary) {
      console.log(stageBReadinessSummary(receipt.report));
    } else {
      console.log(JSON.stringify(receipt, null, 2));
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
