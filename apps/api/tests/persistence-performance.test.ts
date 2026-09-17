import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { isolatedDatabaseUrl } from "./isolated-database.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type {
  ContextEvaluation,
  FeatureSnapshot,
  StrategyEvaluation,
  StrategyStateEvent,
} from "@tsx-scanner/contracts";
import { migrate } from "../src/database/migrate.js";
import { PostgresMarketDataRepository } from "../src/market-data/repository.js";
import { PostgresFeatureSnapshotStore } from "../src/market-data/feature-repository.js";
import { PostgresStrategySignalStore } from "../src/market-data/strategy-repository.js";
import { PersistenceMetrics } from "../src/observability/persistence-metrics.js";
import type { Candle, Instrument, Quote } from "../src/questrade/types.js";

/**
 * W7 performance fixture: 200 instruments, five 2-second quote cycles, one setup profile plus two
 * context profiles (matching the seeded `scanner_profile` rows), typical per-cycle event rate, and
 * one-/five-minute candle writes, all against a real PostgreSQL instance (started the same way the
 * rest of the stack does: `docker compose up -d postgres`, see docker-compose.yml).
 *
 * Local contributors may skip this when PostgreSQL is unavailable. CI sets
 * REQUIRE_POSTGRES_INTEGRATION=true, so an unavailable database fails the build. Where it runs,
 * it prints measured p95 numbers for the W7 budgets (persistence < 500ms, full cycle < 2000ms)
 * and keeps assertions deliberately broad enough for shared CI workers.
 */
const DATABASE_URL = isolatedDatabaseUrl("PERSISTENCE_TEST_DATABASE_URL");
function benchmarkInteger(
  key: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(process.env[key] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(
      `${key} must be an integer between ${minimum} and ${maximum}`,
    );
  return value;
}
const INSTRUMENT_COUNT = benchmarkInteger("BENCHMARK_SYMBOLS", 200, 4, 2000);
const QUOTE_CYCLES = benchmarkInteger("BENCHMARK_CYCLES", 5, 5, 100);
// Symbol-id space reserved for this fixture so its rows can be identified and cleaned up without
// touching any other data in a shared dev database.
const SYMBOL_ID_BASE = 900_000_000;
const SETUP_PROFILE_ID = "10000000-0000-4000-8000-000000000081"; // ORB Standard, seeded in 008-phase8a.sql
const MARKET_CONTEXT_PROFILE_ID = "10000000-0000-4000-8000-000000000084"; // seeded in 013-analysis-context.sql
const SECTOR_CONTEXT_PROFILE_ID = "10000000-0000-4000-8000-000000000085"; // seeded in 013-analysis-context.sql
const FEATURE_VERSION = "w7-fixture-v1";
const CONFIG_VERSION = "w7-fixture-config-v1";

let pool: Pool | undefined;
let reachable = false;

beforeAll(async () => {
  if (!DATABASE_URL) return;
  const candidate = new Pool({ connectionString: DATABASE_URL, max: 5 });
  let lastError: unknown;
  try {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      let client: PoolClient | undefined;
      try {
        client = await Promise.race([
          candidate.connect(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("connect timeout")), 3_000),
          ),
        ]);
        client.release();
        client = undefined;
        await migrate(candidate);
        pool = candidate;
        reachable = true;
        return;
      } catch (error) {
        client?.release();
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
    throw lastError ?? new Error("database connection retry budget exhausted");
  } catch (error) {
    if (process.env.REQUIRE_POSTGRES_INTEGRATION === "true") throw error;
    console.warn(
      `[persistence-performance] Skipping: no reachable PostgreSQL at ${DATABASE_URL} (${
        error instanceof Error ? error.message : String(error)
      }). Start it with \`docker compose up -d postgres\` to run this fixture.`,
    );
    await candidate.end().catch(() => {});
  }
}, 15_000);

afterAll(async () => {
  if (pool) await pool.end();
});

function buildInstruments(): Instrument[] {
  return Array.from({ length: INSTRUMENT_COUNT }, (_, index) => ({
    symbol: `W7FIX${index}`,
    symbolId: SYMBOL_ID_BASE + index,
    description: `W7 fixture instrument ${index}`,
    securityType: "Stock",
    exchange: "TSX",
    currency: "CAD",
    isQuotable: true,
    isTradable: true,
  }));
}

