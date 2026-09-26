import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Pool } from "pg";
import {
  FUNDED_SHADOW_MAX_PREDICTION_LAG_MS,
  fundedShadowEnrollmentSchema,
  fundedShadowGatePolicySchema,
  marketIdSchema,
  type FundedShadowEnrollment,
  type FundedShadowEnrollmentDraft,
  type FundedShadowGatePolicyDraft,
  type FundedShadowReport,
  type MarketId,
} from "@tsx-scanner/contracts";
import { contentHash } from "./paper-bot/funded-evidence-digest.js";
import { resolveFundedComparisonChampion } from "./paper-bot/funded-comparison-champion.js";
import {
  FundedShadowReadError,
  FundedShadowReadService,
} from "./paper-bot/funded-shadow-read-service.js";
import {
  buildFundedShadowGatePolicy,
  fundedShadowChallengerPolicyIdentity,
  loadFundedShadowChallengerById,
} from "./statistical-models/funded-shadow-gate-policy.js";
import { PostgresFundedShadowStore } from "./statistical-models/funded-shadow-repository.js";
import { FundedShadowReportingService } from "./statistical-models/funded-shadow-reporting.js";

/**
 * Guarded FP04 operator CLI.
 *
 * `plan` is read-only. `enroll` performs no write unless `--apply` is present,
 * and refuses without a complete, frozen Stage B approval reference; FP04 can
 * never create or infer that approval. No mode activates, promotes, rolls back
 * or mutates a live funded account, and none adds an HTTP route or UI.
 */

export type FundedShadowCliMode = "plan" | "enroll" | "status" | "report";

export interface FundedShadowCliInput {
  readonly mode: FundedShadowCliMode;
  readonly apply: boolean;
  readonly record: boolean;
  readonly market: MarketId;
  readonly challengerId: string;
  readonly fundedAccountId: string;
  readonly gatePolicyFile: string;
  readonly enrollmentId: string;
  readonly asOf?: string;
}

export interface FundedShadowCliDependencies {
  readonly pool: Pool;
  readonly store: PostgresFundedShadowStore;
  readonly reporting: FundedShadowReportingService;
  readonly read: FundedShadowReadService;
  readonly now: () => Date;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Operator-configured ceiling for the enrollment prediction lag. A larger
 * requested lag is refused; FP04 never silently clamps a frozen value.
 */
function fundedShadowLagCeiling(): number {
  const raw = process.env.FUNDED_SHADOW_MAX_PREDICTION_LAG_MS;
  if (raw === undefined || raw === "")
    return FUNDED_SHADOW_MAX_PREDICTION_LAG_MS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1_000 || parsed > 30_000)
    throw new Error(
      "FUNDED_SHADOW_MAX_PREDICTION_LAG_MS must be an integer between 1000 and 30000",
    );
  return parsed;
}

function usage(): string {
  return [
    "Usage:",
    "  funded-shadow plan --market=<CA_TSX|US_EQUITIES> --challenger-id=<uuid> --funded-account-id=<uuid> --gate-policy-file=<path>",
    "  funded-shadow enroll --market=<...> --challenger-id=<uuid> --funded-account-id=<uuid> --gate-policy-file=<path> [--apply]",
    "  funded-shadow status --enrollment-id=<uuid>",
    "  funded-shadow report --enrollment-id=<uuid> [--as-of=<ISO>] [--apply]",
  ].join("\n");
}

function parseFlags(args: readonly string[]): Map<string, string | true> {
  const flags = new Map<string, string | true>();
  for (const argument of args) {
    if (!argument.startsWith("--"))
      throw new Error(`Unexpected argument: ${argument}\n${usage()}`);
    const equals = argument.indexOf("=");
    const name = equals === -1 ? argument.slice(2) : argument.slice(2, equals);
    const value = equals === -1 ? true : argument.slice(equals + 1);
    if (flags.has(name)) throw new Error(`Duplicate flag: --${name}`);
    flags.set(name, value);
  }
  return flags;
}

function requiredFlag(flags: Map<string, string | true>, name: string): string {
  const value = flags.get(name);
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`--${name}=<value> is required\n${usage()}`);
  return value;
}

