import { z } from "zod";
import { marketIdSchema } from "./markets.js";

/**
 * Shared contracts for immutable funded decision evidence (FP01).
 *
 * These schemas are browser-safe: they contain no Node-only imports and never
 * compute digests. Canonical hashing and digest verification live in the API
 * boundary that owns the database (`funded-evidence-digest.ts`).
 */

const isoDateTime = z.string().datetime({ offset: true });
const contentDigest = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const nonnegative = finite.min(0);
const positive = finite.positive();
const safeCount = z.number().int().safe().nonnegative();

/** Market and native currency are paired, never inferred. */
const marketCurrency = {
  marketId: marketIdSchema,
  currency: z.enum(["CAD", "USD"]),
} as const;

function marketCurrencyMatches(value: {
  marketId: "CA_TSX" | "US_EQUITIES";
  currency: "CAD" | "USD";
}): boolean {
  return value.marketId === "CA_TSX"
    ? value.currency === "CAD"
    : value.currency === "USD";
}

/**
 * Evidence schema version. Version 1 rows were captured before the exact
 * requested capital constraints and the durable decision boundary were
 * retained; they are immutable and remain unavailable to FP02 rather than
 * being rewritten or defaulted. Version 2 is the only capturable version.
 */
export const FUNDED_DECISION_EVIDENCE_SCHEMA_VERSION = 2;

export const fundedSourceKindSchema = z.enum([
  "LIVE_PAPER",
  "HISTORICAL_REPLAY",
]);
export type FundedSourceKind = z.infer<typeof fundedSourceKindSchema>;

export const fundedDecisionActionSchema = z.enum([
  "SUBMIT",
  "DECLINE",
  "DEFER",
]);
export type FundedDecisionAction = z.infer<typeof fundedDecisionActionSchema>;

export const fundedOutcomeStatusSchema = z.enum([
  "DECISION_ACCEPTED",
  "POLICY_DECLINED",
  "POLICY_DEFERRED",
  "RISK_VETOED",
  "EXPIRED",
  "NO_EXECUTABLE_QUOTE",
  "NO_FILL",
  "PARTIAL_FILL",
  "FILLED",
  "CLOSED",
  "UNRESOLVED",
]);
export type FundedOutcomeStatus = z.infer<typeof fundedOutcomeStatusSchema>;

/**
 * Identity of one funded decision. The database owns `decisionSequence`; the
 * capture boundary allocates it under the funded-run lock and returns it.
 */
export const fundedDecisionEvidenceIdentitySchema = z
  .object({
    ...marketCurrency,
    accountId: z.string().min(1),
    runId: z.string().min(1),
    observationId: z.string().min(1),
    decisionSequence: safeCount.positive(),
    fundedPolicyVersion: z.string().min(1),
    executionModelVersion: z.string().min(1),
    featureVersion: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!marketCurrencyMatches(value))
      ctx.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Currency does not match the funded market",
      });
  });
export type FundedDecisionEvidenceIdentity = z.infer<
  typeof fundedDecisionEvidenceIdentitySchema
>;

/** An absent decision-time value is explicit, never zero, false or defaulted. */
const unavailable = z
  .object({ status: z.literal("UNAVAILABLE"), reason: z.string().min(1) })
  .strict();

export const fundedQuoteSnapshotSchema = z
  .object({
    timestamp: isoDateTime,
    bid: positive,
    ask: positive,
    bidSize: nonnegative,
    askSize: nonnegative,
    /** Confirmed provider unit semantics; null when legacy evidence cannot prove it. */
    sizeUnit: z.enum(["SHARES", "BOARD_LOTS", "UNKNOWN"]).nullable(),
    sizeMultiplier: nonnegative.nullable(),
    dataStatus: z.enum(["REALTIME", "DELAYED", "HALTED"]),
    actionable: z.boolean(),
  })
  .strict();
export type FundedQuoteSnapshot = z.infer<typeof fundedQuoteSnapshotSchema>;

