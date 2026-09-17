import { describe, expect, it } from "vitest";
import {
  BREAKOUT_VOLUME_FORMULA,
  SPREAD_PREFERRED_MAX_PCT,
  declaredParameterKeys,
  defaultStrategyParameters,
  descriptorsForDefinition,
  defaultStopPolicyForStrategy,
  fixedParameterDescriptors,
  strategyParameterDescriptors,
  validateStrategyParameters,
} from "../src/index.js";

const bullFlag = {
  parameterSchema: {
    rvolAtTimeMin: "number",
    spreadHardMaxPct: "number",
    atrPctMin: "number",
    breakoutVolumeRatioMin: "number",
    flagpoleMinAtr: "number",
    flagRetracementMaxPct: "number",
    setupTimeoutMinutes: "integer",
    scoreCutoff: "integer",
  },
};
const breakout = {
  parameterSchema: {
    rvolAtTimeMin: "number",
    spreadHardMaxPct: "number",
    breakoutVolumeRatioMin: "number",
    breakoutBufferPct: "number",
    retestTolerancePct: "number",
    scoreCutoff: "integer",
  },
};
const relativeStrength = {
  parameterSchema: {
    rvolAtTimeMin: "number",
    spreadHardMaxPct: "number",
    atrPctMin: "number",
    relativeStrengthMinPct: "number",
    scoreCutoff: "integer",
  },
};

describe("schema-driven strategy parameters", () => {
  it("renders only the parameters a definition declares", () => {
    expect(declaredParameterKeys(bullFlag)).toEqual([
      "rvolAtTimeMin",
      "spreadHardMaxPct",
      "atrPctMin",
      "scoreCutoff",
      "breakoutVolumeRatioMin",
      "setupTimeoutMinutes",
      "flagpoleMinAtr",
      "flagRetracementMaxPct",
    ]);
    expect(declaredParameterKeys(relativeStrength)).not.toContain(
      "breakoutVolumeRatioMin",
    );
    expect(
      descriptorsForDefinition(relativeStrength)
        .filter((v) => v.group === "STRATEGY")
        .map((v) => v.key),
    ).toEqual(["relativeStrengthMinPct"]);
  });

  it("documents the renamed controls, the volume formula, and the separate preferred spread", () => {
    expect(strategyParameterDescriptors.spreadHardMaxPct.label).toBe(
      "Spread hard reject %",
    );
    expect(strategyParameterDescriptors.breakoutVolumeRatioMin.label).toBe(
      "Breakout candle volume ratio",
    );
    expect(
      strategyParameterDescriptors.breakoutVolumeRatioMin.description,
    ).toContain(BREAKOUT_VOLUME_FORMULA);
    expect(BREAKOUT_VOLUME_FORMULA).toBe(
      "Latest completed candle volume divided by the mean volume of the 3 previous completed candles.",
    );
    const preferred = fixedParameterDescriptors.find(
      (v) => v.key === "spreadPreferredMaxPct",
    );
    expect(preferred?.fixed).toBe(true);
    expect(preferred?.default).toBe(SPREAD_PREFERRED_MAX_PCT);
    expect(
      strategyParameterDescriptors.spreadHardMaxPct.key in
        strategyParameterDescriptors,
    ).toBe(true);
  });

  it("accepts a valid declared combination", () => {
    expect(
      validateStrategyParameters(bullFlag, {
        ...defaultStrategyParameters(),
        flagpoleMinAtr: 1.2,
        setupTimeoutMinutes: 30,
      }),
    ).toEqual([]);
  });

  it("uses structural invalidation as the RSI/VWAP experiment stop policy", () => {
    expect(defaultStopPolicyForStrategy("RSI_VWAP_RECLAIM")).toBe(
      "PATTERN_INVALIDATION",
    );
    expect(defaultStopPolicyForStrategy("ORB_RETEST")).toBe("HYBRID");
  });

  it("rejects values outside the declared bounds and non-integers", () => {
    const issues = validateStrategyParameters(bullFlag, {
      ...defaultStrategyParameters(),
      flagpoleMinAtr: 99,
      setupTimeoutMinutes: 12.5,
    });
    expect(issues.map((v) => v.key).sort()).toEqual([
      "flagpoleMinAtr",
      "setupTimeoutMinutes",
    ]);
  });

  it("rejects parameters the selected strategy does not declare", () => {
    const issues = validateStrategyParameters(relativeStrength, {
      ...defaultStrategyParameters(),
      flagpoleMinAtr: 2,
    });
    expect(issues).toEqual([
      {
        key: "flagpoleMinAtr",
        message:
          "Flagpole minimum is not declared by this strategy and must stay at its default of 0.5",
      },
    ]);
  });

  it("rejects a breakout buffer wider than the retest tolerance", () => {
    expect(
      validateStrategyParameters(breakout, {
        ...defaultStrategyParameters(),
        breakoutBufferPct: 0.4,
        retestTolerancePct: 0.15,
      })[0]?.key,
    ).toBe("breakoutBufferPct");
    expect(
      validateStrategyParameters(breakout, {
        ...defaultStrategyParameters(),
        breakoutBufferPct: 0.05,
        retestTolerancePct: 0.15,
      }),
    ).toEqual([]);
  });
});
