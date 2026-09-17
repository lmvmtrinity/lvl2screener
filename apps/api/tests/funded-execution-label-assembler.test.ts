import { describe, expect, it } from "vitest";
import {
  fundedDecisionTimeInputSchema,
  type FundedDecisionTimeInput,
  type FundedExecutionTerminalityProof,
} from "@tsx-scanner/contracts";
import {
  assembleFundedExecutionLabel,
  type FundedExecutionDecisionRecord,
  type FundedExecutionEntryTerminality,
  type FundedExecutionOutcomeEvidence,
} from "../src/statistical-models/funded-execution-label-assembler.js";
import {
  extractFundedExecutionFeatures,
  fundedExecutionSessionDate,
} from "../src/statistical-models/funded-execution-features.js";

const digestA = "a".repeat(64);
const digestB = "b".repeat(64);
const digestC = "c".repeat(64);

function decisionContent(
  overrides: Record<string, unknown> = {},
): FundedDecisionTimeInput {
  return fundedDecisionTimeInputSchema.parse({
    marketId: "CA_TSX",
    currency: "CAD",
    accountId: "account-1",
    runId: "run-1",
    observationId: "observation-1",
    evidenceSchemaVersion: 2,
    fundedPolicyVersion: "funded-policy-v1",
    executionModelVersion: "paper-execution-v3",
    featureVersion: "features-v1",
    sourceKind: "LIVE_PAPER",
    action: "SUBMIT",
    policyReason: null,
    decisionAt: "2026-09-15T14:30:00.000Z",
    strategyKey: "ORB_STANDARD",
    strategyVersion: "2026-09-01",
    score: 82,
    reasonCodes: ["BREAKOUT"],
    requestedCapital: {
      status: "AVAILABLE",
      maximumDebit: 1_500,
      maximumRisk: 250,
    },
    quote: {
      status: "AVAILABLE",
      snapshot: {
        timestamp: "2026-09-15T14:29:59.000Z",
        bid: 10.01,
        ask: 10.03,
        bidSize: 500,
        askSize: 400,
        sizeUnit: "SHARES",
        sizeMultiplier: 1,
        dataStatus: "REALTIME",
        actionable: true,
      },
    },
    model: { status: "UNAVAILABLE", reason: "No signal model was active" },
    portfolio: {
      status: "AVAILABLE",
      cash: 10_000,
      reservedCash: 0,
      openRisk: 0,
      reservedRisk: 0,
      positionCount: 0,
      sectorExposure: {},
      dailyPnl: 0,
      entriesAllowed: true,
      cooldownActive: false,
      consecutiveStops: 0,
    },
    context: { status: "UNAVAILABLE", reason: "No context was captured" },
    execution: {
      positionSize: 1_000,
      slippageBps: 0,
      feePerTrade: 0,
      costs: null,
      riskBudget: 250,
      maxNotional: 3_000,
      economics: null,
      stopMethod: "STRUCTURAL",
      atrStopMultiple: 1,
      rewardRiskRatio: null,
      maxQuoteAgeSeconds: 30,
      sessionTimezone: "America/Toronto",
      noonCloseTime: "16:00",
      executionMode: "CAPACITY_CONSTRAINED",
      latencyMs: 0,
      evidenceScope: null,
    },
    sizingContext: null,
    policy: {
      projectionVersion: "funded-cash-v1",
      participation: 0.25,
      impactBps: 2,
      latencyPolicy: "CAPTURED_PER_ORDER",
      portfolio: null,
    },
    signal: {
      signalTimestamp: "2026-09-15T14:29:58.000Z",
      entryReference: 10.02,
      stopReference: 9.8,
      targetReference: 10.6,
      atr14: 0.15,
    },
    ...overrides,
  });
}

function outcome(
  sequence: number,
  status: FundedExecutionOutcomeEvidence["status"],
  overrides: Partial<FundedExecutionOutcomeEvidence> = {},
): FundedExecutionOutcomeEvidence {
  return {
    sequence,
    status,
    availableAt: "2026-09-15T14:35:00.000Z",
    recordedAt: "2026-09-15T14:35:01.000Z",
    sourceId: `source-${sequence}`,
    sourceDigest: digestA,
    reason: null,
    detail: null,
    supersedesSequence: null,
    knowledge: null,
    ...overrides,
  };
}

