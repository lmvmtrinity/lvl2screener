import type { BacktestAutomationStageDefinition } from "./backtest-automation.js";
import type { PostgresBacktestStore } from "./backtest-repository.js";
import type { FundedHistoricalAutomationService } from "../paper-bot/funded-historical-automation.js";
import { contentHash } from "./research-coverage.js";

export interface FundedReplayStageDependencies {
  readonly policies: FundedHistoricalAutomationService;
  readonly runs: Pick<PostgresBacktestStore, "get">;
}

/**
 * A3 stage: eligible only under an active, bounded policy approved for this
 * exact immutable experiment scope. Without a policy it records a visible
 * NOT_ELIGIBLE state and no funded job is enqueued. The approved policy is
 * re-verified inside the job handler, so a revoked or expired policy can never
 * authorize writes after the stage decision.
 */
export function fundedReplayStage(
  deps: FundedReplayStageDependencies,
): BacktestAutomationStageDefinition {
  return {
    key: "FUNDED_REPLAY",
    authorizationScope: "POLICY_REQUIRED",
    async evaluate({ work }) {
      const policy = await deps.policies.activePolicyFor(work.marketId, {
        kind: "PROFILE_CONFIG",
        configId: work.identity.configId,
        configVersion: work.identity.configVersion,
      });
      if (!policy)
        return {
          kind: "NOT_ELIGIBLE",
          reasonCodes: ["FUNDED_AUTOMATION_POLICY_NOT_APPROVED"],
          inputIdentityHash: null,
        };
      if (!work.runId)
        return {
          kind: "WAITING_FOR_EVIDENCE",
          reasonCodes: ["COMPLETED_RUN_UNAVAILABLE"],
          inputIdentityHash: null,
        };
      const run = await deps.runs.get(work.runId);
      if (!run || run.status !== "COMPLETED")
        return {
          kind: "WAITING_FOR_EVIDENCE",
          reasonCodes: ["COMPLETED_RUN_UNAVAILABLE"],
          inputIdentityHash: null,
        };
      if (run.configVersion !== work.identity.configVersion)
        return {
          kind: "NOT_ELIGIBLE",
          reasonCodes: ["BASELINE_CONFIG_MISMATCH"],
          inputIdentityHash: null,
        };
      return {
        kind: "DISPATCH",
        reasonCodes: ["FUNDED_AUTOMATION_POLICY_APPROVED"],
        inputIdentityHash: contentHash({
          runId: run.id,
          policyHash: policy.policyHash,
        }),
        jobType: "FUNDED_HISTORICAL_REPLAY",
        payload: {
          version: "funded-historical-replay-v1",
          policyId: policy.policyId,
          policyHash: policy.policyHash,
          backtestRunId: run.id,
        },
        idempotencyKey: `funded-historical-replay:${policy.policyHash}:${run.id}`,
      };
    },
  };
}
