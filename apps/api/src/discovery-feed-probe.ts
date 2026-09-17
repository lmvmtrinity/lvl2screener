/**
 * ADR-017 Stage A: one bounded CA_TSX REST-only feed-capability attempt, per
 * execution plan section 15.10.6. The runner never retries, never changes the
 * shared budget or pacing, never uses streaming, and writes a result even when
 * the attempt is blocked, skipped or stopped. It is a bounded feed probe: not
 * synthetic capacity evidence and not a commissioning session.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { EncryptedPostgresRefreshTokenStore } from "./market-data/postgres-token-store.js";
import { zonedSessionBoundary } from "./paper-bot/session-time.js";
import { normalizeExchange } from "./questrade/exchange.js";
import {
  LiveQuestradeTransport,
  QuestradeHttpError,
} from "./questrade/live-transport.js";
import { PostgresRequestBudget } from "./questrade/postgres-request-budget.js";
import {
  QuestradeQueueError,
  QuestradeRateLimiter,
} from "./questrade/rate-limiter.js";
import type { QuestradeRequestObservation } from "./questrade/request-observation.js";
import { parseMasterKey } from "./questrade/token-crypto.js";
import { QuestradeTokenManager } from "./questrade/token-manager.js";
import type { RawCandle, RawQuote, RawSymbol } from "./questrade/types.js";
import { getRecentRegularSessions } from "./universe/market-calendar.js";

export const FEED_PROBE_SCHEMA_VERSION = "discovery-feed-probe-attempt-v1";
export const FEED_PROBE_PREFLIGHT_VERSION = "discovery-feed-probe-preflight-v1";
const QUOTE_OFFSETS_MS = [5_000, 20_000, 35_000] as const;
const CANDLE_OFFSETS_MS = [
  6_000, 7_000, 8_000, 9_000, 10_000, 36_000, 37_000, 38_000, 39_000, 40_000,
] as const;

const preflightSymbolSchema = z
  .object({
    code: z.string().min(1),
    providerSymbol: z.string().min(1),
    symbolId: z.number().int().positive(),
  })
  .strict();
export const feedProbePreflightSchema = z
  .object({
    schemaVersion: z.literal(FEED_PROBE_PREFLIGHT_VERSION),
    market: z.literal("CA_TSX"),
    sessionDate: z.string().date(),
    boundaryLocal: z.string().regex(/^\d{2}:\d{2}$/),
    timezone: z.literal("America/Toronto"),
    boundaryUtc: z.string().datetime(),
    expiryUtc: z.string().datetime(),
    symbols: z.array(preflightSymbolSchema).length(5),
    sourceRevision: z.string().min(1),
    dispatchToleranceMs: z.literal(2_000),
    responseTimeoutMs: z.literal(10_000),
    hardRequestCap: z.literal(30),
    discoverySpacingMs: z.literal(1_000),
    discoveryHourCap: z.literal(1_800),
    monitoringReserveHour: z.literal(6_000),
  })
  .strict();
export type FeedProbePreflight = z.infer<typeof feedProbePreflightSchema>;

export interface PlannedRequest {
  sequence: number;
  kind: "QUOTE" | "CANDLE";
  label: string;
  offsetMs: number;
  symbolIndex: number | null;
}

export interface WireRecord {
  at: string;
  url: string;
  status: number;
  bytes: number;
  digest: string;
  text: string;
}

export interface HeaderRecord {
  at: string;
  status: number;
  remaining: string | null;
  reset: string | null;
}

export interface ProbeSessionInfo {
  apiServer: string;
  expiresAt: string;
}

export interface CallOutcome<T> {
  value: T | null;
  outcome: "COMPLETED" | "FAILED" | "TIMEOUT";
  error: string | null;
  queuedAt: string | null;
  dispatchedAt: string | null;
  settledAt: string | null;
  queueWaitMs: number | null;
  executionMs: number | null;
}

export type ProbePerform = <T>(
  label: string,
  kind: "IDENTITY" | "QUOTE" | "CANDLE",
  requestedItems: number,
  operation: () => Promise<T>,
) => Promise<CallOutcome<T>>;

export interface FeedProbeDeps {
  now(): Date;
  sleep(ms: number): Promise<void>;
  connect(): Promise<ProbeSessionInfo>;
  perform: ProbePerform;
  search(prefix: string): Promise<RawSymbol[]>;
  quotes(symbolIds: number[]): Promise<RawQuote[]>;
  candles(
    symbolId: number,
    startTime: Date,
    endTime: Date,
  ): Promise<RawCandle[]>;
  wire(): WireRecord[];
  rateLimitHeaders(): HeaderRecord[];
  limiterCounts(): Record<string, unknown> | null;
  writeFile(name: string, content: string): void;
}

export interface ProbeCallRecord {
  sequence: number;
  label: string;
  kind: "IDENTITY" | "QUOTE" | "CANDLE";
  symbolIndex: number | null;
  plannedOffsetMs: number | null;
  plannedAt: string | null;
  queuedAt: string | null;
  dispatchedAt: string | null;
  settledAt: string | null;
  offsetErrorMs: number | null;
  outcome: "COMPLETED" | "FAILED" | "TIMEOUT" | "NOT_ATTEMPTED" | "EXPIRED";
  error: string | null;
  requestedItems: number;
  queueWaitMs: number | null;
  executionMs: number | null;
}

export interface QuoteSymbolObservation {
  code: string;
  providerSymbol: string;
  symbolId: number;
  returned: boolean;
  delay: boolean | number | null;
  isHalted: boolean | null;
  lastTradeTime: string | null;
  lastTradeAgeMs: number | null;
}

export interface QuoteRead {
  readIndex: number;
  plannedOffsetMs: number;
  settledAt: string | null;
  symbols: QuoteSymbolObservation[];
  delayStop: boolean;
}

export interface BarObservation {
  code: string;
  symbolId: number;
  readIndex: number;
  targetStart: string;
  targetEnd: string;
  present: boolean;
  ohlcv: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  } | null;
}

export interface IdentityOutcome {
  code: string;
  providerSymbol: string;
  symbolId: number;
  matches: number;
  resolvedSymbolId: number | null;
  resolvedExchange: string | null;
  resolvedCurrency: string | null;
  accepted: boolean;
  reason: string | null;
}

export interface FeedProbeAcceptance {
  checks: {
    allCallsCompleted: boolean;
    noWireErrors: boolean;
    quotesKnownDelayAllReads: boolean;
    barsPresentBothReads: boolean;
    barsStableAcrossReads: boolean;
    dispatchWithinTolerance: boolean;
    completedBeforeExpiry: boolean;
    requestCapRespected: boolean;
    identityVerified: boolean;
  };
  passed: boolean;
}

export interface FeedProbeResult {
  schemaVersion: typeof FEED_PROBE_SCHEMA_VERSION;
  attemptId: string;
  market: "CA_TSX";
  imageId: string;
  startedAt: string;
  completedAt: string;
  status:
    | "COMPLETED_ACCEPTED"
    | "COMPLETED_NOT_ACCEPTED"
    | "STOPPED"
    | "BLOCKED"
    | "SKIPPED";
  reason: string;
  preflight: FeedProbePreflight;
  preflightDigest: string;
  preflightPath: string;
  boundaryUtc: string;
  expiryUtc: string;
  tradingDay: boolean;
  liveMode: boolean;
  session: ProbeSessionInfo | null;
  identity: IdentityOutcome[];
  calls: ProbeCallRecord[];
  quoteReads: QuoteRead[];
  bars: BarObservation[];
  wire: WireRecord[];
  rateLimitHeaders: HeaderRecord[];
  limiterCounts: Record<string, unknown> | null;
  acceptance: FeedProbeAcceptance | null;
  blockers: string[];
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function buildObservationPlan(): Omit<PlannedRequest, "sequence">[] {
  const plan: Omit<PlannedRequest, "sequence">[] = QUOTE_OFFSETS_MS.map(
    (offsetMs, index) => ({
      kind: "QUOTE" as const,
      label: `quote-read-${index + 1}`,
      offsetMs,
      symbolIndex: null,
    }),
  );
  CANDLE_OFFSETS_MS.forEach((offsetMs, index) => {
    const readIndex = index < 5 ? 1 : 2;
    const symbolIndex = index % 5;
    plan.push({
      kind: "CANDLE",
      label: `candle-read-${readIndex}-symbol-${symbolIndex}`,
      offsetMs,
      symbolIndex,
    });
  });
  return plan.sort((left, right) => left.offsetMs - right.offsetMs);
}

function describeError(error: unknown): string {
  if (error instanceof QuestradeHttpError)
    return `HTTP_${error.status}:${error.message.slice(0, 120)}`;
  if (error instanceof QuestradeQueueError) return `QUEUE_${error.code}`;
  if (error instanceof Error)
    return `${error.name}:${error.message.slice(0, 120)}`;
  return String(error).slice(0, 120);
}

function delayStop(delay: boolean | number | null): boolean {
  if (delay === false || delay === 0) return false;
  return true;
}

async function waitUntil(
  deps: FeedProbeDeps,
  target: Date,
  limit: Date,
): Promise<void> {
  while (deps.now().getTime() < target.getTime()) {
    const stopAt = Math.min(target.getTime(), limit.getTime());
    const remaining = stopAt - deps.now().getTime();
    if (remaining <= 0) return;
    await deps.sleep(Math.min(250, remaining));
  }
}

function timingFrom(observations: QuestradeRequestObservation[]): {
  queuedAt: string | null;
  dispatchedAt: string | null;
  settledAt: string | null;
  queueWaitMs: number | null;
  executionMs: number | null;
} {
  const queued = observations.find((event) => event.phase === "QUEUED");
  const dispatched = observations.find((event) => event.phase === "DISPATCHED");
  const settled = observations.find((event) => event.phase === "SETTLED");
  return {
    queuedAt: queued?.at.toISOString() ?? null,
    dispatchedAt: dispatched?.at.toISOString() ?? null,
    settledAt: settled?.at.toISOString() ?? null,
    queueWaitMs: settled?.queueWaitMs ?? null,
    executionMs: settled?.executionMs ?? null,
  };
}

/** Live scheduler-backed call runner. Exactly one attempt per call: a failure
 * is returned, never retried, and a 10-second race marks a timeout. */