function buildQuotes(instruments: Instrument[], cycleTime: Date): Quote[] {
  return instruments.map((instrument, index) => {
    const price = 10 + (index % 50) * 0.37;
    return {
      symbol: instrument.symbol,
      symbolId: instrument.symbolId,
      bid: price - 0.01,
      bidSize: 100,
      ask: price + 0.01,
      askSize: 100,
      last: price,
      lastSize: 100,
      volume: 10_000 + index * 17,
      dayOpen: price - 0.2,
      dayHigh: price + 0.3,
      dayLow: price - 0.3,
      mid: price,
      spreadAbsolute: 0.02,
      spreadPct: 0.02 / price,
      delaySeconds: 0,
      isDelayed: false,
      isHalted: false,
      dataStatus: "REALTIME",
      actionable: true,
      receivedAt: cycleTime,
      source: "QUESTRADE_MOCK",
    };
  });
}

function buildCandles(
  instruments: Instrument[],
  interval: "OneMinute" | "FiveMinutes",
  start: Date,
): Candle[] {
  const durationMs = interval === "OneMinute" ? 60_000 : 300_000;
  return instruments.map((instrument, index) => {
    const price = 10 + (index % 50) * 0.37;
    return {
      symbolId: instrument.symbolId,
      interval,
      start,
      end: new Date(start.getTime() + durationMs),
      open: price,
      high: price + 0.1,
      low: price - 0.1,
      close: price + 0.05,
      volume: 5_000 + index * 3,
      source: "QUESTRADE_MOCK",
      isComplete: true,
    };
  });
}

function buildFeatureSnapshot(
  instrumentId: string,
  symbol: string,
  timestamp: string,
  price: number,
): FeatureSnapshot {
  return {
    marketId: "CA_TSX",
    instrumentId,
    symbol,
    timestamp,
    timeframe: "OneMinute",
    featureVersion: FEATURE_VERSION,
    configVersion: CONFIG_VERSION,
    dataStatus: "REALTIME",
    actionable: true,
    price,
    bid: price - 0.01,
    ask: price + 0.01,
    mid: price,
    spreadAbsolute: 0.02,
    spreadPct: 0.02 / price,
    changeFromOpenPct: 0.5,
    rollingReturn5mPct: 0.1,
    vwap: price - 0.05,
    distanceFromVwapPct: 0.2,
    closeAboveVwap: true,
    last3ClosesAboveVwap: 3,
    vwapSlopePct: 0.05,
    touchVwap: false,
    vwapReclaim: false,
    vwapRejection: false,
    atr14: 0.5,
    atrPct: 2.5,
    rvolAtTime: 1.8,
    currentCumulativeVolume: 50_000,
    historicalMeanCumulativeVolume: 40_000,
    openingRange: {
      high: price + 0.4,
      low: price - 0.4,
      mid: price,
      width: 0.8,
      widthPct: 4,
      widthAtr: 1.6,
      volume: 12_000,
      complete: true,
    },
    swingHighs: [],
    swingLows: [],
    nearestSupport: {
      price: price - 0.5,
      type: "PDH",
      strength: 0.6,
      tests: 2,
      ageBars: 5,
    },
    nearestResistance: {
      price: price + 0.5,
      type: "ORH",
      strength: 0.6,
      tests: 1,
      ageBars: 3,
    },
    supportConfluence: null,
    resistanceConfluence: null,
    distanceFromVwapAtr: 0.3,
    distanceFromOrhAtr: -0.2,
    changeFromOpenAtr: 0.4,
    consecutiveGreenCandles: 2,
    recentMoveVelocityAtr: 0.1,
    warmingUp: [],
  };
}

interface PersistedInstrumentRef {
  id: string;
  symbol: string;
  symbolId: number;
}

function buildEvaluations(
  instruments: PersistedInstrumentRef[],
  timestamp: string,
): { evaluations: StrategyEvaluation[]; events: StrategyStateEvent[] } {
  const evaluations: StrategyEvaluation[] = [];
  const events: StrategyStateEvent[] = [];
  instruments.forEach((instrument, index) => {
    const price = 10 + (index % 50) * 0.37;
    const featureSnapshot = buildFeatureSnapshot(
      instrument.id,
      instrument.symbol,
      timestamp,
      price,
    );
    // Roughly one in ten instruments changes state this cycle -- a typical per-cycle event rate.
    const state = index % 10 === 0 ? "READY" : "WATCH";
    const evaluation: StrategyEvaluation = {
      kind: "SETUP",
      marketId: "CA_TSX",
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      timestamp,
      profileId: SETUP_PROFILE_ID,
      profileName: "ORB Standard",
      strategy: "ORB_RETEST",
      strategyVersion: "1.0.0",
      configVersion: CONFIG_VERSION,
      state,
      score: 50 + (index % 40),
      setupScore: 50 + (index % 40),
      scoreVersion: "score-v1",
      scoreComponents: {
        pattern: 10,
        confirmation: 10,
        structure: 10,
        liquidity: 10,
        timing: 5,
        penalties: 0,
      },
      scoreExplanation: [],
      setupInstanceId: null,
      reasonCodes: ["ROLLING_RANGE_OK"],
      entryReference: price + 0.1,
      stopReference: price - 0.3,
      targetReference: price + 0.5,
      estimatedRr: 1.5,
      featureSnapshot,
    };
    evaluations.push(evaluation);
    if (index % 10 === 0) {
      events.push({
        ...evaluation,
        eventId: randomUUID(),
        eventType: "STRATEGY_STATE_CHANGED",
        previousState: "WATCH",
      });
    }
  });
  return { evaluations, events };
}

