import { z } from "zod";

export const strategyStateSchema = z.enum([
  "INACTIVE",
  "WATCH",
  "FORMING",
  "READY",
  "INVALIDATED",
  "EXPIRED",
  "HALTED",
  "DATA_STALE",
]);
export type StrategyState = z.infer<typeof strategyStateSchema>;
export const setupStrategyNameSchema = z.enum([
  "ORB_RETEST",
  "VWAP_HOLD",
  "VWAP_RECLAIM",
  "RSI_VWAP_RECLAIM",
  "HIGH_OF_DAY_BREAKOUT",
  "BULL_FLAG",
  "PRIOR_DAY_HIGH_BREAKOUT",
]);
export const contextSignalNameSchema = z.enum([
  "SECTOR_RELATIVE_STRENGTH",
  "MARKET_RELATIVE_STRENGTH",
]);
export const strategyNameSchema = z.union([
  setupStrategyNameSchema,
  contextSignalNameSchema,
]);
export type StrategyName = z.infer<typeof strategyNameSchema>;
export type SetupStrategyName = z.infer<typeof setupStrategyNameSchema>;
export type ContextSignalName = z.infer<typeof contextSignalNameSchema>;
export const analysisKindSchema = z.enum(["SETUP", "CONTEXT"]);
export type AnalysisKind = z.infer<typeof analysisKindSchema>;
export const strategyParametersSchema = z.object({
  stopPolicy: z
    .enum(["HYBRID", "PATTERN_INVALIDATION", "NEAREST_SUPPORT"])
    .optional(),
  rvolAtTimeMin: z.number().nonnegative().max(20).default(1.5),
  spreadHardMaxPct: z.number().positive().max(5).default(0.25),
  atrPctMin: z.number().nonnegative().max(20).default(0),
  breakoutVolumeRatioMin: z.number().positive().max(20).default(1.5),
  retestTolerancePct: z.number().nonnegative().max(5).default(0.15),
  scoreCutoff: z.number().int().min(0).max(100).default(0),
  breakoutBufferPct: z.number().nonnegative().max(5).default(0.05),
  relativeStrengthMinPct: z.number().nonnegative().max(20).default(0.5),
  flagpoleMinAtr: z.number().positive().max(10).default(0.5),
  flagRetracementMaxPct: z.number().positive().max(100).default(50),
  setupTimeoutMinutes: z.number().int().min(5).max(120).default(20),
  consolidationBarsMin: z.number().int().min(1).max(20).default(3),
  consolidationRangeMaxPct: z.number().positive().max(10).default(0.75),
  flagDurationBarsMin: z.number().int().min(1).max(10).default(1),
  flagDurationBarsMax: z.number().int().min(1).max(10).default(2),
  flagpoleMinSlopeAtrPerBar: z.number().nonnegative().max(5).default(0),
  volumeContractionMaxPct: z.number().positive().max(100).default(100),
  retestVolumeContractionEnabled: z.number().int().min(0).max(1).optional(),
  retestHighBreakEnabled: z.number().int().min(0).max(1).optional(),
  retestRejectionEnabled: z.number().int().min(0).max(1).optional(),
  retestVolumeContractionMaxRatio: z.number().positive().max(1).optional(),
  rejectionLowerWickBodyMin: z.number().positive().max(20).optional(),
  rejectionUpperWickRangeMaxPct: z.number().nonnegative().max(100).optional(),
  rejectionCloseLocationMinPct: z.number().nonnegative().max(100).optional(),
  rsiPeriod: z.number().int().min(14).max(14).optional(),
  rsiPivotLeftBars: z.number().int().min(1).max(10).optional(),
  rsiPivotRightBars: z.number().int().min(1).max(10).optional(),
  rsiPivotMinSpacingBars: z.number().int().min(1).max(50).optional(),
  rsiPivotMaxSpacingBars: z.number().int().min(1).max(100).optional(),
  rsiDivergenceMinPoints: z.number().nonnegative().max(100).optional(),
  rsiDivergenceVolumeContractionMaxRatio: z
    .number()
    .positive()
    .max(1)
    .optional(),
  rsiSetupTimeoutMinutes: z.number().int().min(5).max(120).optional(),
  dailyEmaFilterEnabled: z.number().int().min(0).max(1).optional(),
});
export type StrategyParameters = z.infer<typeof strategyParametersSchema>;

