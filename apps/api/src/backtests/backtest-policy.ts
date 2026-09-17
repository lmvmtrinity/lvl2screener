import type {
  CapturedHistoryAvailability,
  CreateBacktest,
} from "@tsx-scanner/contracts";
import { costPolicyForMarket } from "../paper-bot/cost-policy.js";

/**
 * Shared execution-policy checks for every path that creates a replay run.
 * The worker handler and the synchronous service must reject identically;
 * callers translate the violation into their own error type.
 */
export type BacktestPolicyViolationCode =
  "INVALID_RANGE" | "HISTORY_UNAVAILABLE";

export interface BacktestPolicyViolation {
  readonly code: BacktestPolicyViolationCode;
  readonly message: string;
}

export function checkBacktestRequest(
  input: Pick<
    CreateBacktest,
    "startDate" | "endDate" | "marketId" | "slippageBps"
  >,
  availability?: CapturedHistoryAvailability,
): BacktestPolicyViolation | null {
  if (input.endDate < input.startDate)
    return {
      code: "INVALID_RANGE",
      message: "endDate must be on or after startDate",
    };
  if (input.marketId === "US_EQUITIES") {
    const floor = costPolicyForMarket("US_EQUITIES").slippageBps;
    if (input.slippageBps < floor)
      return {
        code: "INVALID_RANGE",
        message: `US backtest slippageBps must be at least ${floor} to match the forward-paper cost policy; higher stress is allowed.`,
      };
  }
  return availability ? checkCapturedHistoryRange(input, availability) : null;
}

export function checkCapturedHistoryRange(
  input: Pick<CreateBacktest, "startDate" | "endDate">,
  availability: CapturedHistoryAvailability,
): BacktestPolicyViolation | null {
  const { earliestDate, latestDate } = availability.replay;
  if (!earliestDate || !latestDate)
    return {
      code: "HISTORY_UNAVAILABLE",
      message:
        "Captured quote history is empty; collect quote snapshots before starting research.",
    };
  if (input.startDate < earliestDate || input.endDate > latestDate)
    return {
      code: "HISTORY_UNAVAILABLE",
      message: `Captured quote history is available from ${earliestDate} through ${latestDate}; requested range ${input.startDate} through ${input.endDate} cannot be replayed completely.`,
    };
  return null;
}
