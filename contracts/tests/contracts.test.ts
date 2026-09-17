import { describe, expect, it } from "vitest";
import {
  alertPolicySchema,
  candidateDetailSchema,
  candidateIntakeEntrySchema,
  createBacktestSchema,
  createCalibrationSchema,
  createStatisticalModelSchema,
  scannerReadinessSchema,
  systemStatusSchema,
  universePolicySchema,
  updateCandidateIntakeSchema,
} from "../src/index.js";

describe("foundation service contracts", () => {
  it("accepts the scanner readiness payload", () => {
    expect(
      scannerReadinessSchema.parse({
        service: "scanner",
        status: "ok",
        version: "0.1.0",
        timestamp: "2026-08-24T14:00:00.000Z",
        checks: { config: "ok" },
      }).status,
    ).toBe("ok");
  });

  it("accepts live mode and rejects an unknown market-data mode", () => {
    const payload = {
      service: "api" as const,
      status: "ok" as const,
      version: "0.1.0",
      timestamp: "2026-08-24T14:00:00.000Z",
      checks: {
        database: { status: "ok" as const },
        scanner: { status: "ok" as const },
        config: { status: "ok" as const },
        marketData: { status: "ok" as const },
      },
      operational: {
        serviceReady: true,
        operationalReady: true,
        actionable: true,
        reasonCodes: [] as const,
        marketDataMode: "live" as const,
        session: { marketStatus: "OPEN", phase: "PREFERRED_ENTRIES" },
        auth: "CONNECTED" as const,
        dataFreshness: {
          quoteAgeMs: 500,
          candleAgeMs: 500,
          benchmarkAgeMs: 500,
          evaluationAgeMs: 500,
        },
        universe: { configured: 3, resolved: 3, evaluated: 3 },
        benchmarkReady: true,
        scannerSynchronized: true,
      },
    };
    expect(systemStatusSchema.parse({ ...payload, mode: "live" }).mode).toBe(
      "live",
    );
    expect(() =>
      systemStatusSchema.parse({
        ...payload,
        mode: "replay",
      }),
    ).toThrow();
  });

  it("applies explicit backtest execution and strategy defaults", () => {
    const value = createBacktestSchema.parse({
      name: "Baseline",
      startDate: "2026-08-01",
      endDate: "2026-08-25",
    });
    expect(value.strategies).toEqual(["ORB_RETEST", "VWAP_HOLD"]);
    expect(value.parameters).toMatchObject({
      rvolAtTimeMin: 1.5,
      spreadHardMaxPct: 0.25,
      scoreCutoff: 0,
    });
    expect(value).toMatchObject({
      startingCapital: 100_000,
      positionSize: 10_000,
      slippageBps: 2,
      feePerTrade: 0,
    });
  });

  it("defaults calibration to a bounded, reproducible baseline grid", () => {
    const value = createCalibrationSchema.parse({
      name: "Calibration",
      startDate: "2026-01-01",
      endDate: "2026-06-30",
      strategy: "ORB_RETEST",
    });
    expect(value.grid).toMatchObject({
      atrPctMin: [1.5],
      openingRangeMinutes: [15],
      stopMethod: ["STRUCTURAL"],
      rewardRiskRatio: [2],
    });
    expect(value).toMatchObject({
      trainPct: 60,
      validationPct: 20,
      minimumTradesPerSegment: 30,
      maxCombinations: 128,
    });
  });

  it("validates a bounded TSX universe policy", () => {
    const policy = universePolicySchema.parse({
      version: "tsx-liquid-momentum-v1",
      exchange: "TSX",
      currency: "CAD",
      securityTypes: ["Stock"],
      minimumPrice: 5,
      maximumPrice: 150,
      minimumMarketCap: 500_000_000,
      minimumAverageVolume90d: 500_000,
      minimumDollarVolume: 20_000_000,
      minimumAtrPct: 1.5,
      minimumHistoryDays: 20,
    });
    expect(policy.minimumDollarVolume).toBe(20_000_000);
  });

  it("validates durable Phase 7 candidate intake metadata", () => {
    expect(
      candidateIntakeEntrySchema.parse({
        source: "TRADINGVIEW",
        tradingDate: "2026-08-24",
        addedAt: "2026-08-24T13:25:00.000Z",
        originalInput: "TSX:SHOP",
        normalizedSymbol: "SHOP.TO",
        note: null,
        tags: ["gap-up"],
      }).normalizedSymbol,
    ).toBe("SHOP.TO");
    expect(
      updateCandidateIntakeSchema.parse({
        operation: "ADD",
        inputs: ["TSX:SHOP"],
      }),
    ).toMatchObject({
      source: "TRADINGVIEW",
      tags: [],
    });
    expect(() =>
      candidateIntakeEntrySchema.parse({
        source: "CONTEXT",
        tradingDate: "2026-08-24",
        addedAt: "2026-08-24T13:25:00.000Z",
        originalInput: "NASDAQ:AAPL",
        normalizedSymbol: "AAPL",
        note: null,
        tags: [],
      }),
    ).toThrow();
  });

  it("keeps unavailable detail readable and context notifications off by contract", () => {
    expect(
      candidateDetailSchema.parse({
        symbol: "BAD.TO",
        strategies: [],
        contexts: [],
        feature: null,
        candles: [],
        events: [],
        member: null,
        coverage: null,
      }).feature,
    ).toBeNull();
    expect(
      alertPolicySchema.parse({
        cooldownMinutes: 10,
        rearmRule: "AFTER_INVALIDATION",
      }),
    ).toEqual({
      cooldownMinutes: 10,
      rearmRule: "AFTER_INVALIDATION",
      contextNotificationsEnabled: false,
    });
    expect(() =>
      alertPolicySchema.parse({
        cooldownMinutes: 10,
        rearmRule: "AFTER_INVALIDATION",
        contextNotificationsEnabled: true,
      }),
    ).toThrow();
  });

  it("defaults optional statistical training to a conservative sample gate", () => {
    const value = createStatisticalModelSchema.parse({
      name: "ORB quality",
      backtestRunId: "10000000-0000-4000-8000-000000000001",
      strategy: "ORB_RETEST",
    });
    expect(value).toMatchObject({
      trainPct: 80,
      minimumSamples: 200,
      l2Penalty: 0.1,
    });
  });
});
