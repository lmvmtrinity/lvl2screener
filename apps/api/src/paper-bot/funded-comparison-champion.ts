import type {
  FundedComparisonCapital,
  FundedComparisonChampionPolicyIdentity,
  FundedComparisonFailureReason,
  FundedComparisonRunBinding,
  FundedComparisonSpecification,
  MarketId,
} from "@tsx-scanner/contracts";
import type { Pool } from "pg";
import {
  accountAssumptionDigest,
  contentHash,
} from "./funded-evidence-digest.js";
import {
  executionAssumptionsEvidence,
  fundedPolicyVersion,
  participationPolicyVersion,
} from "./funded-decision-evidence.js";
import { normalizeFundedPolicy, type FundedPolicy } from "./funded-policy.js";
import { costSnapshotOf } from "./financials.js";
import type { AssumptionsSnapshot } from "./types.js";

/**
 * Durable champion resolution (FP03 section 2). The champion is the frozen
 * deterministic funded policy that currently controls the applicable
 * paper-funded portfolio, resolved from `paper_bot_run`/`paper_funded_run`/
 * `paper_funded_account` rows only. Mutable `ApiConfig` may locate the
 * configured account ID but never supplies or overrides frozen economics.
 */

export class FundedComparisonChampionError extends Error {
  constructor(
    readonly reason: FundedComparisonFailureReason,
    message: string,
  ) {
    super(message);
    this.name = "FundedComparisonChampionError";
  }
}

export interface FundedComparisonChampionSource {
  readonly marketId: MarketId;
  readonly currency: "CAD" | "USD";
  readonly sourceRunId: string;
  readonly sourceAccountId: string;
  readonly status: string;
  readonly policy: unknown;
  readonly assumptions: AssumptionsSnapshot;
  readonly executionModelVersion: string;
  readonly initialCash: number;
  readonly dailyLossLimit: number;
}

export interface ResolvedFundedComparisonChampion {
  readonly champion: FundedComparisonChampionPolicyIdentity;
  readonly capital: FundedComparisonCapital;
  readonly source: FundedComparisonChampionSource;
}

/** Legacy policies without portfolio control keep their legacy shape. */
export function portfolioPolicyVersionOf(policy: unknown): string {
  const candidate = (policy ?? {}) as { portfolio?: { version?: unknown } };
  const version = candidate.portfolio?.version;
  if (version === "funded-portfolio-v1" || version === "funded-portfolio-v2")
    return version;
  return "funded-portfolio-v1-legacy";
}

/**
 * Digest of the durable risk configuration that actually governs the replay:
 * initial cash, daily-loss limit and the persisted portfolio caps. Missing
 * legacy portfolio controls stay null rather than defaulting to another
 * market's or another policy's values.
 */
export function riskConfigurationDigestOf(
  initialCash: number,
  dailyLossLimit: number,
  portfolio: FundedPolicy["portfolio"],
): string {
  return contentHash({
    initialCash,
    dailyLossLimit,
    maxOpenPositions: portfolio?.maxOpenPositions ?? null,
    maxTotalOpenRisk: portfolio?.maxTotalOpenRisk ?? null,
    maxSymbolNotional: portfolio?.maxSymbolNotional ?? null,
    maxSectorNotional: portfolio?.maxSectorNotional ?? null,
    cooldownMinutesAfterStop: portfolio?.cooldownMinutesAfterStop ?? null,
    maxConsecutiveStops: portfolio?.maxConsecutiveStops ?? null,
  });
}

export function fundedComparisonChampionFromSource(
  source: FundedComparisonChampionSource,
): ResolvedFundedComparisonChampion {
  const expectedCurrency = source.marketId === "CA_TSX" ? "CAD" : "USD";
  if (source.currency !== expectedCurrency)
    throw new FundedComparisonChampionError(
      "MARKET_CURRENCY_MISMATCH",
      "The champion source account belongs to another market or currency",
    );
  if (!source.policy)
    throw new FundedComparisonChampionError(
      "CHAMPION_NOT_RETAINED",
      "The retained champion run has no persisted funded policy",
    );
  const policy = normalizeFundedPolicy(source.policy as FundedPolicy);
  const champion: FundedComparisonChampionPolicyIdentity = {
    kind: "DETERMINISTIC_FUNDED_POLICY",
    fundedPolicyVersion: fundedPolicyVersion(policy),
    portfolioPolicyVersion: portfolioPolicyVersionOf(policy),
    policyDigest: contentHash(source.policy),
    sourceLiveRunId: source.sourceRunId,
    sourceAccountId: source.sourceAccountId,
    executionModelVersion: source.executionModelVersion,
    costPolicyVersion: costSnapshotOf(source.assumptions).brokerPricingVersion,
    participationVersion: participationPolicyVersion(policy),
    runtimeVersion: contentHash({
      executionModelVersion: source.executionModelVersion,
      assumptionsDigest: contentHash(source.assumptions),
    }),
    accountAssumptionDigest: accountAssumptionDigest(
      executionAssumptionsEvidence(source.assumptions),
    ),
    assumptionsDigest: contentHash(source.assumptions),
  };
  const capital: FundedComparisonCapital = {
    initialCash: source.initialCash,
    dailyLossLimit: source.dailyLossLimit,
    riskConfigurationDigest: riskConfigurationDigestOf(
      source.initialCash,
      source.dailyLossLimit,
      policy.portfolio,
    ),
  };
  return { champion, capital, source };
}

