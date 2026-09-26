import { z } from "zod";
import { discoveryModeSchema } from "./discovery.js";
import { marketIdSchema } from "./markets.js";

/** Pre-market daily-list seed (`daily-seed-v1`, ADR-018). */
export const dailySeedPickSchema = z.object({
  symbol: z.string().min(1),
  score: z.number(),
  price: z.number(),
  atrPct: z.number(),
  relativeVolume: z.number(),
  closeLocation: z.number(),
  changePct: z.number(),
  aboveSma20: z.boolean(),
  dollarVolume: z.number(),
});
export type DailySeedPick = z.infer<typeof dailySeedPickSchema>;

export const dailySeedSelectionSchema = z.object({
  marketId: marketIdSchema,
  version: z.string().min(1),
  tradingDate: z.string().date(),
  selectedAt: z.string().datetime(),
  poolSize: z.number().int().nonnegative(),
  prefiltered: z.number().int().nonnegative(),
  scored: z.number().int().nonnegative(),
  picks: z.array(dailySeedPickSchema),
  /** Symbol-details and daily-candle requests the selection spent. */
  requests: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().default(0),
});
export type DailySeedSelection = z.infer<typeof dailySeedSelectionSchema>;

export const dailySeedRunStatusSchema = z.enum([
  "APPLIED",
  "PREVIEW",
  "SKIPPED_LIST_PRESENT",
  "NO_PICKS",
  "FAILED",
]);
export type DailySeedRunStatus = z.infer<typeof dailySeedRunStatusSchema>;

export const dailySeedRunResultSchema = z.object({
  status: dailySeedRunStatusSchema,
  selection: dailySeedSelectionSchema.nullable(),
  error: z.string().nullable(),
  finishedAt: z.string().datetime(),
  /** Symbols the run left in (APPLIED) or found on (SKIPPED) the list. */
  symbols: z.array(z.string()).default([]),
});
export type DailySeedRunResult = z.infer<typeof dailySeedRunResultSchema>;

export const dailySeedProgressSchema = z.object({
  phase: z.enum(["POOL", "SNAPSHOTS", "CANDLES", "APPLYING"]),
  checked: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  poolSize: z.number().int().nonnegative(),
  prefiltered: z.number().int().nonnegative(),
  startedAt: z.string().datetime(),
  apply: z.boolean(),
});
export type DailySeedProgress = z.infer<typeof dailySeedProgressSchema>;

/** Early-session rescan (`daily-seed-v2`): a symbol's first-minutes activity. */
export const dailySeedRescanCandidateSchema = z.object({
  symbol: z.string().min(1),
  /** Volume since the open over the mean of the same minutes in prior sessions. */
  relativeVolume: z.number(),
  changeFromOpenPct: z.number(),
  /** Today's open over the previous close; null when either is unavailable. */
  gapPct: z.number().nullable(),
  price: z.number(),
  passed: z.boolean(),
  added: z.boolean(),
});
export type DailySeedRescanCandidate = z.infer<
  typeof dailySeedRescanCandidateSchema
>;

export const dailySeedRescanResultSchema = z.object({
  version: z.string().min(1),
  tradingDate: z.string().date(),
  status: z.enum(["APPLIED", "NO_PICKS", "SKIPPED_LIST_PRESENT", "FAILED"]),
  /** Completed five-minute bars up to this instant were used. */
  barsThrough: z.string().datetime().nullable(),
  thresholds: z.object({
    minimumRelativeVolume: z.number(),
    minimumChangeFromOpenPct: z.number(),
  }),
  poolSize: z.number().int().nonnegative(),
  prefiltered: z.number().int().nonnegative(),
  evaluated: z.number().int().nonnegative(),
  /** The strongest evaluated symbols by relative volume, passing or not. */
  candidates: z.array(dailySeedRescanCandidateSchema),
  added: z.array(z.string()),
  error: z.string().nullable(),
  finishedAt: z.string().datetime(),
});
export type DailySeedRescanResult = z.infer<typeof dailySeedRescanResultSchema>;

