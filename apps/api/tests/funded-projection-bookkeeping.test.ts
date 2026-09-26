import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { FundedDecisionEvidenceRepository } from "../src/paper-bot/funded-decision-evidence-repository.js";
import { FundedDecisionOutcomeProjector } from "../src/paper-bot/funded-decision-outcome-projector.js";
import { FundedLiveAdapter } from "../src/paper-bot/funded-live-adapter.js";
import type { FundedFactAdapter } from "../src/paper-bot/funded-fact-adapter.js";
import type { AssumptionsSnapshot } from "../src/paper-bot/types.js";

const RUN_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "99999999-9999-4999-8999-999999999999";
const OBSERVATION_A = "22222222-2222-4222-8222-222222222222";
const OBSERVATION_B = "33333333-3333-4333-8333-333333333333";

const DECISION_COUNT_SQL = "count(*)::int AS count FROM candidates";
const PROJECTION_COUNT_SQL = "count(*)::int AS count FROM missing";

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

function failingClient() {
  return {
    query: async (text: string) => {
      if (text === "BEGIN") throw new Error("fixture repair failure");
      return { rows: [] };
    },
    release: () => undefined,
  };
}

function repairPool(options: {
  candidates: number;
  gapCount: number;
  queries: string[];
}): Pool {
  return {
    query: async (text: string) => {
      options.queries.push(text);
      if (text.includes(DECISION_COUNT_SQL))
        return { rows: [{ count: options.gapCount }] };
      if (text.includes("candidate_sources")) {
        const rows = Array.from({ length: options.candidates }, (_, index) => ({
          run_id: RUN_ID,
          observation_id: index === 0 ? OBSERVATION_A : OBSERVATION_B,
        }));
        return { rows };
      }
      return { rows: [] };
    },
    connect: async () => failingClient(),
  } as unknown as Pool;
}

describe("funded repair bookkeeping", () => {
  it("reports zero remaining without a gap count when the candidate list is uncapped and empty", async () => {
    const queries: string[] = [];
    const pool = {
      query: async (text: string) => {
        queries.push(text);
        return { rows: [] };
      },
      connect: async () => {
        throw new Error("connect must not be called");
      },
    } as unknown as Pool;
    const repository = new FundedDecisionEvidenceRepository(pool);

    const result = await repository.repairMissingDecisions(RUN_ID, 25);

    expect(result).toEqual({ repaired: 0, failed: 0, remaining: 0 });
    expect(queries.some((text) => text.includes("DISTINCT ON"))).toBe(true);
    expect(queries.some((text) => text.includes(DECISION_COUNT_SQL))).toBe(
      false,
    );
  });

  it("reports the failure count as remaining when the candidate list is uncapped", async () => {
    const queries: string[] = [];
    const repository = new FundedDecisionEvidenceRepository(
      repairPool({ candidates: 2, gapCount: 0, queries }),
    );

    const result = await repository.repairMissingDecisions(RUN_ID, 25);

    expect(result.repaired).toBe(0);
    expect(result.failed).toBe(2);
    expect(result.remaining).toBe(2);
    expect(queries.some((text) => text.includes(DECISION_COUNT_SQL))).toBe(
      false,
    );
  });

  it("counts durable gaps when the candidate list was capped", async () => {
    const queries: string[] = [];
    const repository = new FundedDecisionEvidenceRepository(
      repairPool({ candidates: 2, gapCount: 9, queries }),
    );

    const result = await repository.repairMissingDecisions(RUN_ID, 2);

    expect(result.failed).toBe(2);
    expect(result.remaining).toBe(9);
    expect(queries.some((text) => text.includes(DECISION_COUNT_SQL))).toBe(
      true,
    );
  });
});

describe("funded projection bookkeeping", () => {
  it("reports zero remaining without a gap count when the projection list is uncapped and empty", async () => {
    const repository = {
      listProjectionCandidates: async () => [],
      projectionGapCount: async () => {
        throw new Error("gap count must not be called");
      },
      findDecision: async () => {
        throw new Error("unused");
      },
    } as unknown as FundedDecisionEvidenceRepository;
    const projector = new FundedDecisionOutcomeProjector(
      { query: async () => ({ rows: [] }) } as unknown as Pool,
      repository,
    );

    const result = await projector.projectPending(RUN_ID);

    expect(result).toEqual({ projected: 0, failed: 0, remaining: 0 });
  });

  it("reports failures as remaining when the projection list is uncapped", async () => {
    const repository = {
      listProjectionCandidates: async () => [
        { runId: RUN_ID, observationId: OBSERVATION_A },
      ],
      projectionGapCount: async () => {
        throw new Error("gap count must not be called");
      },
      findDecision: async () => undefined,
    } as unknown as FundedDecisionEvidenceRepository;
    const projector = new FundedDecisionOutcomeProjector(
      { query: async () => ({ rows: [] }) } as unknown as Pool,
      repository,
    );

    const result = await projector.projectPending(RUN_ID);

    expect(result.projected).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.remaining).toBe(1);
  });

  it("counts durable gaps when the projection list was capped", async () => {
    const candidates = Array.from({ length: 50 }, () => ({
      runId: RUN_ID,
      observationId: randomUUID(),
    }));
    let gapCountCalls = 0;
    const repository = {
      listProjectionCandidates: async () => candidates,
      projectionGapCount: async () => {
        gapCountCalls += 1;
        return 123;
      },
      findDecision: async () => undefined,
    } as unknown as FundedDecisionEvidenceRepository;
    const projector = new FundedDecisionOutcomeProjector(
      { query: async () => ({ rows: [] }) } as unknown as Pool,
      repository,
    );

    const result = await projector.projectPending(RUN_ID, 50);

    expect(result.failed).toBe(50);
    expect(result.remaining).toBe(123);
    expect(gapCountCalls).toBe(1);
  });
});

