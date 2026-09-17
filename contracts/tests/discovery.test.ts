import { describe, expect, it } from "vitest";
import {
  discoveryCoverageSchema,
  discoveryModeChangeSchema,
  discoveryPolicyForMarket,
  discoveryPolicySchema,
  discoveryQuerySchema,
} from "../src/domains/discovery.js";

describe("discovery v1 contract", () => {
  it.each(["CA_TSX", "US_EQUITIES"] as const)(
    "locks %s policy and rejects threshold drift",
    (marketId) => {
      const policy = discoveryPolicyForMarket(marketId);
      expect(discoveryPolicySchema.parse(policy)).toEqual(policy);
      expect(
        discoveryPolicySchema.safeParse({ ...policy, minimumMarketCap: 0 })
          .success,
      ).toBe(false);
      expect(
        discoveryPolicySchema.safeParse({
          ...policy,
          relativeVolumeMethod: "CUMULATIVE",
        }).success,
      ).toBe(false);
      expect(
        discoveryPolicySchema.safeParse({ ...policy, exchanges: ["NYSE_ARCA"] })
          .success,
      ).toBe(false);
      expect(
        discoveryPolicySchema.safeParse({
          ...policy,
          currency: marketId === "CA_TSX" ? "USD" : "CAD",
        }).success,
      ).toBe(false);
    },
  );
  it("returns independent definitions and preserves requested thresholds", () => {
    const ca = discoveryPolicyForMarket("CA_TSX");
    ca.exchanges.pop();
    expect(discoveryPolicyForMarket("CA_TSX").exchanges).toEqual(["TSX"]);
    expect(discoveryPolicyForMarket("CA_TSX")).toMatchObject({
      minimumPrice: 5,
      maximumPrice: 150,
      minimumMarketCap: 400_000_000,
      minimumAverageVolume90d: 400_000,
      minimumAtrPct: 1.5,
      minimumRelativeVolume: 1.5,
      minimumChangeFromOpenPct: 0.75,
      minimumDollarVolume30d: 15_000_000,
    });
    expect(discoveryPolicyForMarket("US_EQUITIES")).toMatchObject({
      minimumPrice: 10,
      maximumPrice: 200,
      minimumMarketCap: 1_000_000_000,
      minimumAverageVolume90d: 1_000_000,
      minimumAtrPct: 2,
      minimumRelativeVolume: 1.75,
      minimumChangeFromOpenPct: 1,
      minimumDollarVolume30d: 50_000_000,
    });
  });
  it("requires complete coverage even when none qualify", () => {
    expect(
      discoveryCoverageSchema.safeParse({
        total: 10,
        pass: 0,
        fail: 7,
        unevaluable: 2,
        deferred: 1,
      }).success,
    ).toBe(true);
    expect(
      discoveryCoverageSchema.safeParse({
        total: 10,
        pass: 0,
        fail: 7,
        unevaluable: 0,
        deferred: 0,
      }).success,
    ).toBe(false);
  });
  it("requires explicit markets and audited optimistic mode changes", () => {
    expect(discoveryQuerySchema.safeParse({}).success).toBe(false);
    expect(discoveryQuerySchema.safeParse({ marketId: "ALL" }).success).toBe(
      false,
    );
    expect(
      discoveryModeChangeSchema.safeParse({
        marketId: "CA_TSX",
        mode: "AUTO_ADD",
      }).success,
    ).toBe(false);
    expect(
      discoveryModeChangeSchema.parse({
        marketId: "CA_TSX",
        mode: "OFF",
        expectedRevision: 1,
        reason: "pause",
      }).mode,
    ).toBe("OFF");
  });
});
