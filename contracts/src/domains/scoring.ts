import { z } from "zod";
import { featureSnapshotSchema } from "./market-data.js";
import { marketIdSchema } from "./markets.js";
import {
  StrategyName,
  StrategyState,
  contextSignalNameSchema,
  setupStrategyNameSchema,
  strategyStateSchema,
} from "./strategies.js";

export const SETUP_SCORE_VERSION = "setup-score-v1";
export const setupScoreGroupSchema = z.enum([
  "pattern",
  "confirmation",
  "structure",
  "liquidity",
  "timing",
  "penalties",
]);
export type SetupScoreGroup = z.infer<typeof setupScoreGroupSchema>;
export const SETUP_SCORE_GROUPS: SetupScoreGroup[] = [
  "pattern",
  "confirmation",
  "structure",
  "liquidity",
  "timing",
  "penalties",
];
/** Points each component may award. Penalties only subtract, so their budget is 0. */
export const SETUP_SCORE_GROUP_MAXIMUM: Record<SetupScoreGroup, number> = {
  pattern: 25,
  confirmation: 20,
  structure: 20,
  liquidity: 20,
  timing: 15,
  penalties: 0,
};
export const SETUP_SCORE_GROUP_LABEL: Record<SetupScoreGroup, string> = {
  pattern: "Pattern",
  confirmation: "Confirmation",
  structure: "Structure",
  liquidity: "Liquidity",
  timing: "Timing",
  penalties: "Penalties",
};
export const setupScoreComponentsSchema = z.object({
  pattern: z.number().int(),
  confirmation: z.number().int(),
  structure: z.number().int(),
  liquidity: z.number().int(),
  timing: z.number().int(),
  penalties: z.number().int(),
});
export type SetupScoreComponents = z.infer<typeof setupScoreComponentsSchema>;
const emptyScoreComponents: SetupScoreComponents = {
  pattern: 0,
  confirmation: 0,
  structure: 0,
  liquidity: 0,
  timing: 0,
  penalties: 0,
};
export const setupScoreContributionSchema = z.object({
  key: z.string().min(1),
  group: setupScoreGroupSchema,
  label: z.string().min(1),
  points: z.number().int(),
  maximum: z.number().int(),
  value: z.number().nullable(),
  detail: z.string(),
});
export type SetupScoreContribution = z.infer<
  typeof setupScoreContributionSchema
>;

/** Versioned record of the concrete bars and levels selected by a strategy. */
export const FORMATION_EVIDENCE_VERSION = "formation-evidence-v1" as const;
export const formationPivotEvidenceSchema = z.object({
  timestamp: z.string().datetime(),
  price: z.number(),
  rsi: z.number().min(0).max(100),
});
export type FormationPivotEvidence = z.infer<
  typeof formationPivotEvidenceSchema
>;
export const retestFormationEvidenceSchema = z.object({
  impulseStartAt: z.string().datetime().nullable(),
  impulseEndAt: z.string().datetime().nullable(),
  impulseMeanVolume: z.number().nullable(),
  retestBarEnd: z.string().datetime().nullable(),
  retestBarHigh: z.number().nullable(),
  retestBarLow: z.number().nullable(),
  pullbackVolumeSum: z.number().nullable(),
  pullbackVolumeCount: z.number().int().nonnegative().nullable(),
  volumeContractionRatio: z.number().nullable(),
  volumeUnavailable: z.boolean(),
  supportRejectionConfirmed: z.boolean(),
});
export type RetestFormationEvidence = z.infer<
  typeof retestFormationEvidenceSchema
>;
export const rsiVwapReclaimFormationEvidenceSchema = z.object({
  indicatorVersion: z.string().min(1),
  firstPivot: formationPivotEvidenceSchema,
  secondPivot: formationPivotEvidenceSchema,
  divergenceConfirmedAt: z.string().datetime(),
  divergenceVolumeContractionRatio: z.number().nullable(),
  reclaimAt: z.string().datetime().nullable(),
  holdAt: z.string().datetime().nullable(),
  frozenResistance: z.number().nullable(),
  invalidationLevel: z.number().nullable(),
});
export type RsiVwapReclaimFormationEvidence = z.infer<
  typeof rsiVwapReclaimFormationEvidenceSchema
