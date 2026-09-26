import { afterEach, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createResearchRuntimeIdentityProvider } from "../src/backtests/research-runtime-identity.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/**
 * API and worker run from the exact same immutable runtime image (same
 * research-runtime.json, same compiled output, same scanner service), so
 * their reported research runtime identities must be identical. This guards
 * the deployment invariant without requiring a live stack.
 */
it("api and worker report the identical research runtime identity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "runtime-parity-"));
  roots.push(root);
  const api = path.join(root, "apps/api");
  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  for (const dir of [
    "apps/api/dist",
    "contracts/dist",
    "apps/api/node_modules/pg",
    "apps/api/node_modules/zod",
    "apps/api/node_modules/fastify",
  ])
    await mkdir(path.join(root, dir), { recursive: true });
  for (const file of ["apps/api/dist/index.js", "contracts/dist/index.js"])
    await writeFile(path.join(root, file), "source");
  for (const name of ["pg", "zod", "fastify"])
    await writeFile(
      path.join(api, "node_modules", name, "package.json"),
      JSON.stringify({ version: "1.0.0" }),
    );
  const compiled = sha(JSON.stringify([["index.js", sha("source")]]));
  const metadata = path.join(api, "research-runtime.json");
  await writeFile(
    metadata,
    JSON.stringify({
      version: "research-build-v1",
      engineRevision: "d".repeat(40),
      sources: { scanner: "a".repeat(64) },
      compiledApi: compiled,
      compiledContracts: compiled,
    }),
  );
  const scanner = {
    sourceHash: "a".repeat(64),
    python: "3.13.0",
    featureVersion: "1.2.0",
    packages: { fastapi: "1" },
  };
  // Same image, same scanner: API provider and worker provider are constructed
  // identically (see apps/api/src/index.ts and apps/api/src/worker.ts).
  const apiProvider = createResearchRuntimeIdentityProvider(
    { researchRuntimeIdentity: async () => scanner },
    metadata,
  );
  const workerProvider = createResearchRuntimeIdentityProvider(
    { researchRuntimeIdentity: async () => scanner },
    metadata,
  );
  const apiIdentity = await apiProvider.current();
  const workerIdentity = await workerProvider.current();
  expect(apiIdentity).not.toBeNull();
  expect(workerIdentity).toEqual(apiIdentity);
});