export function createLivePerform(options: {
  attemptId: string;
  expiresAt: Date;
  signal: AbortSignal;
  responseTimeoutMs: number;
  schedule: (
    label: string,
    kind: "IDENTITY" | "QUOTE" | "CANDLE",
    requestedItems: number,
    operation: () => Promise<unknown>,
    observer: (event: QuestradeRequestObservation) => void,
  ) => Promise<unknown>;
}): ProbePerform {
  return async <T>(
    label: string,
    kind: "IDENTITY" | "QUOTE" | "CANDLE",
    requestedItems: number,
    operation: () => Promise<T>,
  ): Promise<CallOutcome<T>> => {
    const observations: QuestradeRequestObservation[] = [];
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("PROBE_RESPONSE_TIMEOUT")),
        options.responseTimeoutMs,
      );
      timer.unref?.();
    });
    let value: unknown = null;
    let error: string | null = null;
    let outcome: CallOutcome<unknown>["outcome"] = "COMPLETED";
    try {
      value = await Promise.race([
        options.schedule(label, kind, requestedItems, operation, (event) =>
          observations.push(event),
        ),
        timeout,
      ]);
    } catch (caught) {
      error = describeError(caught);
      outcome = error === "Error:PROBE_RESPONSE_TIMEOUT" ? "TIMEOUT" : "FAILED";
    } finally {
      if (timer) clearTimeout(timer);
    }
    return {
      value: value as T | null,
      outcome,
      error,
      ...timingFrom(observations),
    };
  };
}