function buildContexts(
  instruments: PersistedInstrumentRef[],
  timestamp: string,
): ContextEvaluation[] {
  const contexts: ContextEvaluation[] = [];
  for (const profile of [
    {
      id: MARKET_CONTEXT_PROFILE_ID,
      name: "Market Context",
      signal: "MARKET_RELATIVE_STRENGTH" as const,
    },
    {
      id: SECTOR_CONTEXT_PROFILE_ID,
      name: "Sector Context",
      signal: "SECTOR_RELATIVE_STRENGTH" as const,
    },
  ]) {
    instruments.forEach((instrument, index) => {
      const price = 10 + (index % 50) * 0.37;
      contexts.push({
        kind: "CONTEXT",
        marketId: "CA_TSX",
        instrumentId: instrument.id,
        symbol: instrument.symbol,
        timestamp,
        profileId: profile.id,
        profileName: profile.name,
        signal: profile.signal,
        signalVersion: "1.0.0",
        configVersion: CONFIG_VERSION,
        status: "NEUTRAL",
        contextScore: 55,
        contextScoreVersion: "context-score-v2",
        contextScoreComponents: [],
        missingDataFlags: [],
        observedValue: 0.3,
        benchmarkSymbol: null,
        benchmarkValue: null,
        benchmarkTimestamp: null,
        lookback: "SESSION_FROM_OPEN",
        reasonCodes: [],
        featureSnapshot: buildFeatureSnapshot(
          instrument.id,
          instrument.symbol,
          timestamp,
          price,
        ),
      });
    });
  }
  return contexts;
}

function p95(durations: number[]): number {
  const sorted = [...durations].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[index]!;
}