/** Fixed scoring threshold: spreads at or below this are preferred, wider ones are only tolerated. */
export const SPREAD_PREFERRED_MAX_PCT = 0.15;
/** Breakout volume ratio = latest completed candle volume / mean volume of this many previous completed candles. */
export const BREAKOUT_VOLUME_BASELINE_CANDLES = 3;
export const BREAKOUT_VOLUME_FORMULA = `Latest completed candle volume divided by the mean volume of the ${BREAKOUT_VOLUME_BASELINE_CANDLES} previous completed candles.`;

export const parameterGroupSchema = z.enum(["COMMON", "STRATEGY"]);
export type ParameterGroup = z.infer<typeof parameterGroupSchema>;
export const parameterDescriptorSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  unit: z.string().nullable(),
  group: parameterGroupSchema,
  type: z.enum(["number", "integer"]),
  minimum: z.number(),
  maximum: z.number(),
  step: z.number().positive(),
  default: z.number(),
  /** Fixed parameters are displayed for transparency but cannot be edited on a profile. */
  fixed: z.boolean().default(false),
});
export type ParameterDescriptor = z.infer<typeof parameterDescriptorSchema>;
export type StrategyParameterKey = Exclude<
  keyof StrategyParameters,
  "stopPolicy"
>;

export const strategyParameterDescriptors: Record<
  StrategyParameterKey,
  ParameterDescriptor
