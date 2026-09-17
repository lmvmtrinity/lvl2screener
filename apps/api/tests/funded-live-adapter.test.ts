import { describe, expect, it } from "vitest";
import {
  buildFundedQuoteEnvelope,
  buildFundedInvalidationEnvelope,
  buildFundedSignalEnvelope,
  countFundedCoverageGaps,
  fundedSignalValidityDeadline,
} from "../src/paper-bot/funded-live-adapter.js";
import type { PaperSignalObservation } from "../src/paper-bot/paper-bot-repository.js";
import type { AssumptionsSnapshot } from "../src/paper-bot/types.js";
import { fundedReservationDebit } from "../src/paper-bot/financials.js";
import { fundedPolicy } from "../src/paper-bot/funded-policy.js";
import { fundedEnvelopesSchema } from "../src/paper-bot/funded-fact-schema.js";

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
  runId: "run",
  sourceEventId: "source",
  sourceSignalId: "signal",
  setupInstanceId: null,
  instrumentId: "9f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e1",
  symbol: "TEST.TO",
  profileId: "1f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e1",
  profileName: "profile",
  profileConfigId: "3f4b1f5c-7b4d-4a0c-9f7f-99ad7c9690e1",
  configVersion: "config-v1",
  profileParameters: {},
  strategyKey: "ORB_RETEST",
  strategyVersion: "1.0.0",
  signalTimestamp: "2099-02-02T14:00:00.000Z",
  score: 90,
  entryReference: 10,
  stopReference: 9.5,
  targetReference: 11,
  atr14: 0.4,
  featureSnapshot: {},
  reasonCodes: [],
  sourceEventPayload: {},
  eligibilityStatus: "ELIGIBLE",
  eligibilityReason: null,
  createdAt: "2099-02-02T14:00:00.000Z",
};

