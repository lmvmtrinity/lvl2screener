import { describe, expect, it } from "vitest";
import { researchJobMarket } from "../src/research-jobs/research-job-market.js";

const HASH = "a".repeat(64);
const ENGINE = "b".repeat(40);

describe("research job market resolution", () => {
  it("derives coverage ownership from the validated v1 request and manifest", () => {
    expect(
      researchJobMarket("COVERAGE_VERIFICATION", {
        request: {
          marketId: "US_EQUITIES",
          manifestHash: HASH,
          inputCutoff: "2026-09-10T20:00:00.000Z",
          sessionDates: ["2026-09-10"],
        },
        manifest: {
          hash: HASH,
          marketId: "US_EQUITIES",
          manifest: {},
        },
        engineRevision: ENGINE,
        runtimeFingerprint: HASH,
      }),
    ).toBe("US_EQUITIES");
  });

  it("derives coverage ownership from the frozen v2 recipe", () => {
    expect(
      researchJobMarket("COVERAGE_VERIFICATION", {
        version: "coverage-verification-v2",
        requestId: "10000000-0000-4000-8000-000000000901",
        request: {
          manifest: { hash: HASH, marketId: "CA_TSX", manifest: {} },
          recipe: {
            version: "research-coverage-recipe-v2",
            marketId: "CA_TSX",
            engineRevision: ENGINE,
            runtimeFingerprint: HASH,
            featureVersion: "features-v1",
            sessionDates: ["2026-09-10"],
            inputCutoff: "2026-09-10T20:00:00.000Z",
            streamRequirements: [
              {
                timeframe: "OneMinute",
                warmupDays: 5,
                requiredWarmupBars: 20,
                includeInSession: true,
              },
            ],
            maxQuoteGapMs: 120_000,
            replayPolicyHash: HASH,
            membershipPolicyHash: HASH,
            calendarPolicyHash: HASH,
          },
        },
      }),
    ).toBe("CA_TSX");
  });

  it("fails closed on mismatched or missing ownership", () => {
    expect(() =>
      researchJobMarket("COVERAGE_VERIFICATION", {
        request: {
          marketId: "CA_TSX",
          manifestHash: HASH,
          inputCutoff: "2026-09-10T20:00:00.000Z",
          sessionDates: ["2026-09-10"],
        },
        manifest: { hash: HASH, marketId: "US_EQUITIES", manifest: {} },
        engineRevision: ENGINE,
        runtimeFingerprint: HASH,
      }),
    ).toThrow();
    expect(() => researchJobMarket("BACKTEST", {})).toThrow();
  });
});
