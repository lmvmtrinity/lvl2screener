import { readFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  assertOutsideMarketHours,
  assertRollbackAvailable,
  assertRollbackSchemaCompatible,
  parseRollbackReceipt,
  parseReceipt,
} from "./lib.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function imageExists(ref) {
  try {
    execFileSync("docker", ["image", "inspect", ref], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

// Preflight fails when the required rollback image is unavailable and verifies
// schema compatibility before any rollback. Never rolls back migrations.
const args = process.argv.slice(2);
const allowMarketHours = args.includes("--allow-market-hours");
const positional = args.filter((value) => !value.startsWith("--"));
const candidatePath = positional[0];
const rollbackPath =
  positional[1] ?? path.join(root, "deployment", "rollback", "current.json");
if (!candidatePath) {
  console.error(
    "usage: preflight.mjs <candidate-receipt.json> [rollback.json] [--allow-market-hours]",
  );
  process.exit(2);
}

assertOutsideMarketHours(new Date(), allowMarketHours);
const candidate = parseReceipt(await readFile(candidatePath, "utf8"));
let rollback = null;
try {
  rollback = parseRollbackReceipt(await readFile(rollbackPath, "utf8"));
} catch {
  rollback = null;
}

// Candidate images must resolve to the exact immutable digests in the receipt.
for (const [service, digest] of Object.entries(candidate.digests)) {
  if (!imageExists(digest))
    throw new Error(`CANDIDATE_IMAGE_UNAVAILABLE:${service}`);
}

// Rollback reference must survive subsequent builds and resolve.
if (!rollback) throw new Error("ROLLBACK_REFERENCE_UNAVAILABLE");
const available = {};
for (const service of ["api", "worker", "scanner", "web"])
  available[service] = imageExists(rollback.digests[service])
    ? [rollback.digests[service]]
    : [];
assertRollbackAvailable({
  rollbackReceipt: rollback,
  imagesAvailable: available,
});
assertRollbackSchemaCompatible({
  currentSchema: candidate.schemaVersion,
  rollbackSchema: rollback.schemaVersion,
  compatibilityEvidence: rollback.schemaCompatibilityVerified === true,
});
console.log("preflight ok");
