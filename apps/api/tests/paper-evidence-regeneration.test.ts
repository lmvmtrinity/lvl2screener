import { describe, expect, it } from "vitest";
import {
  classifyEvidenceCohort,
  EvidenceCohortService,
} from "../src/paper-bot/evidence-cohort-service.js";
import {
  classifySessionReproducibility,
  regenerateSessionEvidence,
} from "../src/paper-bot/evidence-regeneration.js";
import { EvidenceRegenerationService } from "../src/paper-bot/evidence-regeneration-service.js";
import { AUTHORITATIVE_EXECUTION_MODEL_VERSION } from "../src/backtests/execution-provenance.js";
import { COORDINATION_POLICY_VERSION } from "../src/paper-bot/coordination-policy.js";
import type {
  AssumptionsSnapshot,
  CandleFact,
  QuoteFact,
} from "../src/paper-bot/types.js";
import type { PaperSignalObservation } from "../src/paper-bot/paper-bot-repository.js";

describe("Phase D - Evidence Cohort Auditing and Classification", () => {
  it("classifies cohorts into authoritative, legacy, and unreproducible historical tiers", () => {
    expect(classifyEvidenceCohort(AUTHORITATIVE_EXECUTION_MODEL_VERSION)).toBe(
      "CURRENT_AUTHORITATIVE",
    );
    expect(classifyEvidenceCohort("paper-execution-v5")).toBe("REVISED_LEGACY");
    expect(classifyEvidenceCohort("paper-execution-v4")).toBe("REVISED_LEGACY");
    expect(classifyEvidenceCohort("paper-execution-v1")).toBe("REVISED_LEGACY");
    expect(classifyEvidenceCohort(null)).toBe("UNREPRODUCIBLE_HISTORICAL");
    expect(classifyEvidenceCohort(undefined)).toBe("UNREPRODUCIBLE_HISTORICAL");
  });

  it("audits cohorts and downstream model / qualification dependencies", async () => {
    const mockPool = {
      query: async (sql: string) => {
        if (sql.includes("WITH run_cohorts AS")) {
          return {
            rows: [
              {
                market_id: "CA_TSX",
                execution_model_version: "paper-execution-v7",
                run_count: "2",
                closed_quote_count: "35",
                closed_candle_count: "35",
                net_pnl: "150.50",
                cumulative_r: "4.2",
                first_signal_at: new Date("2026-09-04T13:30:00.000Z"),
                last_signal_at: new Date("2026-09-04T19:00:00.000Z"),
                qualified_profile_count: "1",
                trained_dataset_count: "0",
                active_model_count: "0",
              },
              {
                market_id: "CA_TSX",
                execution_model_version: "paper-execution-v5",
                run_count: "10",
                closed_quote_count: "120",
                closed_candle_count: "120",
                net_pnl: "420.00",
                cumulative_r: "12.5",
                first_signal_at: new Date("2026-08-15T13:30:00.000Z"),
                last_signal_at: new Date("2026-09-03T19:00:00.000Z"),
                qualified_profile_count: "2",
                trained_dataset_count: "1",
                active_model_count: "1",
              },
            ],
          };
        }
        if (sql.includes("FROM statistical_model m")) {
          return {
            rows: [
              {
                id: "model-active-legacy",
                model_version: "v1.0.0",
                strategy: "ORB_RETEST",
                source_kind: "PAPER_EVIDENCE",
                dataset_execution_model_version: "paper-execution-v5",
                backtest_execution_model_version: null,
                active: true,
              },
            ],
          };
        }
        if (sql.includes("FROM paper_profile_qualification")) {
          return {
            rows: [
              {
                market_id: "CA_TSX",
                profile_config_id: "config-legacy",
                strategy_key: "ORB_RETEST",
                strategy_version: "1.0.0",
                execution_model_version: "paper-execution-v5",
                policy_version: "paper-qualification-v2",
                closed_trades: 45,
                net_pnl: "300.00",
                qualification: "PAPER_QUALIFIED",
              },
            ],
          };
        }
        return { rows: [] };
      },
    };

    const service = new EvidenceCohortService(mockPool as any);
    const report = await service.auditCohorts();

    expect(report.currentAuthoritativeVersion).toBe(
      AUTHORITATIVE_EXECUTION_MODEL_VERSION,
    );
    expect(report.currentCoordinationVersion).toBe(COORDINATION_POLICY_VERSION);
    expect(report.cohorts).toHaveLength(2);

    const v6Cohort = report.cohorts.find(
      (c) => c.executionModelVersion === "paper-execution-v7",
    );
    expect(v6Cohort?.classification).toBe("CURRENT_AUTHORITATIVE");
    expect(v6Cohort?.runCount).toBe(2);

    const v5Cohort = report.cohorts.find(
      (c) => c.executionModelVersion === "paper-execution-v5",
    );
    expect(v5Cohort?.classification).toBe("REVISED_LEGACY");
    expect(v5Cohort?.runCount).toBe(10);

    // Downstream models on v5 need retraining
    expect(report.affectedModels).toHaveLength(1);
    expect(report.affectedModels[0]?.needsRetraining).toBe(true);
    expect(report.affectedModels[0]?.status).toBe("SUPERSEDED_COHORT");

    // Downstream qualifications on v5 require reevaluation
    expect(report.affectedQualifications).toHaveLength(1);
    expect(report.affectedQualifications[0]?.isAuthoritative).toBe(false);
    expect(report.affectedQualifications[0]?.requiresReevaluation).toBe(true);
  });
});

