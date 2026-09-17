import { isDeepStrictEqual } from "node:util";
export interface FundedPortfolioPolicy {
  /** Versioned controls shared by funded live and historical projections. */
  readonly version: "funded-portfolio-v1" | "funded-portfolio-v2";
  readonly maxOpenPositions: number;
  readonly maxTotalOpenRisk: number;
  readonly maxSymbolNotional?: number;
  readonly maxSectorNotional?: number;
  readonly cooldownMinutesAfterStop: number;
  readonly maxConsecutiveStops: number;
  /** Context controls are opt-in until context evidence is carried with a signal. */
  readonly requireFreshContext: boolean;
  readonly contextMaxAgeSeconds: number;
  readonly vetoOnWeakContext: boolean;
  readonly contextRequirement?: "MARKET_ONLY" | "MARKET_AND_SECTOR_REQUIRED";
  readonly maximumHoldingMinutes?: number;
  readonly maximumHoldingMinutesByStrategy?: Readonly<Record<string, number>>;
  readonly stalledBreakoutMinutes?: number;
  readonly stalledBreakoutMinProgressR?: number;
}

export type FundedPortfolioPolicyInput = Partial<
  Omit<FundedPortfolioPolicy, "version">
> & { readonly version?: "funded-portfolio-v1" | "funded-portfolio-v2" };

export interface FundedPolicy {
  projectionVersion: "funded-cash-v1";
  participation: number;
  impactBps: number;
  latencyPolicy: "CAPTURED_PER_ORDER";
  /** Explicit portfolio controls; omitted only by pre-v1 persisted policies. */
  readonly portfolio?: FundedPortfolioPolicy;
}

export function defaultFundedPortfolioPolicy(): FundedPortfolioPolicy {
  return {
    version: "funded-portfolio-v2",
    maxOpenPositions: 3,
    maxTotalOpenRisk: 1_000,
    cooldownMinutesAfterStop: 15,
    maxConsecutiveStops: 3,
    requireFreshContext: false,
    contextMaxAgeSeconds: 300,
    vetoOnWeakContext: false,
  };
}

export function normalizeFundedPolicy(policy: FundedPolicy): FundedPolicy {
  const canonical = fundedPolicy(
    policy.participation,
    policy.impactBps,
    policy.portfolio,
  );
  if (policy.portfolio === undefined)
    delete (canonical as { portfolio?: FundedPortfolioPolicy }).portfolio;
  if (!isDeepStrictEqual(policy, canonical))
    throw new Error("Non-canonical funded policy");
  return canonical;
}

export function fundedPolicy(
  participation = 1,
  impactBps = 0,
  portfolio: FundedPortfolioPolicyInput = {},
): FundedPolicy {
  if (
    !Number.isFinite(participation) ||
    participation <= 0 ||
    participation > 1 ||
    !Number.isFinite(impactBps) ||
    impactBps < 0 ||
    impactBps > 10000
  )
    throw new Error("Invalid funded liquidity policy");
  const canonicalPortfolio: FundedPortfolioPolicy = {
    ...defaultFundedPortfolioPolicy(),
    ...Object.fromEntries(
      Object.entries(portfolio).filter(([, value]) => value !== undefined),
    ),
  };
  if (
    !["funded-portfolio-v1", "funded-portfolio-v2"].includes(
      canonicalPortfolio.version,
    ) ||
    typeof canonicalPortfolio.requireFreshContext !== "boolean" ||
    typeof canonicalPortfolio.vetoOnWeakContext !== "boolean" ||
    (canonicalPortfolio.contextRequirement !== undefined &&
      !["MARKET_ONLY", "MARKET_AND_SECTOR_REQUIRED"].includes(
        canonicalPortfolio.contextRequirement,
      )) ||
    [
      canonicalPortfolio.maximumHoldingMinutes,
      canonicalPortfolio.stalledBreakoutMinutes,
      ...Object.values(
        canonicalPortfolio.maximumHoldingMinutesByStrategy ?? {},
      ),
    ].some(
      (value) => value !== undefined && (!Number.isFinite(value) || value <= 0),
    ) ||
    (canonicalPortfolio.stalledBreakoutMinProgressR !== undefined &&
      (!Number.isFinite(canonicalPortfolio.stalledBreakoutMinProgressR) ||
        canonicalPortfolio.stalledBreakoutMinProgressR < 0)) ||
    !Number.isInteger(canonicalPortfolio.maxOpenPositions) ||
    canonicalPortfolio.maxOpenPositions < 1 ||
    !Number.isFinite(canonicalPortfolio.maxTotalOpenRisk) ||
    canonicalPortfolio.maxTotalOpenRisk <= 0 ||
    !Number.isInteger(canonicalPortfolio.cooldownMinutesAfterStop) ||
    canonicalPortfolio.cooldownMinutesAfterStop < 0 ||
    !Number.isInteger(canonicalPortfolio.maxConsecutiveStops) ||
    canonicalPortfolio.maxConsecutiveStops < 1 ||
    !Number.isInteger(canonicalPortfolio.contextMaxAgeSeconds) ||
    canonicalPortfolio.contextMaxAgeSeconds < 1 ||
    (canonicalPortfolio.maxSymbolNotional !== undefined &&
      (!Number.isFinite(canonicalPortfolio.maxSymbolNotional) ||
        canonicalPortfolio.maxSymbolNotional <= 0)) ||
    (canonicalPortfolio.maxSectorNotional !== undefined &&
      (!Number.isFinite(canonicalPortfolio.maxSectorNotional) ||
        canonicalPortfolio.maxSectorNotional <= 0))
  )
    throw new Error("Invalid funded portfolio policy");
  return {
    projectionVersion: "funded-cash-v1",
    participation,
    impactBps,
    latencyPolicy: "CAPTURED_PER_ORDER",
    portfolio: canonicalPortfolio,
  };
}