export const dailySeedRescanStatusSchema = z.object({
  version: z.string().min(1),
  enabled: z.boolean(),
  runAt: z.string(),
  maxAdds: z.number().int().positive(),
  scheduledAt: z.string().datetime().nullable(),
  latestRunAt: z.string().datetime().nullable(),
  running: z
    .object({
      checked: z.number().int().nonnegative(),
      total: z.number().int().nonnegative(),
      startedAt: z.string().datetime(),
    })
    .nullable(),
  result: dailySeedRescanResultSchema.nullable(),
});
export type DailySeedRescanStatus = z.infer<typeof dailySeedRescanStatusSchema>;

export const dailySeedStatusSchema = z.object({
  marketId: marketIdSchema,
  version: z.string().min(1),
  enabled: z.boolean(),
  runAt: z.string(),
  count: z.number().int().positive(),
  tradingDate: z.string().date(),
  /** Session boundaries for today, null on a non-session day. */
  session: z
    .object({ open: z.string().datetime(), close: z.string().datetime() })
    .nullable(),
  /** Scheduled seed time for today; null when today has no seed window. */
  scheduledAt: z.string().datetime().nullable(),
  /** Last moment a scheduled or retried seed may still run today. */
  latestRunAt: z.string().datetime().nullable(),
  nextRunAt: z.string().datetime().nullable(),
  doneDate: z.string().date().nullable(),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  nextAttemptAt: z.string().datetime().nullable(),
  running: dailySeedProgressSchema.nullable(),
  /** Today's latest applied/skipped/failed outcome, from memory or storage. */
  lastResult: dailySeedRunResultSchema.nullable(),
  /** Today's most recent ranking, from a run or a preview. */
  latestSelection: dailySeedSelectionSchema.nullable(),
  /** Early-session rescan, when configured for this market. */
  rescan: dailySeedRescanStatusSchema.nullable().default(null),
});
export type DailySeedStatus = z.infer<typeof dailySeedStatusSchema>;

export const dailySeedHistoryEntrySchema = z.object({
  id: z.string().uuid(),
  marketId: marketIdSchema,
  tradingDate: z.string().date(),
  trigger: z.enum(["SCHEDULE", "MANUAL"]),
  status: z.enum(["APPLIED", "SKIPPED_LIST_PRESENT", "NO_PICKS", "FAILED"]),
  symbols: z.array(z.string()),
  pickCount: z.number().int().nonnegative(),
  error: z.string().nullable(),
  finishedAt: z.string().datetime(),
  /** Symbols the early-session rescan added that day. */
  rescanSymbols: z.array(z.string()).default([]),
  /** Outcomes for the rescan's symbols alone; null until the close. */
  rescanOutcomes: z
    .object({
      readySymbols: z.number().int().nonnegative(),
      paperTrades: z.number().int().nonnegative(),
      paperNetR: z.number().nullable(),
    })
    .nullable()
    .default(null),
  /** Session outcomes for `symbols`; null until the session has closed. */
  outcomes: z
    .object({
      readySymbols: z.number().int().nonnegative(),
      paperTrades: z.number().int().nonnegative(),
      paperNetR: z.number().nullable(),
    })
    .nullable(),
});
export type DailySeedHistoryEntry = z.infer<typeof dailySeedHistoryEntrySchema>;

export const dailySeedHistorySchema = z.object({
  entries: z.array(dailySeedHistoryEntrySchema),
});

/** Frozen full-catalog discovery engine facts (ADR-018). */
export const dailySeedLegacySchema = z.object({
  markets: z.array(
    z.object({
      marketId: marketIdSchema,
      mode: discoveryModeSchema.nullable(),
      firstRunAt: z.string().datetime().nullable(),
      lastRunAt: z.string().datetime().nullable(),
      poolSize: z.number().int().nonnegative().nullable(),
    }),
  ),
  evaluationsEstimate: z.number().int().nonnegative(),
  decisions: z.number().int().nonnegative(),
  retainedBytes: z.number().int().nonnegative(),
  mappingsRefreshedAt: z.string().datetime().nullable(),
});
export type DailySeedLegacy = z.infer<typeof dailySeedLegacySchema>;
