import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type {
  FrozenStudyPlan,
  StudyExecutionAuthorization,
} from "@tsx-scanner/contracts";
import { contentHash } from "./research-coverage.js";

export type ResearchRuntimeIdentity = {
  engineRevision: string;
  runtimeFingerprint: string;
  featureVersion?: string;
};

export interface ResearchRuntimeIdentityProvider {
  current(): Promise<ResearchRuntimeIdentity | null>;
}

export function runtimeFingerprint(allowlist: Record<string, string>): string {
  return contentHash(
    Object.fromEntries(
      Object.entries(allowlist).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

export function assertStudyIdentity(input: {
  authorization: StudyExecutionAuthorization;
  plan: FrozenStudyPlan;
  runtime: ResearchRuntimeIdentity;
}): void {
  if (input.authorization.engineRevision !== input.plan.binding.engineRevision)
    throw new Error("STUDY_ENGINE_REVISION_MISMATCH");
  if (
    input.authorization.runtimeFingerprint !==
    input.plan.binding.runtimeFingerprint
  )
    throw new Error("STUDY_RUNTIME_FINGERPRINT_MISMATCH");
  if (input.runtime.engineRevision !== input.plan.binding.engineRevision)
    throw new Error("STUDY_RUNTIME_MISMATCH");
  if (
    input.runtime.runtimeFingerprint !== input.plan.binding.runtimeFingerprint
  )
    throw new Error("STUDY_RUNTIME_MISMATCH");
}

const buildIdentitySchema = z.object({
  version: z.literal("research-build-v1"),
  engineRevision: z.string().regex(/^[a-f0-9]{40}$/),
  sources: z
    .object({ scanner: z.string().regex(/^[a-f0-9]{64}$/) })
    .passthrough(),
  compiledApi: z.string(),
  compiledContracts: z.string(),
});
const scannerIdentitySchema = z.object({
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
  python: z.string(),
  featureVersion: z.string().min(1),
  packages: z.record(z.string(), z.string()),
});
async function digestTree(root: string): Promise<string> {
  const entries: [string, string][] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (file.endsWith(".js"))
        entries.push([
          path.relative(root, file).replaceAll("\\", "/"),
          createHash("sha256")
            .update(await readFile(file))
            .digest("hex"),
        ]);
    }
  }
  await walk(root);
  return createHash("sha256")
    .update(
      JSON.stringify(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    )
    .digest("hex");
}
export function createResearchRuntimeIdentityProvider(
  scanner: { researchRuntimeIdentity(): Promise<unknown> },
  metadataPath?: string,
): ResearchRuntimeIdentityProvider {
  const sourceExecution =
    metadataPath === undefined && import.meta.url.endsWith(".ts");
  const resolvedMetadataPath =
    metadataPath ??
    fileURLToPath(new URL("../../research-runtime.json", import.meta.url));
  return {
    async current() {
      try {
        if (sourceExecution) return null;
        const build = buildIdentitySchema.parse(
          JSON.parse(await readFile(resolvedMetadataPath, "utf8")),
        );
        const live = scannerIdentitySchema.parse(
          await scanner.researchRuntimeIdentity(),
        );
        if (live.sourceHash !== build.sources.scanner) return null;
        const apiRoot = path.dirname(resolvedMetadataPath);
        if (
          (await digestTree(path.join(apiRoot, "dist"))) !==
            build.compiledApi ||
          (await digestTree(path.resolve(apiRoot, "../../contracts/dist"))) !==
            build.compiledContracts
        )
          return null;
        const modules = ["pg", "zod", "fastify"];
        const packages: Record<string, string> = {};
        for (const name of modules) {
          const pkg = JSON.parse(
            await readFile(
              path.join(apiRoot, "node_modules", name, "package.json"),
              "utf8",
            ),
          ) as { version: string };
          packages[name] = pkg.version;
        }
        return {
          engineRevision: build.engineRevision,
          featureVersion: live.featureVersion,
          runtimeFingerprint: contentHash({
            build,
            node: process.versions,
            packages,
            scanner: live,
          }),
        };
      } catch {
        return null;
      }
    },
  };
}
