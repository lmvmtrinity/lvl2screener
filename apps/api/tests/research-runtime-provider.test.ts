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
it("binds both actual compiled code and scanner identity; runtime drift changes the fingerprint", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "study-runtime-test-"));
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
  let scanner = {
    sourceHash: "a".repeat(64),
    python: "3.13.0",
    featureVersion: "1.2.0",
    packages: { fastapi: "1" },
  };
  const provider = createResearchRuntimeIdentityProvider(
    { researchRuntimeIdentity: async () => scanner },
    metadata,
  );
  const first = await provider.current();
  expect(first).not.toBeNull();
  scanner = { ...scanner, packages: { fastapi: "2" } };
  expect((await provider.current())?.runtimeFingerprint).not.toBe(
    first?.runtimeFingerprint,
  );
  scanner = { ...scanner, sourceHash: "b".repeat(64) };
  expect(await provider.current()).toBeNull();
  scanner = { ...scanner, sourceHash: "a".repeat(64) };
  await writeFile(path.join(api, "dist/index.js"), "changed");
  expect(await provider.current()).toBeNull();
});
it("refuses absent build metadata without trusting environment identity strings", async () => {
  expect(
    await createResearchRuntimeIdentityProvider(
      { researchRuntimeIdentity: async () => ({}) },
      "missing-research-runtime.json",
    ).current(),
  ).toBeNull();
});