function fillDetail(overrides: Record<string, unknown> = {}) {
  return {
    filledFraction: 1,
    filledShares: 100,
    requestedShares: 100,
    averagePrice: 10.02,
    fees: 1,
    slippage: 0.02,
    ...overrides,
  };
}

function proof(
  factAt = "2026-09-15T14:36:00.000Z",
  recordedAt = factAt,
): FundedExecutionTerminalityProof {
  return {
    orderId: "observation-1",
    revision: 3,
    stateDigest: digestC,
    factAt,
    recordedAt,
  };
}

function latestOf(values: readonly string[]): string {
  return new Date(
    Math.max(...values.map((value) => Date.parse(value))),
  ).toISOString();
}

function terminal(
  overrides: Partial<FundedExecutionEntryTerminality> = {},
): FundedExecutionEntryTerminality {
  const terminalityProof = overrides.proof ?? proof();
  return {
    state: "TERMINAL",
    knownAt: latestOf([terminalityProof.factAt, terminalityProof.recordedAt]),
    proof: terminalityProof,
    replayProvenance: null,
    ...overrides,
  };
}

function record(
  overrides: Partial<FundedExecutionDecisionRecord> = {},
): FundedExecutionDecisionRecord {
  return {
    runId: "run-1",
    observationId: "observation-1",
    accountId: "account-1",
    marketId: "CA_TSX",
    currency: "CAD",
    decisionSequence: 1,
    decisionContentDigest: digestA,
    cohortDigest: digestB,
    evidenceSchemaVersion: 2,
    sourceKind: "LIVE_PAPER",
    action: "SUBMIT",
    decisionAt: "2026-09-15T14:30:00.000Z",
    runSource: "LIVE",
    runStatus: "COMPLETED",
    instrumentId: "10000000-0000-4000-8000-000000000001",
    decisionContent: decisionContent(),
    outcomes: [],
    entryTerminality: terminal(),
    replayChronology: null,
    ...overrides,
  };
}

const cutoff = new Date("2026-09-15T20:00:00.000Z");

