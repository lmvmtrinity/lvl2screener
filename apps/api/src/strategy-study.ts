import { readFile, writeFile } from "node:fs/promises";
import { Pool } from "pg";
import {
  frozenStudyPlanSchema,
  strategyStudyJobPayloadSchema,
} from "@tsx-scanner/contracts";
import { loadConfig } from "./config.js";
import { migrate } from "./database/migrate.js";
import { ResearchJobRepository } from "./research-jobs/research-job-repository.js";
import { PostgresStrategyStudyStore } from "./backtests/strategy-study-repository.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const planPath = option("--request");
const outputPath = option("--output");
const dryRun = process.argv.includes("--dry-run");
if (!planPath || !outputPath)
  throw new Error(
    "Usage: pnpm strategy-study --request <plan.json> --output <report.json> [--dry-run] [--idempotency-key <key>]",
  );
const raw = JSON.parse(await readFile(planPath, "utf8")) as unknown;
const plan = frozenStudyPlanSchema.parse(raw);
const payload = strategyStudyJobPayloadSchema.parse({ plan });
const idempotencyKey =
  option("--idempotency-key") ?? `strategy-study:${plan.experimentId}`;
if (dryRun) {
  await writeFile(
    outputPath,
    JSON.stringify(
      {
        status: "DRY_RUN",
        experimentId: plan.experimentId,
        marketId: plan.comparison.marketId,
        expectedSessions: plan.comparison.expectedSessions.length,
        reasonCodes: ["NO_TEST_CLAIM_DISPATCHED"],
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  process.exit(0);
}
const config = loadConfig();
const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
try {
  await migrate(pool);
  const jobs = new ResearchJobRepository(pool);
  const job = await jobs.createStrictJob(
    "STRATEGY_STUDY",
    payload,
    idempotencyKey,
  );
  let current = job;
  while (
    !["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(
      current.status,
    )
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const next = await jobs.get(job.id);
    if (!next) throw new Error("RESEARCH_JOB_DISAPPEARED");
    current = next;
  }
  const study = current.resultRefId
    ? await new PostgresStrategyStudyStore(pool).get(current.resultRefId)
    : null;
  await writeFile(
    outputPath,
    JSON.stringify({ job: current, study }, null, 2),
    { flag: "wx" },
  );
} finally {
  await pool.end();
}