export function parseFundedShadowArgs(
  args: readonly string[],
): FundedShadowCliInput {
  const mode = args[0] as FundedShadowCliMode | undefined;
  if (
    mode !== "plan" &&
    mode !== "enroll" &&
    mode !== "status" &&
    mode !== "report"
  )
    throw new Error(usage());
  const flags = parseFlags(args.slice(1));
  const applyFlag = flags.get("apply");
  if (applyFlag !== undefined && applyFlag !== true)
    throw new Error(`--apply is a flag without a value\n${usage()}`);
  const apply = applyFlag === true;
  if (apply && mode !== "enroll" && mode !== "report")
    throw new Error(`--apply is only valid for enroll and report\n${usage()}`);
  if (mode === "status" || mode === "report") {
    if (apply && mode === "status")
      throw new Error(`status is read-only\n${usage()}`);
    return {
      mode,
      apply,
      record: apply && mode === "report",
      market: "CA_TSX",
      challengerId: "",
      fundedAccountId: "",
      gatePolicyFile: "",
      enrollmentId: requiredFlag(flags, "enrollment-id"),
      asOf:
        typeof flags.get("as-of") === "string"
          ? requiredFlag(flags, "as-of")
          : undefined,
    };
  }
  const market = requiredFlag(flags, "market");
  if (market !== "CA_TSX" && market !== "US_EQUITIES")
    throw new Error(`--market must be CA_TSX or US_EQUITIES\n${usage()}`);
  const challengerId = requiredFlag(flags, "challenger-id");
  const fundedAccountId = requiredFlag(flags, "funded-account-id");
  if (!UUID.test(challengerId) || !UUID.test(fundedAccountId))
    throw new Error(`--challenger-id and --funded-account-id must be UUIDs`);
  return {
    mode,
    apply,
    record: false,
    market: marketIdSchema.parse(market),
    challengerId,
    fundedAccountId,
    gatePolicyFile: requiredFlag(flags, "gate-policy-file"),
    enrollmentId: "",
    asOf: undefined,
  };
}

export interface FundedShadowPlan {
  readonly marketId: MarketId;
  readonly currency: "CAD" | "USD";
  readonly gatePolicyDigest: string;
  readonly champion: FundedShadowEnrollment["champion"];
  readonly challenger: FundedShadowEnrollment["challenger"];
  readonly evidenceCutoffAt: string;
  /** Deterministic prospective enrollment identity (not yet persisted). */
  readonly requestHash: string;
  readonly registrationRequestId: string;
}

async function loadGatePolicyFile(
  file: string,
  market: MarketId,
): Promise<FundedShadowGatePolicyDraft> {
  const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
  if (typeof raw === "object" && raw !== null && "gatePolicyDigest" in raw) {
    // A digest in the file is never trusted; recompute from the payload.
    delete (raw as Record<string, unknown>).gatePolicyDigest;
  }
  const parsed = fundedShadowGatePolicySchema.parse({
    ...(raw as Record<string, unknown>),
    gatePolicyDigest: "0".repeat(64),
  });
  const { gatePolicyDigest: _placeholder, ...draft } = parsed;
  if (draft.marketId !== market)
    throw new Error(
      `The gate policy file names ${draft.marketId}, not ${market}`,
    );
  return draft;
}

export async function resolveFundedShadowPlan(
  input: FundedShadowCliInput,
  dependencies: Pick<FundedShadowCliDependencies, "pool" | "now">,
): Promise<FundedShadowPlan> {
  const draft = await loadGatePolicyFile(input.gatePolicyFile, input.market);
  const policy = buildFundedShadowGatePolicy({
    marketId: draft.marketId,
    stageBApproval: draft.stageBApproval,
    window: draft.window,
    maxPredictionLagMs: draft.maxPredictionLagMs,
    maxPredictionLagMsCeiling: fundedShadowLagCeiling(),
  });
  const resolved = await resolveFundedComparisonChampion(
    dependencies.pool,
    input.market,
    input.fundedAccountId,
  );
  const challenger = await loadFundedShadowChallengerById(dependencies.pool, {
    modelId: input.challengerId,
    marketId: input.market,
    currency: policy.currency,
  });
  const identity = {
    marketId: policy.marketId,
    currency: policy.currency,
    sourceKind: "LIVE_PAPER" as const,
    champion: resolved.champion,
    challenger: fundedShadowChallengerPolicyIdentity(challenger),
    evidenceCutoffAt:
      fundedShadowChallengerPolicyIdentity(challenger).model
        .trainingEvidenceCutoffAt,
  };
  const requestHash = contentHash(identity);
  return {
    marketId: input.market,
    currency: policy.currency,
    gatePolicyDigest: policy.gatePolicyDigest,
    champion: identity.champion,
    challenger: identity.challenger,
    evidenceCutoffAt: identity.evidenceCutoffAt,
    requestHash,
    registrationRequestId: `funded-shadow:${requestHash.slice(0, 32)}`,
  };
}