describe("funded execution label mapping", () => {
  it("labels a proven full fill with retained costs", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [outcome(1, "FILLED", { detail: fillDetail() })],
      }),
      cutoff,
    });
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: {
        fillProbability: 1,
        fillFraction: 1,
        slippagePerShare: 0.02,
        totalExecutionCost: 3,
        costLabelAvailable: true,
        terminalOutcomeStatus: "FILLED",
      },
    });
  });

  it("labels a terminal partial fill with its observed fraction", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "PARTIAL_FILL", {
            detail: fillDetail({ filledFraction: 0.5, filledShares: 50 }),
          }),
        ],
        entryTerminality: terminal(),
      }),
      cutoff,
    });
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: {
        fillProbability: 1,
        fillFraction: 0.5,
        totalExecutionCost: 2,
      },
    });
  });

  it("does not finalize an intermediate partial fill while entry can continue", () => {
    for (const terminality of [
      { state: "OPEN", knownAt: null, proof: null },
      { state: "UNKNOWN", knownAt: null, proof: null },
    ] as FundedExecutionEntryTerminality[]) {
      const assembly = assembleFundedExecutionLabel({
        decision: record({
          outcomes: [
            outcome(1, "PARTIAL_FILL", {
              detail: fillDetail({ filledFraction: 0.5, filledShares: 50 }),
            }),
          ],
          entryTerminality: terminality,
        }),
        cutoff,
      });
      expect(assembly).toEqual({
        verdict: "EXCLUDED",
        reason: "INTERMEDIATE_PARTIAL_FILL",
        unknown: true,
      });
    }
  });

  it("does not finalize a partial fill whose terminality proof was known after the cutoff", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "PARTIAL_FILL", {
            detail: fillDetail({ filledFraction: 0.5, filledShares: 50 }),
          }),
        ],
        entryTerminality: terminal({
          proof: proof("2026-09-15T21:00:00.000Z"),
        }),
      }),
      cutoff,
    });
    expect(assembly).toEqual({
      verdict: "EXCLUDED",
      reason: "INTERMEDIATE_PARTIAL_FILL",
      unknown: true,
    });
  });

  it("binds the immutable order-revision proof into a final partial fill", () => {
    const terminalityProof = proof(
      "2026-09-15T14:35:00.000Z",
      "2026-09-15T14:36:00.000Z",
    );
    const assembly = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "PARTIAL_FILL", {
            detail: fillDetail({ filledFraction: 0.5, filledShares: 50 }),
          }),
        ],
        entryTerminality: terminal({ proof: terminalityProof }),
      }),
      cutoff,
    });
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: {
        fillFraction: 0.5,
        terminalityProof,
        // The proof's own recording time is part of the label knowledge time.
        labelAvailableAt: "2026-09-15T14:36:00.000Z",
      },
    });
  });

  it("does not finalize a terminal partial fill without a provable revision", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "PARTIAL_FILL", {
            detail: fillDetail({ filledFraction: 0.5, filledShares: 50 }),
          }),
        ],
        entryTerminality: {
          state: "TERMINAL",
          knownAt: null,
          proof: null,
          replayProvenance: null,
        },
      }),
      cutoff,
    });
    expect(assembly).toEqual({
      verdict: "EXCLUDED",
      reason: "INTERMEDIATE_PARTIAL_FILL",
      unknown: true,
    });
  });

  it("labels a proven terminal zero fill as 0 with no fabricated costs", () => {
    for (const status of ["NO_FILL", "EXPIRED"] as const) {
      const assembly = assembleFundedExecutionLabel({
        decision: record({
          outcomes: [outcome(1, status, { detail: null })],
        }),
        cutoff,
      });
      expect(assembly).toMatchObject({
        verdict: "INCLUDED",
        labels: {
          fillProbability: 0,
          fillFraction: 0,
          slippagePerShare: null,
          totalExecutionCost: null,
          costLabelAvailable: false,
          terminalOutcomeStatus: status,
        },
      });
    }
  });

  it("never turns a risk veto or policy refusal into a negative fill label", () => {
    const veto = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "RISK_VETOED", {
            reason: "Daily loss limit",
            detail: { vetoReason: "DAILY_LOSS" },
          }),
        ],
      }),
      cutoff,
    });
    expect(veto).toEqual({
      verdict: "EXCLUDED",
      reason: "RISK_VETOED",
      unknown: false,
    });

    const decline = assembleFundedExecutionLabel({
      decision: record({
        action: "DECLINE",
        decisionContent: decisionContent({
          action: "DECLINE",
          policyReason: "PORTFOLIO_LIMIT",
          requestedCapital: { status: "UNAVAILABLE", reason: "policy" },
        }),
        outcomes: [
          outcome(1, "POLICY_DECLINED", {
            detail: { declineReason: "PORTFOLIO_LIMIT" },
          }),
        ],
      }),
      cutoff,
    });
    expect(decline).toEqual({
      verdict: "EXCLUDED",
      reason: "POLICY_DECLINED",
      unknown: false,
    });

    const defer = assembleFundedExecutionLabel({
      decision: record({
        action: "DEFER",
        decisionContent: decisionContent({
          action: "DEFER",
          policyReason: "SIGNAL_VALIDITY_EXPIRED",
          requestedCapital: { status: "UNAVAILABLE", reason: "policy" },
        }),
        outcomes: [
          outcome(1, "POLICY_DEFERRED", { detail: { deferReason: "x" } }),
        ],
      }),
      cutoff,
    });
    expect(defer).toEqual({
      verdict: "EXCLUDED",
      reason: "POLICY_DEFERRED",
      unknown: false,
    });
  });

  it("keeps unknown and incomplete evidence explicitly unknown", () => {
    const missingQuote = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "NO_EXECUTABLE_QUOTE", {
            detail: { detailReason: "HALTED" },
          }),
        ],
      }),
      cutoff,
    });
    expect(missingQuote).toEqual({
      verdict: "EXCLUDED",
      reason: "NO_EXECUTABLE_QUOTE_MISSING_MARKET",
      unknown: true,
    });

    const accepted = assembleFundedExecutionLabel({
      decision: record({ outcomes: [outcome(1, "DECISION_ACCEPTED")] }),
      cutoff,
    });
    expect(accepted).toEqual({
      verdict: "EXCLUDED",
      reason: "DECISION_ACCEPTED_NOT_EXECUTED",
      unknown: true,
    });

    const unresolved = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "UNRESOLVED", { reason: "No durable source retained" }),
        ],
      }),
      cutoff,
    });
    expect(unresolved).toEqual({
      verdict: "EXCLUDED",
      reason: "UNRESOLVED",
      unknown: true,
    });

    const noEvidence = assembleFundedExecutionLabel({
      decision: record({ outcomes: [] }),
      cutoff,
    });
    expect(noEvidence).toEqual({
      verdict: "EXCLUDED",
      reason: "UNRESOLVED",
      unknown: true,
    });
  });

  it("excludes version-1 decisions and finalizes nothing from them", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: record({ evidenceSchemaVersion: 1, decisionContent: null }),
      cutoff,
    });
    expect(assembly).toEqual({
      verdict: "EXCLUDED",
      reason: "EVIDENCE_SCHEMA_VERSION_UNSUPPORTED",
      unknown: false,
    });
  });

  it("requires label availability at or before the dataset cutoff", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "FILLED", {
            detail: fillDetail(),
            availableAt: "2026-09-15T21:00:00.000Z",
            recordedAt: "2026-09-15T21:00:01.000Z",
          }),
        ],
      }),
      cutoff,
    });
    expect(assembly).toEqual({
      verdict: "EXCLUDED",
      reason: "LABEL_NOT_AVAILABLE_AT_CUTOFF",
      unknown: true,
    });
  });

  it("does not let a later correction leak backward into an earlier cutoff", () => {
    const base = outcome(1, "PARTIAL_FILL", {
      detail: fillDetail({ filledFraction: 0.5, filledShares: 50 }),
      availableAt: "2026-09-15T14:35:00.000Z",
      recordedAt: "2026-09-15T14:35:01.000Z",
    });
    const correction = outcome(2, "FILLED", {
      detail: fillDetail(),
      availableAt: "2026-09-15T15:00:00.000Z",
      recordedAt: "2026-09-15T15:00:01.000Z",
      supersedesSequence: 1,
    });
    const earlyCutoff = new Date("2026-09-15T14:45:00.000Z");

    const earlier = assembleFundedExecutionLabel({
      decision: record({ outcomes: [base, correction] }),
      cutoff: earlyCutoff,
    });
    expect(earlier).toMatchObject({
      verdict: "INCLUDED",
      labels: { fillProbability: 1, fillFraction: 0.5 },
    });

    const later = assembleFundedExecutionLabel({
      decision: record({ outcomes: [base, correction] }),
      cutoff,
    });
    expect(later).toMatchObject({
      verdict: "INCLUDED",
      labels: { fillProbability: 1, fillFraction: 1 },
    });
  });

  it("requires the correction itself to be recorded before the cutoff", () => {
    const base = outcome(1, "PARTIAL_FILL", {
      detail: fillDetail({ filledFraction: 0.5, filledShares: 50 }),
      availableAt: "2026-09-15T14:35:00.000Z",
      recordedAt: "2026-09-15T14:35:01.000Z",
    });
    const lateCapture = outcome(2, "FILLED", {
      detail: fillDetail(),
      availableAt: "2026-09-15T14:40:00.000Z",
      recordedAt: "2026-09-15T15:00:00.000Z",
      supersedesSequence: 1,
    });
    const assembly = assembleFundedExecutionLabel({
      decision: record({ outcomes: [base, lateCapture] }),
      cutoff: new Date("2026-09-15T14:45:00.000Z"),
    });
    // The late-captured correction is not selectable, and its supersession
    // does not erase the version that was valid at the cutoff.
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: { fillFraction: 0.5 },
    });
  });

  it("leaves cost labels unknown when fill evidence is malformed", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "FILLED", {
            detail: {
              filledFraction: 1,
              filledShares: 100,
              requestedShares: 100,
            },
          }),
        ],
      }),
      cutoff,
    });
    expect(assembly).toMatchObject({
      verdict: "EXCLUDED",
      reason: "COST_EVIDENCE_MISSING",
      unknown: true,
    });
  });
});

