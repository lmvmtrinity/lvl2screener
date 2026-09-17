import { studyPlan } from "./study-fixture.js";
import { describe, expect, it } from "vitest";
import { requiredStudyExecutions } from "@tsx-scanner/contracts";
import { CapturedReplayRunner } from "../src/backtests/captured-replay-runner.js";
import { PostgresBacktestStore } from "../src/backtests/backtest-repository.js";
import { StrategyStudyJobHandler } from "../src/worker/handlers/strategy-study-job-handler.js";

describe("production study execution boundaries", () => {
  it("counts the full plan passed by production admission", () => {
    const plan = studyPlan();
    plan.sessionPlan!.sessions.TRAIN = Array.from(
      { length: 10 },
      (_, i) => `2026-08-${String(i + 1).padStart(2, "0")}`,
    );
    plan.sessionPlan!.sessions.VALIDATION = Array.from(
      { length: 10 },
      (_, i) => `2026-08-${String(i + 15).padStart(2, "0")}`,
    );
    expect(requiredStudyExecutions(plan)).toBe(42);
  });
  it("preserves the receiver of real repository session methods", async () => {
    const plan = studyPlan();
    const store = new PostgresBacktestStore({
      query: async () => {
        throw new Error("UNEXPECTED_DATABASE_ACCESS");
      },
    } as never);
    store.loadVerifiedReplayInput = undefined as never;
    store.getCapturedHistoryAvailability = async () =>
      ({
        replay: { earliestDate: "2026-09-01", latestDate: "2026-09-03" },
      }) as never;
    store.resolveReplayInput = async () =>
      ({
        marketId: "CA_TSX",
        candidateInstruments: [],
        benchmarks: [],
        sessions: [],
      }) as never;
    const runner = new CapturedReplayRunner(
      store,
      {} as never,
      { timezone: "America/Toronto" } as never,
      {
        getReport: async () => ({
          status: "VERIFIED",
          marketId: "CA_TSX",
          inputHash: plan.binding.inputHash,
        }),
      } as never,
      {} as never,
    );
    await expect(runner.run(plan, "TRAIN")).rejects.toThrow(
      "STUDY_SESSION_SCOPE_MISMATCH",
    );
  });
  it("rejects authority-free legacy/direct jobs before registration", async () => {
    const handler = new StrategyStudyJobHandler(
      {
        connect: async () => {
          throw new Error("REACHED_REGISTRATION");
        },
      } as never,
      { withFence: () => ({}) } as never,
      {} as never,
      {} as never,
      {} as never,
    );
    await expect(
      handler.execute(
        {
          id: "job",
          leaseOwner: "worker",
          attemptCount: 1,
          requestPayload: { plan: studyPlan() },
        } as never,
        { heartbeat: async () => ({ cancellationRequested: false }) } as never,
      ),
    ).rejects.toMatchObject({ category: "VALIDATION" });
  });
});