> = {
  rvolAtTimeMin: {
    key: "rvolAtTimeMin",
    label: "Relative volume minimum",
    unit: "x",
    group: "COMMON",
    type: "number",
    minimum: 0,
    maximum: 20,
    step: 0.1,
    default: 1.5,
    fixed: false,
    description:
      "Cumulative session volume divided by the historical mean cumulative volume at the same time of day. Candidates below this are gated out.",
  },
  spreadHardMaxPct: {
    key: "spreadHardMaxPct",
    label: "Spread hard reject %",
    unit: "%",
    group: "COMMON",
    type: "number",
    minimum: 0.01,
    maximum: 5,
    step: 0.01,
    default: 0.25,
    fixed: false,
    description: `Bid/ask spread above this percentage rejects the candidate outright. Separate from the fixed preferred spread threshold of ${SPREAD_PREFERRED_MAX_PCT}%.`,
  },
  atrPctMin: {
    key: "atrPctMin",
    label: "ATR minimum %",
    unit: "%",
    group: "COMMON",
    type: "number",
    minimum: 0,
    maximum: 20,
    step: 0.05,
    default: 0,
    fixed: false,
    description:
      "ATR(14) as a percentage of price. Filters out instruments with too little intraday range to pay for the spread.",
  },
  scoreCutoff: {
    key: "scoreCutoff",
    label: "Score cutoff",
    unit: null,
    group: "COMMON",
    type: "integer",
    minimum: 0,
    maximum: 100,
    step: 1,
    default: 0,
    fixed: false,
    description:
      "Evaluations scoring below this are hidden. A cutoff never promotes a setup to READY.",
  },
  breakoutVolumeRatioMin: {
    key: "breakoutVolumeRatioMin",
    label: "Breakout candle volume ratio",
    unit: "x",
    group: "STRATEGY",
    type: "number",
    minimum: 0.1,
    maximum: 20,
    step: 0.1,
    default: 1.5,
    fixed: false,
    description: `${BREAKOUT_VOLUME_FORMULA} The breakout candle must reach this ratio to be volume-confirmed.`,
  },
  retestTolerancePct: {
    key: "retestTolerancePct",
    label: "Retest tolerance %",
    unit: "%",
    group: "STRATEGY",
    type: "number",
    minimum: 0,
    maximum: 5,
    step: 0.01,
    default: 0.15,
    fixed: false,
    description:
      "Distance below the breakout level that still counts as a supported retest, and where the structural invalidation sits.",
  },
  breakoutBufferPct: {
    key: "breakoutBufferPct",
    label: "Breakout buffer %",
    unit: "%",
    group: "STRATEGY",
    type: "number",
    minimum: 0,
    maximum: 5,
    step: 0.01,
    default: 0.05,
    fixed: false,
    description:
      "Distance above the level the close must clear before a breakout is accepted, which suppresses ties and one-tick pokes.",
  },
  setupTimeoutMinutes: {
    key: "setupTimeoutMinutes",
    label: "Setup timeout",
    unit: "min",
    group: "STRATEGY",
    type: "integer",
    minimum: 5,
    maximum: 120,
    step: 1,
    default: 20,
    fixed: false,
    description:
      "Minutes a breakout may wait for its confirmation before the setup expires.",
  },
  flagpoleMinAtr: {
    key: "flagpoleMinAtr",
    label: "Flagpole minimum",
    unit: "ATR",
    group: "STRATEGY",
    type: "number",
    minimum: 0.1,
    maximum: 10,
    step: 0.1,
    default: 0.5,
    fixed: false,
    description:
      "Impulse height in ATR units required before a pullback is treated as a flag.",
  },
  flagRetracementMaxPct: {
    key: "flagRetracementMaxPct",
    label: "Flag retracement maximum %",
    unit: "%",
    group: "STRATEGY",
    type: "number",
    minimum: 1,
    maximum: 100,
    step: 1,
    default: 50,
    fixed: false,
    description:
      "Deepest pullback into the flagpole that still counts as a flag rather than a failed impulse.",
  },
  relativeStrengthMinPct: {
    key: "relativeStrengthMinPct",
    label: "Relative strength threshold %",
    unit: "%",
    group: "STRATEGY",
    type: "number",
    minimum: 0,
    maximum: 20,
    step: 0.1,
    default: 0.5,
    fixed: false,
    description:
      "Outperformance versus the configured benchmark, in percentage points from the session open, needed for a STRONG context status.",
  },
  consolidationBarsMin: {
    key: "consolidationBarsMin",
    label: "Consolidation bars minimum",
    unit: null,
    group: "STRATEGY",
    type: "integer",
    minimum: 1,
    maximum: 20,
    step: 1,
    default: 3,
    fixed: false,
    description:
      "Completed bars immediately before a high-of-day breakout that must form a tight base for the breakout to count.",
  },
  consolidationRangeMaxPct: {
    key: "consolidationRangeMaxPct",
    label: "Consolidation range maximum %",
    unit: "%",
    group: "STRATEGY",
    type: "number",
    minimum: 0.01,
    maximum: 10,
    step: 0.01,
    default: 0.75,
    fixed: false,
    description:
      "Widest high/low range that base may span, as a percentage of the breakout level, before it no longer counts as consolidation.",
  },
  flagDurationBarsMin: {
    key: "flagDurationBarsMin",
    label: "Flag duration minimum",
    unit: "bars",
    group: "STRATEGY",
    type: "integer",
    minimum: 1,
    maximum: 10,
    step: 1,
    default: 1,
    fixed: false,
    description:
      "Fewest completed bars the pullback consolidation may span before it counts as a flag.",
  },
  flagDurationBarsMax: {
    key: "flagDurationBarsMax",
    label: "Flag duration maximum",
    unit: "bars",
    group: "STRATEGY",
    type: "integer",
    minimum: 1,
    maximum: 10,
    step: 1,
    default: 2,
    fixed: false,
    description:
      "Most completed bars the pullback consolidation may span before it counts as a flag.",
  },
  flagpoleMinSlopeAtrPerBar: {
    key: "flagpoleMinSlopeAtrPerBar",
    label: "Flagpole minimum slope",
    unit: "ATR/bar",
    group: "STRATEGY",
    type: "number",
    minimum: 0,
    maximum: 5,
    step: 0.05,
    default: 0,
    fixed: false,
    description:
      "Steepness of the impulse leg, in ATR per bar, required in addition to its total height. Rejects a tall but slow drift.",
  },
  volumeContractionMaxPct: {
    key: "volumeContractionMaxPct",
    label: "Volume contraction maximum %",
    unit: "%",
    group: "STRATEGY",
    type: "number",
    minimum: 1,
    maximum: 100,
    step: 1,
    default: 100,
    fixed: false,
    description:
      "Flag volume must fall to at most this percent of the impulse leg's average volume to count as contracting.",
  },
  retestVolumeContractionEnabled: {
    key: "retestVolumeContractionEnabled",
    label: "Retest volume contraction enabled",
    unit: "0/1",
    group: "STRATEGY",
    type: "integer",
    minimum: 0,
    maximum: 1,
    step: 1,
    default: 0,
    fixed: false,
    description:
      "Require the bound pullback mean volume to contract versus its bound impulse window.",
  },
  retestHighBreakEnabled: {
    key: "retestHighBreakEnabled",
    label: "Retest high-break enabled",
    unit: "0/1",
    group: "STRATEGY",
    type: "integer",
    minimum: 0,
    maximum: 1,
    step: 1,
    default: 0,
    fixed: false,
    description:
      "Require a later completed close above the selected retest candle high plus the symbol-aware buffer.",
  },
  retestRejectionEnabled: {
    key: "retestRejectionEnabled",
    label: "Support rejection enabled",
    unit: "0/1",
    group: "STRATEGY",
    type: "integer",
    minimum: 0,
    maximum: 1,
    step: 1,
    default: 0,
    fixed: false,
    description:
      "Require an explicit non-doji lower-wick rejection at the bound support and a later confirmation.",
  },
  retestVolumeContractionMaxRatio: {
    key: "retestVolumeContractionMaxRatio",
    label: "Retest contraction maximum",
    unit: "x",
    group: "STRATEGY",
    type: "number",
    minimum: 0.01,
    maximum: 1,
    step: 0.01,
    default: 0.8,
    fixed: false,
    description:
      "Maximum mean pullback volume divided by the bound impulse mean volume.",
  },
  rejectionLowerWickBodyMin: {
    key: "rejectionLowerWickBodyMin",
    label: "Rejection lower wick/body minimum",
    unit: "x",
    group: "STRATEGY",
    type: "number",
    minimum: 0.01,
    maximum: 20,
    step: 0.1,
    default: 2,
    fixed: false,
    description:
      "Minimum lower-wick to body ratio for the experimental rejection candle.",
  },
  rejectionUpperWickRangeMaxPct: {
    key: "rejectionUpperWickRangeMaxPct",
    label: "Rejection upper wick maximum",
    unit: "% range",
    group: "STRATEGY",
    type: "number",
    minimum: 0,
    maximum: 100,
    step: 1,
    default: 20,
    fixed: false,
    description: "Maximum upper-wick share of the candle range.",
  },
  rejectionCloseLocationMinPct: {
    key: "rejectionCloseLocationMinPct",
    label: "Rejection close location minimum",
    unit: "% range",
    group: "STRATEGY",
    type: "number",
    minimum: 0,
    maximum: 100,
    step: 1,
    default: 65,
    fixed: false,
    description:
      "Minimum close location within the candle range; the seed is the upper 35%.",
  },
  rsiPeriod: {
    key: "rsiPeriod",
    label: "RSI period",
    unit: "bars",
    group: "STRATEGY",
    type: "integer",
    minimum: 14,
    maximum: 14,
    step: 1,
    default: 14,
    fixed: true,
    description:
      "Fixed Wilder RSI period for the first centrally cached experiment.",
  },
  rsiPivotLeftBars: {
    key: "rsiPivotLeftBars",
    label: "RSI pivot left bars",
    unit: "bars",
    group: "STRATEGY",
    type: "integer",
    minimum: 1,
    maximum: 10,
    step: 1,
    default: 2,
    fixed: false,
    description: "Completed bars to the left of a price pivot.",
  },
  rsiPivotRightBars: {
    key: "rsiPivotRightBars",
    label: "RSI pivot right bars",
    unit: "bars",
    group: "STRATEGY",
    type: "integer",
    minimum: 1,
    maximum: 10,
    step: 1,
    default: 2,
    fixed: false,
    description: "Completed bars required to confirm a price pivot.",
  },
  rsiPivotMinSpacingBars: {
    key: "rsiPivotMinSpacingBars",
    label: "RSI pivot minimum spacing",
    unit: "bars",
    group: "STRATEGY",
    type: "integer",
    minimum: 1,
    maximum: 50,
    step: 1,
    default: 3,
    fixed: false,
    description:
      "Minimum distance between the two selected current-session lows.",
  },
  rsiPivotMaxSpacingBars: {
    key: "rsiPivotMaxSpacingBars",
    label: "RSI pivot maximum spacing",
    unit: "bars",
    group: "STRATEGY",
    type: "integer",
    minimum: 1,
    maximum: 100,
    step: 1,
    default: 12,
    fixed: false,
    description:
      "Maximum distance between the two selected current-session lows.",
  },
  rsiDivergenceMinPoints: {
    key: "rsiDivergenceMinPoints",
    label: "RSI divergence minimum",
    unit: "points",
    group: "STRATEGY",
    type: "number",
    minimum: 0,
    maximum: 100,
    step: 0.5,
    default: 3,
    fixed: false,
    description: "Minimum higher RSI difference at the selected price pivots.",
  },
  rsiDivergenceVolumeContractionMaxRatio: {
    key: "rsiDivergenceVolumeContractionMaxRatio",
    label: "Divergence volume maximum",
    unit: "x",
    group: "STRATEGY",
    type: "number",
    minimum: 0.01,
    maximum: 1,
    step: 0.01,
    default: 0.8,
    fixed: false,
    description:
      "Maximum three-bar second-pivot volume divided by the first-pivot window volume.",
  },
  rsiSetupTimeoutMinutes: {
    key: "rsiSetupTimeoutMinutes",
    label: "RSI setup timeout",
    unit: "min",
    group: "STRATEGY",
    type: "integer",
    minimum: 5,
    maximum: 120,
    step: 1,
    default: 30,
    fixed: false,
    description:
      "Minutes after divergence confirmation before the ordered setup expires.",
  },
  dailyEmaFilterEnabled: {
    key: "dailyEmaFilterEnabled",
    label: "Daily EMA filter enabled",
    unit: "0/1",
    group: "STRATEGY",
    type: "integer",
    minimum: 0,
    maximum: 1,
    step: 1,
    default: 0,
    fixed: false,
    description:
      "Require prior completed daily close above EMA13/21 with both EMA slopes positive.",
  },
};