export function evaluateProbeAcceptance(
  result: Pick<
    FeedProbeResult,
    | "calls"
    | "wire"
    | "quoteReads"
    | "bars"
    | "identity"
    | "boundaryUtc"
    | "expiryUtc"
  > & { completedAt: string },
): FeedProbeAcceptance {
  const marketDataWire = result.wire;
  const attempted = result.calls.filter(
    (call) => call.outcome !== "NOT_ATTEMPTED",
  );
  const expectedBars = result.identity.length * 2;
  const barsPresentBothReads =
    result.identity.length > 0 &&
    result.bars.length === expectedBars &&
    result.bars.every((bar) => bar.present);
  const barKey = (bar: BarObservation) => `${bar.symbolId}:${bar.readIndex}`;
  const barByKey = new Map(result.bars.map((bar) => [barKey(bar), bar]));
  const barsStableAcrossReads =
    barsPresentBothReads &&
    result.identity.every((symbol) => {
      const first = barByKey.get(`${symbol.symbolId}:1`);
      const second = barByKey.get(`${symbol.symbolId}:2`);
      return (
        first?.ohlcv !== null &&
        second?.ohlcv !== null &&
        first?.ohlcv !== undefined &&
        second?.ohlcv !== undefined &&
        first.ohlcv.open === second.ohlcv.open &&
        first.ohlcv.high === second.ohlcv.high &&
        first.ohlcv.low === second.ohlcv.low &&
        first.ohlcv.close === second.ohlcv.close &&
        first.ohlcv.volume === second.ohlcv.volume
      );
    });
  const checks = {
    allCallsCompleted:
      attempted.length > 0 &&
      attempted.every((call) => call.outcome === "COMPLETED"),
    noWireErrors:
      marketDataWire.length > 0 &&
      marketDataWire.every(
        (record) => record.status >= 200 && record.status < 300,
      ),
    quotesKnownDelayAllReads:
      result.quoteReads.length === QUOTE_OFFSETS_MS.length &&
      result.quoteReads.every(
        (read) =>
          read.symbols.length === result.identity.length &&
          read.symbols.every(
            (symbol) =>
              symbol.returned && (symbol.delay === false || symbol.delay === 0),
          ),
      ),
    barsPresentBothReads,
    barsStableAcrossReads,
    dispatchWithinTolerance: attempted.every(
      (call) => (call.offsetErrorMs ?? 0) <= 2_000,
    ),
    completedBeforeExpiry:
      Date.parse(result.completedAt) <= Date.parse(result.expiryUtc) &&
      attempted.every(
        (call) =>
          call.settledAt === null ||
          Date.parse(call.settledAt) <= Date.parse(result.expiryUtc),
      ),
    requestCapRespected: attempted.length <= 30,
    identityVerified:
      result.identity.length === 5 &&
      result.identity.every((symbol) => symbol.accepted),
  };
  return {
    checks,
    passed: Object.values(checks).every(Boolean),
  };
}

