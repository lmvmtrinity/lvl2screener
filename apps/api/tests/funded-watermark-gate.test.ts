import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FundedDecisionEvidenceRepository } from "../src/paper-bot/funded-decision-evidence-repository.js";
import { FundedDecisionOutcomeProjector } from "../src/paper-bot/funded-decision-outcome-projector.js";
import { FundedLiveAdapter } from "../src/paper-bot/funded-live-adapter.js";
import type { FundedFactAdapter } from "../src/paper-bot/funded-fact-adapter.js";
import type { AssumptionsSnapshot } from "../src/paper-bot/types.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "99999999-9999-4999-8999-999999999999";

const assumptions: AssumptionsSnapshot = {
  positionSize: 1_000,
  slippageBps: 2,
  feePerTrade: 0,
  costs: {
    entryCommission: 0,
    exitCommission: 0,
    estimatedRegulatoryFees: 0,
    slippageBps: 2,
    currency: "CAD",
    brokerPricingVersion: "paper-cost-policy-2026-09-04",
  },
  riskBudget: 250,
  maxNotional: 1_500,
  economics: {
    minNetRewardRisk: 1,
    minStopFrictionMultiple: 2,
    minTargetFrictionMultiple: 3,
    maxSpreadPct: 0.5,
  },
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
  executionMode: "CAPACITY_CONSTRAINED",
  latencyMs: 0,
};

const WATERMARK_A = {
  evidenceSequence: 4,
  intentCount: 2,
  refusalCount: 3,
  signalAppliedSequence: 9,
  eligibleObservationCount: 11,
  outcomeTransitionRevision: 12,
};

const WATERMARK_B = { ...WATERMARK_A, evidenceSequence: 5 };

const WATERMARK_OUTCOME_B = {
  ...WATERMARK_A,
  outcomeTransitionRevision: 13,
};

const CYCLE = {
  at: "2026-09-18T14:00:00.500Z",
  sessionDate: "2026-09-18",
  scheduledCloseAt: "2026-09-18T20:00:00.000Z",
  observations: [],
  invalidations: [],
  quotes: [],
} as const;