export const fundedDecisionQuoteSchema = z.discriminatedUnion("status", [
  unavailable,
  z
    .object({
      status: z.literal("AVAILABLE"),
      snapshot: fundedQuoteSnapshotSchema,
    })
    .strict(),
]);
export type FundedDecisionQuote = z.infer<typeof fundedDecisionQuoteSchema>;

export const fundedDecisionModelSchema = z.discriminatedUnion("status", [
  unavailable,
  z
    .object({
      status: z.literal("AVAILABLE"),
      modelId: z.string().min(1),
      modelVersion: z.string().min(1),
      strategyName: z.string().min(1),
      prediction: finite,
      inputDigest: contentDigest,
      predictionAt: isoDateTime,
    })
    .strict(),
]);
export type FundedDecisionModel = z.infer<typeof fundedDecisionModelSchema>;

export const fundedContextEntrySchema = z
  .object({
    signalKey: z.string().min(1),
    status: z.enum(["UNAVAILABLE", "WEAK", "NEUTRAL", "STRONG", "STALE"]),
    timestamp: isoDateTime,
  })
  .strict();
export type FundedContextEntry = z.infer<typeof fundedContextEntrySchema>;

export const fundedDecisionContextSchema = z.discriminatedUnion("status", [
  unavailable,
  z
    .object({
      status: z.literal("AVAILABLE"),
      contexts: z.array(fundedContextEntrySchema),
      contextStatus: z
        .enum(["UNAVAILABLE", "WEAK", "NEUTRAL", "STRONG", "STALE"])
        .nullable(),
      contextTimestamp: isoDateTime.nullable(),
    })
    .strict(),
]);
export type FundedDecisionContext = z.infer<typeof fundedDecisionContextSchema>;

/**
 * Decision-time portfolio state. An absent value is never zero or false.
 * `cooldownActive` and `consecutiveStops` are null when the bound policy has no
 * portfolio control that defines them; they are never defaulted to `false`/0.
 */
export const fundedDecisionPortfolioSchema = z.discriminatedUnion("status", [
  unavailable,
  z
    .object({
      status: z.literal("AVAILABLE"),
      cash: nonnegative,
      reservedCash: nonnegative,
      openRisk: nonnegative,
      reservedRisk: nonnegative,
      positionCount: safeCount,
      sectorExposure: z.record(z.string(), nonnegative).nullable(),
      dailyPnl: finite,
      entriesAllowed: z.boolean(),
      cooldownActive: z.boolean().nullable(),
      consecutiveStops: safeCount.nullable(),
    })
    .strict(),
]);
export type FundedDecisionPortfolio = z.infer<
  typeof fundedDecisionPortfolioSchema
>;

export const fundedExecutionCostsSchema = z
  .object({
    entryCommission: nonnegative,
    exitCommission: nonnegative,
    estimatedRegulatoryFees: nonnegative,
    slippageBps: nonnegative,
    currency: z.enum(["CAD", "USD"]),
    brokerPricingVersion: z.string().min(1),
  })
  .strict();
export type FundedExecutionCosts = z.infer<typeof fundedExecutionCostsSchema>;

/**
 * The funded execution subject only to the mandatory positive-target
 * invariant uses zero thresholds (`MANDATORY_ECONOMICS_GATES`), so the
 * evidence contract must accept valid nonnegative gate values instead of
 * suppressing the opportunity through an evidence-capture failure.
 */
export const fundedEconomicsGatesSchema = z
  .object({
    minNetRewardRisk: nonnegative,
    minStopFrictionMultiple: nonnegative,
    minTargetFrictionMultiple: nonnegative,
    maxSpreadPct: nonnegative,
  })
  .strict();
export type FundedEconomicsGates = z.infer<typeof fundedEconomicsGatesSchema>;

/**
 * Exact execution inputs actually used. Optional legacy fields are nullable,
 * never silently defaulted; `null` records that the snapshot did not carry them.
 */
