import { fundedHistoricalReplayJobPayloadSchema } from "@tsx-scanner/contracts";
import type { PostgresBacktestStore } from "../../backtests/backtest-repository.js";
import {
  fundedPolicyIsActive,
  type FundedHistoricalAutomationService,
} from "../../paper-bot/funded-historical-automation.js";
import { historicalAutomationAccountId } from "../../paper-bot/funded-historical-config.js";
import type {
  FundedHistoricalRangeInput,
  FundedHistoricalRangeResult,
} from "../../paper-bot/funded-historical-runner.js";
import {
  CancelledError,
  CategorizedError,
  type ClaimedResearchJob,
  type JobContext,
  type ResearchJobHandler,
} from "../research-worker.js";

export type FundedHistoricalRangeExecutor = (
  input: FundedHistoricalRangeInput,
  betweenSessions: () => Promise<void>,
) => Promise<FundedHistoricalRangeResult>;

/**
 * A3 worker handler. Re-verifies the approved policy at execution time (active,
 * hash match, scope match) and then applies the bounded range on the dedicated
 * policy-derived replay account. Live funded accounts are never referenced.
 * Re-runs are idempotent per provisioned run, and cancellation between sessions
 * leaves committed, reconcilable effects.
 */
export class FundedHistoricalReplayJobHandler implements ResearchJobHandler {
  constructor(
    private readonly policies: FundedHistoricalAutomationService,
    private readonly runs: Pick<PostgresBacktestStore, "get">,
    private readonly executeRange: FundedHistoricalRangeExecutor,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async execute(
    job: ClaimedResearchJob,
    context: JobContext,
  ): Promise<{ resultRefId: string }> {
    const parsed = fundedHistoricalReplayJobPayloadSchema.safeParse(
      job.requestPayload,
    );
    if (!parsed.success)
      throw new CategorizedError(
        "VALIDATION",
        `Funded historical replay payload failed validation: ${parsed.error.message}`,
      );
    const payload = parsed.data;
    const policy = await this.policies.getPolicy(payload.policyId);
    if (!policy)
      throw new CategorizedError(
        "VALIDATION",
        "FUNDED_HISTORICAL_POLICY_NOT_FOUND",
      );
    if (policy.policyHash !== payload.policyHash)
      throw new CategorizedError(
        "VALIDATION",
        "FUNDED_HISTORICAL_POLICY_HASH_MISMATCH",
      );
    if (!fundedPolicyIsActive(policy, this.now()))
      throw new CategorizedError(
        "VALIDATION",
        "FUNDED_HISTORICAL_POLICY_NOT_ACTIVE",
      );
    const run = await this.runs.get(payload.backtestRunId);
    if (!run || run.status !== "COMPLETED")
      throw new CategorizedError(
        "HISTORY_UNAVAILABLE",
        "FUNDED_HISTORICAL_BASELINE_UNAVAILABLE",
      );
    if (
      run.marketId !== policy.marketId ||
      run.configVersion !== policy.scope.configVersion
    )
      throw new CategorizedError(
        "VALIDATION",
        "FUNDED_HISTORICAL_POLICY_SCOPE_MISMATCH",
      );
    const result = await this.executeRange(
      {
        backtestRunId: run.id,
        accountId: historicalAutomationAccountId(policy.policyHash),
        apply: true,
        maxSessions: policy.maxSessions,
      },
      async () => {
        const { cancellationRequested } = await context.heartbeat({
          message: "Applying approved funded historical replay",
        });
        if (cancellationRequested)
          throw new CancelledError("Cancelled by request");
      },
    );
    return {
      resultRefId: result.sessions.at(-1)?.fundedRunId ?? job.id,
    };
  }
}