describe("funded execution label knowledge time", () => {
  it("uses the later of availableAt and recordedAt as the knowledge time", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "FILLED", {
            detail: fillDetail(),
            availableAt: "2026-09-15T14:35:00.000Z",
            recordedAt: "2026-09-15T14:40:00.000Z",
          }),
        ],
      }),
      cutoff,
    });
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: {
        labelAvailableAt: "2026-09-15T14:40:00.000Z",
        economicOutcomeAt: "2026-09-15T14:35:00.000Z",
      },
    });
  });

  it("includes the terminality-proof knowledge time for a partial fill", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "PARTIAL_FILL", {
            detail: fillDetail({ filledFraction: 0.5, filledShares: 50 }),
            availableAt: "2026-09-15T14:35:00.000Z",
            recordedAt: "2026-09-15T14:35:01.000Z",
          }),
        ],
        entryTerminality: terminal({
          proof: proof("2026-09-15T14:40:00.000Z", "2026-09-15T14:50:00.000Z"),
        }),
      }),
      cutoff,
    });
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: {
        labelAvailableAt: "2026-09-15T14:50:00.000Z",
        economicOutcomeAt: "2026-09-15T14:35:00.000Z",
      },
    });
  });

  it("binds a provable terminal zero fill and its knowledge time", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "NO_FILL", {
            availableAt: "2026-09-15T14:35:00.000Z",
            recordedAt: "2026-09-15T14:35:01.000Z",
          }),
        ],
        entryTerminality: terminal({
          proof: proof("2026-09-15T14:40:00.000Z", "2026-09-15T14:45:00.000Z"),
        }),
      }),
      cutoff,
    });
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: {
        fillProbability: 0,
        labelAvailableAt: "2026-09-15T14:45:00.000Z",
        terminalityProof: proof(
          "2026-09-15T14:40:00.000Z",
          "2026-09-15T14:45:00.000Z",
        ),
      },
    });
  });

  it("keeps an unprovable zero fill null-proof rather than fabricating one", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "NO_FILL", {
            availableAt: "2026-09-15T14:55:00.000Z",
            recordedAt: "2026-09-15T15:10:00.000Z",
          }),
        ],
        entryTerminality: {
          state: "UNKNOWN",
          knownAt: null,
          proof: null,
          replayProvenance: null,
        },
      }),
      cutoff,
    });
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: {
        labelAvailableAt: "2026-09-15T15:10:00.000Z",
        terminalityProof: null,
      },
    });
  });

  it("keeps zero-fill knowledge time separate from the economic event time", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "NO_FILL", {
            availableAt: "2026-09-15T14:55:00.000Z",
            recordedAt: "2026-09-15T15:10:00.000Z",
          }),
        ],
      }),
      cutoff,
    });
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: {
        labelAvailableAt: "2026-09-15T15:10:00.000Z",
        economicOutcomeAt: "2026-09-15T14:55:00.000Z",
      },
    });
  });
});

