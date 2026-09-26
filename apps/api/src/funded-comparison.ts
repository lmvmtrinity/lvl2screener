import {
  FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
  FUNDED_EXECUTION_PREDICTION_VERSION,
  type FundedComparisonChallengerPolicyIdentity,
  type MarketId,
} from "@tsx-scanner/contracts";
import { Pool } from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { loadConfig, type ApiConfig } from "./config.js";
import { PostgresBacktestStore } from "./backtests/backtest-repository.js";
import type { ReplaySessionPolicy } from "./backtests/backtest-repository.js";
import { ResearchJobRepository } from "./research-jobs/research-job-repository.js";
import { ScannerFeatureClient } from "./market-data/scanner-client.js";
import {
  freezeFundedComparisonSharedInput,
  type FundedComparisonFrozenInput,
} from "./paper-bot/funded-comparison-input-freezer.js";
import {
  buildFundedComparisonSpecification,
  type FundedComparisonTrainingWindow,
} from "./paper-bot/funded-comparison-specification.js";
import {
  FundedComparisonRepository,
  FundedComparisonRepositoryError,
  type FundedComparisonSpecificationBuild,
  type FundedComparisonSpecificationFreeze,
  type FundedComparisonSpecificationReceipt,
} from "./paper-bot/funded-comparison-repository.js";
import { fundedComparisonChallengerPolicyDigest } from "./paper-bot/funded-comparison-challenger-policy.js";
import { loadFundedComparisonTrainingLineage } from "./paper-bot/funded-comparison-prediction.js";
import {
  resolveFundedComparisonChampion,
  type ResolvedFundedComparisonChampion,
} from "./paper-bot/funded-comparison-champion.js";
import { FundedComparisonReadService } from "./paper-bot/funded-comparison-read-service.js";
import { buildFundedComparisonJobPayload } from "./worker/handlers/funded-comparison-job-handler.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type FundedComparisonCliMode = "plan" | "enqueue" | "status";

export interface FundedComparisonCliInput {
  readonly mode: FundedComparisonCliMode;
  readonly apply: boolean;
  readonly baselineRunId?: string;
  readonly challengerId?: string;
  readonly marketId?: MarketId;
  readonly evidenceCutoffAt?: string;
  readonly maxSessions?: number;
  readonly specificationId?: string;
}

export interface FundedComparisonPlan {
  readonly marketId: MarketId;
  readonly currency: "CAD" | "USD";
  readonly baselineRunId: string;
  readonly challengerId: string;
  readonly sessionCount: number;
  readonly opportunityCount: number;
  readonly sessions: readonly string[];
  readonly opportunities: readonly string[];
  readonly champion: {
    readonly sourceRunId: string;
    readonly sourceAccountId: string;
    readonly policyDigest: string;
  };
  readonly challenger: {
    readonly modelId: string;
    readonly modelVersion: string;
    readonly policyDigest: string;
  };
  /** Internal prepared state reused by apply; never printed as an identity. */
  readonly prepared?: PreparedComparison;
}

interface PreparedComparison {
  readonly frozen: FundedComparisonFrozenInput;
  readonly champion: ResolvedFundedComparisonChampion;
  readonly challenger: FundedComparisonChallengerPolicyIdentity;
  readonly training: FundedComparisonTrainingWindow;
}

export interface FundedComparisonCliDependencies {
  readonly resolvePlan: (
    input: FundedComparisonCliInput,
  ) => Promise<FundedComparisonPlan>;
  readonly freezeAndEnqueue: (
    input: FundedComparisonCliInput,
    plan: FundedComparisonPlan,
  ) => Promise<{
    readonly specificationId: string;
    readonly jobId: string;
    readonly reused: boolean;
  }>;
  readonly read: Pick<FundedComparisonReadService, "list" | "get">;
}

export function parseFundedComparisonArgs(
  args: readonly string[],
): FundedComparisonCliInput {
  const [mode, ...rest] = args;
  if (mode !== "plan" && mode !== "enqueue" && mode !== "status")
    throw new Error(usage());
  const values = parseFlags(rest);
  const apply = values.has("apply");
  if (values.get("apply") !== undefined && values.get("apply") !== true)
    throw new Error(usage());
  if (values.has("apply") && mode !== "enqueue") throw new Error(usage());

  if (mode === "status") {
    const specId = required(values, "spec-id");
    if (!UUID.test(specId) || values.size !== (apply ? 2 : 1))
      throw new Error(usage());
    return { mode, apply, specificationId: specId };
  }

  const baselineRunId = required(values, "baseline-run-id");
  const challengerId = required(values, "challenger-id");
  const market = required(values, "market");
  const evidenceCutoffAt = required(values, "evidence-cutoff");
  const maxSessionsText = required(values, "max-sessions");
  const maxSessions = Number(maxSessionsText);
  if (
    !UUID.test(baselineRunId) ||
    !UUID.test(challengerId) ||
    (market !== "CA_TSX" && market !== "US_EQUITIES") ||
    !Number.isSafeInteger(maxSessions) ||
    maxSessions < 1 ||
    !Number.isFinite(Date.parse(evidenceCutoffAt))
  )
    throw new Error(usage());
  const expected = 5 + (apply ? 1 : 0);
  if (values.size !== expected) throw new Error(usage());
  return {
    mode,
    apply,
    baselineRunId,
    challengerId,
    marketId: market,
    evidenceCutoffAt: new Date(evidenceCutoffAt).toISOString(),
    maxSessions,
  };
}