export const fundedExecutionAssumptionsSchema = z
  .object({
    positionSize: positive,
    slippageBps: nonnegative,
    feePerTrade: nonnegative,
    costs: fundedExecutionCostsSchema.nullable(),
    riskBudget: nonnegative.nullable(),
    maxNotional: nonnegative.nullable(),
    economics: fundedEconomicsGatesSchema.nullable(),
    stopMethod: z.enum(["STRUCTURAL", "ATR"]),
    atrStopMultiple: positive,
    rewardRiskRatio: positive.nullable(),
    maxQuoteAgeSeconds: positive,
    sessionTimezone: z.string().min(1),
    noonCloseTime: z.string().min(1),
    executionMode: z.enum(["UNCONSTRAINED", "CAPACITY_CONSTRAINED"]).nullable(),
    latencyMs: safeCount.nullable(),
    evidenceScope: z.string().min(1).nullable(),
  })
  .strict();
export type FundedExecutionAssumptions = z.infer<
  typeof fundedExecutionAssumptionsSchema
>;

/** Funded sizing context actually passed to the execution path. */
export const fundedSizingContextSchema = z
  .object({
    displayedSize: nonnegative.nullable(),
    openSymbolNotional: nonnegative.nullable(),
    openSectorNotional: nonnegative.nullable(),
    openPortfolioRisk: nonnegative.nullable(),
    maxDisplayedSizeParticipation: nonnegative.nullable(),
    maxSymbolNotional: nonnegative.nullable(),
    maxSectorNotional: nonnegative.nullable(),
    maxPortfolioRisk: nonnegative.nullable(),
    executionMode: z.enum(["UNCONSTRAINED", "CAPACITY_CONSTRAINED"]).nullable(),
    latencyMs: safeCount.nullable(),
    strategyKey: z.string().min(1).nullable(),
    maximumHoldingMinutes: positive.nullable(),
    stalledBreakoutMinutes: positive.nullable(),
    stalledBreakoutMinProgressR: nonnegative.nullable(),
  })
  .strict();
export type FundedSizingContext = z.infer<typeof fundedSizingContextSchema>;

export const fundedPortfolioControlSchema = z
  .object({
    version: z.enum(["funded-portfolio-v1", "funded-portfolio-v2"]),
    maxOpenPositions: z.number().int().safe().positive(),
    maxTotalOpenRisk: positive,
    maxSymbolNotional: positive.nullable(),
    maxSectorNotional: positive.nullable(),
    cooldownMinutesAfterStop: safeCount,
    maxConsecutiveStops: z.number().int().safe().positive(),
    requireFreshContext: z.boolean(),
    contextMaxAgeSeconds: positive,
    vetoOnWeakContext: z.boolean(),
    contextRequirement: z
      .enum(["MARKET_ONLY", "MARKET_AND_SECTOR_REQUIRED"])
      .nullable(),
    maximumHoldingMinutes: positive.nullable(),
    maximumHoldingMinutesByStrategy: z.record(z.string(), positive).nullable(),
    stalledBreakoutMinutes: positive.nullable(),
    stalledBreakoutMinProgressR: nonnegative.nullable(),
  })
  .strict();
export type FundedPortfolioControl = z.infer<
  typeof fundedPortfolioControlSchema
>;

/** The exact funded policy applied at decision time. */
export const fundedDecisionPolicySchema = z
  .object({
    projectionVersion: z.literal("funded-cash-v1"),
    participation: positive.max(1),
    impactBps: nonnegative.max(10_000),
    latencyPolicy: z.literal("CAPTURED_PER_ORDER"),
    portfolio: fundedPortfolioControlSchema.nullable(),
  })
  .strict();
export type FundedDecisionPolicy = z.infer<typeof fundedDecisionPolicySchema>;

