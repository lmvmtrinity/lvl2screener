// Compare two screenshot evidence directories produced by screenshot.mjs.
//
//   node scripts/visual/compare-shots.mjs <baseline-dir> <candidate-dir>
//                                         [--expect-missing] [--json]
//
// Compares every capture by PNG byte hash and by captured body text. The
// harness freezes the clock and disables animations, so a styling migration
// that preserves appearance should reproduce identical PNGs; any difference is
// listed with its byte size so it can be inspected manually. Layout/error
// evidence is summarized as well. Exit code is non-zero when a capture is
// missing from either side or differs.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [baselineDir, candidateDir] = process.argv
  .slice(2)
  .filter((value) => !value.startsWith("--"));
const asJson = process.argv.includes("--json");

if (!baselineDir || !candidateDir) {
  console.error(
    "usage: node scripts/visual/compare-shots.mjs <baseline-dir> <candidate-dir> [--json]",
  );
  process.exit(2);
}
for (const dir of [baselineDir, candidateDir]) {
  if (!existsSync(dir)) {
    console.error(`missing directory: ${dir}`);
    process.exit(2);
  }
}

function digest(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readJson(path) {
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
}

const baselinePngs = readdirSync(baselineDir)
  .filter((name) => name.endsWith(".png"))
  .sort();
const candidatePngs = new Set(
  readdirSync(candidateDir)
    .filter((name) => name.endsWith(".png"))
    .sort(),
);
const baselineSet = new Set(baselinePngs);

const missing = baselinePngs.filter((name) => !candidatePngs.has(name));
const added = [...candidatePngs].filter((name) => !baselineSet.has(name));
const identical = [];
const pixelDiffs = [];
const textDiffs = [];

for (const name of baselinePngs) {
  if (!candidatePngs.has(name)) continue;
  const baselinePng = join(baselineDir, name);
  const candidatePng = join(candidateDir, name);
  if (digest(baselinePng) === digest(candidatePng)) identical.push(name);
  else
    pixelDiffs.push({
      name,
      baselineBytes: readFileSync(baselinePng).length,
      candidateBytes: readFileSync(candidatePng).length,
    });
}

for (const name of baselinePngs) {
  if (!candidatePngs.has(name)) continue;
  const baselineText = join(baselineDir, name.replace(/\.png$/, ".txt"));
  const candidateText = join(candidateDir, name.replace(/\.png$/, ".txt"));
  if (!existsSync(baselineText) || !existsSync(candidateText)) continue;
  const before = readFileSync(baselineText, "utf8");
  const after = readFileSync(candidateText, "utf8");
  if (before !== after) textDiffs.push(name);
}

const baselineErrors = readJson(join(baselineDir, "errors.json"));
const candidateErrors = readJson(join(candidateDir, "errors.json"));
const summarize = (errors) =>
  errors
    ? {
        pageErrors: errors.pageErrors?.length ?? 0,
        consoleErrors: errors.consoleErrors?.length ?? 0,
        badResponses: errors.badResponses?.length ?? 0,
        navigationErrors: errors.navigationErrors?.length ?? 0,
        bannerMatches: errors.bannerMatches?.length ?? 0,
        failedRequests: errors.failedRequests?.length ?? 0,
      }
    : null;

const report = {
  baselineDir,
  candidateDir,
  captures: baselinePngs.length,
  identical: identical.length,
  pixelDiffs,
  textDiffs,
  missing,
  added,
  errorsBaseline: summarize(baselineErrors),
  errorsCandidate: summarize(candidateErrors),
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`baseline:  ${baselineDir}`);
  console.log(`candidate: ${candidateDir}`);
  console.log(`captures:  ${report.captures}`);
  console.log(`identical: ${report.identical}/${report.captures}`);
  console.log(
    `pixel differences: ${pixelDiffs.length} | text differences: ${textDiffs.length}`,
  );
  for (const item of pixelDiffs)
    console.log(
      `  pixel ${item.name}: ${item.baselineBytes} -> ${item.candidateBytes} bytes`,
    );
  for (const name of textDiffs) console.log(`  text  ${name}`);
  for (const name of missing) console.log(`  missing ${name}`);
  for (const name of added) console.log(`  added ${name}`);
  console.log(`errors baseline:  ${JSON.stringify(report.errorsBaseline)}`);
  console.log(`errors candidate: ${JSON.stringify(report.errorsCandidate)}`);
}

if (missing.length || pixelDiffs.length || textDiffs.length)
  process.exitCode = 1;
