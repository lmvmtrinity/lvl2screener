import { describe, expect, it } from "vitest";
import {
  DEFAULT_ADJUSTMENT_CRITERIA,
  barSeriesRevision,
  detectSeriesRevisionChange,
  evaluateAdjustmentSample,
  evaluateAdjustmentVerification,
  sampleIdentityKey,
  sampleSetRevision,
  type BoundaryBar,
  type CorporateActionSample,
  type IdentifiedSample,
  type SampleObservation,
  type VerificationInterval,
} from "../src/universe/discovery-adjustment-verification.js";

function splitSample(
  overrides: Partial<CorporateActionSample> = {},
): CorporateActionSample {
  return {
    marketId: "CA_TSX",
    symbol: "XYZ",
    exchange: "TSX",
    type: "SPLIT",
    effectiveDate: "2026-08-10",
    priceFactor: 0.25,
    volumeFactor: 4,
    source: "EODHD",
    sourceObservedAt: "2026-09-11T00:00:00.000Z",
    ...overrides,
  };
}

function identified(sample: CorporateActionSample): IdentifiedSample {
  return { sample, role: sample.type === "CONTROL" ? "CONTROL" : "ACTION" };
}

const pre: BoundaryBar = {
  start: "2026-08-07T20:00:00.000Z",
  close: 40,
  volume: 1000,
};
const post: BoundaryBar = {
  start: "2026-08-10T20:00:00.000Z",
  close: 10,
  volume: 1000,
};

function observation(
  interval: VerificationInterval,
  preBar: BoundaryBar,
  postBar: BoundaryBar,
  sampleKey: string,
  symbol = "XYZ",
): SampleObservation {
  return {
    sampleKey,
    symbol,
    interval,
    pre: preBar,
    post: postBar,
    retrievedAt: "2026-09-11T00:00:00.000Z",
  };
}

function observations(
  sampleKey: string,
  factory: (interval: VerificationInterval) => [BoundaryBar, BoundaryBar],
): SampleObservation[] {
  return (["OneDay", "FiveMinutes", "OneMinute"] as const).map((interval) =>
    observation(interval, ...factory(interval), sampleKey),
  );
}

