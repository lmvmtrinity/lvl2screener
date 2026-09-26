import { createImportProgress } from "./historical-archive/import-progress.js";
import { parseArgs } from "node:util";
import { Pool } from "pg";
import { PostgresHistoricalArchiveStore } from "./historical-archive/archive-repository.js";
import {
  localDate,
  runArchiveImport,
} from "./historical-archive/archive-importer.js";
import {
  DatabentoHistoryClient,
  MassiveHistoryClient,
} from "./historical-archive/provider-clients.js";

/**
 * Imports US provider history into the research archive (ADR-019).
 *
 *   historical-import --symbols COIN,OKTA --start 2026-06-01 --end 2026-08-31
 *     [--max-cost 5] [--dry-run] [--no-benchmarks] [--bars-only | --quotes-only]
 *
 * Symbols must already be US_EQUITIES instruments. Benchmarks are included by
 * default because every replay session needs them. The Databento cost of the
 * whole plan is priced first and the command stops before downloading anything
 * when it exceeds --max-cost. Covered ranges are skipped, so reruns resume.
 */
const { values } = parseArgs({
  options: {
    symbols: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    "max-cost": { type: "string", default: "5" },
    "dry-run": { type: "boolean", default: false },
    "no-benchmarks": { type: "boolean", default: false },
    "bars-only": { type: "boolean", default: false },
    "quotes-only": { type: "boolean", default: false },
  },
  strict: true,
});
const date = /^\d{4}-\d{2}-\d{2}$/;
if (
  !values.symbols ||
  !values.start ||
  !values.end ||
  !date.test(values.start) ||
  !date.test(values.end)
)
  throw new Error(
    "Usage: historical-import --symbols A,B --start YYYY-MM-DD --end YYYY-MM-DD [--max-cost 5] [--dry-run] [--no-benchmarks] [--bars-only|--quotes-only]",
  );
if (values["bars-only"] && values["quotes-only"])
  throw new Error("--bars-only and --quotes-only are mutually exclusive");
const maxCostUsd = Number(values["max-cost"]);
if (!Number.isFinite(maxCostUsd) || maxCostUsd < 0)
  throw new Error("--max-cost must be a non-negative number of US dollars");
if (!process.env.DATABASE_URL)
  throw new Error(
    "Set DATABASE_URL explicitly; this command never migrates the database",
  );

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const progress = createImportProgress(
  values["quotes-only"]
    ? "Quotes (step 2)"
    : values["bars-only"]
      ? "Bars (step 3)"
      : "Bars and quotes",
  values.start,
  values.end,
);
const heartbeat = setInterval(() => progress.save(), 10_000);
try {
  const summary = await runArchiveImport(
    {
      pool,
      store: new PostgresHistoricalArchiveStore(pool),
      massive: process.env.MASSIVE_API_KEY
        ? new MassiveHistoryClient({ apiKey: process.env.MASSIVE_API_KEY })
        : undefined,
      databento: process.env.DATABENTO_API_KEY
        ? new DatabentoHistoryClient({ apiKey: process.env.DATABENTO_API_KEY })
        : undefined,
      log: (line) => {
        progress.event(line);
        console.log(JSON.stringify({ at: new Date().toISOString(), ...line }));
      },
    },
    {
      symbols: values.symbols.split(","),
      startDate: values.start,
      endDate: values.end,
      includeBenchmarks: !values["no-benchmarks"],
      maxCostUsd,
      dryRun: values["dry-run"],
      bars: !values["quotes-only"],
      quotes: !values["bars-only"],
      today: localDate(new Date()),
    },
  );
  console.log(JSON.stringify({ event: "summary", ...summary }, null, 2));
  progress.state.status = summary.failed.length ? "Failed" : "Completed";
  progress.state.current = values["dry-run"]
    ? "Cost estimate complete; no downloads requested"
    : "Import finished";
  progress.save();
  if (summary.failed.length) process.exitCode = 1;
} catch (error) {
  progress.state.status = "Failed";
  progress.state.error = error instanceof Error ? error.message : String(error);
  progress.save();
  throw error;
} finally {
  clearInterval(heartbeat);
  await pool.end();
}