/** Displayed next to the editable parameters so the two spread thresholds are never confused. */
export const fixedParameterDescriptors: ParameterDescriptor[] = [
  {
    key: "spreadPreferredMaxPct",
    label: "Spread preferred %",
    unit: "%",
    group: "COMMON",
    type: "number",
    minimum: SPREAD_PREFERRED_MAX_PCT,
    maximum: SPREAD_PREFERRED_MAX_PCT,
    step: 0.01,
    default: SPREAD_PREFERRED_MAX_PCT,
    fixed: true,
    description:
      "Spreads at or below this are scored as good; wider spreads up to the hard reject threshold are scored as caution. Fixed, not profile-configurable.",
  },
];

export const defaultStrategyParameters = (): StrategyParameters =>
  strategyParametersSchema.parse({
    retestVolumeContractionEnabled: 0,
    retestHighBreakEnabled: 0,
    retestRejectionEnabled: 0,
    retestVolumeContractionMaxRatio: 0.8,
    rejectionLowerWickBodyMin: 2,
    rejectionUpperWickRangeMaxPct: 20,
    rejectionCloseLocationMinPct: 65,
    rsiPeriod: 14,
    rsiPivotLeftBars: 2,
    rsiPivotRightBars: 2,
    rsiPivotMinSpacingBars: 3,
    rsiPivotMaxSpacingBars: 12,
    rsiDivergenceMinPoints: 3,
    rsiDivergenceVolumeContractionMaxRatio: 0.8,
    rsiSetupTimeoutMinutes: 30,
    dailyEmaFilterEnabled: 0,
  });

