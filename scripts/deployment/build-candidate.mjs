import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  EXPECTED_SCHEMA_VERSION,
  buildReceipt,
  candidateTag,
  validateBuildSource,
  validateImageRevision,
} from "./lib.mjs";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function run(command, args) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8" }).trim();
}

function imageInfo(tag, sha) {
  const parsed = JSON.parse(
    run("docker", ["image", "inspect", tag, "--format", "json"]),
  );
  const inspect = Array.isArray(parsed) ? parsed[0] : parsed;
  const id = inspect?.Id;
  if (!/^sha256:[a-f0-9]{64}$/.test(id ?? ""))
    throw new Error(`DEPLOYMENT_DIGEST_UNRESOLVED:${tag}=${id ?? ""}`);
  validateImageRevision({ sha, labels: inspect?.Config?.Labels ?? {} });
  return id;
}

// Build the runtime image once for the accepted commit and run both API and
// worker from that exact immutable digest. No rebuild happens between staging
// acceptance and production promotion; promotion reuses these digests.
const sha = process.argv[2] ?? process.env.DEPLOYMENT_SHA;
if (!sha) {
  console.error("usage: build-candidate.mjs <40-hex-sha>");
  process.exit(2);
}
validateBuildSource({
  requestedSha: sha,
  headSha: run("git", ["rev-parse", "HEAD"]),
  status: run("git", ["status", "--porcelain", "--untracked-files=all"]),
});

const targets = {
  api: { dockerfile: "apps/api/Dockerfile", tag: candidateTag("api", sha) },
  scanner: {
    dockerfile: "services/scanner/Dockerfile",
    tag: candidateTag("scanner", sha),
  },
  web: { dockerfile: "apps/web/Dockerfile", tag: candidateTag("web", sha) },
};

for (const [service, target] of Object.entries(targets)) {
  console.log(`building ${service} as ${target.tag}`);
  run("docker", [
    "build",
    "-f",
    target.dockerfile,
    "--label",
    `org.opencontainers.image.revision=${sha}`,
    "-t",
    target.tag,
    ".",
  ]);
}

// API and worker may share one tested runtime image. Keep the worker identity
// explicit in the candidate receipt even when its digest equals API's.
run("docker", ["tag", targets.api.tag, candidateTag("worker", sha)]);

const digests = {
  api: imageInfo(targets.api.tag, sha),
  worker: imageInfo(candidateTag("worker", sha), sha),
  scanner: imageInfo(targets.scanner.tag, sha),
  "scanner-research": imageInfo(targets.scanner.tag, sha),
  web: imageInfo(targets.web.tag, sha),
};

const receipt = buildReceipt({
  sha,
  digests,
  schemaVersion: EXPECTED_SCHEMA_VERSION,
  builtAt: new Date().toISOString(),
});

const outDir = path.join(root, "deployment", "candidates", sha);
await mkdir(outDir, { recursive: true });
await writeFile(
  path.join(outDir, "receipt.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
);
console.log(JSON.stringify(receipt, null, 2));
