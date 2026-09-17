import { describe, expect, it } from "vitest";
import {
  FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
  type FundedComparisonChallengerPolicyIdentity,
} from "@tsx-scanner/contracts";
import {
  challengerBatchKey,
  fundedComparisonChallengerPolicyDigest,
  orderChallengerCandidates,
  type FundedComparisonChallengerCandidate,
} from "../src/paper-bot/funded-comparison-challenger-policy.js";

const specification = {
  policyVersion: FUNDED_COMPARISON_CHALLENGER_POLICY_VERSION,
  policyDigest: "a".repeat(64),
} as Pick<
  FundedComparisonChallengerPolicyIdentity,
  "policyVersion" | "policyDigest"
>;

const at = "2026-09-15T14:30:00.000Z";

function candidate(
  index: number,
  overrides: Partial<FundedComparisonChallengerCandidate> = {},
): FundedComparisonChallengerCandidate {
  return {
    sourceOpportunityId: `source-${index}`,
    sourceOrdinal: index,
    signalTimestamp: at,
    deterministicScore: 70,
    decisionAt: at,
    prediction: {
      expectedFillFraction: 1 - index / 100,
      expectedTotalExecutionCost: index,
      expectedSlippagePerShare: index / 10,
    },
    predictionIdentityValid: true,
    unavailableReason: null,
    ...overrides,
  };
}