export function buildFundedShadowEnrollmentDraft(input: {
  policy: ReturnType<typeof buildFundedShadowGatePolicy>;
  gatePolicyId: string;
  champion: FundedShadowEnrollment["champion"];
  challenger: FundedShadowEnrollment["challenger"];
}): FundedShadowEnrollmentDraft {
  const identity = {
    gatePolicyId: input.gatePolicyId,
    marketId: input.policy.marketId,
    currency: input.policy.currency,
    sourceKind: "LIVE_PAPER" as const,
    champion: input.champion,
    challenger: input.challenger,
    evidenceCutoffAt: input.challenger.model.trainingEvidenceCutoffAt,
  };
  const { gatePolicyId: _gatePolicyId, ...requestIdentity } = identity;
  const requestHash = contentHash(requestIdentity);
  return {
    enrollmentVersion: "funded-shadow-enrollment-v1",
    ...identity,
    registrationRequestId: `funded-shadow:${requestHash.slice(0, 32)}`,
    requestHash,
  };
}

export interface FundedShadowEnqueueReceipt {
  readonly gatePolicyDigest: string;
  readonly enrollmentId: string;
  readonly enrollmentDigest: string;
  readonly reusedGatePolicy: boolean;
  readonly reusedEnrollment: boolean;
}

export async function enrollFundedShadow(
  input: FundedShadowCliInput,
  dependencies: FundedShadowCliDependencies,
): Promise<FundedShadowEnqueueReceipt> {
  const draft = await loadGatePolicyFile(input.gatePolicyFile, input.market);
  const policy = buildFundedShadowGatePolicy({
    marketId: draft.marketId,
    stageBApproval: draft.stageBApproval,
    window: draft.window,
    maxPredictionLagMs: draft.maxPredictionLagMs,
    maxPredictionLagMsCeiling: fundedShadowLagCeiling(),
  });
  const { gatePolicyDigest: _policyDigest, ...policyDraft } = policy;
  const savedGatePolicy = await dependencies.store.saveGatePolicy(policyDraft);
  const resolved = await resolveFundedComparisonChampion(
    dependencies.pool,
    input.market,
    input.fundedAccountId,
  );
  const challenger = await loadFundedShadowChallengerById(dependencies.pool, {
    modelId: input.challengerId,
    marketId: input.market,
    currency: policy.currency,
  });
  const enrollmentDraft = buildFundedShadowEnrollmentDraft({
    policy,
    gatePolicyId: savedGatePolicy.id,
    champion: resolved.champion,
    challenger: fundedShadowChallengerPolicyIdentity(challenger),
  });
  const saved = await dependencies.store.saveEnrollment(enrollmentDraft);
  const enrollment = fundedShadowEnrollmentSchema.parse(saved.enrollment);
  return {
    gatePolicyDigest: savedGatePolicy.policy.gatePolicyDigest,
    enrollmentId: enrollment.id,
    enrollmentDigest: enrollment.enrollmentDigest,
    reusedGatePolicy: savedGatePolicy.reused,
    reusedEnrollment: saved.reused,
  };
}

export async function runFundedShadowCli(
  args: readonly string[],
  dependencies: FundedShadowCliDependencies,
): Promise<unknown> {
  const input = parseFundedShadowArgs(args);
  if (input.mode === "status") {
    return dependencies.read.get(input.enrollmentId);
  }
  if (input.mode === "report") {
    if (input.record) {
      const recorded = await dependencies.reporting.record(
        input.enrollmentId,
        input.asOf,
      );
      if (!recorded)
        throw new FundedShadowReadError(
          "FUNDED_SHADOW_ENROLLMENT_NOT_FOUND",
          "No funded shadow enrollment exists for that identity",
        );
      return {
        mode: "report",
        recorded: true,
        reused: recorded.reused,
        report: recorded.report,
      };
    }
    const report: FundedShadowReport = await dependencies.read.report(
      input.enrollmentId,
      input.asOf,
    );
    return { mode: "report", recorded: false, report };
  }
  const plan = await resolveFundedShadowPlan(input, dependencies);
  if (input.mode === "plan" || !input.apply)
    return {
      mode: input.mode,
      apply: false,
      plan,
    };
  const receipt = await enrollFundedShadow(input, dependencies);
  return { mode: "enroll", apply: true, plan, receipt };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  if (!process.env.DATABASE_URL)
    throw new Error(
      "Set DATABASE_URL explicitly; this command never migrates the database",
    );
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
  });
  try {
    const store = new PostgresFundedShadowStore(pool);
    const reporting = new FundedShadowReportingService(store);
    const dependencies: FundedShadowCliDependencies = {
      pool,
      store,
      reporting,
      read: new FundedShadowReadService(store, reporting),
      now: () => new Date(),
    };
    const output = await runFundedShadowCli(argv, dependencies);
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await pool.end();
  }
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(fileURLToPath(import.meta.url)) === path.resolve(entry);
}

if (isDirectExecution()) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
