import type { BacktestAutomationStageDefinition } from "./backtest-automation.js";
import type { PostgresBacktestStore } from "./backtest-repository.js";
import type { ProfileStore } from "../profiles/profile-repository.js";
import { contentHash } from "./research-coverage.js";

export interface BacktestAutomationStageDependencies {
  readonly backtests: Pick<PostgresBacktestStore, "get">;
  readonly profiles: Pick<ProfileStore, "listProfiles">;
  /** A3 policy-aware funded replay stage, injected only by the worker. */
  readonly fundedReplay?: BacktestAutomationStageDefinition;
}

/**
 * A2 stage catalog. Stages declare their authorization scope up front:
 * - COVERAGE is automatic but read-only: it observes whether the completed
 *   baseline carries verified retained-input evidence; the run-time lineage
 *   step owns coverage requests and this stage never fabricates a binding.
 * - CALIBRATION and STRATEGY_STUDY require an explicit authorization and are
 *   never launched by automation.
 * - TRAINING is qualification-owned: the existing learning scheduler decides
 *   when a qualified configuration may train; baseline completion alone can
 *   never qualify or launch training.
 * - FUNDED_REPLAY is policy-required and exists only when the worker injects
 *   the A3 policy-aware stage.
 */
export function standardBacktestAutomationStages(
  deps: BacktestAutomationStageDependencies,
): BacktestAutomationStageDefinition[] {
  const definitions: BacktestAutomationStageDefinition[] = [
    {
      key: "COVERAGE",
      authorizationScope: "AUTOMATIC",
      async evaluate({ work }) {
        if (!work.runId)
          return {
            kind: "WAITING_FOR_EVIDENCE",
            reasonCodes: ["COMPLETED_RUN_UNAVAILABLE"],
            inputIdentityHash: null,
          };
        const run = await deps.backtests.get(work.runId);
        if (!run || run.status !== "COMPLETED")
          return {
            kind: "WAITING_FOR_EVIDENCE",
            reasonCodes: ["COMPLETED_RUN_UNAVAILABLE"],
            inputIdentityHash: null,
          };
        const inputIdentityHash = contentHash({
          runId: run.id,
          executionModelVersion: run.executionModelVersion,
          replayInputHash: run.replayInput?.inputHash ?? null,
          configVersion: run.configVersion,
        });
        return run.researchEvidence
          ? {
              kind: "COMPLETED",
              reasonCodes: ["RESEARCH_EVIDENCE_VERIFIED"],
              inputIdentityHash,
            }
          : {
              kind: "WAITING_FOR_EVIDENCE",
              reasonCodes: ["RESEARCH_EVIDENCE_PENDING"],
              inputIdentityHash,
            };
      },
    },
    {
      key: "CALIBRATION",
      authorizationScope: "AUTHORIZATION_REQUIRED",
      async evaluate() {
        return {
          kind: "NOT_ELIGIBLE",
          reasonCodes: ["EXPLICIT_AUTHORIZATION_REQUIRED"],
          inputIdentityHash: null,
        };
      },
    },
    {
      key: "TRAINING",
      authorizationScope: "QUALIFICATION_OWNED",
      async evaluate({ work }) {
        const profiles = await deps.profiles.listProfiles();
        const config = profiles.find(
          (profile) => profile.configId === work.identity.configId,
        );
        if (!config)
          return {
            kind: "WAITING_FOR_EVIDENCE",
            reasonCodes: ["PROFILE_CONFIG_UNAVAILABLE"],
            inputIdentityHash: null,
          };
        const qualified =
          config.qualification === "PAPER_QUALIFIED" ||
          config.qualification === "EVIDENCE_QUALIFIED";
        const inputIdentityHash = contentHash({
          configId: work.identity.configId,
          configVersion: work.identity.configVersion,
          qualification: config.qualification,
        });
        return qualified
          ? {
              kind: "NOT_ELIGIBLE",
              reasonCodes: ["TRAINING_SCHEDULER_OWNED"],
              inputIdentityHash,
            }
          : {
              kind: "WAITING_FOR_EVIDENCE",
              reasonCodes: ["PAPER_QUALIFICATION_REQUIRED"],
              inputIdentityHash,
            };
      },
    },
    {
      key: "STRATEGY_STUDY",
      authorizationScope: "AUTHORIZATION_REQUIRED",
      async evaluate() {
        return {
          kind: "NOT_ELIGIBLE",
          reasonCodes: ["EXPLICIT_STUDY_AUTHORIZATION_REQUIRED"],
          inputIdentityHash: null,
        };
      },
    },
  ];
  if (deps.fundedReplay) definitions.push(deps.fundedReplay);
  return definitions;
}