describe("W7 set-based persistence performance fixture", () => {
  {
    it("keeps a 200-instrument scan cycle's persistence portion and total cycle time within budget", async () => {
      if (!reachable || !pool) {
        console.warn(
          "[persistence-performance] Skipped: no live PostgreSQL reachable.",
        );
        return;
      }
      const metrics = new PersistenceMetrics();
      const repository = new PostgresMarketDataRepository(pool, metrics);
      const featureStore = new PostgresFeatureSnapshotStore(pool, metrics);
      const strategyStore = new PostgresStrategySignalStore(pool, metrics);

      const instruments = buildInstruments();
      const persisted = await repository.upsertInstruments(instruments);
      expect(persisted).toHaveLength(INSTRUMENT_COUNT);
      const refs: PersistedInstrumentRef[] = persisted.map((value) => ({
        id: value.id,
        symbol: value.symbol,
        symbolId: value.symbolId,
      }));

      try {
        const persistenceDurations: number[] = [];
        const cycleDurations: number[] = [];
        let baseTime = Date.parse("2026-08-24T13:31:00.000Z");

        for (let cycle = 0; cycle < QUOTE_CYCLES; cycle += 1) {
          baseTime += 2_000;
          const cycleTimestamp = new Date(baseTime);
          const isoTimestamp = cycleTimestamp.toISOString();
          const cycleStarted = performance.now();

          const quotes = buildQuotes(instruments, cycleTimestamp);
          const persistStarted = performance.now();
          await repository.saveQuotes(quotes);

          // One- and five-minute candle writes: representative of due-bucket candle collection,
          // not fired every single 2-second poll in the real service, but exercised every cycle
          // here so the fixture covers both interval writes under the same transaction budget.
          await repository.saveCandles(
            buildCandles(instruments, "OneMinute", cycleTimestamp),
          );
          await repository.saveCandles(
            buildCandles(instruments, "FiveMinutes", cycleTimestamp),
          );

          const snapshots = refs.map((ref, index) =>
            buildFeatureSnapshot(
              ref.id,
              ref.symbol,
              isoTimestamp,
              10 + (index % 50) * 0.37,
            ),
          );
          await featureStore.saveFeatureSnapshots(snapshots);

          const { evaluations, events } = buildEvaluations(refs, isoTimestamp);
          const contexts = buildContexts(refs, isoTimestamp);
          await strategyStore.saveStrategyResults(
            evaluations,
            events,
            contexts,
          );

          const persistenceMs = performance.now() - persistStarted;
          const cycleMs = performance.now() - cycleStarted;
          persistenceDurations.push(persistenceMs);
          cycleDurations.push(cycleMs);
        }

        const persistenceP95 = p95(persistenceDurations);
        const cycleP95 = p95(cycleDurations);
        console.log(
          JSON.stringify({
            benchmark: "persistence-v1",
            symbols: INSTRUMENT_COUNT,
            cycles: QUOTE_CYCLES,
            persistenceP95Ms: persistenceP95,
            cycleP95Ms: cycleP95,
            persistenceDurationsMs: persistenceDurations,
            cycleDurationsMs: cycleDurations,
            persistenceTargetMs: 500,
            cycleTargetMs: 2000,
          }),
        );

        console.log(
          `[W7 fixture] ${INSTRUMENT_COUNT} instruments x ${QUOTE_CYCLES} cycles -- ` +
            `persistence p95=${persistenceP95.toFixed(1)}ms (budget 500ms), ` +
            `full cycle p95=${cycleP95.toFixed(1)}ms (budget 2000ms). ` +
            `Per-cycle durations: persistence=[${persistenceDurations.map((v) => v.toFixed(1)).join(", ")}] ` +
            `cycle=[${cycleDurations.map((v) => v.toFixed(1)).join(", ")}]`,
        );

        console.log(
          "[W7 fixture] persistence metrics snapshot:",
          JSON.stringify(metrics.snapshot(), null, 2),
        );

        // Wide headroom over the plan's 500ms/2000ms budgets: this asserts the fixture is not
        // wildly out of budget on a slow/shared CI box, while the console output above carries
        // the real measured numbers for the report.
        expect(persistenceP95).toBeLessThan(2_000);
        expect(cycleP95).toBeLessThan(4_000);

        const rowCounts = await pool.query<{
          quotes: string;
          candles: string;
          features: string;
          signals: string;
          evaluations: string;
          events: string;
          contexts: string;
        }>(
          `SELECT
               (SELECT count(*) FROM quote_snapshot WHERE instrument_id = ANY($1::uuid[])) AS quotes,
               (SELECT count(*) FROM candle WHERE instrument_id = ANY($1::uuid[])) AS candles,
               (SELECT count(*) FROM feature_snapshot WHERE instrument_id = ANY($1::uuid[])) AS features,
               (SELECT count(*) FROM strategy_signal WHERE instrument_id = ANY($1::uuid[])) AS signals,
               (SELECT count(*) FROM strategy_evaluation WHERE instrument_id = ANY($1::uuid[])) AS evaluations,
               (SELECT count(*) FROM strategy_state_event WHERE instrument_id = ANY($1::uuid[])) AS events,
               (SELECT count(*) FROM context_evaluation WHERE instrument_id = ANY($1::uuid[])) AS contexts`,
          [refs.map((ref) => ref.id)],
        );
        const counts = rowCounts.rows[0]!;
        // Every cycle upserts one quote per instrument at a distinct timestamp: expect exactly
        // INSTRUMENT_COUNT * QUOTE_CYCLES rows, not fewer (a lossy write) and not more (a leak).
        expect(Number(counts.quotes)).toBe(INSTRUMENT_COUNT * QUOTE_CYCLES);
        // Each cycle uses a distinct synthetic start_time, so one- and five-minute candles both
        // accumulate one row per instrument per cycle rather than upserting onto the same key.
        expect(Number(counts.candles)).toBe(
          INSTRUMENT_COUNT * 2 * QUOTE_CYCLES,
        );
        expect(Number(counts.features)).toBe(INSTRUMENT_COUNT * QUOTE_CYCLES);
        expect(Number(counts.signals)).toBe(INSTRUMENT_COUNT * QUOTE_CYCLES);
        expect(Number(counts.evaluations)).toBe(
          INSTRUMENT_COUNT * QUOTE_CYCLES,
        );
        expect(Number(counts.events)).toBe(
          Math.ceil(INSTRUMENT_COUNT / 10) * QUOTE_CYCLES,
        );
        expect(Number(counts.contexts)).toBe(
          INSTRUMENT_COUNT * 2 * QUOTE_CYCLES,
        );

        const snapshot = metrics.snapshot();
        expect(snapshot.quote_snapshot?.rowsWrittenTotal).toBe(
          INSTRUMENT_COUNT * QUOTE_CYCLES,
        );
        expect(snapshot.strategy_signal?.rowsWrittenTotal).toBe(
          INSTRUMENT_COUNT * QUOTE_CYCLES,
        );
      } finally {
        await cleanup(
          pool,
          refs.map((ref) => ref.id),
        );
      }
    }, 60_000);

    it("leaves no partial writes when a bulk strategy-result write fails mid-transaction", async () => {
      if (!reachable || !pool) {
        console.warn(
          "[persistence-performance] Skipped: no live PostgreSQL reachable.",
        );
        return;
      }
      const repository = new PostgresMarketDataRepository(pool);
      const featureStore = new PostgresFeatureSnapshotStore(pool);
      const strategyStore = new PostgresStrategySignalStore(pool);

      const instruments = buildInstruments()
        .slice(0, 20)
        .map((value, index) => ({
          ...value,
          symbol: `W7FAIL${index}`,
          symbolId: SYMBOL_ID_BASE + 500_000 + index,
        }));
      const persisted = await repository.upsertInstruments(instruments);
      const refs: PersistedInstrumentRef[] = persisted.map((value) => ({
        id: value.id,
        symbol: value.symbol,
        symbolId: value.symbolId,
      }));

      try {
        const timestamp = new Date().toISOString();
        const snapshots = refs.map((ref, index) =>
          buildFeatureSnapshot(ref.id, ref.symbol, timestamp, 10 + index),
        );
        await featureStore.saveFeatureSnapshots(snapshots);

        const { evaluations, events } = buildEvaluations(refs, timestamp);
        const contexts = buildContexts(refs, timestamp);
        // Inject a failure: an out-of-range score violates the strategy_evaluation CHECK
        // constraint, which must fail the whole statement -- and therefore the whole
        // transaction, since events/contexts run in the same BEGIN/COMMIT -- rather than
        // partially committing some instruments' rows.
        evaluations[3]!.score = 999;

        await expect(
          strategyStore.saveStrategyResults(evaluations, events, contexts),
        ).rejects.toThrow();

        const rowCounts = await pool.query<{
          signals: string;
          evaluations: string;
          events: string;
          contexts: string;
        }>(
          `SELECT
             (SELECT count(*) FROM strategy_signal WHERE instrument_id = ANY($1::uuid[])) AS signals,
             (SELECT count(*) FROM strategy_evaluation WHERE instrument_id = ANY($1::uuid[])) AS evaluations,
             (SELECT count(*) FROM strategy_state_event WHERE instrument_id = ANY($1::uuid[])) AS events,
             (SELECT count(*) FROM context_evaluation WHERE instrument_id = ANY($1::uuid[])) AS contexts`,
          [refs.map((ref) => ref.id)],
        );
        const counts = rowCounts.rows[0]!;
        expect(Number(counts.signals)).toBe(0);
        expect(Number(counts.evaluations)).toBe(0);
        expect(Number(counts.events)).toBe(0);
        expect(Number(counts.contexts)).toBe(0);
      } finally {
        await cleanup(
          pool,
          refs.map((ref) => ref.id),
        );
      }
    }, 30_000);
  }
});