/** The first RSI/VWAP experiment uses its structural pivot low as the stop anchor. */
export const defaultStopPolicyForStrategy = (
  strategy: StrategyName | undefined,
): NonNullable<StrategyParameters["stopPolicy"]> =>
  strategy === "RSI_VWAP_RECLAIM" ? "PATTERN_INVALIDATION" : "HYBRID";

/** Parameter keys a definition declares, in descriptor order, ignoring keys the platform no longer knows. */
export const declaredParameterKeys = (definition: {
  parameterSchema: Record<string, unknown>;
}): StrategyParameterKey[] => {
  const declared = new Set(Object.keys(definition.parameterSchema));
  return (
    Object.keys(strategyParameterDescriptors) as StrategyParameterKey[]
  ).filter((key) => declared.has(key));
};
export const descriptorsForDefinition = (definition: {
  parameterSchema: Record<string, unknown>;
}): ParameterDescriptor[] =>
  declaredParameterKeys(definition).map(
    (key) => strategyParameterDescriptors[key],
  );

export type ParameterIssue = { key: string; message: string };

/**
 * Authoritative parameter validation. The UI renders the same descriptors, but the
 * API runs this so direct API use cannot save a combination the UI would refuse.
 */
export const validateStrategyParameters = (
  definition: { parameterSchema: Record<string, unknown> },
  values: StrategyParameters,
): ParameterIssue[] => {
  const declared = declaredParameterKeys(definition),
    defaults = defaultStrategyParameters(),
    issues: ParameterIssue[] = [];
  for (const key of Object.keys(
    strategyParameterDescriptors,
  ) as StrategyParameterKey[]) {
    const descriptor = strategyParameterDescriptors[key],
      value = values[key] ?? defaults[key];
    if (!declared.includes(key)) {
      if (value !== defaults[key])
        issues.push({
          key,
          message: `${descriptor.label} is not declared by this strategy and must stay at its default of ${defaults[key]}`,
        });
      continue;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push({
        key,
        message: `${descriptor.label} must be a finite number`,
      });
      continue;
    }
    if (descriptor.type === "integer" && !Number.isInteger(value))
      issues.push({
        key,
        message: `${descriptor.label} must be a whole number`,
      });
    if (value < descriptor.minimum || value > descriptor.maximum)
      issues.push({
        key,
        message: `${descriptor.label} must be between ${descriptor.minimum} and ${descriptor.maximum}`,
      });
  }
  // A buffer wider than the retest tolerance arms the setup on a move larger than
  // the one that immediately invalidates it, so the combination can never hold.
  if (
    declared.includes("breakoutBufferPct") &&
    declared.includes("retestTolerancePct") &&
    values.breakoutBufferPct > values.retestTolerancePct
  )
    issues.push({
      key: "breakoutBufferPct",
      message:
        "Breakout buffer % cannot exceed retest tolerance %, because the setup would be invalidated by a smaller move than the one that armed it",
    });
  return issues;
};