describe("funded execution replay knowledge chronology", () => {
  const replayPoints = [
    { at: "2026-09-14T13:30:00.000Z", sequence: 1 },
    { at: "2026-09-14T14:30:00.000Z", sequence: 2 },
    { at: "2026-09-14T14:35:00.000Z", sequence: 3 },
    { at: "2026-09-14T15:00:00.000Z", sequence: 4 },
  ];

  function replayRecord(
    overrides: Partial<FundedExecutionDecisionRecord> = {},
  ): FundedExecutionDecisionRecord {
    return record({
      runId: "replay-run",
      sourceKind: "HISTORICAL_REPLAY",
      runSource: "BACKTEST",
      runStatus: "COMPLETED",
      decisionAt: "2026-09-14T14:28:00.000Z",
      replayChronology: { runId: "replay-run", points: replayPoints },
      ...overrides,
    });
  }

  function replayOutcome(
    overrides: Partial<FundedExecutionOutcomeEvidence> = {},
  ): FundedExecutionOutcomeEvidence {
    return outcome(1, "FILLED", {
      detail: fillDetail(),
      // The audit recording time is long after the simulated event; the replay
      // coordinate must use the persisted causal boundary, not wall clock.
      availableAt: "2026-09-14T14:30:30.000Z",
      recordedAt: "2026-09-16T09:00:00.000Z",
      knowledge: {
        runId: "replay-run",
        sequence: 3,
        at: "2026-09-14T14:35:00.000Z",
      },
      ...overrides,
    });
  }

  it("binds the persisted replay boundary instead of the wall clock", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: replayRecord({ outcomes: [replayOutcome()] }),
      cutoff: new Date("2026-09-16T20:00:00.000Z"),
    });
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: {
        labelAvailableAt: "2026-09-16T09:00:00.000Z",
        knowledge: {
          provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
          runId: "replay-run",
          sequence: 3,
          at: "2026-09-14T14:35:00.000Z",
        },
      },
    });
  });

  it("does not backdate a correction to its earlier economic event time", () => {
    // Version 1 is knowable at 14:35. The correction keeps the earlier
    // economic timestamp but was only recorded after the 15:00 fact, so its
    // own boundary governs the label and cannot leak backward.
    const base = replayOutcome({ sequence: 1 });
    const correction = replayOutcome({
      sequence: 2,
      detail: fillDetail({ filledFraction: 1 }),
      availableAt: "2026-09-14T14:30:30.000Z",
      knowledge: {
        runId: "replay-run",
        sequence: 4,
        at: "2026-09-14T15:00:00.000Z",
      },
      supersedesSequence: 1,
    });
    const assembly = assembleFundedExecutionLabel({
      decision: replayRecord({ outcomes: [base, correction] }),
      cutoff: new Date("2026-09-16T20:00:00.000Z"),
    });
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: {
        knowledge: {
          provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
          runId: "replay-run",
          sequence: 4,
          at: "2026-09-14T15:00:00.000Z",
        },
        terminalOutcomeSequence: 2,
      },
    });
  });

  it("uses the exact terminality causal sequence, not the proof fact time", () => {
    // The proof's fact time (14:35) would resolve to applied point 3, but the
    // revision was actually caused by the 14:30 fact at sequence 2. Exact
    // provenance must win.
    const assembly = assembleFundedExecutionLabel({
      decision: replayRecord({
        outcomes: [
          replayOutcome({
            status: "PARTIAL_FILL",
            detail: fillDetail({ filledFraction: 0.5, filledShares: 50 }),
            knowledge: {
              runId: "replay-run",
              sequence: 2,
              at: "2026-09-14T14:30:00.000Z",
            },
          }),
        ],
        entryTerminality: terminal({
          proof: proof("2026-09-14T14:35:00.000Z", "2026-09-16T09:00:00.000Z"),
          replayProvenance: {
            factId: "same-time-clock",
            appliedSequence: 2,
            at: "2026-09-14T14:30:00.000Z",
          },
        }),
      }),
      cutoff: new Date("2026-09-16T20:00:00.000Z"),
    });
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: {
        knowledge: {
          provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
          runId: "replay-run",
          sequence: 2,
          at: "2026-09-14T14:30:00.000Z",
        },
      },
    });
  });

  it("uses the later exact terminality sequence over an earlier outcome version", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: replayRecord({
        outcomes: [
          replayOutcome({
            status: "PARTIAL_FILL",
            detail: fillDetail({ filledFraction: 0.5, filledShares: 50 }),
            knowledge: {
              runId: "replay-run",
              sequence: 2,
              at: "2026-09-14T14:30:00.000Z",
            },
          }),
        ],
        entryTerminality: terminal({
          proof: proof("2026-09-14T15:00:00.000Z", "2026-09-16T09:00:00.000Z"),
          replayProvenance: {
            factId: "close-fact",
            appliedSequence: 4,
            at: "2026-09-14T15:00:00.000Z",
          },
        }),
      }),
      cutoff: new Date("2026-09-16T20:00:00.000Z"),
    });
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: {
        knowledge: {
          provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
          runId: "replay-run",
          sequence: 4,
          at: "2026-09-14T15:00:00.000Z",
        },
      },
    });
  });

  it("uses the later outcome-version sequence over an earlier terminality fact", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: replayRecord({
        outcomes: [
          replayOutcome({
            status: "PARTIAL_FILL",
            detail: fillDetail({ filledFraction: 0.5, filledShares: 50 }),
            knowledge: {
              runId: "replay-run",
              sequence: 4,
              at: "2026-09-14T15:00:00.000Z",
            },
          }),
        ],
        entryTerminality: terminal({
          proof: proof("2026-09-14T14:35:00.000Z", "2026-09-16T09:00:00.000Z"),
          replayProvenance: {
            factId: "early-close-fact",
            appliedSequence: 2,
            at: "2026-09-14T14:30:00.000Z",
          },
        }),
      }),
      cutoff: new Date("2026-09-16T20:00:00.000Z"),
    });
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: {
        knowledge: {
          provenance: "HISTORICAL_REPLAY_FACT_SEQUENCE",
          runId: "replay-run",
          sequence: 4,
          at: "2026-09-14T15:00:00.000Z",
        },
      },
    });
  });

  it("fails closed when a terminality proof lacks exact causal provenance", () => {
    for (const replayProvenance of [
      null,
      { factId: "no-sequence", appliedSequence: 0, at: "2026-09-14T15:00:00Z" },
      { factId: "bad-time", appliedSequence: 3, at: "not-a-time" },
    ]) {
      const assembly = assembleFundedExecutionLabel({
        decision: replayRecord({
          outcomes: [
            replayOutcome({
              status: "PARTIAL_FILL",
              detail: fillDetail({ filledFraction: 0.5, filledShares: 50 }),
              knowledge: {
                runId: "replay-run",
                sequence: 2,
                at: "2026-09-14T14:30:00.000Z",
              },
            }),
          ],
          entryTerminality: terminal({
            proof: proof(
              "2026-09-14T15:00:00.000Z",
              "2026-09-16T09:00:00.000Z",
            ),
            replayProvenance,
          }),
        }),
        cutoff: new Date("2026-09-16T20:00:00.000Z"),
      });
      expect(assembly).toEqual({
        verdict: "EXCLUDED",
        reason: "REPLAY_CHRONOLOGY_UNPROVEN",
        unknown: true,
      });
    }
  });

  it("fails closed without a provable replay chronology", () => {
    for (const overrides of [
      { replayChronology: null },
      { replayChronology: { runId: "other-run", points: replayPoints } },
      { replayChronology: { runId: "replay-run", points: [] } },
      {
        replayChronology: {
          runId: "replay-run",
          points: [
            { at: "2026-09-14T14:35:00.000Z", sequence: 2 },
            { at: "2026-09-14T14:30:00.000Z", sequence: 3 },
          ],
        },
      },
      { runSource: "LIVE" },
    ]) {
      const assembly = assembleFundedExecutionLabel({
        decision: replayRecord({
          outcomes: [replayOutcome()],
          ...overrides,
        }),
        cutoff: new Date("2026-09-16T20:00:00.000Z"),
      });
      expect(assembly).toEqual({
        verdict: "EXCLUDED",
        reason: "REPLAY_CHRONOLOGY_UNPROVEN",
        unknown: true,
      });
    }
  });

  it("fails closed for a cross-run or malformed persisted boundary", () => {
    for (const knowledge of [
      null,
      { runId: "other-run", sequence: 3, at: "2026-09-14T14:35:00.000Z" },
      { runId: "replay-run", sequence: 0, at: "2026-09-14T14:35:00.000Z" },
      { runId: "replay-run", sequence: 3, at: "not-a-time" },
    ]) {
      const assembly = assembleFundedExecutionLabel({
        decision: replayRecord({ outcomes: [replayOutcome({ knowledge })] }),
        cutoff: new Date("2026-09-16T20:00:00.000Z"),
      });
      expect(assembly).toEqual({
        verdict: "EXCLUDED",
        reason: "REPLAY_CHRONOLOGY_UNPROVEN",
        unknown: true,
      });
    }
  });

  it("keeps live chronology on the database capture knowledge time", () => {
    const assembly = assembleFundedExecutionLabel({
      decision: record({
        outcomes: [
          outcome(1, "FILLED", {
            detail: fillDetail(),
            availableAt: "2026-09-14T14:30:30.000Z",
            recordedAt: "2026-09-16T09:00:00.000Z",
          }),
        ],
      }),
      cutoff: new Date("2026-09-16T20:00:00.000Z"),
    });
    expect(assembly).toMatchObject({
      verdict: "INCLUDED",
      labels: {
        knowledge: {
          provenance: "DATABASE_CAPTURE",
          runId: null,
          sequence: null,
          at: "2026-09-16T09:00:00.000Z",
        },
      },
    });
  });
});