function parseFlags(args: readonly string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (!arg.startsWith("--")) throw new Error(usage());
    const equals = arg.indexOf("=");
    const name = equals >= 0 ? arg.slice(2, equals) : arg.slice(2);
    if (!name || values.has(name)) throw new Error(usage());
    if (equals >= 0) {
      const value = arg.slice(equals + 1);
      if (!value) throw new Error(usage());
      values.set(name, value);
    } else if (args[index + 1]?.startsWith("--")) values.set(name, true);
    else if (args[index + 1] !== undefined) values.set(name, args[++index]!);
    else values.set(name, true);
  }
  return values;
}

function required(values: Map<string, string | true>, key: string): string {
  const value = values.get(key);
  if (typeof value !== "string" || !value) throw new Error(usage());
  return value;
}

function usage(): string {
  return "Usage: funded-comparison plan|enqueue --baseline-run-id=<uuid> --challenger-id=<uuid> --market=<CA_TSX|US_EQUITIES> --evidence-cutoff=<ISO> --max-sessions=<n> [--apply] | status --spec-id=<uuid>";
}

export interface FundedComparisonEnqueueInput {
  readonly marketId: MarketId;
  readonly baselineBacktestRunId: string;
  readonly championPolicyDigest: string;
  readonly challengerPolicyDigest: string;
  readonly evidenceCutoffAt: string;
  readonly maxSessions: number;
}

export interface FundedComparisonEnqueueDependencies {
  readonly repository: {
    readonly findSpecificationIdByFrozenIdentity: (input: {
      readonly marketId: string;
      readonly baselineBacktestRunId: string;
      readonly championPolicyDigest: string;
      readonly challengerPolicyDigest: string;
      readonly evidenceCutoffAt: string;
    }) => Promise<string | undefined>;
    readonly loadSpecification: (
      specId: string,
    ) => Promise<FundedComparisonSpecificationReceipt | undefined>;
    readonly saveSpecification: (
      freeze: FundedComparisonSpecificationFreeze,
    ) => Promise<FundedComparisonSpecificationReceipt>;
  };
  readonly jobs: {
    readonly createStrictJob: (
      jobType: "FUNDED_COMPARISON",
      payload: Record<string, unknown>,
      idempotencyKey: string,
    ) => Promise<{ readonly id: string }>;
  };
  readonly build: (
    specificationFrozenAt: string,
  ) => FundedComparisonSpecificationBuild;
}

/**
 * Durable spec/job boundary. Existing immutable specifications are rebuilt
 * against their retained database freeze time so the repository can perform
 * its complete exact-match check without allowing a fresh timestamp to look
 * like a conflicting retry. A conflict after an empty prelookup is the one
 * expected concurrent-winner race that is reloaded and retried.
 */
export async function enqueueFundedComparison(
  input: FundedComparisonEnqueueInput,
  dependencies: FundedComparisonEnqueueDependencies,
): Promise<{
  readonly specificationId: string;
  readonly jobId: string;
  readonly reused: boolean;
}> {
  const { repository, jobs } = dependencies;
  const existingId =
    await repository.findSpecificationIdByFrozenIdentity(input);
  let retained: FundedComparisonSpecificationReceipt | undefined;
  if (existingId !== undefined) {
    retained = await repository.loadSpecification(existingId);
    if (!retained) throw new Error("RETAINED_INPUT_MISSING");
  }

  const save = (retainedReceipt?: FundedComparisonSpecificationReceipt) =>
    repository.saveSpecification({
      build: (databaseFrozenAt) =>
        dependencies.build(
          retainedReceipt?.specification.specificationFrozenAt ??
            databaseFrozenAt,
        ),
    });

  let receipt: FundedComparisonSpecificationReceipt;
  let reused = retained !== undefined;
  if (retained) receipt = await save(retained);
  else {
    try {
      receipt = await save();
    } catch (error) {
      if (
        !(error instanceof FundedComparisonRepositoryError) ||
        error.reason !== "CONFLICTING_RETRY"
      )
        throw error;
      const winnerId =
        await repository.findSpecificationIdByFrozenIdentity(input);
      if (!winnerId) throw error;
      const winner = await repository.loadSpecification(winnerId);
      if (!winner) throw error;
      receipt = await save(winner);
      reused = true;
    }
  }

  const payload = buildFundedComparisonJobPayload(
    receipt.specId,
    receipt.specification,
    input.maxSessions,
  );
  const job = await jobs.createStrictJob(
    "FUNDED_COMPARISON",
    payload,
    `funded-comparison:${receipt.specification.comparisonSpecDigest}`,
  );
  return { specificationId: receipt.specId, jobId: job.id, reused };
}