export const parameterChangeSchema = z.object({
  key: z.string(),
  label: z.string(),
  unit: z.string().nullable(),
  previous: z.number().nullable(),
  next: z.number().nullable(),
});
export type ParameterChange = z.infer<typeof parameterChangeSchema>;
export const profileConfigVersionSchema = z.object({
  configId: z.string().uuid(),
  configVersion: z.string().min(1),
  sourceCalibrationRunId: z.string().uuid().nullable().optional(),
  parameters: strategyParametersSchema,
  createdAt: z.string().datetime(),
  current: z.boolean(),
  changes: z.array(parameterChangeSchema),
});
export type ProfileConfigVersion = z.infer<typeof profileConfigVersionSchema>;
export const profileConfigHistorySchema = z.object({
  profileId: z.string().uuid(),
  profileName: z.string().min(1),
  versions: z.array(profileConfigVersionSchema),
});
export type ProfileConfigHistory = z.infer<typeof profileConfigHistorySchema>;
/**
 * Phase 4 explainable setup scoring. The scanner owns the curves; this contract
 * owns the shape, the component budget, and the deterministic ranking policy.
 * `SETUP_SCORE_VERSION` mirrors SCORE_VERSION in services/scanner/app/scoring.py
 * and moves independently from a strategy version or a configuration version.
 */