function buildAdapter() {
  const pool = {
    query: async () => {
      throw new Error("the watermark gate tests never touch the pool");
    },
    connect: async () => {
      throw new Error("the watermark gate tests never open transactions");
    },
  } as unknown as Pool;
  const adapter = new FundedLiveAdapter({
    pool,
    runId: RUN_ID,
    accountId: ACCOUNT_ID,
    currency: "CAD",
    marketId: "CA_TSX",
    assumptions,
  });
  const internals = adapter as unknown as {
    evidence: FundedDecisionEvidenceRepository;
    projector: FundedDecisionOutcomeProjector;
    inbox: FundedFactAdapter;
  };
  const watermark = vi.spyOn(internals.evidence, "decisionWorkWatermark");
  const repair = vi
    .spyOn(internals.evidence, "repairMissingDecisions")
    .mockResolvedValue({ repaired: 0, failed: 0, remaining: 0 });
  const projection = vi
    .spyOn(internals.projector, "projectPending")
    .mockResolvedValue({ projected: 0, failed: 0, remaining: 0 });
  vi.spyOn(internals.inbox, "enqueue").mockResolvedValue(undefined);
  vi.spyOn(internals.inbox, "drain").mockResolvedValue(0);
  return { adapter, watermark, repair, projection };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("funded decision work watermark", () => {
  it("runs both passes on the first cycle and skips them while the watermark is unchanged and clean", async () => {
    const { adapter, watermark, repair, projection } = buildAdapter();
    watermark.mockResolvedValue(WATERMARK_A);

    const first = await adapter.process(CYCLE);
    expect(first.captureFailures).toBe(0);
    expect(first.decisionGaps).toBe(0);
    expect(first.projectionFailures).toBe(0);
    expect(first.outcomeGaps).toBe(0);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(projection).toHaveBeenCalledTimes(1);

    const second = await adapter.process(CYCLE);
    expect(second.decisionGaps).toBe(0);
    expect(second.outcomeGaps).toBe(0);
    expect(watermark).toHaveBeenCalledTimes(2);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(projection).toHaveBeenCalledTimes(1);
  });

  it("runs both passes again when the watermark changes", async () => {
    const { adapter, watermark, repair, projection } = buildAdapter();
    watermark.mockResolvedValueOnce(WATERMARK_A);
    watermark.mockResolvedValue(WATERMARK_B);

    await adapter.process(CYCLE);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(projection).toHaveBeenCalledTimes(1);

    await adapter.process(CYCLE);
    expect(repair).toHaveBeenCalledTimes(2);
    expect(projection).toHaveBeenCalledTimes(2);
  });

  it("reruns only projection when outcome transitions advance", async () => {
    const { adapter, watermark, repair, projection } = buildAdapter();
    watermark.mockResolvedValueOnce(WATERMARK_A);
    watermark.mockResolvedValue(WATERMARK_OUTCOME_B);

    await adapter.process(CYCLE);
    await adapter.process(CYCLE);

    expect(repair).toHaveBeenCalledTimes(1);
    expect(projection).toHaveBeenCalledTimes(2);
  });

  it("retries the repair pass after a failed or capped result even when the watermark is unchanged", async () => {
    const { adapter, watermark, repair, projection } = buildAdapter();
    watermark.mockResolvedValue(WATERMARK_A);
    repair.mockResolvedValueOnce({ repaired: 0, failed: 0, remaining: 2 });
    repair.mockResolvedValue({ repaired: 0, failed: 0, remaining: 0 });

    const first = await adapter.process(CYCLE);
    expect(first.decisionGaps).toBe(2);
    expect(projection).toHaveBeenCalledTimes(1);

    await adapter.process(CYCLE);
    expect(repair).toHaveBeenCalledTimes(2);
    // The projection pass stayed clean, so it is not repeated.
    expect(projection).toHaveBeenCalledTimes(1);

    await adapter.process(CYCLE);
    expect(repair).toHaveBeenCalledTimes(2);
    expect(projection).toHaveBeenCalledTimes(1);
  });

  it("retries the projection pass after a failed result even when the watermark is unchanged", async () => {
    const { adapter, watermark, repair, projection } = buildAdapter();
    watermark.mockResolvedValue(WATERMARK_A);
    projection.mockResolvedValueOnce({ projected: 0, failed: 1, remaining: 1 });
    projection.mockResolvedValue({ projected: 0, failed: 0, remaining: 0 });

    await adapter.process(CYCLE);
    await adapter.process(CYCLE);

    expect(repair).toHaveBeenCalledTimes(1);
    expect(projection).toHaveBeenCalledTimes(2);
  });

  it("forces a full pass after the bounded interval even when nothing changed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T14:00:00.000Z"));
    const { adapter, watermark, repair, projection } = buildAdapter();
    watermark.mockResolvedValue(WATERMARK_A);

    await adapter.process(CYCLE);
    await adapter.process(CYCLE);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(projection).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(61_000);
    await adapter.process(CYCLE);
    expect(repair).toHaveBeenCalledTimes(2);
    expect(projection).toHaveBeenCalledTimes(2);
  });

  it("runs both passes when the watermark cannot be read", async () => {
    const { adapter, watermark, repair, projection } = buildAdapter();
    watermark.mockRejectedValue(new Error("watermark unavailable"));

    const first = await adapter.process(CYCLE);
    const second = await adapter.process(CYCLE);

    expect(first.decisionGaps).toBe(0);
    expect(second.outcomeGaps).toBe(0);
    expect(repair).toHaveBeenCalledTimes(2);
    expect(projection).toHaveBeenCalledTimes(2);
  });
});

describe("funded decision work watermark repository read", () => {
  it("maps the durable decision and outcome change signals and stays fail-closed on a missing row", async () => {
    const queries: string[] = [];
    const pool = {
      query: async (text: string) => {
        queries.push(text);
        return {
          rows: [
            {
              evidence_sequence: "4",
              intent_count: "2",
              refusal_count: "3",
              signal_applied_sequence: "9",
              eligible_observation_count: "11",
              outcome_transition_revision: "12",
            },
          ],
        };
      },
    } as unknown as Pool;
    const repository = new FundedDecisionEvidenceRepository(pool);

    const watermark = await repository.decisionWorkWatermark(RUN_ID);

    expect(watermark).toEqual(WATERMARK_A);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("funded_decision_evidence");
    expect(queries[0]).toContain("funded_decision_intent");
    expect(queries[0]).toContain("funded_decision_refusal");
    expect(queries[0]).toContain("paper_funded_fact");
    expect(queries[0]).toContain("paper_signal_observation");
    expect(queries[0]).toContain("paper_entry_order");
    expect(queries[0]).toContain("paper_funded_event");

    const empty = {
      query: async () => ({ rows: [] }),
    } as unknown as Pool;
    await expect(
      new FundedDecisionEvidenceRepository(empty).decisionWorkWatermark(RUN_ID),
    ).rejects.toThrow(/watermark/i);
  });
});
