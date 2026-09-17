import type { MarketId } from "@tsx-scanner/contracts";
import type { ApiConfig } from "../config.js";
import { costPolicyForMarket } from "./cost-policy.js";
import { fundedPolicy, type FundedPolicy } from "./funded-policy.js";
import { stableUuid } from "./stable-uuid.js";
import type { AssumptionsSnapshot } from "./types.js";

/**
 * Historical funded replay runs use the same market policy shape as the live
 * funded paper bot, but they are separate accounts and never inherit a live
 * account's funding identity. These helpers keep the two configurations
 * visibly parallel instead of copying literals into the CLI.
 */
export interface HistoricalMarketRisk {
  readonly riskBudget: number;
  readonly maxSymbolNotional: number;
  readonly maxSectorNotional: number;
  readonly maxTotalOpenRisk: number;
  readonly initialCash: number;
  readonly dailyLossLimit: number;
  readonly timezone: "America/Toronto" | "America/New_York";
}

export function historicalMarketRisk(
  config: ApiConfig,
  marketId: MarketId,
): HistoricalMarketRisk {
  if (marketId === "US_EQUITIES")
    return {
      riskBudget: config.PAPER_BOT_RISK_BUDGET_USD,
      maxSymbolNotional: config.PAPER_COORDINATION_MAX_SYMBOL_NOTIONAL_USD,
      maxSectorNotional: config.PAPER_COORDINATION_MAX_SECTOR_NOTIONAL_USD,
      maxTotalOpenRisk: config.PAPER_COORDINATION_MAX_TOTAL_OPEN_RISK_USD,
      initialCash: config.PAPER_FUNDED_INITIAL_CASH_USD,
      dailyLossLimit: config.PAPER_FUNDED_DAILY_LOSS_LIMIT_USD,
      timezone: config.US_SESSION_TIMEZONE,
    };
  return {
    riskBudget: config.PAPER_BOT_RISK_BUDGET_CAD,
    maxSymbolNotional: config.PAPER_COORDINATION_MAX_SYMBOL_NOTIONAL_CAD,
    maxSectorNotional: config.PAPER_COORDINATION_MAX_SECTOR_NOTIONAL_CAD,
    maxTotalOpenRisk: config.PAPER_COORDINATION_MAX_TOTAL_OPEN_RISK_CAD,
    initialCash: config.PAPER_FUNDED_INITIAL_CASH_CAD,
    dailyLossLimit: config.PAPER_FUNDED_DAILY_LOSS_LIMIT_CAD,
    timezone: config.SESSION_TIMEZONE,
  };
}

export function historicalFundedAssumptions(
  config: ApiConfig,
  marketId: MarketId,
): AssumptionsSnapshot {
  const risk = historicalMarketRisk(config, marketId);
  return {
    positionSize: risk.maxSymbolNotional,
    slippageBps: config.PAPER_BOT_SLIPPAGE_BPS,
    feePerTrade: config.PAPER_BOT_FEE_PER_TRADE,
    costs: {
      ...costPolicyForMarket(marketId),
      exitCommission: config.PAPER_BOT_FEE_PER_TRADE,
      slippageBps: config.PAPER_BOT_SLIPPAGE_BPS,
    },
    riskBudget: risk.riskBudget,
    maxNotional: risk.maxSymbolNotional,
    economics: {
      minNetRewardRisk: config.PAPER_BOT_MIN_NET_REWARD_RISK,
      minStopFrictionMultiple: config.PAPER_BOT_MIN_STOP_FRICTION_MULTIPLE,
      minTargetFrictionMultiple: config.PAPER_BOT_MIN_TARGET_FRICTION_MULTIPLE,
      maxSpreadPct: config.PAPER_BOT_MAX_SPREAD_PCT,
    },
    stopMethod: "STRUCTURAL",
    atrStopMultiple: 1,
    rewardRiskRatio: null,
    maxQuoteAgeSeconds: 30,
    sessionTimezone: risk.timezone,
    noonCloseTime: "16:00",
    evidenceScope: "FUNDED_HISTORICAL_REPLAY",
  };
}

export function historicalFundedPolicy(
  config: ApiConfig,
  marketId: MarketId,
): FundedPolicy {
  const risk = historicalMarketRisk(config, marketId);
  return fundedPolicy(
    config.PAPER_COORDINATION_MAX_DISPLAYED_SIZE_PARTICIPATION,
    0,
    {
      maxOpenPositions: config.PAPER_COORDINATION_MAX_OPEN_POSITIONS,
      maxTotalOpenRisk: risk.maxTotalOpenRisk,
      maxSymbolNotional: risk.maxSymbolNotional,
      maxSectorNotional: risk.maxSectorNotional,
      cooldownMinutesAfterStop:
        config.PAPER_COORDINATION_COOLDOWN_MINUTES_AFTER_STOP,
      maxConsecutiveStops: config.PAPER_COORDINATION_MAX_CONSECUTIVE_STOPS,
      requireFreshContext: config.PAPER_COORDINATION_REQUIRE_FRESH_CONTEXT,
      contextRequirement: config.PAPER_COORDINATION_CONTEXT_REQUIREMENT,
      contextMaxAgeSeconds: config.PAPER_COORDINATION_CONTEXT_MAX_AGE_SECONDS,
      vetoOnWeakContext: config.PAPER_COORDINATION_VETO_ON_WEAK_CONTEXT,
      maximumHoldingMinutes: config.PAPER_COORDINATION_MAX_HOLDING_MINUTES,
      maximumHoldingMinutesByStrategy:
        config.PAPER_COORDINATION_MAX_HOLDING_MINUTES_BY_STRATEGY,
      stalledBreakoutMinutes:
        config.PAPER_COORDINATION_STALLED_BREAKOUT_MINUTES,
      stalledBreakoutMinProgressR:
        config.PAPER_COORDINATION_STALLED_BREAKOUT_MIN_PROGRESS_R,
    },
  );
}

export function historicalFundedAccountId(
  marketId: MarketId,
  initialCash: number,
  dailyLossLimit: number,
): string {
  return stableUuid(
    `funded-historical-account:${marketId}:${initialCash}:${dailyLossLimit}`,
  );
}

/**
 * A3 automation account identity: scoped to the frozen approval, not to the
 * market or currency, so separate experiments can never inherit each other's
 * balances. Only dedicated historical replay runs use this id.
 */
export function historicalAutomationAccountId(policyHash: string): string {
  return stableUuid(`funded-historical-automation-account:${policyHash}`);
}