describe("discovery adjustment verification", () => {
  it("content-addresses sample sets and bar series", () => {
    const sample = splitSample();
    expect(sampleSetRevision([sample])).toBe(sampleSetRevision([sample]));
    expect(sampleSetRevision([sample])).not.toBe(
      sampleSetRevision([splitSample({ effectiveDate: "2026-08-11" })]),
    );

    const bars = [
      {
        start: "2026-08-07T20:00:00.000Z",
        open: 40,
        high: 41,
        low: 39,
        close: 40,
        volume: 1000,
      },
      {
        start: "2026-08-10T20:00:00.000Z",
        open: 10,
        high: 11,
        low: 9,
        close: 10,
        volume: 1000,
      },
    ];
    const reordered = [bars[1]!, bars[0]!];
    expect(barSeriesRevision(bars)).toBe(barSeriesRevision(reordered));
    expect(barSeriesRevision(bars)).not.toBe(
      barSeriesRevision([bars[0]!, { ...bars[1]!, close: 10.5 }]),
    );
  });

  it("detects changed, added and removed bars between snapshots", () => {
    const bars = [
      {
        start: "2026-08-07T20:00:00.000Z",
        open: 40,
        high: 41,
        low: 39,
        close: 40,
        volume: 1000,
      },
      {
        start: "2026-08-10T20:00:00.000Z",
        open: 10,
        high: 11,
        low: 9,
        close: 10,
        volume: 1000,
      },
    ];
    expect(
      detectSeriesRevisionChange(bars, [
        { ...bars[0]!, volume: 2000 },
        { ...bars[1]!, start: "2026-08-11T20:00:00.000Z" },
        {
          start: "2026-08-12T20:00:00.000Z",
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1,
        },
      ]),
    ).toEqual({ changedBars: 1, addedBars: 2, removedBars: 1 });
  });

  it("classifies a consistently unadjusted split across all intervals", () => {
    const sample = splitSample();
    const evaluation = evaluateAdjustmentSample(
      identified(sample),
      observations(sampleIdentityKey(sample, "ACTION"), () => [pre, post]),
    );
    expect(evaluation.passed).toBe(true);
    expect(evaluation.priceBasis).toBe("UNADJUSTED");
    expect(evaluation.volumeBasis).toBe("UNADJUSTED");
    expect(evaluation.intervalResults).toHaveLength(3);
  });

  it("classifies a consistently split-adjusted series across all intervals", () => {
    const sample = splitSample();
    const adjustedPre: BoundaryBar = { ...pre, close: 10, volume: 4000 };
    const evaluation = evaluateAdjustmentSample(
      identified(sample),
      observations(sampleIdentityKey(sample, "ACTION"), () => [
        adjustedPre,
        post,
      ]),
    );
    expect(evaluation.passed).toBe(true);
    expect(evaluation.priceBasis).toBe("ADJUSTED");
    expect(evaluation.volumeBasis).toBe("ADJUSTED");
  });

  it("fails closed when an interval is missing", () => {
    const sample = splitSample();
    const evaluation = evaluateAdjustmentSample(
      identified(sample),
      observations(sampleIdentityKey(sample, "ACTION"), () => [
        pre,
        post,
      ]).filter((value) => value.interval !== "OneMinute"),
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failures).toContain("MISSING_INTERVAL:OneMinute");
  });

  it("fails when intervals disagree on the price basis", () => {
    const sample = splitSample();
    const adjustedPre: BoundaryBar = { ...pre, close: 10, volume: 4000 };
    const key = sampleIdentityKey(sample, "ACTION");
    const evaluation = evaluateAdjustmentSample(
      identified(sample),
      observations(key, (interval) =>
        interval === "FiveMinutes" ? [pre, post] : [adjustedPre, post],
      ),
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.priceBasis).toBe("INCONSISTENT");
    expect(evaluation.failures).toContain("PRICE_BASIS_MISMATCH");
  });

  it("fails a control sample with an unexplained move", () => {
    const sample = splitSample({
      type: "CONTROL",
      priceFactor: 1,
      volumeFactor: 1,
    });
    const evaluation = evaluateAdjustmentSample(
      identified(sample),
      observations(sampleIdentityKey(sample, "CONTROL"), () => [pre, post]),
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failures).toContain("CONTROL_UNEXPLAINED_MOVE");
  });

  it("aggregates a verification report from sample evaluations", () => {
    const split = splitSample();
    const control: CorporateActionSample = {
      ...splitSample({ type: "CONTROL", priceFactor: 1, volumeFactor: 1 }),
      symbol: "CTRL",
    };
    const controlObservations = (
      ["OneDay", "FiveMinutes", "OneMinute"] as const
    ).map((interval) =>
      observation(
        interval,
        pre,
        post,
        sampleIdentityKey(control, "CONTROL"),
        "CTRL",
      ),
    );
    const passing = evaluateAdjustmentVerification(
      [identified(split)],
      observations(sampleIdentityKey(split, "ACTION"), () => [pre, post]),
    );
    expect(passing.status).toBe("PASS");
    expect(passing.priceBasis).toBe("UNADJUSTED");
    expect(passing.failedSamples).toBe(0);

    const stopping = evaluateAdjustmentVerification(
      [identified(split), identified(control)],
      [
        ...observations(sampleIdentityKey(split, "ACTION"), () => [pre, post]),
        ...controlObservations,
      ],
    );
    expect(stopping.status).toBe("STOP");
    expect(stopping.failedSamples).toBe(1);
    expect(stopping.protocolRevision).toBe(
      DEFAULT_ADJUSTMENT_CRITERIA.revision,
    );
  });

  it("does not let a second same-symbol action borrow the first action's observations", () => {
    const first = splitSample({ effectiveDate: "2026-08-10" });
    const second = splitSample({ effectiveDate: "2026-08-24" });
    const firstKey = sampleIdentityKey(first, "ACTION");
    const observationsForFirst = observations(firstKey, () => [pre, post]);
    const secondEvaluation = evaluateAdjustmentSample(
      identified(second),
      observationsForFirst,
    );
    expect(secondEvaluation.sampleKey).not.toBe(firstKey);
    expect(secondEvaluation.passed).toBe(false);
    expect(secondEvaluation.failures).toContain("MISSING_INTERVAL:OneDay");

    const report = evaluateAdjustmentVerification(
      [identified(first), identified(second)],
      observationsForFirst,
    );
    expect(report.status).toBe("STOP");
    expect(report.passedSamples).toBe(1);
    expect(report.failedSamples).toBe(1);
  });

  it("classifies a cash-dividend series with its own derived price factor", () => {
    const dividend = splitSample({
      type: "CASH_DIVIDEND",
      priceFactor: 0.99,
      volumeFactor: 1,
    });
    const key = sampleIdentityKey(dividend, "ACTION");
    const postDividend: BoundaryBar = { ...post, close: 39.6 };
    const evaluation = evaluateAdjustmentSample(
      identified(dividend),
      observations(key, () => [pre, postDividend]),
    );
    expect(evaluation.passed).toBe(true);
    expect(evaluation.priceBasis).toBe("UNADJUSTED");
  });

  it("rejects duplicate and ambiguous observation identity", () => {
    const sample = splitSample();
    const key = sampleIdentityKey(sample, "ACTION");
    const duplicated = [
      ...observations(key, () => [pre, post]),
      observation("OneDay", pre, post, key),
    ];
    const ambiguous = evaluateAdjustmentSample(identified(sample), duplicated);
    expect(ambiguous.passed).toBe(false);
    expect(ambiguous.failures).toContain("AMBIGUOUS_INTERVAL:OneDay");
  });

  it("does not bind unkeyed legacy observations by symbol", () => {
    const sample = splitSample();
    const legacy = observations(sampleIdentityKey(sample, "ACTION"), () => [
      pre,
      post,
    ]).map(({ sampleKey: _sampleKey, ...rest }) => rest as SampleObservation);
    const evaluation = evaluateAdjustmentSample(identified(sample), legacy);
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failures).toContain("MISSING_INTERVAL:OneDay");
  });

  it("rejects a market or action mismatch even when the symbol matches", () => {
    const caSample = splitSample();
    const usSample = splitSample({ marketId: "US_EQUITIES", exchange: "US" });
    const evaluation = evaluateAdjustmentSample(
      identified(caSample),
      observations(sampleIdentityKey(usSample, "ACTION"), () => [pre, post]),
    );
    expect(evaluation.passed).toBe(false);
    expect(evaluation.failures).toContain("MISSING_INTERVAL:OneDay");
  });

  it("rejects duplicate frozen sample identities rather than sharing observations", () => {
    const duplicate = splitSample({ priceFactor: 0.5, volumeFactor: 2 });
    const key = sampleIdentityKey(duplicate, "ACTION");
    const report = evaluateAdjustmentVerification(
      [identified(duplicate), identified(duplicate)],
      observations(key, () => [pre, post]),
    );
    expect(report.status).toBe("STOP");
    expect(
      report.evaluations.every((value) =>
        value.failures.includes("DUPLICATE_SAMPLE_IDENTITY"),
      ),
    ).toBe(true);
  });
});