>;
export const formationEvidenceSchema = z.object({
  version: z.literal(FORMATION_EVIDENCE_VERSION),
  strategy: setupStrategyNameSchema,
  formationKey: z.string().nullable(),
  setupLevel: z.number().nullable(),
  stopLevel: z.number().nullable(),
  retest: retestFormationEvidenceSchema.nullable(),
  rsiVwapReclaim: rsiVwapReclaimFormationEvidenceSchema.nullable(),
});
export type FormationEvidence = z.infer<typeof formationEvidenceSchema>;

export const strategyEvaluationSchema = z.object({
  kind: z.literal("SETUP"),
  // Historical TSX evaluations predate explicit market provenance. New scanner
  // output always sends this field, while the default preserves their reads.
  marketId: marketIdSchema.default("CA_TSX"),
  instrumentId: z.string().uuid(),
  symbol: z.string().min(1),
  timestamp: z.string().datetime(),
  profileId: z.string().uuid().default("00000000-0000-4000-8000-000000000000"),
  profileName: z.string().min(1).default("Legacy"),
  strategy: setupStrategyNameSchema,
  strategyVersion: z.literal("1.0.0"),
  configVersion: z.string().min(1),
  state: strategyStateSchema,
  score: z.number().int().min(0).max(100),
  setupScore: z.number().int().min(0).max(100),
  // Evaluations recorded before Phase 4 stay readable as V1 setup records with no components.
  scoreVersion: z.string().min(1).default("legacy-v1"),
  scoreComponents: setupScoreComponentsSchema.default(emptyScoreComponents),
  scoreExplanation: z.array(setupScoreContributionSchema).default([]),
  // Identifies one concrete formation (e.g. one ORH breakout and retest) so repeated
  // alerts, invalidation, and re-arm all refer to the same lifecycle. Absent on legacy
  // (pre-Phase-5) records.
  setupInstanceId: z.string().uuid().nullable().default(null),
  reasonCodes: z.array(z.string()),
  entryReference: z.number().nullable(),
  stopReference: z.number().nullable(),
  targetReference: z.number().nullable(),
  estimatedRr: z.number().nullable(),
  signalSemanticsVersion: z.string().optional(),
  entryWindow: z
    .object({
      preferredStart: z.string(),
      preferredEnd: z.string(),
      hardEnd: z.string(),
    })
    .nullable()
    .optional(),
  stopPolicy: z
    .enum(["HYBRID", "PATTERN_INVALIDATION", "NEAREST_SUPPORT"])
    .optional(),
  patternStopReference: z.number().nullable().optional(),
  stopSelectionReason: z.string().nullable().optional(),
  // Historical evaluations and state events predate bound formation evidence.
  formationEvidence: formationEvidenceSchema.nullable().optional(),
  featureSnapshot: featureSnapshotSchema,
});
export type StrategyEvaluation = z.infer<typeof strategyEvaluationSchema>;
export const strategyStateEventSchema = strategyEvaluationSchema.extend({
  eventId: z.string().uuid(),
  eventType: z.literal("STRATEGY_STATE_CHANGED"),
  previousState: strategyStateSchema,
});
export type StrategyStateEvent = z.infer<typeof strategyStateEventSchema>;
export const contextStatusSchema = z.enum([
  "UNAVAILABLE",
  "WEAK",
  "NEUTRAL",
  "STRONG",
  "STALE",
]);
export type ContextStatus = z.infer<typeof contextStatusSchema>;
export const CONTEXT_SCORE_VERSION = "context-score-v2";
export const contextScoreComponentSchema = z
  .object({
    key: z.enum(["SESSION_RELATIVE_STRENGTH", "ROLLING_RELATIVE_STRENGTH"]),
    horizon: z.enum(["SESSION_FROM_OPEN", "ROLLING_5_MINUTES"]),
    candidateValue: z.number().nullable(),
    benchmarkValue: z.number().nullable(),
    observedDifference: z.number().nullable(),
    score: z.number().int().min(0).max(100).default(50),
    available: z.boolean().default(false),
    missingDataFlags: z.array(z.string()).default([]),
  })
  .strict();