describe("funded execution feature extraction", () => {
  it("derives decision-only values and explicit nulls", () => {
    const features = extractFundedExecutionFeatures({
      decision: decisionContent(),
      marketId: "CA_TSX",
    });
    expect(features.deterministicScore).toBe(82);
    expect(features.spreadPct).toBeCloseTo(((10.03 - 10.01) / 10.02) * 100, 10);
    expect(features.logDisplayedSize).toBeCloseTo(Math.log1p(400), 10);
    expect(features.logRequestedNotional).toBeCloseTo(Math.log1p(1_500), 10);
    expect(features.quoteAgeSeconds).toBe(1);
    expect(features.atrPct).toBeCloseTo(0.15 / 10.02, 10);
    expect(features.stopDistancePct).toBeCloseTo((10.02 - 9.8) / 10.02, 10);
    expect(features.contextStrength).toBeNull();
    expect(features.minutesFromOpen).toBe(10 * 60 + 30 - 570);
  });

  it("keeps board-lot quote sizes and unavailable values null", () => {
    const features = extractFundedExecutionFeatures({
      decision: decisionContent({
        quote: {
          status: "AVAILABLE",
          snapshot: {
            timestamp: "2026-09-15T14:29:59.000Z",
            bid: 10.01,
            ask: 10.03,
            bidSize: 500,
            askSize: 400,
            sizeUnit: "BOARD_LOTS",
            sizeMultiplier: 100,
            dataStatus: "REALTIME",
            actionable: true,
          },
        },
        portfolio: { status: "UNAVAILABLE", reason: "No snapshot" },
      }),
      marketId: "CA_TSX",
    });
    expect(features.logDisplayedSize).toBeNull();
    expect(features.logCash).toBeNull();
  });

  it("keeps absent requested capital null for policy refusals", () => {
    const features = extractFundedExecutionFeatures({
      decision: decisionContent({
        action: "DECLINE",
        policyReason: "PORTFOLIO_LIMIT",
        requestedCapital: { status: "UNAVAILABLE", reason: "refusal" },
      }),
      marketId: "CA_TSX",
    });
    expect(features.logRequestedNotional).toBeNull();
    expect(features.logRequestedRisk).toBeNull();
  });

  it("uses the market timezone for the session date", () => {
    expect(
      fundedExecutionSessionDate("2026-09-15T00:30:00.000Z", "CA_TSX"),
    ).toBe("2026-09-14");
    expect(
      fundedExecutionSessionDate("2026-09-15T00:30:00.000Z", "US_EQUITIES"),
    ).toBe("2026-09-14");
  });
});