export async function runFeedProbeAttempt(input: {
  preflight: FeedProbePreflight;
  preflightDigest: string;
  preflightPath: string;
  attemptId: string;
  imageId: string;
  liveMode: boolean;
  tradingDay: boolean;
  deps: FeedProbeDeps;
}): Promise<FeedProbeResult> {
  const { preflight, deps } = input;
  const startedAt = deps.now().toISOString();
  const boundary = new Date(preflight.boundaryUtc);
  const expiry = new Date(preflight.expiryUtc);
  const calls: ProbeCallRecord[] = [];
  const quoteReads: QuoteRead[] = [];
  const bars: BarObservation[] = [];
  const identity: IdentityOutcome[] = [];
  const blockers: string[] = [];
  let status: FeedProbeResult["status"] = "COMPLETED_NOT_ACCEPTED";
  let reason = "COMPLETED";
  let stop = false;
  let session: ProbeSessionInfo | null = null;
  let stopReason: string | null = null;
  const finish = (): FeedProbeResult => {
    const completedAt = deps.now().toISOString();
    const result: FeedProbeResult = {
      schemaVersion: FEED_PROBE_SCHEMA_VERSION,
      attemptId: input.attemptId,
      market: "CA_TSX",
      imageId: input.imageId,
      startedAt,
      completedAt,
      status,
      reason: stopReason ?? reason,
      preflight,
      preflightDigest: input.preflightDigest,
      preflightPath: input.preflightPath,
      boundaryUtc: preflight.boundaryUtc,
      expiryUtc: preflight.expiryUtc,
      tradingDay: input.tradingDay,
      liveMode: input.liveMode,
      session,
      identity,
      calls,
      quoteReads,
      bars,
      wire: deps.wire(),
      rateLimitHeaders: deps.rateLimitHeaders(),
      limiterCounts: deps.limiterCounts(),
      acceptance: null,
      blockers,
    };
    if (status === "COMPLETED_ACCEPTED" || status === "COMPLETED_NOT_ACCEPTED")
      result.acceptance = evaluateProbeAcceptance(result);
    deps.writeFile("attempt.json", `${JSON.stringify(result, null, 2)}\n`);
    return result;
  };

  if (!input.liveMode || !input.tradingDay) {
    status = "BLOCKED";
    stopReason = input.liveMode ? "NOT_A_TRADING_DAY" : "NOT_LIVE_MODE";
    return finish();
  }
  if (deps.now().getTime() >= expiry.getTime()) {
    status = "SKIPPED";
    stopReason = "WINDOW_ELAPSED";
    return finish();
  }
  if (deps.now().getTime() > boundary.getTime() - 60_000) {
    status = "BLOCKED";
    stopReason = "INSUFFICIENT_PREFLIGHT_LEAD";
    return finish();
  }

  try {
    session = await deps.connect();
  } catch (error) {
    status = "BLOCKED";
    stopReason = `SESSION_UNAVAILABLE:${describeError(error)}`;
    return finish();
  }

  // Identity preflight: exactly one exact-symbol match per frozen symbol; no
  // substitutes, no added requests.
  for (const symbol of preflight.symbols) {
    if (stop) break;
    if (deps.now().getTime() >= expiry.getTime()) {
      calls.push({
        sequence: calls.length + 1,
        label: `identity-${symbol.code}`,
        kind: "IDENTITY",
        symbolIndex: preflight.symbols.indexOf(symbol),
        plannedOffsetMs: null,
        plannedAt: null,
        queuedAt: null,
        dispatchedAt: null,
        settledAt: null,
        offsetErrorMs: null,
        outcome: "EXPIRED",
        error: null,
        requestedItems: 1,
        queueWaitMs: null,
        executionMs: null,
      });
      stop = true;
      stopReason = "EXPIRY_DURING_IDENTITY";
      break;
    }
    const call = await deps.perform(
      `identity-${symbol.code}`,
      "IDENTITY",
      1,
      () => deps.search(symbol.code),
    );
    calls.push({
      sequence: calls.length + 1,
      label: `identity-${symbol.code}`,
      kind: "IDENTITY",
      symbolIndex: preflight.symbols.indexOf(symbol),
      plannedOffsetMs: null,
      plannedAt: null,
      queuedAt: call.queuedAt,
      dispatchedAt: call.dispatchedAt,
      settledAt: call.settledAt,
      offsetErrorMs: null,
      outcome: call.outcome,
      error: call.error,
      requestedItems: 1,
      queueWaitMs: call.queueWaitMs,
      executionMs: call.executionMs,
    });
    if (call.outcome !== "COMPLETED" || call.value === null) {
      identity.push({
        code: symbol.code,
        providerSymbol: symbol.providerSymbol,
        symbolId: symbol.symbolId,
        matches: 0,
        resolvedSymbolId: null,
        resolvedExchange: null,
        resolvedCurrency: null,
        accepted: false,
        reason: call.error ?? "IDENTITY_REQUEST_FAILED",
      });
      stop = true;
      stopReason = "IDENTITY_REQUEST_FAILED";
      break;
    }
    const matches = call.value.filter(
      (candidate) => candidate.symbol === symbol.providerSymbol,
    );
    const match = matches[0] ?? null;
    const exchange = match ? normalizeExchange(match.listingExchange) : null;
    const currency = match?.currency?.toUpperCase() ?? null;
    const accepted =
      matches.length === 1 &&
      match !== null &&
      match.symbolId === symbol.symbolId &&
      exchange === "TSX" &&
      currency === "CAD" &&
      match.isQuotable &&
      match.isTradable;
    identity.push({
      code: symbol.code,
      providerSymbol: symbol.providerSymbol,
      symbolId: symbol.symbolId,
      matches: matches.length,
      resolvedSymbolId: match?.symbolId ?? null,
      resolvedExchange: exchange,
      resolvedCurrency: currency,
      accepted,
      reason: accepted
        ? null
        : matches.length === 0
          ? "NO_EXACT_MATCH"
          : matches.length > 1
            ? "AMBIGUOUS"
            : "UNSUPPORTED",
    });
    if (!accepted) {
      stop = true;
      stopReason = `IDENTITY_REJECTED:${symbol.code}`;
    }
  }
  if (stop) {
    status = "BLOCKED";
    return finish();
  }
  const symbolIds = preflight.symbols.map((symbol) => symbol.symbolId);

  const plan = buildObservationPlan().map((request, index) => ({
    ...request,
    sequence: index + 1,
  }));
  for (const request of plan) {
    if (stop) {
      calls.push({
        sequence: calls.length + 1,
        label: request.label,
        kind: request.kind,
        symbolIndex: request.symbolIndex,
        plannedOffsetMs: request.offsetMs,
        plannedAt: new Date(
          boundary.getTime() + request.offsetMs,
        ).toISOString(),
        queuedAt: null,
        dispatchedAt: null,
        settledAt: null,
        offsetErrorMs: null,
        outcome: "NOT_ATTEMPTED",
        error: null,
        requestedItems: request.kind === "QUOTE" ? symbolIds.length : 1,
        queueWaitMs: null,
        executionMs: null,
      });
      continue;
    }
    const plannedAt = new Date(boundary.getTime() + request.offsetMs);
    await waitUntil(deps, plannedAt, expiry);
    if (deps.now().getTime() >= expiry.getTime()) {
      calls.push({
        sequence: calls.length + 1,
        label: request.label,
        kind: request.kind,
        symbolIndex: request.symbolIndex,
        plannedOffsetMs: request.offsetMs,
        plannedAt: plannedAt.toISOString(),
        queuedAt: null,
        dispatchedAt: null,
        settledAt: null,
        offsetErrorMs: null,
        outcome: "EXPIRED",
        error: null,
        requestedItems: request.kind === "QUOTE" ? symbolIds.length : 1,
        queueWaitMs: null,
        executionMs: null,
      });
      stop = true;
      stopReason = "EXPIRY_REACHED";
      continue;
    }
    if (request.kind === "QUOTE") {
      const call = await deps.perform(
        request.label,
        "QUOTE",
        symbolIds.length,
        () => deps.quotes(symbolIds),
      );
      const record: ProbeCallRecord = {
        sequence: calls.length + 1,
        label: request.label,
        kind: request.kind,
        symbolIndex: request.symbolIndex,
        plannedOffsetMs: request.offsetMs,
        plannedAt: plannedAt.toISOString(),
        queuedAt: call.queuedAt,
        dispatchedAt: call.dispatchedAt,
        settledAt: call.settledAt,
        offsetErrorMs:
          call.dispatchedAt === null
            ? null
            : Math.abs(Date.parse(call.dispatchedAt) - plannedAt.getTime()),
        outcome: call.outcome,
        error: call.error,
        requestedItems: symbolIds.length,
        queueWaitMs: call.queueWaitMs,
        executionMs: call.executionMs,
      };
      calls.push(record);
      if (call.outcome !== "COMPLETED" || call.value === null) {
        stop = true;
        stopReason =
          call.outcome === "TIMEOUT"
            ? "RESPONSE_TIMEOUT"
            : "FIRST_ERROR:" + (call.error ?? "UNKNOWN");
        continue;
      }
      if (
        record.offsetErrorMs !== null &&
        record.offsetErrorMs > preflight.dispatchToleranceMs
      ) {
        stop = true;
        stopReason = "DISPATCH_OFFSET_EXCEEDED";
        continue;
      }
      const readIndex = calls.filter(
        (entry) => entry.kind === "QUOTE" && entry.outcome === "COMPLETED",
      ).length;
      const observations: QuoteSymbolObservation[] = preflight.symbols.map(
        (symbol) => {
          const quote = call.value!.find(
            (candidate) => candidate.symbolId === symbol.symbolId,
          );
          const lastTradeTime = quote?.lastTradeTime ?? null;
          return {
            code: symbol.code,
            providerSymbol: symbol.providerSymbol,
            symbolId: symbol.symbolId,
            returned: quote !== undefined,
            delay: quote ? quote.delay : null,
            isHalted: quote ? quote.isHalted : null,
            lastTradeTime,
            lastTradeAgeMs:
              lastTradeTime === null || record.settledAt === null
                ? null
                : Date.parse(record.settledAt) - Date.parse(lastTradeTime),
          };
        },
      );
      const read: QuoteRead = {
        readIndex,
        plannedOffsetMs: request.offsetMs,
        settledAt: record.settledAt,
        symbols: observations,
        delayStop: observations.some(
          (symbol) => symbol.returned && delayStop(symbol.delay),
        ),
      };
      quoteReads.push(read);
      if (read.delayStop) {
        stop = true;
        stopReason = "QUOTE_DELAY_OR_UNKNOWN";
      }
      continue;
    }
    const symbolIndex = request.symbolIndex ?? 0;
    const symbol = preflight.symbols[symbolIndex]!;
    const targetStart = new Date(boundary.getTime() - 300_000);
    const call = await deps.perform(request.label, "CANDLE", 1, () =>
      deps.candles(symbol.symbolId, targetStart, boundary),
    );
    const record: ProbeCallRecord = {
      sequence: calls.length + 1,
      label: request.label,
      kind: request.kind,
      symbolIndex: request.symbolIndex,
      plannedOffsetMs: request.offsetMs,
      plannedAt: plannedAt.toISOString(),
      queuedAt: call.queuedAt,
      dispatchedAt: call.dispatchedAt,
      settledAt: call.settledAt,
      offsetErrorMs:
        call.dispatchedAt === null
          ? null
          : Math.abs(Date.parse(call.dispatchedAt) - plannedAt.getTime()),
      outcome: call.outcome,
      error: call.error,
      requestedItems: 1,
      queueWaitMs: call.queueWaitMs,
      executionMs: call.executionMs,
    };
    calls.push(record);
    if (call.outcome !== "COMPLETED" || call.value === null) {
      stop = true;
      stopReason =
        call.outcome === "TIMEOUT"
          ? "RESPONSE_TIMEOUT"
          : "FIRST_ERROR:" + (call.error ?? "UNKNOWN");
      continue;
    }
    if (
      record.offsetErrorMs !== null &&
      record.offsetErrorMs > preflight.dispatchToleranceMs
    ) {
      stop = true;
      stopReason = "DISPATCH_OFFSET_EXCEEDED";
      continue;
    }
    const readIndex = request.offsetMs < 20_000 ? 1 : 2;
    const target = call.value.find(
      (candle) =>
        Date.parse(candle.start) === targetStart.getTime() &&
        Date.parse(candle.end) === boundary.getTime(),
    );
    bars.push({
      code: symbol.code,
      symbolId: symbol.symbolId,
      readIndex,
      targetStart: targetStart.toISOString(),
      targetEnd: boundary.toISOString(),
      present: target !== undefined,
      ohlcv: target
        ? {
            open: target.open,
            high: target.high,
            low: target.low,
            close: target.close,
            volume: target.volume,
          }
        : null,
    });
  }

  if (!stop) {
    status = "COMPLETED_NOT_ACCEPTED";
    const provisional = finish();
    status = provisional.acceptance?.passed
      ? "COMPLETED_ACCEPTED"
      : "COMPLETED_NOT_ACCEPTED";
    reason = provisional.acceptance?.passed
      ? "COMPLETED_ACCEPTED"
      : "COMPLETED_NOT_ACCEPTED";
  } else {
    status = calls.every((call) => call.outcome === "NOT_ATTEMPTED")
      ? "BLOCKED"
      : "STOPPED";
  }
  return finish();
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const argument of argv) {
    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (!match) throw new Error(`Unsupported argument: ${argument}`);
    parsed[match[1]!] = match[2]!;
  }
  return parsed;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && fileURLToPath(import.meta.url) === entry;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const evidenceDir = args["evidence-dir"];
  const preflightPath = args.preflight;
  if (!evidenceDir || !preflightPath)
    throw new Error("--evidence-dir and --preflight are required");
  const preflightText = readFileSync(preflightPath, "utf8");
  const preflight = feedProbePreflightSchema.parse(JSON.parse(preflightText));
  if (args.date !== preflight.sessionDate)
    throw new Error("Probe date does not match the frozen preflight");
  if (args.boundary !== preflight.boundaryLocal)
    throw new Error("Probe boundary does not match the frozen preflight");
  const computedBoundary = new Date(
    zonedSessionBoundary(
      preflight.sessionDate,
      preflight.boundaryLocal,
      preflight.timezone,
    ),
  );
  if (computedBoundary.getTime() !== Date.parse(preflight.boundaryUtc))
    throw new Error("Frozen boundary does not match the exchange calendar");
  if (
    Date.parse(preflight.expiryUtc) - Date.parse(preflight.boundaryUtc) !==
    60_000
  )
    throw new Error("Frozen expiry must be exactly 60 seconds after T");

  const config = loadConfig();
  const liveMode = config.MARKET_DATA_MODE === "live";
  const sessions = getRecentRegularSessions("CA_TSX", preflight.sessionDate, 1);
  const tradingDay = sessions.at(-1)?.tradingDate === preflight.sessionDate;
  const attemptId = randomUUID();
  const attemptDir = join(evidenceDir, "CA_TSX", attemptId);
  mkdirSync(attemptDir, { recursive: true });
  const writeFile = (name: string, content: string) =>
    writeFileSync(join(attemptDir, name), content);
  const persist = (result: FeedProbeResult, extra: string[]) => {
    writeFileSync(
      join(evidenceDir, "latest.json"),
      `${JSON.stringify(
        {
          attemptId: result.attemptId,
          status: result.status,
          reason: result.reason,
          attemptDir,
          extra,
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      JSON.stringify({
        attemptId: result.attemptId,
        status: result.status,
        reason: result.reason,
        attemptDir,
      }),
    );
  };

  const wire: WireRecord[] = [];
  const rateLimitHeaders: HeaderRecord[] = [];
  const expiry = Date.parse(preflight.expiryUtc);
  const abort = new AbortController();
  const expiryTimer = setTimeout(
    () =>
      abort.abort(
        Object.assign(new Error("PROBE_EXPIRED"), { code: "EXPIRED" }),
      ),
    Math.max(1, expiry - Date.now()),
  );
  expiryTimer.unref?.();

  const baseDeps: Omit<
    FeedProbeDeps,
    "connect" | "perform" | "search" | "quotes" | "candles" | "limiterCounts"
  > = {
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    wire: () => wire,
    rateLimitHeaders: () => rateLimitHeaders,
    writeFile,
  };

  if (!liveMode || !tradingDay) {
    persist(
      await runFeedProbeAttempt({
        preflight,
        preflightDigest: sha256(preflightText),
        preflightPath,
        attemptId,
        imageId: args["image-id"] ?? "unknown",
        liveMode,
        tradingDay,
        deps: {
          ...baseDeps,
          connect: async () => {
            throw new Error("not used");
          },
          perform: async () => {
            throw new Error("not used");
          },
          search: async () => [],
          quotes: async () => [],
          candles: async () => [],
          limiterCounts: () => null,
        },
      }),
      [],
    );
    return;
  }

  const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });
  const clock = () => new Date();
  const masterKey = parseMasterKey(config.APP_MASTER_KEY!);
  const tokenStore = new EncryptedPostgresRefreshTokenStore(
    pool,
    masterKey,
    "questrade_live",
  );
  const limiter = new QuestradeRateLimiter(
    2,
    2,
    clock,
    new PostgresRequestBudget(pool, "questrade_live"),
  );
  const transport = new LiveQuestradeTransport(fetch, (headers, status) => {
    rateLimitHeaders.push({
      at: clock().toISOString(),
      status: status ?? 0,
      remaining: headers.get("x-ratelimit-remaining"),
      reset: headers.get("x-ratelimit-reset"),
    });
    return limiter.observeHeaders(headers, status);
  });
  const tokenManager = new QuestradeTokenManager(
    transport,
    tokenStore,
    clock,
    30_000,
    limiter,
  );
  // The token session is acquired lazily: a blocked or skipped attempt must not
  // rotate the shared durable credential.
  let sessionPromise: Promise<
    Awaited<ReturnType<typeof tokenManager.getSession>>
  > | null = null;
  const getSession = () => (sessionPromise ??= tokenManager.getSession());
  const perform = createLivePerform({
    attemptId,
    expiresAt: new Date(preflight.expiryUtc),
    signal: abort.signal,
    responseTimeoutMs: preflight.responseTimeoutMs,
    schedule: (label, kind, requestedItems, operation, observer) =>
      limiter.schedule(
        kind === "QUOTE" ? "P1" : kind === "CANDLE" ? "P2" : "P3",
        operation,
        {
          discovery: true,
          expiresAt: new Date(preflight.expiryUtc),
          signal: abort.signal,
          observation: {
            attemptId,
            operation:
              kind === "QUOTE"
                ? "QUOTE"
                : kind === "CANDLE"
                  ? "SLOT_HISTORY"
                  : "MAPPING",
            requestedItems,
            observer: { observe: observer },
          },
        },
      ),
  });
  const result = await runFeedProbeAttempt({
    preflight,
    preflightDigest: sha256(preflightText),
    preflightPath,
    attemptId,
    imageId: args["image-id"] ?? "unknown",
    liveMode,
    tradingDay,
    deps: {
      ...baseDeps,
      connect: async () => {
        const session = await getSession();
        return {
          apiServer: session.apiServer.hostname,
          expiresAt: session.expiresAt.toISOString(),
        };
      },
      perform,
      search: async (prefix) => {
        const session = await getSession();
        return transport.searchSymbols(
          session.apiServer,
          session.accessToken,
          prefix,
        );
      },
      quotes: async (symbolIds) => {
        const session = await getSession();
        return transport.getQuotes(
          session.apiServer,
          session.accessToken,
          symbolIds,
        );
      },
      candles: async (symbolId, startTime, endTime) => {
        const session = await getSession();
        return transport.getCandles(
          session.apiServer,
          session.accessToken,
          symbolId,
          "FiveMinutes",
          { startTime, endTime },
        );
      },
      limiterCounts: () => limiter.requestCounts,
    },
  });
  persist(result, []);
  await tokenManager.settle().catch(() => undefined);
  await pool.end().catch(() => undefined);
}

if (isDirectRun()) {
  await main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        status: "INTERNAL_ERROR",
        error:
          error instanceof Error ? error.message.slice(0, 200) : String(error),
      }),
    );
    process.exitCode = 1;
  });
}
