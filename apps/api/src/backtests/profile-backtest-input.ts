import {
  setupStrategyNameSchema,
  type CapturedHistoryAvailability,
  type CreateBacktest,
  type ScannerProfile,
} from "@tsx-scanner/contracts";
import { costPolicyForMarket } from "../paper-bot/cost-policy.js";
import {
  checkBacktestRequest,
  type BacktestPolicyViolation,
} from "./backtest-policy.js";

/**
 * Recorded automation policy for profile qualification replays. CA keeps the
 * forward-paper default already used by every qualification run; US uses the
 * shared floor the policy validator enforces. Construction and validation must
 * agree so automation cannot enqueue a request the validator rejects.
 */
export function automationSlippageBps(
  marketId: "CA_TSX" | "US_EQUITIES",
): number {
  return marketId === "US_EQUITIES"
    ? costPolicyForMarket("US_EQUITIES").slippageBps
    : 2;
}

export interface ProfileQualificationInput {
  readonly input: CreateBacktest;
  readonly violation: BacktestPolicyViolation | null;
}

/**
 * Canonical automation payload for one immutable profile configuration over a
 * captured range. Returns the policy violation instead of throwing so the
 * caller can record a blocker rather than enqueueing predictable failures.
 */
export function profileQualificationInput(
  profile: ScannerProfile,
  availability: CapturedHistoryAvailability,
): ProfileQualificationInput {
  const strategy = setupStrategyNameSchema.parse(profile.strategyKey);
  const input: CreateBacktest = {
    name: `Auto qualification · ${profile.name} · ${profile.configVersion}`.slice(
      0,
      120,
    ),
    marketId: profile.marketId,
    startDate: availability.replay.earliestDate!,
    endDate: availability.replay.latestDate!,
    strategies: [strategy],
    symbols: [],
    dataSource: "CAPTURED_QUOTES",
    startingCapital: 100_000,
    positionSize: 10_000,
    slippageBps: automationSlippageBps(profile.marketId),
    feePerTrade: 0,
    parameters: profile.parameters,
  };
  return { input, violation: checkBacktestRequest(input, availability) };
}
