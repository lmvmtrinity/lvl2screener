import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildReceipt,
  parseComposePsOutput,
  parseObservedSchemaVersion,
  rollbackTag,
  validateContainerImages,
  writeAtomicFile,
} from "./lib.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
}

// Capture container-owned immutable image IDs. Compose's Image field is a
// moving configuration tag and cannot identify the bytes that are running.
const sha = process.argv[2] ?? process.env.DEPLOYMENT_SHA;
const observedSchemaVersion = process.argv[3] ?? process.env.DEPLOYMENT_SCHEMA;
if (!sha) {
  console.error(
    "usage: capture-rollback.mjs <40-hex-sha> <observedSchemaVersion>",
  );
  process.exit(2);
}
const schemaVersion = parseObservedSchemaVersion(observedSchemaVersion);

const rows = parseComposePsOutput(
  run("docker", ["compose", "ps", "--format", "json"]),
);
const containerByService = {};
for (const row of rows) {
  const service = String(row.Service ?? row.service ?? "");
  const name = String(row.Name ?? row.name ?? "");
  if (service && name) containerByService[service] = name;
}

// Resolve every required image before tagging anything or replacing a receipt.
const imageByService = {};
const services = [
  "api",
  "worker",
  "scanner",
  "web",
  ...(containerByService["scanner-research"] ? ["scanner-research"] : []),
];
for (const service of services) {
  const container = containerByService[service];
  if (container) {
    imageByService[service] = {
      container,
      image: run("docker", ["inspect", container, "--format", "{{.Image}}"]),
    };
  }
}
validateContainerImages(rows, imageByService);
for (const service of services) {
  try {
    run("docker", ["image", "inspect", imageByService[service].image]);
  } catch {
    throw new Error(`ROLLBACK_IMAGE_UNAVAILABLE:${service}`);
  }
}

const capturedAt = new Date().toISOString();
const digests = {};
for (const service of services) {
  const source = imageByService[service].image;
  digests[service] = source;
  const tag = rollbackTag(service, sha, capturedAt);
  run("docker", ["tag", source, tag]);
  console.log(
    `captured ${service}: ${imageByService[service].container} -> ${tag} (${source})`,
  );
}

const receipt = buildReceipt({
  sha,
  digests,
  schemaVersion,
  builtAt: capturedAt,
  verifiedAt: capturedAt,
});
const outDir = path.join(root, "deployment", "rollback");
await mkdir(outDir, { recursive: true });
await writeAtomicFile(
  path.join(outDir, `rollback-${sha.slice(0, 12)}.json`),
  `${JSON.stringify({ ...receipt, capturedAt }, null, 2)}\n`,
);
await writeAtomicFile(
  path.join(outDir, "current.json"),
  `${JSON.stringify({ ...receipt, capturedAt }, null, 2)}\n`,
);
console.log("rollback reference written");