describe("Phase D - Evidence Reproducibility and Regeneration", () => {
  it("orders multi-session corrected regeneration by retained session date", async () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const calls: string[] = [];
    const service = new EvidenceRegenerationService({
      query: async () => ({
        rows: [
          {
            id: second,
            marketId: "CA_TSX",
            timezone: "America/Toronto",
            sessionDate: "2026-09-05",
          },
          {
            id: first,
            marketId: "CA_TSX",
            timezone: "America/Toronto",
            sessionDate: "2026-09-04",
          },
        ],
      }),
    } as never);
    (service as unknown as { run: (runId: string) => Promise<unknown> }).run =
      async (runId) => {
        calls.push(runId);
        return { sourceRunId: runId };
      };

    await expect(service.runMany([second, first])).resolves.toMatchObject({
      sourceRunIds: [first, second],
      applied: false,
      sessionResults: [{ sourceRunId: first }, { sourceRunId: second }],
    });
    expect(calls).toEqual([first, second]);
  });

  const dummyQuote: QuoteFact = {
    timestamp: "2026-09-04T14:00:00.000Z",
    bid: 10.0,
    ask: 10.05,
    bidSize: 500,
    askSize: 500,
    dataStatus: "REALTIME",
    actionable: true,
  };

  const dummyCandle: CandleFact = {
    start: "2026-09-04T14:00:00.000Z",
    end: "2026-09-04T14:01:00.000Z",
    open: 10.05,
    high: 10.15,
    low: 10.0,
    close: 10.1,
  };

  it("classifies session reproducibility accurately", () => {
    expect(classifySessionReproducibility([dummyQuote], [dummyCandle])).toBe(
      "REPRODUCIBLE",
    );

    expect(classifySessionReproducibility([], [dummyCandle])).toBe(
      "UNREPRODUCIBLE_MISSING_QUOTES",
    );

    expect(classifySessionReproducibility([dummyQuote], [])).toBe(
      "UNREPRODUCIBLE_INCOMPLETE_CANDLES",
    );

    expect(
      classifySessionReproducibility([dummyQuote], [dummyCandle], {
        isLegacyFillAuthority: true,
      }),
    ).toBe("UNREPRODUCIBLE_INCOMPATIBLE_SEMANTICS");
  });

  it("re-executes retained session inputs under paper-execution-v6 semantics", () => {
    const observation = {
      id: "obs-regen-1",
      runId: "run-original",
      marketId: "CA_TSX",
      symbol: "SHOP.TO",
      instrumentId: "inst-shop",
      strategyKey: "ORB_RETEST",
      strategyVersion: "1.0.0",
      profileId: "prof-shop",
      profileName: "ORB Standard",
      configVersion: "1",
      signalTimestamp: "2026-09-04T14:00:00.000Z",
      score: 85,
      entryReference: 10.05,
      stopReference: 9.5,
      targetReference: 11.0,
      atr14: 0.25,
      profileConfigId: "cfg-1",
      featureSnapshot: {},
      reasonCodes: ["ORB_BREAKOUT_CONFIRMED"],
      eligibilityStatus: "ELIGIBLE",
      eligibilityReason: null,
      sourceEventPayload: {},
      createdAt: "2026-09-04T14:00:00.000Z",
    } as unknown as PaperSignalObservation;

    const quotes: QuoteFact[] = [
      // Entry quote at signal time
      {
        timestamp: "2026-09-04T14:00:00.000Z",
        bid: 10.04,
        ask: 10.05,
        bidSize: 200,
        askSize: 200,
        dataStatus: "REALTIME",
        actionable: true,
      },
      // Target exit quote
      {
        timestamp: "2026-09-04T14:15:00.000Z",
        bid: 11.05,
        ask: 11.06,
        bidSize: 300,
        askSize: 300,
        dataStatus: "REALTIME",
        actionable: true,
      },
    ];

    const candles: CandleFact[] = [
      // Excluded entry bar (start at 14:00)
      {
        start: "2026-09-04T14:00:00.000Z",
        end: "2026-09-04T14:01:00.000Z",
        open: 10.05,
        high: 10.2,
        low: 10.0,
        close: 10.15,
      },
      // Target hit bar
      {
        start: "2026-09-04T14:01:00.000Z",
        end: "2026-09-04T14:02:00.000Z",
        open: 10.15,
        high: 11.1,
        low: 10.1,
        close: 11.05,
      },
    ];

    const assumptions: AssumptionsSnapshot = {
      positionSize: 1000,
      slippageBps: 0,
      feePerTrade: 0,
      stopMethod: "STRUCTURAL",
      atrStopMultiple: 1,
      rewardRiskRatio: null,
      maxQuoteAgeSeconds: 30,
      sessionTimezone: "America/Toronto",
      noonCloseTime: "16:00",
      executionMode: "CAPACITY_CONSTRAINED",
      latencyMs: 0,
    };

    const quotesMap = new Map([["inst-shop", quotes]]);
    const candlesMap = new Map([["inst-shop", candles]]);

    const result = regenerateSessionEvidence({
      originalRunId: "run-original",
      sessionDate: "2026-09-04",
      marketId: "CA_TSX",
      observations: [observation],
      quotesByInstrument: quotesMap,
      candlesByInstrument: candlesMap,
      assumptions,
    });

    expect(result.reproducibility).toBe("REPRODUCIBLE");
    expect(result.executionModelVersion).toBe(
      AUTHORITATIVE_EXECUTION_MODEL_VERSION,
    );
    expect(result.totalObservations).toBe(1);
    expect(result.closedQuoteCount).toBe(1);
    expect(result.closedCandleCount).toBe(1);
    expect(result.quoteNetPnl).toBeGreaterThan(0);
    expect(result.candleNetPnl).toBeGreaterThan(0);

    const exec = result.executions[0];
    expect(exec?.quoteStatus).toBe("CLOSED");
    expect(exec?.quoteExitReason).toBe("TARGET");
    expect(exec?.candleStatus).toBe("CLOSED");
    expect(exec?.candleExitReason).toBe("TARGET");
  });

  it("detects adverse gap-through stops accurately during regeneration", () => {
    const observation = {
      id: "obs-regen-gap",
      runId: "run-original",
      marketId: "CA_TSX",
      symbol: "SHOP.TO",
      instrumentId: "inst-shop",
      strategyKey: "ORB_RETEST",
      strategyVersion: "1.0.0",
      profileId: "prof-shop",
      profileName: "ORB Standard",
      configVersion: "1",
      signalTimestamp: "2026-09-04T14:00:00.000Z",
      score: 85,
      entryReference: 10.0,
      stopReference: 9.5,
      targetReference: 11.0,
      atr14: 0.25,
      profileConfigId: "cfg-1",
      featureSnapshot: {},
      reasonCodes: [],
      eligibilityStatus: "ELIGIBLE",
      eligibilityReason: null,
      sourceEventPayload: {},
      createdAt: "2026-09-04T14:00:00.000Z",
    } as unknown as PaperSignalObservation;

    const quotes: QuoteFact[] = [
      {
        timestamp: "2026-09-04T14:00:00.000Z",
        bid: 9.99,
        ask: 10.0,
        bidSize: 500,
        askSize: 500,
        dataStatus: "REALTIME",
        actionable: true,
      },
      // Adverse gap-down quote
      {
        timestamp: "2026-09-04T14:05:00.000Z",
        bid: 8.5,
        ask: 8.55,
        bidSize: 500,
        askSize: 500,
        dataStatus: "REALTIME",
        actionable: true,
      },
    ];

    const candles: CandleFact[] = [
      {
        start: "2026-09-04T14:00:00.000Z",
        end: "2026-09-04T14:01:00.000Z",
        open: 10.0,
        high: 10.05,
        low: 9.95,
        close: 10.0,
      },
      // Severe gap down below stop of 9.50
      {
        start: "2026-09-04T14:05:00.000Z",
        end: "2026-09-04T14:06:00.000Z",
        open: 8.5,
        high: 8.7,
        low: 8.4,
        close: 8.6,
      },
    ];

    const assumptions: AssumptionsSnapshot = {
      positionSize: 1000,
      slippageBps: 0,
      feePerTrade: 0,
      stopMethod: "STRUCTURAL",
      atrStopMultiple: 1,
      rewardRiskRatio: null,
      maxQuoteAgeSeconds: 30,
      sessionTimezone: "America/Toronto",
      noonCloseTime: "16:00",
    };

    const result = regenerateSessionEvidence({
      originalRunId: "run-original",
      sessionDate: "2026-09-04",
      marketId: "CA_TSX",
      observations: [observation],
      quotesByInstrument: new Map([["inst-shop", quotes]]),
      candlesByInstrument: new Map([["inst-shop", candles]]),
      assumptions,
    });

    expect(result.closedCandleCount).toBe(1);
    expect(result.gapThroughStopsCount).toBe(1);
    expect(result.reproducibility).toBe("UNREPRODUCIBLE_INCOMPLETE_CANDLES");
    expect(result.executions[0]?.gapThroughStopApplied).toBe(true);
    // Net P&L reflects the gap to 8.50 instead of stopping at 9.50
    expect(result.executions[0]?.candleNetPnl).toBeLessThan(-50);
  });
});
