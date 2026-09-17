import { Pool } from "pg";
import { EvidenceCohortService } from "./paper-bot/evidence-cohort-service.js";
import { EvidenceRegenerationService } from "./paper-bot/evidence-regeneration-service.js";
import { PostgresFundedLedgerStore } from "./paper-bot/funded-ledger-repository.js";
import { FundedReportingService } from "./paper-bot/funded-reporting-service.js";
import { ScannerFeatureClient } from "./market-data/scanner-client.js";

const [command, sourceRunId, ...flags] = process.argv.slice(2);
const apply = flags.includes("--apply");
const correctedStrategy = flags.includes("--corrected-strategy");
const currentReport = flags.includes("--current");
const asOfFlag = flags.find((flag) => flag.startsWith("--as-of="));
const asOfValue = asOfFlag?.slice("--as-of=".length);
const sourceRunIds = sourceRunId?.split(",").filter(Boolean) ?? [];
const usage =
  "Usage: paper-evidence audit | regenerate <run UUID[,run UUID...]> [--apply] [--corrected-strategy] | funded-report <run UUID> [--current | --as-of=<ISO timestamp>] | funded-compact <account UUID> [--retain-events=N] [--apply]";
if (!process.env.DATABASE_URL)
  throw new Error(
    "Set DATABASE_URL explicitly; this command never migrates the database",
  );
if (
  command !== "audit" &&
  command !== "regenerate" &&
  command !== "funded-report" &&
  command !== "funded-compact"
)
  throw new Error(usage);
const retainEventsFlag = flags.find((flag) =>
  flag.startsWith("--retain-events="),
);
const retainEvents = retainEventsFlag
  ? Number(retainEventsFlag.slice("--retain-events=".length))
  : 0;
if (
  (command === "regenerate" ||
    command === "funded-report" ||
    command === "funded-compact") &&
  (!sourceRunId ||
    sourceRunIds.length === 0 ||
    sourceRunIds.some(
      (id) =>
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          id,
        ),
    ) ||
    ((command === "funded-report" || command === "funded-compact") &&
      sourceRunIds.length !== 1) ||
    (command === "regenerate" &&
      sourceRunIds.length > 1 &&
      !correctedStrategy) ||
    flags.some((flag) =>
      command === "funded-report"
        ? flag !== "--current" && flag !== asOfFlag
        : command === "funded-compact"
          ? flag !== "--apply" && flag !== retainEventsFlag
          : !["--apply", "--corrected-strategy"].includes(flag),
    ) ||
    new Set(flags).size !== flags.length ||
    (command === "funded-report" && currentReport && asOfFlag !== undefined) ||
    (command === "funded-report" &&
      asOfFlag !== undefined &&
      (!asOfValue || !Number.isFinite(Date.parse(asOfValue)))) ||
    (command === "funded-compact" &&
      (!Number.isSafeInteger(retainEvents) || retainEvents < 0)))
) {
  throw new Error(usage);
}
const fundedReportAt =
  command !== "funded-report"
    ? undefined
    : asOfValue
      ? new Date(asOfValue).toISOString()
      : currentReport
        ? { mode: "CURRENT_ACCOUNT" as const }
        : undefined;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
try {
  const correctedEngine = correctedStrategy
    ? new ScannerFeatureClient(
        new URL(process.env.SCANNER_URL ?? "http://localhost:8000"),
        10_000,
        process.env.SCANNER_SERVICE_TOKEN,
      )
    : undefined;
  const result =
    command === "audit"
      ? await new EvidenceCohortService(pool).auditCohorts()
      : command === "funded-report"
        ? await new FundedReportingService(pool).report(
            sourceRunId!,
            fundedReportAt,
          )
        : command === "funded-compact"
          ? apply
            ? await new PostgresFundedLedgerStore(pool).compact(
                sourceRunId!,
                retainEvents,
              )
            : {
                mode: "PREVIEW",
                accountId: sourceRunId,
                currentEventCount: (
                  await new PostgresFundedLedgerStore(pool).read(sourceRunId!)
                ).events.length,
                retainEvents,
                writes: false,
              }
          : correctedStrategy && sourceRunIds.length > 1
            ? await new EvidenceRegenerationService(
                pool,
                correctedEngine,
              ).runMany(sourceRunIds, apply)
            : await new EvidenceRegenerationService(pool, correctedEngine).run(
                sourceRunIds[0]!,
                apply,
                correctedStrategy ? "CORRECTED_STRATEGY" : "FILL_ONLY",
              );
  console.log(JSON.stringify(result, null, 2));
} finally {
  await pool.end();
}