describe("funded live fact construction", () => {
  it("keeps run evidence scope out of strict execution facts without changing economics", () => {
    const runAssumptions = Object.freeze({
      ...assumptions,
      evidenceScope: "FORWARD_LIVE",
    });
    const envelope = buildFundedSignalEnvelope(
      observation,
      "2099-02-02T14:00:03.000Z",
      "2099-02-02T16:00:00.000Z",
      runAssumptions,
    );
    expect(envelope).toBeDefined();
    expect(fundedEnvelopesSchema.parse([envelope])).toEqual([envelope]);
    expect(envelope).toEqual(
      buildFundedSignalEnvelope(
        observation,
        "2099-02-02T14:00:03.000Z",
        "2099-02-02T16:00:00.000Z",
        assumptions,
      ),
    );
    expect(runAssumptions.evidenceScope).toBe("FORWARD_LIVE");
  });

  it("still rejects unknown execution assumptions", () => {
    const envelope = buildFundedSignalEnvelope(
      observation,
      "2099-02-02T14:00:03.000Z",
      "2099-02-02T16:00:00.000Z",
      Object.assign({}, assumptions, { unexpectedExecutionInput: true }),
    );
    expect(() => fundedEnvelopesSchema.parse([envelope])).toThrow(
      "unexpectedExecutionInput",
    );
  });

  it("uses the durable observation timestamp for stable retries", () => {
    const envelope = buildFundedSignalEnvelope(
      observation,
      "2099-02-02T14:00:03.000Z",
      "2099-02-02T16:00:00.000Z",
      assumptions,
    );
    expect(envelope).toMatchObject({
      id: `funded-signal:${observation.id}`,
      fact: {
        type: "SIGNAL",
        order: {
          orderId: observation.id,
          submittedAt: "2099-02-02T14:00:03.000Z",
          expiresAt: "2099-02-02T14:20:00.000Z",
          context: { latencyMs: 500 },
        },
      },
    });
  });

  it("derives a durable signal deadline from the setup timeout and entry window", () => {
    expect(
      fundedSignalValidityDeadline(
        {
          signalTimestamp: observation.signalTimestamp,
          profileParameters: {
            setupTimeoutMinutes: 20,
            entryWindow: { hardEnd: "10:15" },
          },
        },
        "2099-02-02",
        "2099-02-02T21:00:00.000Z",
        assumptions,
      ),
    ).toBe("2099-02-02T14:20:00.000Z");
  });

  it("does not create a submission that cannot outlive its release time", () => {
    expect(
      buildFundedSignalEnvelope(
        observation,
        "2099-02-02T15:59:59.700Z",
        "2099-02-02T16:00:00.000Z",
        { ...assumptions, latencyMs: 500 },
      ),
    ).toBeUndefined();
  });

  it("does not turn a stale observation into a newly submitted order", () => {
    expect(
      buildFundedSignalEnvelope(
        observation,
        "2099-02-02T15:30:00.000Z",
        "2099-02-02T16:00:00.000Z",
        assumptions,
      ),
    ).toBeUndefined();
  });

  it("uses the emitted profile entry window and rejects malformed boundaries", () => {
    const observed = {
      ...observation,
      signalTimestamp: "2099-02-02T15:10:00.000Z",
      sourceEventPayload: { entryWindow: { hardEnd: "10:15" } },
    };
    expect(
      fundedSignalValidityDeadline(
        observed,
        "2099-02-02",
        "2099-02-02T21:00:00Z",
        assumptions,
      ),
    ).toBe("2099-02-02T15:15:00.000Z");
    expect(
      fundedSignalValidityDeadline(
        {
          ...observed,
          sourceEventPayload: { entryWindow: { hardEnd: "25:00" } },
        },
        "2099-02-02",
        "2099-02-02T21:00:00Z",
        assumptions,
      ),
    ).toBeUndefined();
  });

  it("honors configured validity longer than twenty minutes consistently", () => {
    const observed = {
      ...observation,
      profileParameters: { setupTimeoutMinutes: 40 },
    };
    const result = buildFundedSignalEnvelope(
      observed,
      "2099-02-02T14:25:00.000Z",
      "2099-02-02T21:00:00.000Z",
      assumptions,
    );
    expect(result?.fact).toMatchObject({
      order: { expiresAt: "2099-02-02T14:40:00.000Z" },
    });
  });

  it("carries the captured market context in the v2 compatibility fields", () => {
    const result = buildFundedSignalEnvelope(
      {
        ...observation,
        fundedContexts: [
          {
            signalKey: "MARKET_RELATIVE_STRENGTH",
            status: "STRONG",
            timestamp: "2099-02-02T14:00:00.000Z",
          },
          {
            signalKey: "SECTOR_RELATIVE_STRENGTH",
            status: "NEUTRAL",
            timestamp: "2099-02-02T14:00:00.000Z",
          },
        ],
      },
      "2099-02-02T14:00:03.000Z",
      "2099-02-02T16:00:00.000Z",
      assumptions,
      undefined,
      undefined,
      { policy: fundedPolicy(1, 0, { requireFreshContext: true }) },
    );
    expect(result?.fact).toMatchObject({
      order: {
        context: {
          contextStatus: "STRONG",
          contextTimestamp: "2099-02-02T14:00:00.000Z",
        },
      },
    });
  });

  it("uses invalidation event identity for durable cancellation retries", () => {
    expect(
      buildFundedInvalidationEnvelope({
        eventId: "event-1",
        orderId: observation.id,
        at: "2099-02-02T14:00:04.000Z",
      }),
    ).toEqual({
      id: "funded-invalidation:event-1",
      fact: {
        type: "CANCEL",
        orderId: observation.id,
        at: "2099-02-02T14:00:04.000Z",
        reason: "SIGNAL_INVALIDATED",
      },
    });
  });

  it("records a pre-submission invalidation as a durable suppression fact", () => {
    expect(
      buildFundedInvalidationEnvelope(
        {
          eventId: "event-1",
          orderId: observation.id,
          at: "2099-02-02T14:00:00.000Z",
        },
        true,
      ),
    ).toMatchObject({
      id: "funded-invalidation:event-1",
      fact: {
        type: "CANCEL",
        orderId: observation.id,
        preSubmissionEventId: "event-1",
      },
    });
  });

  it("reserves entry commission on top of the tighter notional cap", () => {
    const withCosts = {
      ...assumptions,
      positionSize: 2_000,
      costs: {
        entryCommission: 5,
        exitCommission: 5,
        estimatedRegulatoryFees: 0,
        slippageBps: 2,
        currency: "CAD" as const,
        brokerPricingVersion: "audit-v1",
      },
    };
    expect(fundedReservationDebit(withCosts)).toBe(1_005);
    expect(
      buildFundedSignalEnvelope(
        observation,
        "2099-02-02T14:00:03.000Z",
        "2099-02-02T16:00:00.000Z",
        withCosts,
      )?.fact,
    ).toMatchObject({ maximumDebit: 1_005 });
  });

  it("rejects malformed quote timestamps instead of throwing during envelope construction", () => {
    expect(
      buildFundedQuoteEnvelope(
        {
          instrumentId: observation.instrumentId,
          timestamp: "not-a-timestamp",
          bid: 10,
          ask: 10.01,
          bidSize: 100,
          askSize: 100,
          dataStatus: "REALTIME",
          actionable: true,
        },
        {
          projectionVersion: "funded-cash-v1",
          participation: 1,
          impactBps: 0,
          latencyPolicy: "CAPTURED_PER_ORDER",
        },
      ),
    ).toBeUndefined();
  });

  it("treats missing actionable quotes as explicit coverage gaps", () => {
    expect(
      countFundedCoverageGaps(
        [observation.instrumentId, "missing-instrument", "missing-instrument"],
        new Set([observation.instrumentId]),
        2,
      ),
    ).toBe(3);
  });
});