describe("funded operational snapshot gap counters", () => {
  function adapterPool() {
    const calls = { gaps: 0, snapshots: 0, lifetime: 0 };
    const pool = {
      query: async (text: string) => {
        if (text.includes('"pendingFacts"')) {
          calls.snapshots += 1;
          return {
            rows: [
              {
                pendingFacts: 0,
                oldestPendingAt: null,
                closePendingOrders: 0,
                oldestClosePendingAt: null,
                riskVetoesTotal: 0,
                lateFactsTotal: 0,
                factsArrived5m: 0,
                factsDrained5m: 0,
              },
            ],
          };
        }
        if (text.includes("AS risk")) {
          calls.lifetime += 1;
          return { rows: [{ risk: 2, late: 3 }] };
        }
        if (text.includes(DECISION_COUNT_SQL)) {
          calls.gaps += 1;
          return { rows: [{ count: 3 }] };
        }
        if (text.includes(PROJECTION_COUNT_SQL)) {
          calls.gaps += 1;
          return { rows: [{ count: 4 }] };
        }
        return { rows: [] };
      },
      connect: async () => ({
        query: async () => ({ rows: [] }),
        release: () => undefined,
      }),
    } as unknown as Pool;
    return { pool, calls };
  }

  it("reuses gap counts for 60 seconds and refreshes after invalidation", async () => {
    const { pool, calls } = adapterPool();
    const adapter = new FundedLiveAdapter({
      pool,
      runId: RUN_ID,
      accountId: ACCOUNT_ID,
      currency: "CAD",
      marketId: "CA_TSX",
      assumptions,
    });

    const first = await adapter.operationalSnapshot("2026-09-18T14:00:00.000Z");
    expect(first.evidenceDecisionGapsTotal).toBe(3);
    expect(first.evidenceOutcomeGapsTotal).toBe(4);
    expect(calls.gaps).toBe(2);
    expect(calls.lifetime).toBe(1);

    const cached = await adapter.operationalSnapshot(
      "2026-09-18T14:00:30.000Z",
    );
    expect(cached.evidenceDecisionGapsTotal).toBe(3);
    expect(cached.evidenceOutcomeGapsTotal).toBe(4);
    expect(calls.gaps).toBe(2);
    expect(calls.lifetime).toBe(1);

    (
      adapter as unknown as { invalidateGapCounts(): void }
    ).invalidateGapCounts();
    await adapter.operationalSnapshot("2026-09-18T14:00:31.000Z");
    expect(calls.gaps).toBe(4);
    expect(calls.lifetime).toBe(1);

    await adapter.operationalSnapshot("2026-09-18T14:01:32.000Z");
    expect(calls.gaps).toBe(6);
    expect(calls.lifetime).toBe(2);
  });

  it("invalidates gap counts after a capped repair pass", async () => {
    const { pool, calls } = adapterPool();
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
    vi.spyOn(internals.evidence, "repairMissingDecisions").mockResolvedValue({
      repaired: 0,
      failed: 0,
      remaining: 7,
    });
    vi.spyOn(internals.projector, "projectPending").mockResolvedValue({
      projected: 0,
      failed: 0,
      remaining: 0,
    });
    vi.spyOn(internals.inbox, "enqueue").mockResolvedValue(undefined);
    vi.spyOn(internals.inbox, "drain").mockResolvedValue(0);

    await adapter.operationalSnapshot("2026-09-18T14:00:00.000Z");
    expect(calls.gaps).toBe(2);

    const cycle = await adapter.process({
      at: "2026-09-18T14:00:00.500Z",
      sessionDate: "2026-09-18",
      scheduledCloseAt: "2026-09-18T20:00:00.000Z",
      observations: [],
      invalidations: [],
      quotes: [],
    });
    expect(cycle.decisionGaps).toBe(7);

    const refreshed = await adapter.operationalSnapshot(
      "2026-09-18T14:00:01.000Z",
    );
    expect(refreshed.evidenceDecisionGapsTotal).toBe(3);
    expect(refreshed.evidenceOutcomeGapsTotal).toBe(4);
    expect(calls.gaps).toBe(4);
  });
});