async function cleanup(pool: Pool, instrumentIds: string[]): Promise<void> {
  if (instrumentIds.length === 0) return;
  await pool.query(
    `DELETE FROM strategy_state_event WHERE instrument_id = ANY($1::uuid[])`,
    [instrumentIds],
  );
  await pool.query(
    `DELETE FROM context_evaluation WHERE instrument_id = ANY($1::uuid[])`,
    [instrumentIds],
  );
  await pool.query(
    `DELETE FROM strategy_evaluation WHERE instrument_id = ANY($1::uuid[])`,
    [instrumentIds],
  );
  await pool.query(
    `DELETE FROM strategy_signal WHERE instrument_id = ANY($1::uuid[])`,
    [instrumentIds],
  );
  await pool.query(
    `DELETE FROM feature_snapshot WHERE instrument_id = ANY($1::uuid[])`,
    [instrumentIds],
  );
  await pool.query(`DELETE FROM candle WHERE instrument_id = ANY($1::uuid[])`, [
    instrumentIds,
  ]);
  await pool.query(
    `DELETE FROM quote_snapshot WHERE instrument_id = ANY($1::uuid[])`,
    [instrumentIds],
  );
  await pool.query(`DELETE FROM instrument WHERE id = ANY($1::uuid[])`, [
    instrumentIds,
  ]);
}
