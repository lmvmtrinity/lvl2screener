import { z } from "zod";

export const marketDataStatusSchema = z.enum(["REALTIME", "DELAYED", "HALTED"]);

export const featureLevelProvenanceSchema = z
  .object({
    levelId: z.string().min(1),
    originAt: z.string().datetime(),
    availableAt: z.string().datetime(),
  })
  .refine(
    (provenance) =>
      Date.parse(provenance.availableAt) >= Date.parse(provenance.originAt),
    { message: "level availability precedes origin" },
  );
export type FeatureLevelProvenance = z.infer<
  typeof featureLevelProvenanceSchema
>;

export const featureLevelSchema = z.object({
  price: z.number(),
  type: z.string().min(1),
  strength: z.number().min(0).max(1),
  tests: z.number().int().nonnegative(),
  ageBars: z.number().int().nonnegative(),
  provenance: featureLevelProvenanceSchema.nullable().optional(),
});
export type FeatureLevel = z.infer<typeof featureLevelSchema>;

/** Distinct level types (PDH/ORH/HOD/VWAP/confirmed pivot) clustered near one anchor price,
 * deduplicated by type so two swing highs a tick apart near the same anchor count once, not twice. */
export const levelConfluenceSchema = z.object({
  price: z.number(),
  levelTypes: z.array(z.string()),
  count: z.number().int().nonnegative(),
});
export type LevelConfluence = z.infer<typeof levelConfluenceSchema>;

export const openingRangeFeatureSchema = z.object({
  high: z.number(),
  low: z.number(),
  mid: z.number(),
  width: z.number().nonnegative(),
  widthPct: z.number().nonnegative(),
  widthAtr: z.number().nonnegative().nullable(),
  volume: z.number().int().nonnegative(),
  complete: z.boolean(),
});
export type OpeningRangeFeature = z.infer<typeof openingRangeFeatureSchema>;

export const dailyEmaContextFeatureSchema = z.object({
  status: z.enum(["BULLISH", "NEUTRAL", "BEARISH", "UNAVAILABLE"]),
  ema13: z.number().nullable(),
  ema21: z.number().nullable(),
  slope13: z.number().nullable(),
  slope21: z.number().nullable(),
  sourceTimestamp: z.string().datetime().nullable().optional(),
  reason: z.string().nullable().optional(),
});
export type DailyEmaContextFeature = z.infer<
  typeof dailyEmaContextFeatureSchema
>;

export const featureSnapshotSchema = z.object({
  marketId: z.enum(["CA_TSX", "US_EQUITIES"]).default("CA_TSX"),
  instrumentId: z.string().uuid(),
  symbol: z.string().min(1),
  timestamp: z.string().datetime(),
  timeframe: z.literal("OneMinute"),
  featureVersion: z.string().min(1),
  configVersion: z.string().min(1),
  dataStatus: marketDataStatusSchema,
  actionable: z.boolean(),
  price: z.number().positive(),
  bid: z.number().positive(),
  ask: z.number().positive(),
  mid: z.number().positive(),
  spreadAbsolute: z.number().nonnegative(),
  spreadPct: z.number().nonnegative(),
  changeFromOpenPct: z.number(),
  rollingReturn5mPct: z.number().nullable().default(null),
  vwap: z.number().positive().nullable(),
  completedBarVwap: z.number().positive().nullable().optional(),
  completedBarVwapTimestamp: z.string().datetime().nullable().optional(),
  distanceFromVwapPct: z.number().nullable(),
  closeAboveVwap: z.boolean().nullable(),
  last3ClosesAboveVwap: z.number().int().min(0).max(3),
  vwapSlopePct: z.number().nullable(),
  touchVwap: z.boolean(),
  vwapReclaim: z.boolean(),
  vwapRejection: z.boolean(),
  // Optional so payloads captured before the research indicators remain parseable.
  rsi14: z.number().min(0).max(100).nullable().optional(),
  rsiTimestamp: z.string().datetime().nullable().optional(),
  dailyEmaContext: dailyEmaContextFeatureSchema.nullable().optional(),
  atr14: z.number().nonnegative().nullable(),
  atrPct: z.number().nonnegative().nullable(),
  rvolAtTime: z.number().nonnegative().nullable(),
  currentCumulativeVolume: z.number().int().nonnegative(),
  historicalMeanCumulativeVolume: z.number().nonnegative().nullable(),
  openingRange: openingRangeFeatureSchema.nullable(),
  swingHighs: z.array(featureLevelSchema),
  swingLows: z.array(featureLevelSchema),
  nearestSupport: featureLevelSchema.nullable(),
  nearestResistance: featureLevelSchema.nullable(),
  supportConfluence: levelConfluenceSchema.nullable().default(null),
  resistanceConfluence: levelConfluenceSchema.nullable().default(null),
  distanceFromVwapAtr: z.number().nullable(),
  distanceFromOrhAtr: z.number().nullable(),
  changeFromOpenAtr: z.number().nullable(),
  consecutiveGreenCandles: z.number().int().nonnegative(),
  recentMoveVelocityAtr: z.number().nullable(),
  warmingUp: z.array(z.string()),
});
export type FeatureSnapshot = z.infer<typeof featureSnapshotSchema>;

export const featureSnapshotBatchSchema = z.object({
  snapshots: z.array(featureSnapshotSchema),
});
export type FeatureSnapshotBatch = z.infer<typeof featureSnapshotBatchSchema>;