describe("approved challenger policy (execution-quality ordering v1)", () => {
  it("applies the exact lexicographic key to a complete batch", () => {
    const ordering = orderChallengerCandidates(
      [
        candidate(1, {
          prediction: {
            expectedFillFraction: 0.5,
            expectedTotalExecutionCost: 1,
            expectedSlippagePerShare: 1,
          },
        }),
        candidate(2, {
          prediction: {
            expectedFillFraction: 0.9,
            expectedTotalExecutionCost: 5,
            expectedSlippagePerShare: 5,
          },
        }),
        candidate(3, {
          prediction: {
            expectedFillFraction: 0.9,
            expectedTotalExecutionCost: 2,
            expectedSlippagePerShare: 9,
          },
        }),
      ],
      specification,
    );
    expect(ordering.batchFallback).toBe(false);
    expect(ordering.entries.map((entry) => entry.sourceOpportunityId)).toEqual([
      "source-3",
      "source-2",
      "source-1",
    ]);
    expect(ordering.entries[0]).toMatchObject({
      championRank: 3,
      appliedRank: 1,
      disposition: "PREDICTED",
      fallbackReason: null,
    });
    expect(ordering.batchKey).toBe(at);
  });

  it("breaks every remaining tie deterministically", () => {
    const samePredictions = {
      expectedFillFraction: 0.5,
      expectedTotalExecutionCost: 1,
      expectedSlippagePerShare: 1,
    };
    const ordering = orderChallengerCandidates(
      [
        candidate(1, { prediction: samePredictions, deterministicScore: 50 }),
        candidate(2, { prediction: samePredictions, deterministicScore: 80 }),
        candidate(3, {
          prediction: samePredictions,
          deterministicScore: 80,
          decisionAt: "2026-09-15T14:30:00.500Z",
        }),
      ],
      specification,
    );
    expect(ordering.entries.map((entry) => entry.sourceOpportunityId)).toEqual([
      "source-2",
      "source-3",
      "source-1",
    ]);
    const again = orderChallengerCandidates(
      [
        candidate(3, {
          prediction: samePredictions,
          deterministicScore: 80,
          decisionAt: "2026-09-15T14:30:00.500Z",
        }),
        candidate(1, { prediction: samePredictions, deterministicScore: 50 }),
        candidate(2, { prediction: samePredictions, deterministicScore: 80 }),
      ],
      specification,
    );
    expect(again.entries).toEqual(ordering.entries);
  });

  it("cannot be influenced by destination observation identity", () => {
    const first = orderChallengerCandidates(
      [candidate(1), candidate(2)],
      specification,
    );
    const second = orderChallengerCandidates(
      [
        { ...candidate(1), destinationObservationId: "zzz" } as never,
        { ...candidate(2), destinationObservationId: "aaa" } as never,
      ],
      specification,
    );
    expect(second.entries).toEqual(first.entries);
  });

  it("restores champion order for the complete batch on any bad prediction", () => {
    for (const [broken, expectedReason] of [
      [
        candidate(2, {
          prediction: null,
          unavailableReason: "INFERENCE_FAILED",
        }),
        "INFERENCE_FAILED",
      ],
      [
        candidate(2, {
          prediction: {
            expectedFillFraction: Number.NaN,
            expectedTotalExecutionCost: 1,
            expectedSlippagePerShare: 1,
          },
        }),
        "INVALID_DIAGNOSTIC",
      ],
      [
        candidate(2, {
          predictionIdentityValid: false,
          unavailableReason: "MODEL_IDENTITY_MISMATCH",
        }),
        "MODEL_IDENTITY_MISMATCH",
      ],
    ] as const) {
      const ordering = orderChallengerCandidates(
        [candidate(1), broken, candidate(3)],
        specification,
      );
      expect(ordering.batchFallback).toBe(true);
      expect(
        ordering.entries.map((entry) => entry.sourceOpportunityId),
      ).toEqual(["source-1", "source-2", "source-3"]);
      expect(
        ordering.entries.every(
          (entry) =>
            entry.disposition === "FALLBACK_CHAMPION_ORDER" &&
            entry.appliedRank === entry.championRank,
        ),
      ).toBe(true);
      // One truthful stable batch-wide reason; a valid peer is never labelled
      // with the failing candidate's identity reason.
      expect(ordering.entries.map((entry) => entry.fallbackReason)).toEqual([
        expectedReason,
        expectedReason,
        expectedReason,
      ]);
    }
  });

  it("uniformly reports one batch reason when peers fail differently", () => {
    const ordering = orderChallengerCandidates(
      [
        candidate(1, {
          predictionIdentityValid: false,
          unavailableReason: "MODEL_IDENTITY_MISMATCH",
        }),
        candidate(2, {
          prediction: {
            expectedFillFraction: 1.5,
            expectedTotalExecutionCost: 0,
            expectedSlippagePerShare: 0,
          },
        }),
        candidate(3, {
          prediction: null,
          unavailableReason: "PREDICTION_DECISION_UNAVAILABLE",
        }),
      ],
      specification,
    );
    expect(ordering.batchFallback).toBe(true);
    const reasons = new Set(
      ordering.entries.map((entry) => entry.fallbackReason),
    );
    expect(reasons.size).toBe(1);
    expect([...reasons][0]).toBe("MODEL_IDENTITY_MISMATCH");
  });

  it("rejects out-of-range fill fraction, cost and slippage", () => {
    for (const prediction of [
      {
        expectedFillFraction: 1.0001,
        expectedTotalExecutionCost: 0,
        expectedSlippagePerShare: 0,
      },
      {
        expectedFillFraction: -0.0001,
        expectedTotalExecutionCost: 0,
        expectedSlippagePerShare: 0,
      },
      {
        expectedFillFraction: 0.5,
        expectedTotalExecutionCost: -1,
        expectedSlippagePerShare: 0,
      },
      {
        expectedFillFraction: 0.5,
        expectedTotalExecutionCost: 0,
        expectedSlippagePerShare: -0.01,
      },
    ]) {
      const ordering = orderChallengerCandidates(
        [candidate(1), candidate(2, { prediction })],
        specification,
      );
      expect(ordering.batchFallback).toBe(true);
      expect(
        ordering.entries.every(
          (entry) =>
            entry.disposition === "FALLBACK_CHAMPION_ORDER" &&
            entry.fallbackReason === "INVALID_DIAGNOSTIC",
        ),
      ).toBe(true);
    }
  });

  it("never declines, sizes, bypasses or grants authority", () => {
    const ordering = orderChallengerCandidates(
      [candidate(1), candidate(2)],
      specification,
    );
    const text = JSON.stringify(ordering);
    for (const forbidden of [
      "decline",
      "vetoBypass",
      "bypass",
      "size",
      "authority",
      "recommendation",
      "activation",
    ])
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    expect(ordering.entries).toHaveLength(2);
  });

  it("asserts the frozen policy version", () => {
    expect(() =>
      orderChallengerCandidates([candidate(1)], {
        policyVersion: "other-policy-v1" as never,
        policyDigest: "a".repeat(64),
      }),
    ).toThrow(/approved challenger rule/i);
    expect(fundedComparisonChallengerPolicyDigest()).toMatch(/^[a-f0-9]{64}$/);
    expect(fundedComparisonChallengerPolicyDigest()).toBe(
      fundedComparisonChallengerPolicyDigest(),
    );
  });

  it("rejects a non-simultaneous or empty batch", () => {
    expect(() =>
      challengerBatchKey([
        { signalTimestamp: at },
        { signalTimestamp: "2026-09-15T14:31:00.000Z" },
      ]),
    ).toThrow(/exact retained signal timestamp/i);
    expect(() => orderChallengerCandidates([], specification)).toThrow(
      /at least one candidate/i,
    );
  });
});
