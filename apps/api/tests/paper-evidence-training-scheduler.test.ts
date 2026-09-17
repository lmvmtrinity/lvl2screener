import { describe, expect, it } from "vitest";
import { PaperEvidenceTrainingScheduler } from "../src/statistical-models/paper-evidence-training-scheduler.js";
import type { RecordLearningAutomationRunInput } from "../src/statistical-models/learning-automation-repository.js";

describe("PaperEvidenceTrainingScheduler", () => {
  it("queues only a policy-qualified inactive paper-evidence challenger", async () => {
    const createJob = async (
      _type: string,
      payload: unknown,
      key?: string | null,
    ) => {
      expect(key).toBe("paper-evidence:digest");
      expect(payload).toMatchObject({
        sourceKind: "PAPER_EVIDENCE",
        minimumSamples: 200,
      });
      return { status: "QUEUED" };
    };
    const scheduler = new PaperEvidenceTrainingScheduler(
      {
        listCohorts: async () => [
          {
            strategy: "ORB_RETEST",
            closedQuoteCount: 200,
            positives: 100,
            negatives: 100,
          },
        ],
        latestDatasetFor: async () => undefined,
        prospectiveRows: async () => [
          { rMultiple: 1 },
          { rMultiple: -1 },
          { rMultiple: 1 },
          { rMultiple: -1 },
          { rMultiple: 1 },
          { rMultiple: -1 },
          { rMultiple: 1 },
          { rMultiple: -1 },
          { rMultiple: 1 },
          { rMultiple: -1 },
        ],
        qualify: async () => ({
          qualification: {
            policyVersion: "paper-research-qualification-v1",
            qualified: true,
            reasons: [],
            sourceRowCount: 200,
            acceptedRowCount: 200,
            distinctSessionCount: 4,
            chronologicalSplitAt: "2026-08-31T00:00:00.000Z",
            walkForwardWindows: [],
            excludedCounts: {},
          },
          acceptedRows: [],
        }),
        materialize: async () => ({
          id: "10000000-0000-4000-8000-000000000010",
          sourceDigest: "digest",
          effectiveCutoff: "2026-08-31T00:00:00.000Z",
          researchQualification: {
            policyVersion: "paper-research-qualification-v1",
            qualified: true,
            reasons: [],
            sourceRowCount: 200,
            acceptedRowCount: 200,
            distinctSessionCount: 4,
            chronologicalSplitAt: "2026-08-31T00:00:00.000Z",
            walkForwardWindows: [],
            excludedCounts: {},
          },
        }),
      } as never,
      { createJob } as never,
    );
    await expect(scheduler.run()).resolves.toBe(1);
  });

  const runNoop = async (
    cohorts: unknown[],
    latestDatasetFor: (cohort: unknown) => Promise<unknown> = async () =>
      undefined,
  ): Promise<RecordLearningAutomationRunInput | undefined> => {
    const recorded: RecordLearningAutomationRunInput[] = [];
    const scheduler = new PaperEvidenceTrainingScheduler(
      {
        listCohorts: async () => cohorts,
        latestDatasetFor,
        qualify: async () => {
          throw new Error("qualify must not run for a disqualified cohort");
        },
        materialize: async () => {
          throw new Error("materialize must not run for a disqualified cohort");
        },
      } as never,
      {
        createJob: async () => {
          throw new Error("createJob must not run when no cohort qualifies");
        },
      } as never,
      undefined,
      {
        recordRun: async (input: RecordLearningAutomationRunInput) => {
          recorded.push(input);
        },
      } as never,
    );
    await expect(scheduler.run()).resolves.toBe(0);
    return recorded[0];
  };

  it("names the leading cohort and its shortfall instead of the first examined one", async () => {
    const run = await runNoop([
      {
        strategy: "VWAP_HOLD",
        marketId: "US_EQUITIES",
        closedQuoteCount: 4,
        positives: 1,
        negatives: 3,
      },
      {
        strategy: "PRIOR_DAY_HIGH_BREAKOUT",
        marketId: "US_EQUITIES",
        closedQuoteCount: 47,
        positives: 10,
        negatives: 37,
      },
    ]);

    expect(run?.state).toBe("NOOP");
    expect(run?.noopReason).toContain("INSUFFICIENT_CLOSED_QUOTES (47 < 200)");
    expect(run?.noopReason).toContain(
      "leading US_EQUITIES/PRIOR_DAY_HIGH_BREAKOUT",
    );
    expect(run?.noopReason).toContain("2 cohorts examined");
  });

  it("prefers a cohort blocked after the closed-quote gate over an unqualified one", async () => {
    const run = await runNoop(
      [
        {
          strategy: "HIGH_OF_DAY_BREAKOUT",
          marketId: "CA_TSX",
          closedQuoteCount: 199,
          positives: 50,
          negatives: 149,
        },
        {
          strategy: "PRIOR_DAY_HIGH_BREAKOUT",
          marketId: "US_EQUITIES",
          closedQuoteCount: 205,
          positives: 60,
          negatives: 145,
        },
      ],
      async (cohort) =>
        (cohort as { closedQuoteCount?: number }).closedQuoteCount === 205
          ? { sourceRowCount: 180 }
          : undefined,
    );

    expect(run?.noopReason).toContain("INSUFFICIENT_NEW_OUTCOMES (25 < 50)");
    expect(run?.noopReason).toContain(
      "leading US_EQUITIES/PRIOR_DAY_HIGH_BREAKOUT",
    );
  });

  it("reports NO_COHORTS_AVAILABLE when no compatible cohort exists", async () => {
    const run = await runNoop([]);
    expect(run?.noopReason).toBe("NO_COHORTS_AVAILABLE");
  });
});