export async function runFundedComparisonCli(
  args: readonly string[],
  dependencies: FundedComparisonCliDependencies,
): Promise<unknown> {
  const input = parseFundedComparisonArgs(args);
  if (input.mode === "status")
    return dependencies.read.get(input.specificationId!);

  const plan = await dependencies.resolvePlan(input);
  if (input.mode === "plan" || !input.apply)
    return {
      mode: input.mode,
      apply: input.apply,
      baseline: { runId: plan.baselineRunId },
      ...withoutPrepared(plan),
    };
  const receipt = await dependencies.freezeAndEnqueue(input, plan);
  return {
    mode: input.mode,
    apply: true,
    baseline: { runId: plan.baselineRunId },
    ...withoutPrepared(plan),
    ...receipt,
  };
}

function withoutPrepared(
  plan: FundedComparisonPlan,
): Omit<FundedComparisonPlan, "prepared"> {
  const { prepared: _prepared, ...publicPlan } = plan;
  return publicPlan;
}

function currencyOf(marketId: MarketId): "CAD" | "USD" {
  return marketId === "CA_TSX" ? "CAD" : "USD";
}

async function challengerIdentity(
  pool: Pool,
  marketId: MarketId,
  challengerId: string,
): Promise<{
  identity: FundedComparisonChallengerPolicyIdentity;
  training: FundedComparisonTrainingWindow;
}> {
  const currency = currencyOf(marketId);
  const result = await pool.query<{
    id: string;
    model_version: string;
    artifact_digest: string;
    cohort_digest: string;
    dataset_digest: string;
    dataset_id: string;
    feature_version: string;
  }>(
    `SELECT id,model_version,artifact_digest,cohort_digest,dataset_digest,
       dataset_id,feature_version
     FROM funded_execution_challenger
     WHERE id=$1 AND market_id=$2 AND currency=$3
       AND status='INACTIVE' AND eligible_for_activation=false AND active=false`,
    [challengerId, marketId, currency],
  );
  const row = result.rows[0];
  if (!row) throw new Error("MODEL_IDENTITY_MISMATCH");
  const training = await loadFundedComparisonTrainingLineage(
    pool,
    row.dataset_id,
  );
  const identity: FundedComparisonChallengerPolicyIdentity = {
    kind: "FUNDED_EXECUTION_POLICY_V1",
    policyVersion: FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
    policyDigest: fundedComparisonChallengerPolicyDigest(),
    model: {
      modelId: row.id,
      modelVersion: row.model_version,
      artifactDigest: row.artifact_digest,
      datasetDigest: row.dataset_digest,
      cohortDigest: row.cohort_digest,
      featureVersion: row.feature_version as "funded-execution-features-v1",
      predictionPolicyVersion: FUNDED_EXECUTION_PREDICTION_VERSION,
      trainingPartitionDigest: training.trainingPartitionDigest,
      trainingEvidenceCutoffAt: training.trainingKnowledgeCutoffAt,
      trainingSessionDigest: training.trainingSessionDigest,
    },
  };
  return { identity, training };
}

function replayPolicy(
  config: ApiConfig,
  marketId: MarketId,
): ReplaySessionPolicy {
  return {
    marketId,
    timezone:
      marketId === "CA_TSX"
        ? config.SESSION_TIMEZONE
        : config.US_SESSION_TIMEZONE,
    openingRange: {
      start: config.OPENING_RANGE_START,
      end: config.OPENING_RANGE_END,
    },
    scanning: { start: config.SCANNING_START, end: config.SCANNING_END },
    entries: {
      preferredStart: config.ENTRY_PREFERRED_START,
      preferredEnd: config.ENTRY_PREFERRED_END,
      hardEnd: config.ENTRY_HARD_END,
    },
    benchmarkMaxStalenessSeconds: config.BENCHMARK_MAX_STALENESS_SECONDS,
  };
}