interface ChampionRow {
  run_id: string;
  status: string;
  execution_model_version: string;
  assumptions: AssumptionsSnapshot;
  policy: unknown;
  account_id: string;
  currency: "CAD" | "USD";
  initial_state: { cash: number; dailyLossLimit: number; currency: string };
}

/**
 * Resolution order: the newest active LIVE run for the configured funded
 * account, otherwise its newest COMPLETED LIVE run, otherwise fail closed as
 * `CHAMPION_NOT_RETAINED`.
 */
export async function resolveFundedComparisonChampion(
  pool: Pool,
  marketId: MarketId,
  fundedAccountId: string,
): Promise<ResolvedFundedComparisonChampion> {
  const currency = marketId === "CA_TSX" ? "CAD" : "USD";
  const { rows } = await pool.query<ChampionRow>(
    `SELECT r.id AS run_id,r.status,r.execution_model_version,r.assumptions,
       b.policy,b.account_id,b.currency,a.initial_state
     FROM paper_bot_run r
     JOIN paper_funded_run b ON b.run_id=r.id
     JOIN paper_funded_account a ON a.id=b.account_id
     WHERE r.source='LIVE' AND r.market_id=$1 AND b.account_id=$2
       AND b.currency=$3
       AND r.status IN ('RUNNING','CLOSE_PENDING','COMPLETED')
     ORDER BY CASE WHEN r.status IN ('RUNNING','CLOSE_PENDING') THEN 0 ELSE 1 END,
       r.started_at DESC,r.id
     LIMIT 1`,
    [marketId, fundedAccountId, currency],
  );
  const row = rows[0];
  if (!row)
    throw new FundedComparisonChampionError(
      "CHAMPION_NOT_RETAINED",
      "No retained LIVE funded run exists for the configured account",
    );
  if (!row.initial_state)
    throw new FundedComparisonChampionError(
      "REPLAY_LINEAGE_UNAVAILABLE",
      "The champion account has no retained initial ledger state",
    );
  return fundedComparisonChampionFromSource({
    marketId,
    currency: row.currency,
    sourceRunId: row.run_id,
    sourceAccountId: row.account_id,
    status: row.status,
    policy: row.policy,
    assumptions: row.assumptions,
    executionModelVersion: row.execution_model_version,
    initialCash: Number(row.initial_state.cash),
    dailyLossLimit: Number(row.initial_state.dailyLossLimit),
  });
}

function assertBindingOwnership(
  specification: Pick<FundedComparisonSpecification, "marketId" | "currency">,
  binding: FundedComparisonRunBinding,
): void {
  if (
    binding.marketId !== specification.marketId ||
    binding.currency !== specification.currency
  )
    throw new FundedComparisonChampionError(
      "MARKET_CURRENCY_MISMATCH",
      "A comparison binding crosses market or currency ownership",
    );
}

/** Pre-session and pre-finalization champion identity recheck. */
export function verifyChampionBinding(
  specification: Pick<
    FundedComparisonSpecification,
    "marketId" | "currency" | "champion"
  >,
  binding: FundedComparisonRunBinding,
): void {
  assertBindingOwnership(specification, binding);
  if (
    binding.side !== "CHAMPION" ||
    binding.policyDigest !== specification.champion.policyDigest ||
    binding.executionModelVersion !==
      specification.champion.executionModelVersion ||
    binding.accountAssumptionDigest !==
      specification.champion.accountAssumptionDigest
  )
    throw new FundedComparisonChampionError(
      "CHAMPION_POLICY_IDENTITY_MISMATCH",
      "The champion binding no longer matches the frozen champion identity",
    );
}

/** Pre-session and pre-finalization challenger identity recheck. */
export function verifyChallengerBinding(
  specification: Pick<
    FundedComparisonSpecification,
    "marketId" | "currency" | "challenger"
  >,
  binding: FundedComparisonRunBinding,
): void {
  assertBindingOwnership(specification, binding);
  if (
    binding.side !== "CHALLENGER" ||
    binding.policyDigest !== specification.challenger.policyDigest
  )
    throw new FundedComparisonChampionError(
      "CHALLENGER_POLICY_IDENTITY_MISMATCH",
      "The challenger binding no longer matches the frozen challenger identity",
    );
}
