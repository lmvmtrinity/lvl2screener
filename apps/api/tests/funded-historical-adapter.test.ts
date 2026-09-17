import { describe, expect, it } from "vitest";
import { buildFundedHistoricalFacts } from "../src/paper-bot/funded-historical-adapter.js";
import type { PaperSignalObservation } from "../src/paper-bot/paper-bot-repository.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import type { AssumptionsSnapshot } from "../src/paper-bot/types.js";

const assumptions: AssumptionsSnapshot = {
  positionSize: 1_000,
  slippageBps: 2,
  feePerTrade: 0,
  stopMethod: "STRUCTURAL",
  atrStopMultiple: 1,
  rewardRiskRatio: null,
  maxQuoteAgeSeconds: 30,
  sessionTimezone: "America/Toronto",
  noonCloseTime: "16:00",
  executionMode: "CAPACITY_CONSTRAINED",
  latencyMs: 500,
  riskBudget: 100,
  maxNotional: 1_000,
};

const observation: PaperSignalObservation = {
  id: "2f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e1",
  marketId: "CA_TSX",
  runId: "2f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e2",
  sourceEventId: "2f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e3",
  sourceSignalId: null,
  setupInstanceId: null,
  instrumentId: "9f4b1f5c-7b4d-4a0c-9f7f-99ad4d9690e1",
  symbol: "TEST.TO",
  profileId: "1f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e1",
  profileName: "profile",
  profileConfigId: "3f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e1",
  configVersion: "config-v1",
  profileParameters: {},
  strategyKey: "ORB_RETEST",
  strategyVersion: "1.0.0",
  signalTimestamp: "2099-02-02T14:30:00.000Z",
  score: 90,
  entryReference: 10,
  stopReference: 9.5,
  targetReference: 11,
  atr14: 0.4,
  featureSnapshot: {},
  reasonCodes: [],
  sourceEventPayload: { signalSemanticsVersion: "setup-semantics-v2" },
  eligibilityStatus: "ELIGIBLE",
  eligibilityReason: null,
  createdAt: "2099-02-02T14:30:00.000Z",
};

const quote = {
  instrumentId: observation.instrumentId,
  timestamp: "2099-02-02T14:30:01.000Z",
  bid: 9.99,
  ask: 10,
  bidSize: 100,
  askSize: 100,
  sizeUnit: "SHARES" as const,
  sizeMultiplier: 1,
  dataStatus: "REALTIME" as const,
  actionable: true,
};

const baseInput = {
  runId: observation.runId,
  marketId: "CA_TSX" as const,
  executionModelVersion: "paper-execution-v7",
  sessionDate: "2099-02-02",
  sessionTimezone: assumptions.sessionTimezone,
  scheduledCloseAt: "2099-02-02T21:00:00.000Z",
  assumptions,
  policy: fundedPolicy(),
  observations: [observation],
  invalidations: [],
  quotes: [quote],
};

describe("funded historical adapter", () => {
  it("keeps legacy replay deadlines and context unchanged", () => {
    const { portfolio: _portfolio, ...legacy } = fundedPolicy();
    const result = buildFundedHistoricalFacts({
      ...baseInput,
      policy: legacy,
      observations: [{ ...observation, fundedContexts: [] }],
      quotes: [{ ...quote, timestamp: "2099-02-02T15:30:00.000Z" }],
    });
    const signal = result.envelopes.find(
      (value) => value.fact.type === "SIGNAL",
    )!;
    expect(signal.fact).toMatchObject({
      order: {
        expiresAt: baseInput.scheduledCloseAt,
        context: { executionMode: "CAPACITY_CONSTRAINED", latencyMs: 500 },
      },
    });
    if (signal.fact.type === "SIGNAL")
      expect(signal.fact.order.context).not.toHaveProperty("contexts");
    expect(() =>
      buildFundedHistoricalFacts({
        ...baseInput,
        quotes: [{ ...quote, timestamp: "2099-02-02T15:30:00.000Z" }],
      }),
    ).toThrow("missing retained quote coverage");
  });
  it("builds the same chronological facts as live processing and proves coverage", () => {
    const result = buildFundedHistoricalFacts(baseInput);
    expect(result.coverage).toEqual({
      rawCoverageVerified: true,
      observationCount: 1,
      quoteCount: 1,
      coveredObservationCount: 1,
      semanticVersions: ["setup-semantics-v2"],
    });
    expect(result.envelopes.map(({ fact }) => fact.type)).toEqual([
      "CLOCK",
      "SIGNAL",
      "QUOTE",
      "CLOCK",
    ]);
  });

  it("fails closed for missing semantic provenance and post-release quotes", () => {
    expect(() =>
      buildFundedHistoricalFacts({
        ...baseInput,
        observations: [{ ...observation, sourceEventPayload: {} }],
      }),
    ).toThrow("signal semantic provenance");
    expect(() =>
      buildFundedHistoricalFacts({
        ...baseInput,
        quotes: [],
      }),
    ).toThrow("missing retained quote coverage");
  });

  it("suppresses a signal invalidated before its historical submission", () => {
    const invalidation = {
      eventId: "event-1",
      orderId: observation.id,
      at: "2099-02-02T14:30:00.000Z",
    };
    const result = buildFundedHistoricalFacts({
      ...baseInput,
      invalidations: [invalidation],
    });
    expect(result.envelopes.map(({ fact }) => fact.type)).toEqual([
      "CLOCK",
      "CANCEL",
      "QUOTE",
      "CLOCK",
    ]);
    expect(result.envelopes[1]).toMatchObject({
      id: "funded-invalidation:event-1",
      fact: {
        type: "CANCEL",
        orderId: observation.id,
        preSubmissionEventId: "event-1",
      },
    });
    // The exact refusal semantics travel as an additive sidecar bound to the
    // enqueued fact; the strict driver envelope is unchanged.
    expect(result.refusalRequests).toEqual([
      {
        factId: "funded-invalidation:event-1",
        observationId: observation.id,
        action: "DECLINE",
        policyReason: "PRE_SUBMISSION_INVALIDATION",
        decisionAt: "2099-02-02T14:30:00.000Z",
      },
    ]);
  });

  it("prepares no refusal requests for a normal session", () => {
    expect(buildFundedHistoricalFacts(baseInput).refusalRequests).toEqual([]);
  });
});