function productionDependencies(
  pool: Pool,
  config: ApiConfig,
): FundedComparisonCliDependencies {
  const backtests = new PostgresBacktestStore(pool);
  const scanner = new ScannerFeatureClient(
    new URL(config.SCANNER_URL),
    600_000,
    config.SCANNER_SERVICE_TOKEN,
  );
  const repository = new FundedComparisonRepository(pool);
  const jobs = new ResearchJobRepository(pool);
  const read = new FundedComparisonReadService(repository);
  return {
    read,
    resolvePlan: async (input) => {
      const marketId = input.marketId!;
      const challenger = await challengerIdentity(
        pool,
        marketId,
        input.challengerId!,
      );
      const fundedAccountId =
        marketId === "CA_TSX"
          ? config.PAPER_FUNDED_CAD_ACCOUNT_ID
          : config.PAPER_FUNDED_USD_ACCOUNT_ID;
      if (!fundedAccountId) throw new Error("CHAMPION_NOT_RETAINED");
      const champion = await resolveFundedComparisonChampion(
        pool,
        marketId,
        fundedAccountId,
      );
      const frozen = await freezeFundedComparisonSharedInput(
        {
          baselineRunId: input.baselineRunId!,
          marketId,
          evidenceCutoffAt: input.evidenceCutoffAt!,
          maxSessions: input.maxSessions!,
          replayPolicy: replayPolicy(config, marketId),
        },
        { pool, store: backtests, engine: scanner },
      );
      return {
        marketId,
        currency: currencyOf(marketId),
        baselineRunId: input.baselineRunId!,
        challengerId: input.challengerId!,
        sessionCount: frozen.sessionDates.length,
        opportunityCount: frozen.opportunities.length,
        sessions: frozen.sessionDates,
        opportunities: frozen.opportunities.map(
          (opportunity) => opportunity.sourceOpportunityId,
        ),
        champion: {
          sourceRunId: champion.champion.sourceLiveRunId,
          sourceAccountId: champion.champion.sourceAccountId,
          policyDigest: champion.champion.policyDigest,
        },
        challenger: {
          modelId: challenger.identity.model.modelId,
          modelVersion: challenger.identity.model.modelVersion,
          policyDigest: challenger.identity.policyDigest,
        },
        prepared: {
          frozen,
          champion,
          challenger: challenger.identity,
          training: challenger.training,
        },
      };
    },
    freezeAndEnqueue: async (input, plan) => {
      const prepared = plan.prepared;
      if (!prepared) throw new Error("COMPARISON_PLAN_NOT_PREPARED");
      return enqueueFundedComparison(
        {
          marketId: plan.marketId,
          baselineBacktestRunId: prepared.frozen.baseline.backtestRunId,
          championPolicyDigest: prepared.champion.champion.policyDigest,
          challengerPolicyDigest: prepared.challenger.policyDigest,
          evidenceCutoffAt: input.evidenceCutoffAt!,
          maxSessions: input.maxSessions!,
        },
        {
          repository,
          jobs,
          build: (specificationFrozenAt) => {
            const specification = buildFundedComparisonSpecification({
              marketId: plan.marketId,
              baseline: prepared.frozen.baseline,
              sessionDates: prepared.frozen.sessionDates,
              sessions: prepared.frozen.sessions,
              replay: prepared.frozen.replay,
              opportunities: prepared.frozen.opportunities,
              champion: prepared.champion.champion,
              challenger: prepared.challenger,
              capital: prepared.champion.capital,
              training: prepared.training,
              lastInputEffectiveAt: prepared.frozen.lastInputEffectiveAt,
              evidenceCutoffAt: input.evidenceCutoffAt!,
              specificationFrozenAt,
            });
            return {
              specification,
              sessions: prepared.frozen.sessions.map((session) => ({
                sessionDate: session.sessionDate,
                sessionStartAt: session.sessionStartAt,
                scheduledCloseAt: session.scheduledCloseAt,
                sessionTimezone: session.sessionTimezone,
                itemCount: session.itemCount,
                chunkCount: session.chunkCount,
                sessionInputDigest: session.sessionInputDigest,
                chunks: session.chunks,
                opportunities: session.opportunities,
              })),
            };
          },
        },
      );
    },
  };
}

export async function main(): Promise<void> {
  const input = parseFundedComparisonArgs(process.argv.slice(2));
  if (input.mode === "status") {
    if (!process.env.DATABASE_URL)
      throw new Error(
        "Set DATABASE_URL explicitly; this command never migrates the database",
      );
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 2,
    });
    try {
      const output = await runFundedComparisonCli(
        process.argv.slice(2),
        productionDependencies(pool, loadConfig()),
      );
      console.log(JSON.stringify(output, null, 2));
    } finally {
      await pool.end();
    }
    return;
  }
  if (!process.env.DATABASE_URL)
    throw new Error(
      "Set DATABASE_URL explicitly; this command never migrates the database",
    );
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  try {
    const output = await runFundedComparisonCli(
      process.argv.slice(2),
      productionDependencies(pool, loadConfig()),
    );
    console.log(JSON.stringify(output, null, 2));
  } finally {
    await pool.end();
  }
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
)
  await main();