/**
 * The exact capital constraints supplied to the funded execution path with the
 * signal. These are retained as supplied, never re-derived from later
 * assumptions. A decision with no retained SIGNAL submission (for example a
 * policy DECLINE/DEFER before submission) carries an explicit `UNAVAILABLE`.
 */
export const fundedRequestedCapitalSchema = z.discriminatedUnion("status", [
  unavailable,
  z
    .object({
      status: z.literal("AVAILABLE"),
      maximumDebit: positive,
      maximumRisk: nonnegative,
    })
    .strict(),
]);
export type FundedRequestedCapital = z.infer<
  typeof fundedRequestedCapitalSchema
>;

export const fundedDecisionSignalSchema = z
  .object({
    signalTimestamp: isoDateTime,
    entryReference: positive.nullable(),
    stopReference: positive.nullable(),
    targetReference: positive.nullable(),
    atr14: nonnegative.nullable(),
  })
  .strict();
export type FundedDecisionSignal = z.infer<typeof fundedDecisionSignalSchema>;

/**
 * Immutable decision-time input (the stored `decision_content`). Outcome
 * fields, database-owned sequence and capture time are not part of it.
 */
export const fundedDecisionTimeInputSchema = z
  .object({
    ...marketCurrency,
    accountId: z.string().min(1),
    runId: z.string().min(1),
    observationId: z.string().min(1),
    evidenceSchemaVersion: z.literal(FUNDED_DECISION_EVIDENCE_SCHEMA_VERSION),
    fundedPolicyVersion: z.string().min(1),
    executionModelVersion: z.string().min(1),
    featureVersion: z.string().min(1),
    sourceKind: fundedSourceKindSchema,
    action: fundedDecisionActionSchema,
    /**
     * The exact funded-policy reason for a `DECLINE`/`DEFER` action; null for a
     * submission that was handed to the execution path.
     */
    policyReason: z.string().min(1).nullable(),
    decisionAt: isoDateTime,
    strategyKey: z.string().min(1),
    strategyVersion: z.string().min(1),
    score: z.number().int().min(0).max(100),
    reasonCodes: z.array(z.string().min(1)),
    requestedCapital: fundedRequestedCapitalSchema,
    quote: fundedDecisionQuoteSchema,
    model: fundedDecisionModelSchema,
    portfolio: fundedDecisionPortfolioSchema,
    context: fundedDecisionContextSchema,
    execution: fundedExecutionAssumptionsSchema,
    sizingContext: fundedSizingContextSchema.nullable(),
    policy: fundedDecisionPolicySchema,
    signal: fundedDecisionSignalSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const decisionAt = Date.parse(value.decisionAt);
    if (Date.parse(value.signal.signalTimestamp) > decisionAt)
      ctx.addIssue({
        code: "custom",
        path: ["signal", "signalTimestamp"],
        message: "Signal cannot follow the decision time",
      });
    if (
      value.quote.status === "AVAILABLE" &&
      Date.parse(value.quote.snapshot.timestamp) > decisionAt
    )
      ctx.addIssue({
        code: "custom",
        path: ["quote", "snapshot", "timestamp"],
        message: "Quote cannot follow the decision time",
      });
    if (
      value.model.status === "AVAILABLE" &&
      Date.parse(value.model.predictionAt) > decisionAt
    )
      ctx.addIssue({
        code: "custom",
        path: ["model", "predictionAt"],
        message: "Model prediction cannot follow the decision time",
      });
    if (value.context.status === "AVAILABLE") {
      for (const [index, entry] of value.context.contexts.entries())
        if (Date.parse(entry.timestamp) > decisionAt)
          ctx.addIssue({
            code: "custom",
            path: ["context", "contexts", index, "timestamp"],
            message: "Context cannot follow the decision time",
          });
      if (
        value.context.contextTimestamp !== null &&
        Date.parse(value.context.contextTimestamp) > decisionAt
      )
        ctx.addIssue({
          code: "custom",
          path: ["context", "contextTimestamp"],
          message: "Context cannot follow the decision time",
        });
    }
    // A v2 decision is either a submission with the exact supplied capital or
    // a policy refusal with an exact reason and no fabricated capital. The two
    // halves can never be mixed.
    if (value.action === "SUBMIT") {
      if (value.policyReason !== null)
        ctx.addIssue({
          code: "custom",
          path: ["policyReason"],
          message: "SUBMIT decisions cannot carry a policy reason",
        });
      if (value.requestedCapital.status !== "AVAILABLE")
        ctx.addIssue({
          code: "custom",
          path: ["requestedCapital"],
          message: "SUBMIT decisions require the exact requested capital",
        });
    } else {
      if (value.policyReason === null || value.policyReason.trim() === "")
        ctx.addIssue({
          code: "custom",
          path: ["policyReason"],
          message: "DECLINE/DEFER decisions require an exact policy reason",
        });
      if (value.requestedCapital.status !== "UNAVAILABLE")
        ctx.addIssue({
          code: "custom",
          path: ["requestedCapital"],
          message: "DECLINE/DEFER decisions cannot carry requested capital",
        });
    }
  });