export type ContextScoreComponent = z.infer<typeof contextScoreComponentSchema>;
export const contextEvaluationSchema = z
  .object({
    kind: z.literal("CONTEXT"),
    // Context evidence must remain in the same market book as the feature
    // snapshot it explains. The default keeps legacy TSX rows readable.
    marketId: marketIdSchema.default("CA_TSX"),
    instrumentId: z.string().uuid(),
    symbol: z.string().min(1),
    timestamp: z.string().datetime(),
    profileId: z.string().uuid(),
    profileName: z.string().min(1),
    signal: contextSignalNameSchema,
    signalVersion: z.literal("1.0.0"),
    configVersion: z.string().min(1),
    status: contextStatusSchema,
    contextScore: z.number().int().min(0).max(100),
    contextScoreVersion: z.string().min(1).default("legacy-context-v1"),
    contextScoreComponents: z.array(contextScoreComponentSchema).default([]),
    missingDataFlags: z.array(z.string()).default([]),
    observedValue: z.number().nullable(),
    benchmarkSymbol: z.string().nullable(),
    benchmarkValue: z.number().nullable(),
    benchmarkTimestamp: z.string().datetime().nullable(),
    lookback: z.literal("SESSION_FROM_OPEN"),
    reasonCodes: z.array(z.string()),
    featureSnapshot: featureSnapshotSchema,
  })
  .strict();
export type ContextEvaluation = z.infer<typeof contextEvaluationSchema>;
/**
 * Phase 4 initial ranking policy. Setup state comes first, then the setup score,
 * then the context score purely as a deterministic tie-breaker, then freshness and
 * symbol. Context can reorder two otherwise identical setups; it can never move a
 * setup between states or past a hard data, spread, session, or structure gate.
 */
export const SETUP_STATE_RANK: Record<StrategyState, number> = {
  READY: 0,
  FORMING: 1,
  WATCH: 2,
  INACTIVE: 3,
  INVALIDATED: 4,
  EXPIRED: 5,
  HALTED: 6,
  DATA_STALE: 7,
};
/** A missing, stale, or unavailable context is neutral, never favourable. */
export const NEUTRAL_CONTEXT_SCORE = 50;
export const ACTIVE_RANKING_FORMULA_VERSION = "ranking-tiebreak-v1";
export const rankingFormulaModeSchema = z.enum([
  "TIE_BREAKER",
  "BOUNDED_CONTEXT",
  "SETUP_INTERACTION",
]);
export type RankingFormulaMode = z.infer<typeof rankingFormulaModeSchema>;
export type RankingFormula = {
  version: string;
  mode: RankingFormulaMode;
  contextWeight: number;
  maxContextAdjustment: number;
  strategyWeights?: Partial<Record<StrategyName, number>>;
};
/** The sole active formula. Research formulas remain opt-in and cannot affect the live comparator. */
export const ACTIVE_RANKING_FORMULA: RankingFormula = {
  version: ACTIVE_RANKING_FORMULA_VERSION,
  mode: "TIE_BREAKER",
  contextWeight: 0,
  maxContextAdjustment: 0,
};
export const BOUNDED_CONTEXT_RESEARCH_FORMULA: RankingFormula = {
  version: "ranking-bounded-context-research-v1",
  mode: "BOUNDED_CONTEXT",
  contextWeight: 0.1,
  maxContextAdjustment: 5,
};
export const SETUP_INTERACTION_RESEARCH_FORMULA: RankingFormula = {
  version: "ranking-setup-interaction-research-v1",
  mode: "SETUP_INTERACTION",
  contextWeight: 0,
  maxContextAdjustment: 5,
  strategyWeights: {},
};
export type RankedOpportunity = {
  setup: StrategyEvaluation;
  contextScore: number;
};
export type RankingResearchResult = RankedOpportunity & {
  rankingScore: number;
  contextAdjustment: number;
  rankingFormulaVersion: string;
  correlatedInputFlags: string[];
};
const stateRank = (state: StrategyState): number => SETUP_STATE_RANK[state];
export const compareOpportunities = (
  a: RankedOpportunity,
  b: RankedOpportunity,
): number =>
  stateRank(a.setup.state) - stateRank(b.setup.state) ||
  b.setup.setupScore - a.setup.setupScore ||
  b.contextScore - a.contextScore ||
  Date.parse(b.setup.timestamp) - Date.parse(a.setup.timestamp) ||
  a.setup.symbol.localeCompare(b.setup.symbol) ||
  a.setup.profileId.localeCompare(b.setup.profileId);
