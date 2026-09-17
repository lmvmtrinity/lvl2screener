import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";

const identity = z.string().trim().min(1);
const dates = z
  .array(z.iso.date())
  .min(1)
  .refine(
    (values) =>
      values.every((value, index) => index === 0 || value > values[index - 1]!),
    "Dates must be unique and chronological",
  );
const segment = z.object({ start: z.iso.date(), end: z.iso.date() }).strict();

export const researchPlanSchema = z
  .object({
    version: z.literal("research-plan-v1"),
    experimentId: identity,
    revision: z.string().regex(/^[a-f0-9]{40}$/),
    marketId: z.enum(["CA_TSX", "US_EQUITIES"]),
    currency: z.enum(["CAD", "USD"]),
    profileId: identity,
    configVersion: identity,
    featureVersion: identity,
    strategyVersion: identity,
    scoreVersion: identity,
    executionAssumptions: identity,
    qualificationPolicy: identity,
    comparison: identity,
    searchBudget: z.number().int().positive(),
    minimumTradesPerSegment: z.number().int().positive(),
    maximumDrawdownR: z.number().positive(),
    minimumImprovementR: z.number().nonnegative(),
    uncertaintyMethod: identity,
    overlapPurgeRule: identity,
    splits: z
      .object({ TRAIN: segment, VALIDATION: segment, TEST: segment })
      .strict(),
    expectedSessions: dates,
    inputs: z
      .array(
        z
          .object({
            path: identity,
            marketId: z.enum(["CA_TSX", "US_EQUITIES"]),
            sessions: dates,
            role: z.enum(["CANDIDATES", "BENCHMARKS", "CONFIGURATION"]),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .superRefine((plan, context) => {
    const reject = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (plan.currency !== (plan.marketId === "CA_TSX" ? "CAD" : "USD"))
      reject("Market/currency mismatch");
    const { TRAIN, VALIDATION, TEST } = plan.splits;
    for (const value of Object.values(plan.splits)) {
      if (value.start > value.end) reject("Reversed split dates");
      if (
        !plan.expectedSessions.some(
          (date) => date >= value.start && date <= value.end,
        )
      )
        reject("Split has no expected sessions");
    }
    if (TRAIN.end >= VALIDATION.start || VALIDATION.end >= TEST.start)
      reject("Splits must be chronological and disjoint");
    for (const date of plan.expectedSessions) {
      if (
        !Object.values(plan.splits).some(
          (value) => date >= value.start && date <= value.end,
        )
      )
        reject("Expected session outside splits");
    }
    if (!plan.inputs.some((input) => input.role === "CANDIDATES"))
      reject("Candidate input required");
    for (const input of plan.inputs) {
      if (input.marketId !== plan.marketId) reject("Input market mismatch");
      if (input.sessions.some((date) => !plan.expectedSessions.includes(date)))
        reject("Input session outside expected sessions");
    }
  });

const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

/** Offline inventory only: session declarations are not provider coverage verification. */
export async function freezeResearchManifest(
  planPath: string,
  outputPath: string,
) {
  const planBytes = await readFile(planPath);
  const plan = researchPlanSchema.parse(JSON.parse(planBytes.toString("utf8")));
  const paths = plan.inputs.map((input) =>
    resolve(dirname(planPath), input.path),
  );
  if (
    new Set(
      paths.map((path) =>
        process.platform === "win32" ? path.toLowerCase() : path,
      ),
    ).size !== paths.length
  ) {
    throw new Error("Duplicate input paths");
  }
  const inputs = await Promise.all(
    plan.inputs.map(async (input, index) => {
      const bytes = await readFile(paths[index]!);
      return { ...input, sha256: hash(bytes), bytes: bytes.length };
    }),
  );
  const declared = new Set(
    inputs
      .filter((input) => input.role === "CANDIDATES")
      .flatMap((input) => input.sessions),
  );
  const payload = {
    version: "research-manifest-v1",
    plan,
    planSha256: hash(planBytes),
    inputs,
    coverage: {
      basis: "operator-declared-session-inventory",
      expectedSessions: plan.expectedSessions.length,
      declaredCandidateSessions: declared.size,
      missingCandidateSessions: plan.expectedSessions.filter(
        (date) => !declared.has(date),
      ),
      inputContentsValidated: false,
    },
  };
  const manifest = { ...payload, sha256: hash(JSON.stringify(payload)) };
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
  });
  return manifest;
}
