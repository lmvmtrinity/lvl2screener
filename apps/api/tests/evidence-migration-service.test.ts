import { describe, expect, it } from "vitest";
import type { BacktestRun } from "@tsx-scanner/contracts";
import { BacktestError } from "../src/backtests/backtest-service.js";
import { EvidenceMigrationService } from "../src/evidence-migration/evidence-migration-service.js";

const sourceId = "10000000-0000-4000-8000-000000000201";
const replacementId = "10000000-0000-4000-8000-000000000202";
const source = {
  id: sourceId,
  name: "legacy",
  status: "COMPLETED",
  executionModelVersion: null,
} as BacktestRun;
const replacement = {
  ...source,
  id: replacementId,
  executionModelVersion: "paper-execution-v1",
  supersedesBacktestRunId: sourceId,
} as BacktestRun;

describe("Phase 4a evidence migration orchestration", () => {
  it("records replacements and audits unreplayable dependencies", async () => {
    const completed: Array<[string, string]> = [];
    const failed: Array<[string, string, string]> = [];
    const repository = {
      pendingExecutions: async () => [
        { id: "migration-1", sourceId, report: {} },
        {
          id: "migration-2",
          sourceId: `${sourceId.slice(0, -1)}9`,
          report: {},
        },
      ],
      pendingCalibrations: async () => [],
      startExecution: async () => undefined,
      legacyModelIds: async () => [],
      activatedRankingStudyIds: async () => [],
      completeExecution: async (id: string, replacementRunId: string) => {
        completed.push([id, replacementRunId]);
      },
      failExecution: async (id: string, status: string, reason: string) => {
        failed.push([id, status, reason]);
        return ["Demoted profile"];
      },
      report: async () => ({ execution: [], calibrations: [] }),
    };
    const backtests = {
      getRun: async (id: string) => ({ ...source, id }),
      createReplacementRun: async (legacy: BacktestRun) => {
        if (legacy.id !== sourceId)
          throw new BacktestError(
            "REPLAY_INPUT_UNAVAILABLE",
            "immutable replay snapshot is missing",
            legacy.id,
          );
        return replacement;
      },
    };
    const log: Record<string, unknown>[] = [];
    await new EvidenceMigrationService(
      repository as never,
      backtests as never,
      {} as never,
      {} as never,
      {} as never,
      {
        info: (fields) => log.push(fields),
        error: (fields) => log.push(fields),
      },
    ).run();

    expect(completed).toEqual([["migration-1", replacementId]]);
    expect(failed[0]?.slice(0, 2)).toEqual([
      "migration-2",
      "UNREPLAYABLE_LEGACY",
    ]);
    expect(log).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ event: "EVIDENCE_RUN_REPLACED" }),
        expect.objectContaining({
          event: "EVIDENCE_RUN_MIGRATION_FAILED",
          demotedProfiles: ["Demoted profile"],
        }),
      ]),
    );
  });
});