/** Mean of the usable context scores for a symbol; unavailable and stale signals are excluded. */
export const contextScoreForSymbol = (
  contexts: ContextEvaluation[],
  symbol: string,
): number => {
  const usable = contexts.filter(
    (value) =>
      value.symbol === symbol &&
      value.status !== "UNAVAILABLE" &&
      value.status !== "STALE",
  );
  if (!usable.length) return NEUTRAL_CONTEXT_SCORE;
  return Math.round(
    usable.reduce((total, value) => total + value.contextScore, 0) /
      usable.length,
  );
};
export const rankOpportunities = (
  setups: StrategyEvaluation[],
  contexts: ContextEvaluation[] = [],
): RankedOpportunity[] =>
  setups
    .map((setup) => ({
      setup,
      contextScore: contextScoreForSymbol(contexts, setup.symbol),
    }))
    .sort(compareOpportunities);

const boundedAdjustment = (value: number, maximum: number): number =>
  Math.max(-maximum, Math.min(maximum, value));
/**
 * Produces research-only ordering projections. State priority remains the first
 * comparator and `setupScore` is retained unchanged. Callers must supply an
 * explicit per-strategy weight for interaction experiments; an omitted weight
 * is neutral rather than silently applying one global bonus.
 */
export const projectRankingResearch = (
  setup: StrategyEvaluation,
  contextScore: number,
  formula: RankingFormula,
): RankingResearchResult => {
  const weight =
    formula.mode === "SETUP_INTERACTION"
      ? (formula.strategyWeights?.[setup.strategy] ?? 0)
      : formula.contextWeight;
  const contextAdjustment =
    formula.mode === "TIE_BREAKER"
      ? 0
      : Math.round(
          boundedAdjustment(
            (contextScore - NEUTRAL_CONTEXT_SCORE) * weight,
            formula.maxContextAdjustment,
          ),
        );
  const keys = new Set(
    setup.scoreExplanation
      .filter((value) => value.points !== 0)
      .map((value) => value.key),
  );
  const correlatedInputFlags = [
    keys.has("RELATIVE_VOLUME") ? "RVOL_PRESENT_IN_SETUP_SCORE" : null,
    keys.has("VWAP_EXTENSION") || setup.reasonCodes.includes("ABOVE_VWAP")
      ? "VWAP_STATE_PRESENT_IN_SETUP_SCORE"
      : null,
    setup.featureSnapshot.changeFromOpenPct !== 0
      ? "PRICE_MOMENTUM_PRESENT_IN_CONTEXT_INPUT"
      : null,
  ].filter((value): value is string => value !== null);
  return {
    setup,
    contextScore,
    rankingScore: Math.max(
      0,
      Math.min(100, setup.setupScore + contextAdjustment),
    ),
    contextAdjustment,
    rankingFormulaVersion: formula.version,
    correlatedInputFlags,
  };
};
export const compareRankingResearch = (
  a: RankingResearchResult,
  b: RankingResearchResult,
): number =>
  stateRank(a.setup.state) - stateRank(b.setup.state) ||
  b.rankingScore - a.rankingScore ||
  b.setup.setupScore - a.setup.setupScore ||
  b.contextScore - a.contextScore ||
  Date.parse(b.setup.timestamp) - Date.parse(a.setup.timestamp) ||
  a.setup.symbol.localeCompare(b.setup.symbol) ||
  a.setup.profileId.localeCompare(b.setup.profileId);
export const researchRankOpportunities = (
  setups: StrategyEvaluation[],
  contexts: ContextEvaluation[],
  formula: RankingFormula,
): RankingResearchResult[] =>
  setups
    .map((setup) =>
      projectRankingResearch(
        setup,
        contextScoreForSymbol(contexts, setup.symbol),
        formula,
      ),
    )
    .sort(compareRankingResearch);