export type FundedDecisionTimeInput = z.infer<
  typeof fundedDecisionTimeInputSchema
>;

const fillFraction = finite.min(0).max(1);

const fillDetail = z
  .object({
    filledFraction: fillFraction,
    filledShares: safeCount,
    requestedShares: safeCount,
    averagePrice: positive,
    fees: nonnegative,
    slippage: nonnegative,
  })
  .strict();

export const fundedOutcomeDetailSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("RISK_VETOED"),
      detail: z.object({ vetoReason: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      status: z.literal("POLICY_DECLINED"),
      detail: z.object({ declineReason: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      status: z.literal("POLICY_DEFERRED"),
      detail: z.object({ deferReason: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      status: z.literal("NO_EXECUTABLE_QUOTE"),
      detail: z.object({ detailReason: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      status: z.literal("NO_FILL"),
      detail: z.object({ noFillReason: z.string().min(1) }).strict(),
    })
    .strict(),
  z.object({ status: z.literal("PARTIAL_FILL"), detail: fillDetail }).strict(),
  z.object({ status: z.literal("FILLED"), detail: fillDetail }).strict(),
  z
    .object({
      status: z.literal("CLOSED"),
      detail: z
        .object({
          filledFraction: fillFraction,
          realizedNetPnl: finite,
          realizedR: finite.nullable(),
        })
        .strict(),
    })
    .strict(),
]);
export type FundedOutcomeDetail = z.infer<typeof fundedOutcomeDetailSchema>;

/**
 * One append-only outcome version. Corrections append a new version that
 * references the superseded sequence; they never update or delete history.
 * `recordedAt` is database-owned; `sourceDigest` is recomputed at the capture
 * boundary from the source identity and content.
 */
export const fundedOutcomeVersionSchema = z
  .object({
    identity: fundedDecisionEvidenceIdentitySchema,
    sequence: safeCount.positive(),
    status: fundedOutcomeStatusSchema,
    availableAt: isoDateTime,
    recordedAt: isoDateTime,
    sourceKind: fundedSourceKindSchema,
    sourceId: z.string().min(1),
    sourceDigest: contentDigest,
    reason: z.string().min(1).nullable(),
    detail: z.unknown().nullable(),
    supersedesSequence: safeCount.positive().nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.recordedAt) < Date.parse(value.availableAt))
      ctx.addIssue({
        code: "custom",
        path: ["recordedAt"],
        message: "Recording cannot precede availability",
      });
    if (value.status === "UNRESOLVED" && !value.reason)
      ctx.addIssue({
        code: "custom",
        path: ["reason"],
        message: "UNRESOLVED requires an explicit reason",
      });
    if (
      value.supersedesSequence !== null &&
      value.supersedesSequence >= value.sequence
    )
      ctx.addIssue({
        code: "custom",
        path: ["supersedesSequence"],
        message: "A correction must supersede an earlier version",
      });
    const detailStatuses = new Set<FundedOutcomeStatus>([
      "POLICY_DECLINED",
      "POLICY_DEFERRED",
      "RISK_VETOED",
      "NO_EXECUTABLE_QUOTE",
      "NO_FILL",
      "PARTIAL_FILL",
      "FILLED",
      "CLOSED",
    ]);
    if (detailStatuses.has(value.status)) {
      const parsed = fundedOutcomeDetailSchema.safeParse({
        status: value.status,
        detail: value.detail,
      });
      if (!parsed.success) {
        ctx.addIssue({
          code: "custom",
          path: ["detail"],
          message: "Detail does not match the outcome status",
        });
        return;
      }
      if (
        (value.status === "PARTIAL_FILL" || value.status === "FILLED") &&
        parsed.data.status === value.status
      ) {
        const detail = parsed.data.detail;
        if (value.status === "PARTIAL_FILL") {
          if (
            detail.filledFraction <= 0 ||
            detail.filledFraction >= 1 ||
            detail.filledShares <= 0 ||
            detail.filledShares >= detail.requestedShares
          )
            ctx.addIssue({
              code: "custom",
              path: ["detail"],
              message:
                "PARTIAL_FILL requires 0 < fraction < 1 and 0 < filledShares < requestedShares",
            });
        } else if (
          detail.filledFraction !== 1 ||
          detail.filledShares !== detail.requestedShares ||
          detail.filledShares <= 0
        )
          ctx.addIssue({
            code: "custom",
            path: ["detail"],
            message:
              "FILLED requires fraction = 1 and filledShares = requestedShares > 0",
          });
      }
      return;
    }
    if (value.detail !== null)
      ctx.addIssue({
        code: "custom",
        path: ["detail"],
        message: "This outcome status carries no detail payload",
      });
  });
export type FundedOutcomeVersion = z.infer<typeof fundedOutcomeVersionSchema>;

/**
 * The isolation components that determine cohort membership. This schema
 * deliberately has no digest field: a caller-supplied runtime `cohortDigest`
 * must never enter the trusted hashing input or the persisted components.
 * Any component change separates cohorts; FP01 does not define a pooling rule.
 */
export const fundedCohortComponentsSchema = z
  .object({
    ...marketCurrency,
    evidenceSchemaVersion: z.literal(FUNDED_DECISION_EVIDENCE_SCHEMA_VERSION),
    fundedPolicyVersion: z.string().min(1),
    portfolioPolicyVersion: z.string().min(1),
    executionModelVersion: z.string().min(1),
    costPolicyVersion: z.string().min(1),
    participationVersion: z.string().min(1),
    sourceKind: fundedSourceKindSchema,
    featureVersion: z.string().min(1),
    runtimeVersion: z.string().min(1),
    accountAssumptionDigest: contentDigest,
    signalModelId: z.string().min(1).nullable(),
    signalModelVersion: z.string().min(1).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!marketCurrencyMatches(value))
      ctx.addIssue({
        code: "custom",
        path: ["currency"],
        message: "Currency does not match the funded market",
      });
    if ((value.signalModelId === null) !== (value.signalModelVersion === null))
      ctx.addIssue({
        code: "custom",
        path: ["signalModelVersion"],
        message: "Signal model identity is all-or-nothing",
      });
  });
export type FundedCohortComponents = z.infer<
  typeof fundedCohortComponentsSchema
>;

/**
 * Compatible cohort identity: the components plus their canonical digest. The
 * digest is computed and verified by the API capture boundary, never by these
 * browser-safe schemas.
 */
export const fundedCohortIdentitySchema = fundedCohortComponentsSchema
  .safeExtend({ cohortDigest: contentDigest })
  .strict();
export type FundedCohortIdentity = z.infer<typeof fundedCohortIdentitySchema>;
