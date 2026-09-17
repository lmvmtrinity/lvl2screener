import { z } from "zod";
import type { FundedSessionFact } from "./funded-session-driver.js";

const nonnegative = z.number().finite().nonnegative();
const positive = z.number().finite().positive();
const timestamp = z.string().datetime({ offset: true });
const mode = z.enum(["UNCONSTRAINED", "CAPACITY_CONSTRAINED"]);
const latency = nonnegative.int().safe();
const costs = z
  .object({
    entryCommission: nonnegative,
    exitCommission: nonnegative,
    estimatedRegulatoryFees: nonnegative,
    slippageBps: nonnegative,
    currency: z.enum(["CAD", "USD"]),
    brokerPricingVersion: z.string().min(1),
  })
  .strict();
const assumptions = z
  .object({
    positionSize: positive,
    slippageBps: nonnegative,
    feePerTrade: nonnegative,
    stopMethod: z.enum(["STRUCTURAL", "ATR"]),
    atrStopMultiple: positive,
    rewardRiskRatio: positive.nullable(),
    maxQuoteAgeSeconds: nonnegative,
    sessionTimezone: z.string().min(1),
    noonCloseTime: z.string().regex(/^\d{2}:\d{2}$/),
    executionMode: mode.optional(),
    latencyMs: latency.optional(),
    costs: costs.optional(),
    riskBudget: positive.optional(),
    maxNotional: positive.optional(),
    economics: z
      .object({
        minNetRewardRisk: nonnegative,
        minStopFrictionMultiple: nonnegative,
        minTargetFrictionMultiple: nonnegative,
        maxSpreadPct: nonnegative,
      })
      .strict()
      .optional(),
  })
  .strict();
const context = z
  .object({
    displayedSize: nonnegative.optional(),
    openSymbolNotional: nonnegative.optional(),
    openSectorNotional: nonnegative.optional(),
    openPortfolioRisk: nonnegative.optional(),
    maxDisplayedSizeParticipation: positive.max(1).optional(),
    maxSymbolNotional: nonnegative.optional(),
    maxSectorNotional: nonnegative.optional(),
    maxPortfolioRisk: nonnegative.optional(),
    executionMode: mode.optional(),
    latencyMs: latency.optional(),
    strategyKey: z.string().optional(),
    maximumHoldingMinutes: positive.optional(),
    stalledBreakoutMinutes: positive.optional(),
    stalledBreakoutMinProgressR: nonnegative.optional(),
    contexts: z
      .array(
        z
          .object({
            signalKey: z.string(),
            status: z.enum([
              "UNAVAILABLE",
              "WEAK",
              "NEUTRAL",
              "STRONG",
              "STALE",
            ]),
            timestamp,
          })
          .strict(),
      )
      .optional(),
    contextStatus: z
      .enum(["UNAVAILABLE", "WEAK", "NEUTRAL", "STRONG", "STALE"])
      .optional(),
    contextTimestamp: timestamp.optional(),
  })
  .strict();

export const fundedFactSchema: z.ZodType<FundedSessionFact> =
  z.discriminatedUnion("type", [
    z.object({ type: z.literal("CLOCK"), at: timestamp }).strict(),
    z
      .object({
        type: z.literal("CANCEL"),
        at: timestamp,
        orderId: z.string().uuid(),
        reason: z.enum([
          "USER_CANCELLED",
          "SIGNAL_INVALIDATED",
          "SESSION_CLOSED",
          "RISK_VETO",
        ]),
        preSubmissionEventId: z.string().min(1).optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("QUOTE"),
        instrumentId: z.string().uuid(),
        participation: positive.max(1),
        impactBps: nonnegative.max(10000),
        quote: z
          .object({
            timestamp,
            bid: positive,
            ask: positive,
            bidSize: nonnegative.int().safe(),
            askSize: nonnegative.int().safe(),
            dataStatus: z.literal("REALTIME"),
            actionable: z.literal(true),
          })
          .strict(),
      })
      .strict(),
    z
      .object({
        type: z.literal("SIGNAL"),
        instrumentId: z.string().uuid(),
        maximumDebit: positive,
        maximumRisk: nonnegative,
        order: z
          .object({
            orderId: z.string().uuid(),
            submittedAt: timestamp,
            expiresAt: timestamp,
            signal: z
              .object({
                entryReference: positive.nullable(),
                stopReference: positive.nullable(),
                targetReference: positive.nullable(),
                atr14: nonnegative.nullable(),
                signalTimestamp: timestamp,
              })
              .strict(),
            assumptions,
            context: context.optional(),
          })
          .strict(),
      })
      .strict(),
  ]);
export const fundedEnvelopesSchema = z.array(
  z.object({ id: z.string().min(1), fact: fundedFactSchema }).strict(),
);
